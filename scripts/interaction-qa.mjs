import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const endpoint = process.env.STEPCHAN_TEST_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors = [],
  inputs = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => {
  if (r.url().endsWith('/api/interact')) inputs.push(r.postDataJSON());
});
const done = () => expect(page.getByLabel('对话模式')).toBeEnabled({ timeout: 15000 });
const act = async (name) => {
  await page.getByRole('button', { name, exact: true }).click();
  await done();
};
const clear = async () => {
  await act('清空会话');
  await expect(page.getByRole('switch')).toBeEnabled();
  await expect(page.locator('.message')).toHaveCount(0);
};
try {
  await fs.mkdir('artifacts', { recursive: true });
  await page.goto(endpoint);
  await page.locator('canvas').waitFor();
  await expect(page.getByRole('switch')).toBeEnabled();
  await page.getByLabel('对话模式').selectOption('mock');
  await page.waitForTimeout(700);
  await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('交互建议')).toBeVisible();
  await page.screenshot({ path: 'artifacts/interaction-room.png' });
  await act('关闭台灯');
  await expect(page.locator('.room-stage')).toHaveClass(/lamp-off/);
  await act('打开台灯');
  await page.getByRole('button', { name: '给盆栽浇水', exact: true }).click();
  await expect(page.locator('.message.assistant').last().locator('.message-text')).toContainText(
    '浇好水',
  );
  const partial = await page
    .locator('.message.assistant')
    .last()
    .locator('.message-text')
    .innerText();
  await page.getByRole('textbox').fill('简短一点，请接上刚才的回复。');
  await page.getByRole('button', { name: '打断并发送' }).click();
  await done();
  await expect(page.locator('.incomplete')).toContainText('已停止');
  await expect(page.getByTestId('plant')).toHaveAttribute('data-water-count', '1');
  assert.ok(inputs.at(-1).interrupt?.visibleChars >= 4);
  assert.ok(partial.length > 0);
  await expect(page.locator('.message.assistant').last()).toContainText('浇好水');
  await act('给盆栽浇水');
  await expect(page.getByTestId('plant')).toHaveAttribute('data-water-count', '1');
  await act('抽一张发现卡');
  await expect(page.getByLabel('当前发现卡')).toBeVisible();
  assert.equal(await page.locator('.card-answer').count(), 0);
  await page.getByLabel('当前发现卡').getByRole('button', { name: '金星', exact: true }).click();
  await done();
  await expect(page.locator('.card-answer')).toBeVisible();
  await page.screenshot({ path: 'artifacts/interaction-card.png' });
  await act('收起发现卡');
  // Actual pointer hits on opaque sprite pixels; no hidden trigger API.
  const box = await page.locator('.pet-area').boundingBox();
  const size = Math.min(370, box.width - 12, box.height - 45);
  for (const [part, x, y] of [
    ['head', 0.5, 0.1],
    ['cheek', 0.48, 0.25],
    ['badge', 0.5, 0.335],
    ['hand', 0.31, 0.58],
  ]) {
    await page.mouse.click(
      box.x + box.width / 2 + (x - 0.5) * size,
      box.y + box.height / 2 + (y - 0.5) * size,
    );
    await page.waitForTimeout(350);
    await done();
    assert.equal(inputs.at(-1).input.kind, 'touch');
    assert.equal(inputs.at(-1).input.part, part);
  }
  const count = inputs.length;
  await page.mouse.click(box.x + box.width / 2 - size * 0.46, box.y + box.height / 2 - size * 0.45);
  await page.waitForTimeout(700);
  assert.equal(inputs.length, count, 'transparent pixels must not send touches');
  await act('试试 10 秒');
  await expect(page.locator('.object-timer')).toContainText('点击取消');
  await expect(page.locator('.object-timer')).toContainText('休息结束了', { timeout: 15000 });
  await done();
  await expect(page.getByRole('log')).toContainText('这一小段休息结束');
  await clear();
  await page.getByRole('switch').click();
  await expect(page.getByTestId('plant')).toHaveAttribute('data-water-count', '1', {
    timeout: 8000,
  });
  await done();
  await expect(page.getByRole('log')).toContainText('自主探索');
  // Advance browser scheduler only after validating a real ten-second timer.
  await page.clock.install();
  await page.getByRole('textbox').fill('正在想要说的话');
  const before = inputs.length;
  await page.clock.fastForward(25000);
  await page.waitForTimeout(300);
  assert.equal(inputs.length, before, 'typing pauses autonomous turns');
  await page.getByRole('textbox').fill('');
  await page.clock.fastForward(1000);
  await expect(page.getByLabel('当前发现卡')).toBeVisible({ timeout: 8000 });
  await done();
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await clear();
  await expect(page.getByTestId('plant')).toHaveAttribute('data-water-count', '0');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/interaction-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'Interaction QA passed: lamp, water, card answer, partial interrupt + resume, 4 opaque body hits, transparent miss, real timer completion, autonomous tools, typing pause, toggle off, clean session, mobile, no browser errors.',
  );
} finally {
  await browser.close();
}
