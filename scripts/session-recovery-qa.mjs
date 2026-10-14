import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
let sessionId,
  creates = 0,
  requests = 0;
page.on('response', async (response) => {
  if (
    response.url().endsWith('/api/sessions') &&
    response.request().method() === 'POST' &&
    response.status() === 201
  ) {
    sessionId = (await response.json()).sessionId;
    creates++;
  }
});
page.on('request', (request) => {
  if (request.url().endsWith('/api/interact')) requests++;
});
const clear = async () => {
  await page.getByLabel('清空会话').click();
  await expect(page.getByRole('switch')).toBeEnabled();
};
try {
  await page.goto('http://127.0.0.1:5173');
  await expect(page.getByRole('switch')).toBeEnabled();
  await page.getByLabel('对话模式').selectOption('mock');
  await page.getByRole('button', { name: '给盆栽浇水', exact: true }).click();
  await expect(page.getByLabel('对话模式')).toBeEnabled();
  await expect(page.getByTestId('plant')).toHaveAttribute('data-water-count', '1');
  const before = creates,
    reqBefore = requests;
  // Remove server memory, just as restarting Fastify would. The browser retains its old ID.
  await page.request.delete(`http://127.0.0.1:5173/api/sessions/${sessionId}`);
  await page.getByRole('textbox').fill('你好');
  await page.getByLabel('发送消息', { exact: true }).click();
  await expect(page.locator('.session-notice')).toContainText('重新连接');
  await expect(page.getByLabel('对话模式')).toBeEnabled();
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).not.toContainText('回复未完成');
  await expect(page.getByTestId('plant')).toHaveAttribute('data-water-count', '0');
  assert.equal(creates - before, 1);
  assert.equal(requests - reqBefore, 2);
  await clear();
  await page.getByRole('button', { name: '抽一张发现卡', exact: true }).click();
  await expect(page.getByLabel('对话模式')).toBeEnabled();
  await page.request.delete(`http://127.0.0.1:5173/api/sessions/${sessionId}`);
  const answerStart = requests;
  await page.getByLabel('当前发现卡').getByRole('button', { name: '金星', exact: true }).click();
  await expect(page.locator('.session-notice')).toContainText('重新选择互动');
  assert.equal(requests - answerStart, 1);
  await expect(page.getByLabel('当前发现卡')).toHaveCount(0);
  // A repeated 410 cannot loop forever, and leaves the composer usable.
  await page.route('**/api/interact', (route) =>
    route.fulfill({ status: 410, json: { message: 'test expired' } }),
  );
  const failureStart = requests;
  await page.getByRole('textbox').fill('再试试');
  await page.getByLabel('发送消息', { exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('test expired');
  await expect(page.getByLabel('对话模式')).toBeEnabled();
  assert.equal(requests - failureStart, 2);
  console.log(
    'PASS: session loss recovers once; resets room/history; drops stale card action; repeated 410 stops cleanly',
  );
} finally {
  await browser.close();
}
