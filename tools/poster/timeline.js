// 动画时间线：她在海报中间把表情、动作、效果件依次演一遍。
//
// 为什么用动画而不是横排堆缩图：静态图表达不了呼吸、眨眼、歪头这些**程序化**
// 动画，而那恰好是这个项目美术上最花功夫的部分。
const BREATH = (t, n) => 1 - 0.014 * (1 - Math.cos((t / n) * 2 * Math.PI)) / 2;

/** 返回每帧的状态数组。fps 固定 12。 */
export function buildTimeline() {
  const f = [];
  const push = (n, s) => { for (let i = 0; i < n; i++) f.push(s); };

  // 待机呼吸 + 一次连眨（眨眼在渲染器里是随机的，这里固定成一次连眨）
  for (let t = 0; t < 14; t++) {
    const sq = BREATH(t, 14);
    let expr = 'neutral';
    if (t === 6 || t === 10) expr = 'confused';      // eyes-half
    else if (t === 7 || t === 8) expr = 'sleepy';
    f.push({ expr, squash: sq });
  }
  // 说话：真机口型由播放音频的 RMS 驱动，这里用几档嘴形示意
  for (const e of ['happy', 'excited', 'curious', 'excited', 'happy']) push(2, { expr: e });
  // 兴奋 + 闪光
  push(6, { expr: 'excited', fx: 'sparkle' });
  // 歪头看你（12.6° 是渲染器的真值）
  for (const r of [3.2, 7, 12.6, 12.6, 12.6, 7, 3.2]) f.push({ expr: 'curious', rotate: r });
  // 被摸头 → 害羞 + 爱心
  push(7, { expr: 'shy', fx: 'heart' });
  // 挥手（整身图自带脸，不叠表情层）
  push(5, { action: 'wave' });
  // 打瞌睡
  push(8, { action: 'sleep', fx: 'zzz' });
  // 回到待机，闭环
  for (let t = 0; t < 6; t++) f.push({ expr: 'neutral', squash: BREATH(t, 12) });
  return f;
}
