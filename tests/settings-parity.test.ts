import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultSettings, settingsSchema } from '../shared/desktop';

/**
 * 设置的形状有两个真相源：
 *   - TS：`shared/desktop.ts` 的 `settingsSchema`（前端读写、带 zod 默认值）
 *   - Rust：`apps/desktop/src-tauri/src/settings.rs` 的 `defaults()`
 *     （**同时是 `settings_set` 的白名单**，不在表里的键会被静默丢弃）
 *
 * 只往一边加键的后果是**静默失败**：前端写入不报错、读回来还是默认值，
 * 用户看到的是「开关点了没反应、右键菜单永远打钩」。这个坑已经踩过一次
 * （listening / voiceInterruptible / brainMode / chatModel / speechRate /
 * sleepAfterMinutes 六个键全漏了），而且因为不报错，只能靠人肉发现。
 *
 * 所以这里直接解析 Rust 源码里的那段 json!，逐键比对。
 * 解析脆弱是刻意的取舍：宁可将来有人改了 Rust 的写法导致这条测试报错，
 * 也不要再出现一次「加了键但没生效」。
 */
const settingsRs = path.resolve(
  import.meta.dirname,
  '../apps/desktop/src-tauri/src/settings.rs',
);

function rustDefaultKeys(): string[] {
  const source = readFileSync(settingsRs, 'utf8');
  const start = source.indexOf('fn defaults()');
  assert.ok(start >= 0, 'settings.rs 里找不到 fn defaults() —— 比对失效了，请修这条测试');
  const open = source.indexOf('json!({', start);
  assert.ok(open >= 0, 'fn defaults() 里找不到 json!({ —— Rust 侧写法变了，请修这条测试');
  const close = source.indexOf('})', open);
  assert.ok(close > open, 'json! 块没有闭合');
  const body = source.slice(open, close);

  const keys: string[] = [];
  // 只认 `"key":` 这种形式；注释行里不会出现它，所以注释不用单独剥。
  for (const match of body.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"\s*:/g)) {
    keys.push(match[1]);
  }
  return keys;
}

test('Rust 的 defaults() 与 zod 的 settingsSchema 键集完全一致', () => {
  const rust = new Set(rustDefaultKeys());
  const ts = new Set(Object.keys(defaultSettings));

  const missingInRust = [...ts].filter((k) => !rust.has(k));
  const missingInTs = [...rust].filter((k) => !ts.has(k));

  assert.deepEqual(
    missingInRust,
    [],
    `这些键只在 zod 里有，Rust 白名单会把它们静默丢弃（开关点了没反应）：${missingInRust.join(', ')}`,
  );
  assert.deepEqual(
    missingInTs,
    [],
    `这些键只在 Rust 里有，前端读不到也写不了：${missingInTs.join(', ')}`,
  );
});

test('Rust 的默认值能通过 zod 校验，且与 zod 默认值一致', () => {
  // 两边默认值不一致同样是静默问题：首次启动用 Rust 的值，
  // 读失败兜底时用 zod 的值，于是行为会跟"有没有读到设置"有关。
  const source = readFileSync(settingsRs, 'utf8');
  const open = source.indexOf('json!({', source.indexOf('fn defaults()'));
  // +1 只取到 `}`，不要把 json! 的收尾 `)` 也切进来。
  const body = source.slice(open + 'json!('.length, source.indexOf('})', open) + 1);
  // 去掉行注释后就是合法 JSON。
  const json = body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const parsed: unknown = JSON.parse(json);

  const viaZod = settingsSchema.safeParse(parsed);
  assert.ok(
    viaZod.success,
    `Rust 默认值过不了 zod 校验：${viaZod.success ? '' : JSON.stringify(viaZod.error.issues)}`,
  );
  assert.deepEqual(
    viaZod.data,
    defaultSettings,
    '两边的默认值必须逐字段相同，否则行为会取决于"有没有读到设置"',
  );
});
