// One actual ASR request from synthetic microphone input, one Flash turn, then actual TTS.
import { chromium, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.resolve('artifacts/stepchan-mic-fixture.wav')}`,
  ],
});
const page = await browser.newPage({ permissions: ['microphone'] });
const codes = [],
  errors = [];
page.on('response', (r) => {
  if (/\/api\/audio\//.test(r.url()))
    codes.push({ url: new URL(r.url()).pathname, status: r.status() });
});
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:5173');
  await expect(page.getByLabel('语音朗读')).toBeEnabled();
  await page.getByLabel('语音朗读').click();
  const mic = page.getByLabel('按住说话', { exact: true });
  const box = await mic.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(mic).toHaveText(/松开/);
  await page.waitForTimeout(6500);
  await page.mouse.up();
  await expect(page.getByRole('textbox')).not.toHaveValue('', { timeout: 15000 });
  const transcript = await page.getByRole('textbox').inputValue();
  // Confirm/edit the recognized draft, then use the existing agent route with actual tools available.
  await page.getByRole('textbox').fill('用一句话向我打招呼，不用工具。');
  await page.getByLabel('发送消息', { exact: true }).click();
  await expect(page.locator('.voice-controls > small')).toContainText('正在说话', {
    timeout: 40000,
  });
  const reply = await page.locator('.message.assistant').last().innerText();
  await page.getByLabel('停止语音', { exact: true }).click();
  await expect(page.locator('.voice-controls > small')).toContainText('清亮童真');
  if (errors.length || codes.some((c) => c.status !== 200))
    throw Error(JSON.stringify({ errors, codes }));
  const result = {
    transcript,
    reply,
    codes,
    errors,
    source: 'Synthetic WAV microphone; no human recording',
  };
  await fs.writeFile('artifacts/audio-browser-live.json', JSON.stringify(result, null, 2));
  console.log(result);
} finally {
  await browser.close();
}
