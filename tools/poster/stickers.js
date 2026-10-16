// 动态表情包的时间线。
//
// 可动的东西只有四类：表情覆盖层（眼/眉/嘴）、整身姿势图、一次性效果件，
// 外加程序化变换（旋转 / 沿 y 压扁 / 上下位移）。所有"动作"都是这四类的组合 ——
// 没有逐帧绘制的素材，也不需要。
//
// 每条循环都要**首尾相接**，否则贴图循环时会跳一下。
//
// ⚠️ **眨眼只能叠在睁眼的表情上。** 渲染器里有明文规则
// （`RigRenderer` 的 `NO_BLINK = {closed, half, smile}`）：这些眼型本身就是闭着或
// 变形的，再叠眨眼只会打架。`happy` / `proud` 的眼型是 `smile`（闭着的笑眼），
// 第一版在 happy 里插了眨眼（smile→half→half→smile），结果"半睁的眼"在笑眼之间
// 来回，读作「无语 → 微笑」。眼型见 rig.json 的 expressions。
const BREATH = (t, n, amp = 0.014) => 1 - amp * (1 - Math.cos((t / n) * 2 * Math.PI)) / 2;
/** 沿正弦来回摆，首尾都在 0。 */
const SWAY = (t, n, amp) => amp * Math.sin((t / n) * 2 * Math.PI);

export const STICKERS = {
  hello: {
    label: '打招呼',
    // 挥手姿势 + 小幅摆动 —— 整身图自带手臂抬起，摆动读作"挥"
    frames: (n = 14) => Array.from({ length: n }, (_, t) => ({
      action: 'wave', rotate: SWAY(t, n / 2, 5), squash: BREATH(t, n),
    })),
  },
  happy: {
    label: '开心',
    // 眼型是 smile（闭着的笑眼）→ **不叠眨眼**，见文件头的说明。
    // 改成欢快地上下晃：呼吸 + 两次小幅起伏，眼睛和嘴全程保持笑。
    frames: (n = 16) => Array.from({ length: n }, (_, t) => {
      const bob = Math.sin((t / n) * 4 * Math.PI);        // 两个周期，首尾都在 0
      return {
        expr: 'happy',
        dy: -7 * Math.max(0, bob),                        // 只往上弹，不往下沉
        squash: BREATH(t, n, 0.018) - 0.012 * Math.max(0, -bob),
        rotate: SWAY(t, n, 2),
      };
    }),
  },
  shy: {
    label: '害羞',
    frames: (n = 14) => Array.from({ length: n }, (_, t) => ({
      expr: 'shy', fx: 'heart', squash: BREATH(t, n, 0.02),
      rotate: SWAY(t, n, 2.5),
    })),
  },
  angry: {
    label: '生气',
    // 快速左右抖 + 怒气符号
    frames: (n = 12) => Array.from({ length: n }, (_, t) => ({
      expr: 'angry', fx: 'exclaim', rotate: SWAY(t, 3, 4.5),
    })),
  },
  sad: {
    label: '难过',
    // 慢慢往下沉一点再回来，配汗滴
    frames: (n = 16) => Array.from({ length: n }, (_, t) => ({
      expr: 'sad', fx: 'sweat',
      squash: 1 - 0.03 * (1 - Math.cos((t / n) * 2 * Math.PI)) / 2,
      dy: 5 * (1 - Math.cos((t / n) * 2 * Math.PI)) / 2,
    })),
  },
  surprised: {
    label: '惊讶',
    // 猛地往上一跳再落回（挤压拉伸：起跳拉长、落地压扁）
    frames: () => {
      const seq = [0, -26, -44, -52, -44, -26, -8, 0, 0, 0, 0, 0];
      return seq.map((dy, t) => ({
        expr: 'surprised', fx: t < 7 ? 'exclaim' : null, dy,
        squash: t === 0 ? 0.94 : t === 7 ? 0.93 : dy < -20 ? 1.03 : 1,
      }));
    },
  },
  curious: {
    label: '好奇',
    // 歪头 12.6°（渲染器 PROCEDURAL_POSE.tilt 的真值）来回
    frames: (n = 16) => Array.from({ length: n }, (_, t) => ({
      expr: 'curious', fx: 'question', rotate: SWAY(t, n, 12.6), squash: BREATH(t, n),
    })),
  },
  excited: {
    label: '兴奋',
    // 连续小跳 + 闪光
    frames: (n = 14) => Array.from({ length: n }, (_, t) => {
      const ph = (t % 7) / 7;
      const up = Math.sin(ph * Math.PI);
      return { expr: 'excited', fx: 'sparkle', dy: -22 * up, squash: 1 - 0.05 * (1 - up) };
    }),
  },
  sleepy: {
    label: '打瞌睡',
    // 睡姿是整身图（自带闭眼），呼吸放慢、周期性冒 zzz
    frames: (n = 18) => Array.from({ length: n }, (_, t) => ({
      action: 'sleep', fx: t % 9 < 5 ? 'zzz' : null, squash: BREATH(t, n, 0.022),
    })),
  },
  proud: {
    label: '得意',
    frames: (n = 16) => Array.from({ length: n }, (_, t) => ({
      expr: 'proud', fx: 'note', rotate: SWAY(t, n, 3.5), squash: BREATH(t, n),
    })),
  },
};

export const STICKER_NAMES = Object.keys(STICKERS);
export const buildSticker = (name) => STICKERS[name].frames();
