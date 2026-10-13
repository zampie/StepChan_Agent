import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const endpoint = process.env.STEPCHAN_TEST_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
await fs.mkdir('artifacts', { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const waitDone = () =>
  page.getByRole('button', { name: '停止回复' }).waitFor({ state: 'hidden', timeout: 15000 });
const send = async (text) => {
  await page.getByRole('textbox').fill(text);
  await page.getByRole('button', { name: '发送消息' }).click();
};
try {
  await page.goto(endpoint);
  await page.locator('canvas').waitFor();
  await page.waitForTimeout(1500);
  await page.getByLabel('对话模式').selectOption('mock');
  assert.equal(await page.locator('canvas').count(), 1);
  await page.screenshot({ path: 'artifacts/main.png' });
  await page.getByRole('button', { name: '现在几点了？' }).click();
  await waitDone();
  assert.match(await page.getByRole('log').innerText(), /Asia\/Shanghai|UTC/);
  await send('打开 https://example.com');
  await waitDone();
  const link = page.getByRole('link', { name: '打开网页' });
  assert.equal(await link.getAttribute('href'), 'https://example.com/');
  assert.match(await link.getAttribute('rel'), /noopener/);
  assert.equal(page.context().pages().length, 1);
  await send('给我一个计划');
  await page.getByRole('button', { name: '停止回复' }).click();
  await send('你好');
  await waitDone();
  assert.match(await page.getByRole('log').innerText(), /已停止/);
  assert.match(await page.getByRole('log').innerText(), /你好呀，我是 Step酱/);
  await page.getByRole('button', { name: '收起聊天' }).click();
  await page.getByRole('button', { name: '打开聊天' }).click();
  await page.getByRole('button', { name: '清空会话' }).click();
  assert.equal(await page.locator('.message').count(), 0);
  assert.deepEqual(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    { local: 0, session: 0 },
  );
  await page.goto(endpoint + '/debug/pet');
  await page.locator('canvas').waitFor();
  await page.waitForTimeout(1200);
  await page.getByLabel('对话模式').selectOption('mock');
  await page.getByRole('button', { name: 'error', exact: true }).click();
  await waitDone();
  assert.match(await page.getByRole('alert').innerText(), /模拟/);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitDone();
  await page.getByRole('button', { name: 'disconnect', exact: true }).click();
  await waitDone();
  assert.match(await page.locator('.incomplete').last().innerText(), /未完成/);
  await page.getByRole('button', { name: 'slow', exact: true }).click();
  await page.getByRole('button', { name: '停止回复' }).click();
  await page.getByRole('button', { name: '清空会话' }).click();
  for (const expression of ['neutral', 'happy', 'confused', 'angry', 'sleepy', 'surprised']) {
    await page.getByRole('button', { name: new RegExp(' · ' + expression + '$') }).click();
    await page.waitForTimeout(100);
    await page.locator('.stage').screenshot({ path: `artifacts/expression-${expression}.png` });
  }
  await page.getByRole('button', { name: '平静 · neutral' }).click();
  for (const background of ['light', 'dark', 'checker'])
    for (const size of ['250', '350', '500'])
      for (const mouth of ['none', 'closed', 'open_small', 'open_big']) {
        await page.getByLabel('舞台背景').selectOption(background);
        await page.getByLabel('角色尺寸').selectOption(size);
        await page.getByLabel('嘴型预览').selectOption(mouth);
        await page.waitForTimeout(70);
        await page
          .locator('.pet-area')
          .screenshot({ path: `artifacts/mouth-${background}-${size}-${mouth}.png` });
      }
  await page.getByLabel('舞台背景').selectOption('light');
  await page.getByLabel('角色尺寸').selectOption('430');
  await page.getByLabel('嘴型预览').selectOption('none');
  const box = await page.locator('.pet-area').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 2, box.y + box.height * 2, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('button', { name: '重置角色位置' }).click();
  await page.getByRole('button', { name: '模拟 happy 资源缺失' }).click();
  await page.getByRole('button', { name: '开心 · happy' }).click();
  assert.match(await page.getByRole('alert').innerText(), /回退/);
  await page.goto(endpoint);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await page.getByLabel('对话模式').selectOption('mock');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  await send('你好');
  await waitDone();
  assert.equal(await page.locator('canvas').count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    'Browser QA passed: mock, time, link without auto-open, cancel/new request, clear, retry, disconnect, slow cancellation, expressions, 36 mouth previews, drag/reset, fallback, mobile, no storage, no page errors.',
  );
} finally {
  await browser.close();
}
