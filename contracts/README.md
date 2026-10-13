# 契约样例

`mock-*.events.json` 保留为开发前的历史事件样例，不能直接发送给当前服务。当前运行协议以 `shared/protocol.ts` 为准：requestId 为 UUID，JSON data 内含 type 字段，错误使用 message，done 使用 status。

`presentation-capabilities.json` 已更新为运行能力，并被 PetController 读取；嘴型通过浏览器 QA 后启用。验证见 `docs/VALIDATION.md`。

以下保留原样例的设计说明：

`mock-chat.events.json` 与 `mock-tool.events.json` 各是一条独立请求的顺序事件；实际 SSE 将每项输出为 `event: <event>
data: <JSON data>

`，而不是直接发送整个数组。

原设计中的 plannedMotions 已替换为 motions。这些是控制器实现的整体程序动作，不表示已有动画文件。

客户端用 requestId 拒绝旧请求，用 toolCallId 合并同一工具状态。error.data 包含 requestId、code、message、retryable；随后 done.status=failed。直接断流可能没有终态，客户端仍需回收状态。任何提供给 UI 的 message 均应为不含凭据和供应商堆栈的可读消息。
