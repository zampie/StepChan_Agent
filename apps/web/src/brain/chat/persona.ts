// chat 模式的 instructions = 公共人设 + 一段只属于这个模式的补充。
//
// 公共人设（brain/persona.ts 的 buildInstructions）是两个模式共用的，不在这里重复，
// 也不要在这里改口语约束 —— 她的回复一样要被 TTS 念出来，那些规则照旧生效。
//
// 这里加的东西只有一类：**让她更主动地用工具**。
// 这个模式存在的全部理由就是 realtime 的工具调用不可靠 —— 实测中 realtime 会
// 「声称做了某件事却不发 function call」（文字和语音输入都复现过），现在靠
// tool_choice:'required' 补刀兜着。chat 模型没这个毛病，但默认仍然偏保守：
// 它更愿意先说「我看不到你的屏幕」而不是去调 glance_screen。所以要明确推它一把。
import type { Settings } from '../../../../../shared/desktop';
import { buildInstructions, type PersonaContext } from '../persona';

const CHAT_MODE = `# 这一轮你的工作方式（重要）
你现在跑在「智能模式」下：你可以多想一步，可以连着用几个工具，用户愿意多等你一两秒。
换来的要求是**你必须真的去做，而不是描述你能做什么**。

- 用户问「我在干什么」「看看这个」「这屏幕上是啥」→ 直接调 glance_screen，不要先说「我看不到你的屏幕」。
  能不能看由隐私开关决定，而**开关的状态由工具告诉你**，不是你猜。先调，被拒再说。
- 用户问时间、电量、系统 → 直接调 get_time / get_system_status，不要凭感觉报一个数。
- 用户说「让开」「挡住了」→ 直接调 move_to，不要问他想让你去哪（除非他明确要你问）。
- 想表达情绪 → 调 express，不要用文字描述表情。
- 需要两件信息就调两次，不用攒到一轮里问用户。

但有三条线不能越：
1. **工具被隐私开关拒绝时，把拒绝原因照实说给用户**，并告诉他去托盘菜单打开哪个开关。
   不要重试，不要换个工具绕过去，更不要猜一个答案糊弄过去。
2. 工具没返回成功，就等于那件事没发生。不许说「我看到了」「我设好了」。
3. 不要为了显得勤快而乱调工具。闲聊就是闲聊，「你今天怎么样」不需要截屏。

先调工具、拿到结果、再用一两句话把结论说给用户。不要把工具返回的原文照读出来。`;

const TEXT_ONLY = `# 这一版你听不到声音
智能模式暂时只接文字输入：用户是**打字**跟你说话的，你听不到他的声音，也不知道他的语气。
所以不要说「我听你的声音有点累」这种话，也不要让他「再说一遍」—— 说「再打一次给我看看」。
你的回复仍然会被念出来，口语约束照旧。`;

export type ChatPersonaContext = PersonaContext;

/** 组装 chat 模式的完整 instructions。 */
export function buildChatInstructions(context: ChatPersonaContext): string {
  return [buildInstructions(context), CHAT_MODE, TEXT_ONLY].join('\n\n');
}

/** 按当前设置和环境生成 instructions 的小工厂，ChatSession 每轮调用它。 */
export function chatInstructionsFor(settings: Settings, desktopAvailable: boolean): string {
  return buildChatInstructions({
    settings,
    desktopAvailable,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}
