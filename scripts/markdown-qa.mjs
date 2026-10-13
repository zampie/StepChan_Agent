import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage();
  const external = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:5173')) external.push(r.url());
  });
  await page.route('**/api/chat', async (route) => {
    const { requestId } = route.request().postDataJSON();
    const events = [
      {
        type: 'text_delta',
        requestId,
        delta:
          '**安全渲染**\n\n<script>window.injected=true</script>\n\n[危险](javascript:alert(1))\n\n![远程图](https://example.com/tracker.png)\n\n[安全链接](https://example.com)',
      },
      { type: 'done', requestId, status: 'completed' },
    ];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    });
  });
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('textbox').fill('测试渲染');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('安全渲染', { exact: true }).waitFor();
  assert.equal(await page.locator('.message.assistant script').count(), 0);
  assert.equal(await page.locator('.message.assistant img').count(), 0);
  assert.equal(await page.getByRole('link', { name: '危险' }).count(), 0);
  assert.equal(
    await page.getByRole('link', { name: '安全链接' }).getAttribute('rel'),
    'noopener noreferrer',
  );
  assert.deepEqual(external, []);
  console.log(
    'Markdown QA passed: formatted text, no raw HTML, no unsafe links, no remote image fetches.',
  );
} finally {
  await browser.close();
}
