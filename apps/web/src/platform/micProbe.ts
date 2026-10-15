// 麦克风自检。
//
// 为什么值得专门做一个：麦克风失败的症状和「语音开关关着」「TCC 授权过期」
// 「设备被别的应用占用」完全一样 —— 按住、说完、松手，什么都没发生。
// 用户无法区分，我也只能靠猜。所以这里做一次**显式的、带结论的**检查：
// 真的申请一次权限、真的开一次流、真的读一帧样本，然后把每一步的结果说清楚。
//
// 刻意不复用 MicStream：它的职责是长期采集并对接会话，而这里要的是
// 「一次性探一下然后立刻释放」，混在一起会让释放语义变复杂。

export type MicProbeStep = {
  label: string;
  ok: boolean;
  detail: string;
};

export type MicProbeResult = {
  ok: boolean;
  steps: MicProbeStep[];
  /** 给用户的一句结论 + 下一步该做什么。 */
  advice: string;
};

/** 读一帧样本最多等多久。超时本身就是一个有意义的结论（设备在但不出数据）。 */
const FRAME_TIMEOUT_MS = 3000;

/**
 * 判定"采到人声"的峰值门限。
 *
 * 正常说话峰值在 0.05~0.5；安静房间的本底噪声约 0.001~0.005。
 * 取 0.01 把两者分开。**这个数字很重要**：定得太低会把本底噪声报成成功，
 * 用户看到一排 ✓ 却说话没反应，排查方向会被整个带偏（实际发生过）。
 */
const SPEECH_PEAK = 0.01;

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * 把浏览器的异常名翻译成「用户能据此行动」的话。
 * 只说「失败了」等于没说 —— 每一种都要对应一个具体动作。
 */
function adviceFor(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
      return '系统拒绝了麦克风权限。打开 系统设置 → 隐私与安全性 → 麦克风，勾上 Step酱；如果列表里已经勾着，把勾去掉再勾回来（重新编译过的应用会被当成新应用），然后重启 Step酱。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '系统里找不到可用的麦克风。检查一下有没有外接麦克风被拔掉，或者在 系统设置 → 声音 → 输入 里选一个设备。';
    case 'NotReadableError':
      return '麦克风被占用或读不出数据。先关掉可能在录音的应用（会议软件、录屏、语音备忘录）再试。';
    case 'SecurityError':
      return '当前页面上下文不允许使用麦克风。这通常意味着没跑在打包产物里 —— 请用 .app 而不是浏览器调试页。';
    default:
      return `麦克风打不开：${describe(error)}`;
  }
}

/**
 * 跑一次完整自检。
 *
 * 每一步都单独报告，因为"在哪一步断的"决定了用户该做什么：
 * 权限被拒 → 去系统设置；没有设备 → 去插麦克风；拿到流但读不到样本 → 设备被占。
 */
export async function probeMicrophone(): Promise<MicProbeResult> {
  const steps: MicProbeStep[] = [];
  const fail = (advice: string): MicProbeResult => ({ ok: false, steps, advice });

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    steps.push({ label: '接口可用性', ok: false, detail: 'navigator.mediaDevices.getUserMedia 不存在' });
    return fail('当前环境没有麦克风接口。请在打包好的 .app 里使用，而不是浏览器调试页。');
  }
  steps.push({ label: '接口可用性', ok: true, detail: 'getUserMedia 可用' });

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    steps.push({ label: '权限与设备', ok: true, detail: '已获得麦克风' });
  } catch (error) {
    steps.push({ label: '权限与设备', ok: false, detail: describe(error) });
    return fail(adviceFor(error));
  }

  // 不管后面成不成，流一定要放掉 —— 自检不该留着录音指示灯亮。
  const release = () => stream.getTracks().forEach((t) => t.stop());

  const track = stream.getAudioTracks()[0];
  steps.push({
    label: '输入设备',
    ok: !!track,
    detail: track ? track.label || '（系统未提供设备名）' : '流里没有音轨',
  });
  if (!track) {
    release();
    return fail('拿到了麦克风流但里面没有音轨，这通常是系统音频设备异常。重启一次试试。');
  }

  let context: AudioContext;
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
    await context.resume().catch(() => {});
    steps.push({
      label: '音频上下文',
      ok: context.state === 'running',
      // 实际采样率要报出来：WKWebView 不保证兑现我们请求的 24000，
      // 而这个数字直接决定要不要重采样（之前一直是"未验证"的一项）。
      detail: `状态 ${context.state}，实际采样率 ${context.sampleRate} Hz`,
    });
  } catch (error) {
    steps.push({ label: '音频上下文', ok: false, detail: describe(error) });
    release();
    return fail(`音频上下文建不起来：${describe(error)}`);
  }

  // 真的读一帧。能拿到权限但读不到数据是独立的故障模式（设备被占用）。
  let peak = 0;
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const started = Date.now();
    // 读若干帧取峰值：只读一帧可能正好赶上静音段。
    while (Date.now() - started < FRAME_TIMEOUT_MS) {
      analyser.getFloatTimeDomainData(buffer);
      for (const v of buffer) peak = Math.max(peak, Math.abs(v));
      if (peak > 0.02) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    source.disconnect();
    analyser.disconnect();
    // 门限按**语音电平**定，不是"有没有信号"。
    // 原来用 0.0005，于是 0.001（本底噪声）也报成 ✓ —— 用户看到全绿却说话没反应，
    // 这种"通过"比失败更有害，因为它把排查方向带偏了。
    // 正常说话的峰值在 0.05~0.5；0.01 以下基本可以断定没采到人声。
    steps.push({
      label: '采集到语音',
      ok: peak >= SPEECH_PEAK,
      detail:
        peak >= SPEECH_PEAK
          ? `峰值 ${peak.toFixed(3)}（正常）`
          : `峰值 ${peak.toFixed(3)} —— 这是本底噪声的量级，没有采到人声`,
    });
  } catch (error) {
    steps.push({ label: '采集到声音', ok: false, detail: describe(error) });
  } finally {
    release();
    void context.close().catch(() => {});
  }

  if (peak < SPEECH_PEAK) {
    return {
      ok: false,
      steps,
      advice:
        `权限和设备都正常，但三秒内只采到 ${peak.toFixed(3)} 的信号（本底噪声量级），没有人声。` +
        '请在点「检查麦克风」之后**立刻正常说话**再看结果。如果说了话还是这样：' +
        '① 蓝牙耳机（AirPods 这类）常见输入增益极低或根本没切到麦克风，去 系统设置 → 声音 → 输入 看一眼选中的设备和输入电平；' +
        '② 把输入音量拉高；③ 换成内置麦克风试一次，用来区分是设备问题还是应用问题。',
    };
  }
  return { ok: true, steps, advice: '麦克风正常，采到了人声，可以直接跟她说话。' };
}
