// WAV ↔ PCM16。两个方向都在这里：
// - **解码**（下行）：播放侧（voice/SpeechStream.ts）只吃 base64 的裸 PCM16，
//   而 /v1/audio/speech 返回的是 WAV 容器，所以要先剥壳。
// - **编码**（上行）：MicStream 出的是裸 PCM16 帧，而 /v1/audio/asr/sse 要一个
//   完整的 WAV（见 ./asr.ts）。编码侧我们自己拼头，所以可以是标准的 44 字节布局 ——
//   下面那个「data 块不在偏移 44」的坑只存在于解码侧。
//
// **这里有个实测的坑：data 块不在偏移 44。** StepFun 的 WAV 在 fmt 之后还塞了一个
// 26 字节的 LIST 块，实际块布局是：
//   fmt @12:16  LIST@36:26  data@70:...   → PCM 数据从偏移 78 开始
// 按教科书的「跳过 44 字节头」会把 34 字节的 LIST 当成音频样本念出来（开头一声爆音），
// 而且后面全部样本错位一个字节 → 变成白噪声。所以必须老老实实走 RIFF 块链。

export type DecodedWav = {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
};

/**
 * 解析 WAV，返回交错的 PCM16 样本。
 * 只接受 PCM（fmt=1）/16bit —— 其他编码我们没法直接喂给播放环，宁可明确失败。
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw Error('TTS 返回的不是 WAV（缺 RIFF/WAVE 头）。');
  }

  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let dataOffset = -1;
  let dataSize = 0;

  // 走块链。块长度是奇数时后面有 1 字节填充（RIFF 规范），不补会一路错位。
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      // 有些实现把 data 长度写成 0 或写错（流式生成时长度未知），以实际字节数为准。
      dataSize = size > 0 && body + size <= bytes.byteLength ? size : bytes.byteLength - body;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0) throw Error('TTS 返回的 WAV 里找不到 data 块。');
  if (format !== 1 || bits !== 16) {
    throw Error(`TTS 返回的 WAV 不是 PCM16（format=${format}, bits=${bits}）。`);
  }
  if (!sampleRate || !channels) throw Error('TTS 返回的 WAV 缺少 fmt 信息。');

  const usable = dataSize - (dataSize % 2);
  // 不能直接 new Int16Array(buffer, dataOffset) —— dataOffset 不保证是 2 的倍数
  // （LIST 块长度随时可能是奇数），对不齐会直接抛 RangeError。拷一份最稳。
  const samples = new Int16Array(usable / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true);
  }
  return { samples, sampleRate, channels };
}

/** 多声道 → 单声道（取平均）。播放环是单声道的。 */
export function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/**
 * 线性重采样到目标采样率。
 *
 * 实测我们请求 24000 时服务端就给 24000，所以这条路平时不走。留着是因为采样率
 * 不一致的后果不是报错而是**音调不对**（播放 worklet 的 sourceRate 是建图时写死的
 * 24000），那种 bug 听起来像「她感冒了」，很难查。宁可多这十行。
 */
export function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[index] ?? 0;
    const b = samples[index + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** 任意字节 → base64。分块避免超长 apply 爆栈（30 秒录音有 1.4MB）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // btoa 在 webview 和 Node 里都有。
  return btoa(binary);
}

/** base64 → 字节。MicStream 给的是 base64 帧，攒 WAV 前要先还原。 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** PCM16 → base64，喂给 SpeechStream.enqueue。 */
export function pcm16ToBase64(samples: Int16Array): string {
  return bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
}

/** WAV 头的固定长度。编码侧用标准布局：RIFF + fmt(16) + data，没有 LIST 块。 */
const WAV_HEADER_BYTES = 44;

/**
 * 单声道 PCM16 → 一个完整的 WAV 文件。
 *
 * 为什么编码侧敢用 44 字节的教科书布局，而解码侧不敢（见文件开头）：头是我们自己
 * 拼的，没有谁会往中间插 LIST 块。而且 ASR 服务端按 fmt 里声明的采样率解，所以
 * 这里的 sampleRate 必须是**实际**采样率 —— 写错不会报错，只会让她听到一句变调的话，
 * 转写结果莫名其妙。
 */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true); // RIFF 块长度 = 文件长 - 8
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate = rate * 声道 * 2 字节
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  // 逐样本写，不走 Int16Array 视图：samples 的 byteOffset 不保证 2 字节对齐。
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, samples[i], true);
  }
  return out;
}

/**
 * 把一串 PCM16 字节块（MicStream 的帧）拼成一个 Int16Array。
 *
 * 帧长固定 1920 字节（24000 × 0.04 × 2），所以正常不会出现奇数字节；但万一出现，
 * 落单的那个字节必须丢掉而不是补 0 —— 补 0 会让后面所有样本错位一个字节，
 * 整段变成白噪声（和解码侧那个坑同一个教训）。
 */
export function concatPcm16(chunks: readonly Uint8Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const samples = new Int16Array(total >> 1);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}
