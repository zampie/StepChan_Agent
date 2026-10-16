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
    // **正常眨眼需要睁开的眼。** happy 预设的眼型是 smile（闭着的笑眼），
    // 所以这里用图层直接组合「睁眼 + 笑嘴」—— 这不是 rig.json 的 11 个预设之一，
    // 但图层系统本身支持任意组合（见 rig.js 的 layers 参数）。
    //
    // 眨眼节奏照抄渲染器的 BLINK_FRAMES：half 45ms → closed 75ms → half 55ms。
    // 12fps 下一帧 83ms，所以 half/closed/half 各一帧最接近真机观感。
    // 中段再给一个「笑弯眼」的拍子（切到 smile 眼型），比纯眨眼更像在笑。
    frames: () => {
      const EYES = [
        'open','open','open','open','open',
        'half','closed','half',                 // 眨一次
        'open','open',
        'smile','smile','smile','smile',        // 笑弯了
        'half','open','open','open',
      ];
      const n = EYES.length;
      return EYES.map((eyes, t) => {
        const bob = Math.sin((t / n) * 4 * Math.PI);
        return {
          layers: { eyes, brow: 'neutral', mouth: 'smile' },
          dy: -6 * Math.max(0, bob),
          squash: BREATH(t, n, 0.016),
          rotate: SWAY(t, n, 1.8),
        };
      });
    },
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
    // 眼型从 open 猛切到 wide（瞪大），配合起跳 —— 比只是跳一下清楚得多。
    // 第一帧刻意是平静的（open + 闭嘴），这样"被吓到"有个起点。
    frames: () => {
      const DY = [0, -26, -44, -52, -44, -26, -8, 0, 0, 0, 0, 0];
      const EYE = ['open', 'wide', 'wide', 'wide', 'wide', 'wide',
                   'wide', 'wide', 'open', 'open', 'open', 'open'];
      return DY.map((dy, t) => ({
        layers: { eyes: EYE[t], brow: 'raised', mouth: t === 0 ? 'closed' : 'round' },
        fx: t >= 1 && t < 8 ? 'exclaim' : null,
        dy,
        squash: t === 0 ? 0.94 : t === 7 ? 0.93 : dy < -20 ? 1.03 : 1,
      }));
    },
  },
  curious: {
    label: '好奇',
    // 眼型是 open → **可以正常眨眼**（不在 NO_BLINK 里）。
    // 歪头 12.6° 是渲染器 PROCEDURAL_POSE.tilt 的真值。
    frames: () => {
      const EYES = [
        'open','open','open','open','open',
        'half','closed','half',                 // 歪到一半时眨一下
        'open','open','open','open','open','open','open','open',
      ];
      const n = EYES.length;
      return EYES.map((eyes, t) => ({
        layers: { eyes, brow: 'raised', mouth: 'small' },
        fx: 'question',
        rotate: SWAY(t, n, 12.6),
        squash: BREATH(t, n),
      }));
    },
  },
  excited: {
    label: '兴奋',
    // **眼睛一亮**：普通大眼 → 睁大 → 星星眼 → 收回。比眨眼更贴"兴奋"。
    // 嘴和眉全程保持（wide / raised），只有眼型在变 —— 眼型是这套素材里
    // 表现力最强的一层。闪光在星星眼出现的那一刻冒出来。
    frames: () => {
      const EYES = [
        'open','open','wide',
        'sparkle','sparkle','sparkle','sparkle','sparkle','sparkle',
        'wide','open','open',
      ];
      const n = EYES.length;
      return EYES.map((eyes, t) => {
        const up = Math.sin((t / n) * 2 * Math.PI);   // 一次小跳，首尾归零
        return {
          layers: { eyes, brow: 'raised', mouth: 'wide' },
          fx: eyes === 'sparkle' ? 'sparkle' : null,
          dy: -20 * Math.max(0, up),
          squash: 1 - 0.045 * Math.max(0, -up),
          rotate: SWAY(t, n, 2),
        };
      });
    },
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
    // smile 在 NO_BLINK 里（本来就是闭着的笑眼），不能眨 —— 但可以做
    // **眼型过渡**：先睁眼看着你，再得意地眯起来。比纯摆动有表情。
    frames: () => {
      const EYES = [
        'open','open','open','open',
        'half','smile','smile','smile','smile','smile','smile',
        'half','open','open','open','open',
      ];
      const n = EYES.length;
      return EYES.map((eyes, t) => ({
        layers: { eyes, brow: 'raised', mouth: 'smile' },
        fx: 'note',
        rotate: SWAY(t, n, 3.5),
        squash: BREATH(t, n),
      }));
    },
  },
};

export const STICKER_NAMES = Object.keys(STICKERS);
export const buildSticker = (name) => STICKERS[name].frames();
