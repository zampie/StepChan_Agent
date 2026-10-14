import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pcmWav } from '../shared/audio.ts';
const endpoint = process.env.STEPCHAN_TEST_URL ?? 'http://127.0.0.1:5173';
await fs.mkdir('artifacts', { recursive: true });
const wav = Buffer.from(
  pcmWav(
    Float32Array.from(
      { length: 24000 * 4 },
      (_, i) => Math.sin((i * 440 * 2 * Math.PI) / 24000) * 0.05,
    ),
    24000,
  ),
);
await fs.writeFile('artifacts/audio-qa-input.wav', wav);
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.resolve('artifacts/audio-qa-input.wav')}`,
  ],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 940 },
  permissions: ['microphone'],
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let speechCalls = 0,
  asrCalls = 0,
  delaySpeech = false,
  delayAsr = false;
await page.addInitScript(() => {
  const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.micTracks = [];
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await get(...args);
    window.micTracks.push(...stream.getTracks());
    return stream;
  };
});
await page.route('**/api/audio/tts', async (route) => {
  speechCalls++;
  if (delaySpeech) await new Promise((resolve) => setTimeout(resolve, 1300));
  await route.fulfill({ contentType: 'audio/wav', body: wav }).catch(() => {});
});
await page.route('**/api/audio/asr', async (route) => {
  asrCalls++;
  const audio = Buffer.from(route.request().postDataJSON().audio, 'base64');
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.readUInt32LE(24), 24000);
  assert.ok(audio.length > 24000);
  if (delayAsr) await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.fulfill({ json: { text: '请给盆栽浇一点水。' } }).catch(() => {});
});
await page.route('**/api/interact', async (route) => {
  const { requestId } = route.request().postDataJSON();
  const events = [
    { type: 'text_delta', requestId, delta: '嘿，你来啦！今天一起发现点新东西吧！' },
    { type: 'done', requestId, status: 'completed' },
  ];
  await route.fulfill({
    contentType: 'text/event-stream',
    body: events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
  });
});
const hold = async () => {
  const button = page.getByRole('button', { name: '按住说话', exact: true });
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveText(/松开/);
  await page.waitForTimeout(1100);
  await page.mouse.up();
};
try {
  await page.goto(endpoint);
  await expect(page.getByLabel('语音朗读')).toBeEnabled();
  const mic = page.getByLabel('按住说话', { exact: true });
  await expect(page.getByLabel('语音朗读')).toHaveAttribute('aria-pressed', 'false');
  assert.equal(speechCalls, 0);
  assert.equal(asrCalls, 0);
  await page.getByLabel('对话模式').selectOption('mock');
  await expect(page.getByLabel('按住说话', { exact: true })).toBeDisabled();
  await page.getByLabel('对话模式').selectOption('live');
  await page.getByRole('button', { name: '试听', exact: true }).click();
  await expect(page.locator('.voice-controls > small')).toContainText('正在说话');
  await page.getByRole('button', { name: '停止语音', exact: true }).click();
  await expect(page.locator('.voice-controls > small')).toContainText('清亮童真');
  await page.getByLabel('语音朗读').click();
  await page.getByRole('textbox').fill('你好');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.voice-controls > small')).toContainText('正在说话');
  // A new input stops current playback, even when text generation has already finished.
  await hold();
  await expect(page.getByRole('textbox')).toHaveValue('请给盆栽浇一点水。');
  assert.equal(asrCalls, 1);
  assert.equal(
    await page.evaluate(() => window.micTracks.every((t) => t.readyState === 'ended')),
    true,
  );
  // Releasing while permission/device setup is still pending must stop late microphone tracks.
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.originalMic = original;
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args);
      await new Promise((resolve) => setTimeout(resolve, 800));
      return stream;
    };
  });
  const pendingBox = await mic.boundingBox();
  await page.mouse.move(pendingBox.x + 10, pendingBox.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  assert.equal(
    await page.evaluate(() => window.micTracks.every((t) => t.readyState === 'ended')),
    true,
  );
  await expect(mic).toHaveText('按住说话');
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await page.mouse.down();
  await expect(page.locator('.voice-error')).toContainText('未获授权');
  await page.mouse.up();
  await expect(page.getByRole('textbox')).toBeEnabled();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = window.originalMic;
  });
  await page.getByRole('button', { name: '清空会话', exact: true }).click();
  await page.getByRole('textbox').fill('我可以修改识别结果');
  delayAsr = true;
  await hold();
  await page.getByRole('textbox').fill('保留我的新草稿');
  await page.waitForTimeout(1700);
  await expect(page.getByRole('textbox')).toHaveValue('保留我的新草稿');
  delaySpeech = true;
  await page.getByRole('button', { name: '试听', exact: true }).click();
  await expect(page.locator('.voice-controls > small')).toContainText('准备声音');
  await page.getByRole('button', { name: '清空会话', exact: true }).click();
  await page.waitForTimeout(1500);
  await expect(page.locator('.voice-controls > small')).toContainText('清亮童真');
  // Key-based recording and cancellation remain usable without a pointer.
  await mic.focus();
  await page.keyboard.down('Space');
  await expect(mic).toHaveText(/松开/);
  await page.keyboard.press('Escape');
  await page.keyboard.up('Space');
  await expect(mic).toHaveText('按住说话');
  assert.equal(
    await page.evaluate(() => window.micTracks.every((t) => t.readyState === 'ended')),
    true,
  );
  await page.screenshot({ path: 'artifacts/audio-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await mic.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/audio-mobile.png' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      speechCalls,
      asrCalls,
      checks:
        'default off; mock isolation; preview/playback stop; automatic reply speech; PCM recording; editable transcript; late ASR/TTS discarded; keyboard Escape; tracks released; desktop/mobile; no page errors',
    }),
  );
} catch (error) {
  console.log({
    speechCalls,
    asrCalls,
    voice: await page.locator('.voice-controls').innerText(),
    errors,
  });
  throw error;
} finally {
  await browser.close();
}
