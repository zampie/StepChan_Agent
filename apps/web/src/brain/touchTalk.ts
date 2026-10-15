// 点击/摸她时给大脑的"旁白"。
//
// 为什么不是预制台词：预制句子说三遍就露馅，而且和她当下的情绪、刚聊的话题脱节
//（刚安慰完用户，被摸头却蹦一句「嘿嘿好痒」）。所以这里产出的是**给模型的简短中文旁白**，
// 由她自己组织回应 —— 和 awareness 的意图走同一条路。
//
// 代价是要等模型，所以：
// - 表情/动作的即时反馈不走这条路（渲染器的 reactToTap 已经先动了，零延迟）；
// - 这条路有冷却和"她在忙就不发"的抑制，避免连点变成刷屏和烧额度。
import { ShuffleBag } from '../pet';

/** 两次"因为被摸而说话"之间的最小间隔。连点时只有第一下会让她开口。 */
export const TOUCH_TALK_COOLDOWN_MS = 12_000;

/**
 * 每个部位几条不同措辞的旁白。
 *
 * 用洗牌袋而不是随机：同一个部位连续两次拿到同一条旁白，她的回应会高度相似，
 * 看起来就像预制台词 —— 那正是我们想避开的。
 */
const NARRATION: Record<string, readonly string[]> = {
  head: [
    '用户摸了摸你的头。',
    '用户轻轻拍了下你的头顶。',
    '用户揉了揉你的呆毛。',
  ],
  cheek: ['用户碰了碰你的脸。', '用户戳了一下你的脸颊。'],
  badge: ['用户点了点你身上的 StepFun 徽章。', '用户好奇地看着你胸前的标志。'],
  hand: ['用户拉了拉你的手。', '用户碰了碰你的手。'],
  skirt: ['用户碰到了你的裙子。'],
  default: ['用户轻轻点了你一下。', '用户戳了戳你。'],
};

const COMMON_RULE =
  '用一句话随口回应，别超过十来个字，别重复之前说过的话，也不要解释你在做什么。';

export class TouchTalk {
  private readonly bags = new Map<string, ShuffleBag<string>>();
  /**
   * 上次开口的时刻。初值必须是 -Infinity 而不是 0 ——
   * 用 0 的话，当时钟本身从 0 开始（测试里的注入时钟、或者 performance.now 刚启动）
   * 第一次调用就落在冷却窗口内，表现为「她第一次被摸永远不开口」。
   */
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 被摸之后要不要开口；要的话返回给大脑的旁白。
   *
   * busy = 她正在听/想/说。这时插一句会打断她自己的回合，所以直接跳过 ——
   * 表情反馈已经发生过了，不开口不算没反应。
   */
  narrate(part: string | null, busy: boolean): string | null {
    if (busy) return null;
    const at = this.now();
    if (at - this.lastAt < TOUCH_TALK_COOLDOWN_MS) return null;
    this.lastAt = at;

    const key = part && NARRATION[part] ? part : 'default';
    let bag = this.bags.get(key);
    if (!bag) {
      bag = new ShuffleBag([...NARRATION[key]]);
      this.bags.set(key, bag);
    }
    const line = bag.next();
    return line ? `${line}${COMMON_RULE}` : null;
  }

  /** 她被打断/会话重建时调，免得冷却跨会话残留。 */
  reset(): void {
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}
