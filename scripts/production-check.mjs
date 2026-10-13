import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const endpoint = 'http://127.0.0.1:3002';
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  env: { ...process.env, PORT: '3002' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw Error(output);
    try {
      const r = await fetch(endpoint + '/api/health');
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, 'production did not start');
  for (const path of ['/', '/debug/pet', '/assets/derived/blue_pet_512/expressions/neutral.png'])
    assert.equal((await fetch(endpoint + path)).status, 200);
  const child = spawn(process.execPath, ['scripts/browser-qa.mjs'], {
    env: { ...process.env, STEPCHAN_TEST_URL: endpoint },
    windowsHide: true,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, 'browser QA failed');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const requests = [];
    page.on('request', (r) =>
      requests.push({ url: r.url(), headers: r.headers(), body: r.postData() }),
    );
    await page.goto(endpoint);
    await page.getByRole('textbox').fill('你好，Step酱！请简短介绍一下你能做什么。');
    await page.getByLabel('对话模式').selectOption('live');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page
      .getByRole('button', { name: '停止回复' })
      .waitFor({ state: 'hidden', timeout: 65000 });
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.ok((await page.locator('.message.assistant').innerText()).length > 20);
    assert.deepEqual(pageErrors, []);
    assert.ok(!JSON.stringify(requests).includes(process.env.OPENROUTER_API_KEY));
    assert.ok(!requests.some((r) => r.url.includes('openrouter.ai')));
    await page.screenshot({ path: 'artifacts/live-browser.png' });
    console.log(
      'Production browser live reply:',
      await page.locator('.message.assistant').innerText(),
    );
    await page.route('**/expressions/neutral.png', (r) => r.abort());
    await page.reload();
    await page.getByRole('alert').waitFor({ timeout: 20000 });
    assert.match(await page.getByRole('alert').innerText(), /加载失败/);
  } finally {
    await browser.close();
  }
  const files = await fs.readdir('apps/web/dist', { recursive: true });
  let count = 0;
  for (const file of files) {
    const path = 'apps/web/dist/' + file;
    const stat = await fs.stat(path);
    if (stat.isFile()) {
      const data = await fs.readFile(path);
      assert.ok(
        !data.includes(Buffer.from(process.env.OPENROUTER_API_KEY)),
        'secret in frontend bundle',
      );
      count++;
    }
  }
  console.log(
    `Production checks passed; ${count} public files scanned, no provider key or direct provider browser requests.`,
  );
} finally {
  server.kill();
}
