#!/usr/bin/env node
// 把运行期素材同步到 apps/web/public/rig/。
//
// 为什么需要这一步：素材的权威位置是仓库根的 assets/stepchan_q_v1/（和 tools/art 的
// 产出目录一致，也便于 review diff），但 Vite 只会把 apps/web/public/ 下的东西当静态资源。
// 不同步的话 rig.json 在运行时是 404 —— 而且因为渲染器会「优雅降级」，表现出来只是
// 桌宠不显示，不会有明显报错，很难查。所以这一步必须进 predev/prebuild，不能靠人记得跑。
//
// 刻意不用符号链接：vite build 对 public/ 下的符号链接处理在不同版本上不一致，
// 复制虽然笨但结果确定。
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'assets/stepchan_q_v1');
const dest = join(root, 'apps/web/public/rig');

// 这些只是生成过程的留痕，不该进构建产物：
// candidates 是筛选 master 时的候选，raw 是抠色/归一化前的 1024px 原图，
// registration-report.json 是 diff 配准的量化记录，_ 开头的是视觉 QA 拼版（几 MB）。
const EXCLUDE = new Set(['candidates', 'raw', '__pycache__', 'registration-report.json']);
const skip = (name) => EXCLUDE.has(name) || name.startsWith('.') || name.startsWith('_');

if (!existsSync(src)) {
  console.error(`[rig] 找不到素材目录：${src}\n先运行 tools/art 的生成流水线。`);
  process.exit(1);
}

const entries = (await readdir(src)).filter((name) => !skip(name));
if (!entries.includes('rig.json')) {
  console.error(
    `[rig] ${src} 里没有 rig.json。\n` +
      `素材流水线没跑完，或者产出目录不对。现有内容：${entries.join(', ') || '(空)'}`,
  );
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

let files = 0;
let bytes = 0;
for (const name of entries) {
  const from = join(src, name);
  await cp(from, join(dest, name), { recursive: true });
  const info = await stat(from);
  if (info.isDirectory()) {
    for (const child of await readdir(from, { recursive: true })) {
      const childInfo = await stat(join(from, child)).catch(() => null);
      if (childInfo?.isFile()) {
        files += 1;
        bytes += childInfo.size;
      }
    }
  } else {
    files += 1;
    bytes += info.size;
  }
}

console.log(`[rig] 已同步 ${files} 个文件（${(bytes / 1024 / 1024).toFixed(2)} MB）→ apps/web/public/rig/`);
