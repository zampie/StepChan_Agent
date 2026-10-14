import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatEvent, InteractionRequest } from '../../../shared/protocol';
import { suggestionsFor, inputLabel } from '../../../shared/room';
import { ToolRunner } from './tools';
import type { Provider, ToolCall } from './providers';
import type { Session, Run } from './sessions';
const raw = readFileSync(
  resolve(import.meta.dirname, '../../../prompts/stepchan.runtime.md'),
  'utf8',
);
const character = raw.slice(raw.indexOf('你是 Step酱'), raw.indexOf('表现建议：'));
export async function runInteraction(
  session: Session,
  run: Run,
  request: InteractionRequest,
  provider: Provider,
  emit: (e: ChatEvent) => void,
) {
  const check = () => {
    run.controller.signal.throwIfAborted();
    if (!session.isCurrent(run)) throw Error('请求已被替换');
  };
  const send = (e: ChatEvent) => {
    check();
    emit(e);
  };
  const scene = () =>
    send({ type: 'scene', requestId: run.id, scene: structuredClone(session.scene) });
  const runner = new ToolRunner(request.timezone ?? 'UTC', session.scene);
  let count = 0;
  const seen = new Set<string>();
  const execute = (call: ToolCall) => {
    check();
    if (++count > 4) throw Error('本轮工具调用已达 4 次上限。');
    if (seen.has(call.id)) throw Error('模型重复使用工具标识，已停止。');
    seen.add(call.id);
    send({ type: 'tool_start', requestId: run.id, name: call.function.name, toolCallId: call.id });
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = null;
    }
    check();
    const result = runner.run(call.id, call.function.name, args);
    run.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    send({
      type: 'tool_end',
      requestId: run.id,
      name: call.function.name,
      toolCallId: call.id,
      result,
    });
    scene();
    return result;
  };
  session.goal =
    request.input.kind === 'autonomy'
      ? '看看房间，找一件值得做的小事'
      : request.input.kind === 'touch'
        ? '回应你的招呼'
        : inputLabel(request.input).slice(0, 60);
  send({ type: 'status', requestId: run.id, activity: 'thinking' });
  send({ type: 'goal', requestId: run.id, text: session.goal });
  scene();
  if (request.input.kind === 'action') {
    const { name, ...args } = request.input.action;
    const call: ToolCall = {
      id: `direct-${run.id}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    };
    session.commit(run, [call]);
    execute(call);
  }
  if (request.input.kind === 'touch')
    send({
      type: 'presentation',
      requestId: run.id,
      expression: request.input.part === 'cheek' ? 'surprised' : 'happy',
      motion: 'bounce',
    });
  for (let round = 0; round < 5; round++) {
    check();
    const system =
      character +
      `\n当前为小房间交互版：可以观察房间、调灯、浇水、抽取或揭晓发现卡、启动或取消页面倒计时、移动到物件旁。所有实际改变必须通过工具；不要声称改变尚未发生。日常回应优先结合当前物件提供一次有意义行动，不为了工具而重复操作。自主调度时只选择一个合适小目标，最多两个工具；植物湿度低先照顾它。你可以安静完成行动。使用简短中文（通常 1–3 句），不要用大段说明。发现卡未揭晓时不要公布答案，邀请用户点击选项。用户说“让我猜”时停止解释并保留卡片。用户说“简短一点”时接上刚才被打断的内容。触碰事件自然回应，不必操作物件。当前房间真实状态：${JSON.stringify(session.scene)}。`;
    const result = await provider(
      [{ role: 'system', content: system }, ...session.context()],
      run.controller.signal,
      (delta) => {
        check();
        session.append(run, delta);
        send({ type: 'text_delta', requestId: run.id, delta });
      },
    );
    check();
    const limit = request.input.kind === 'autonomy' ? 2 : 4;
    if (count + result.calls.length > limit) throw Error(`本轮工具调用已达 ${limit} 次上限。`);
    const ids = new Set(seen);
    for (const call of result.calls) {
      if (ids.has(call.id)) throw Error('模型重复使用工具标识，已停止。');
      ids.add(call.id);
    }
    session.commit(run, result.calls);
    if (!result.calls.length) break;
    for (const call of result.calls) execute(call);
    if (round === 4) throw Error('本轮处理次数达到上限。');
  }
  send({ type: 'suggestions', requestId: run.id, items: suggestionsFor(session.scene) });
  send({
    type: 'presentation',
    requestId: run.id,
    expression: /开心|嘿嘿|答对/.test(run.text) ? 'happy' : 'neutral',
    motion: /开心|嘿嘿|答对/.test(run.text) ? 'bounce' : 'idle',
  });
}
