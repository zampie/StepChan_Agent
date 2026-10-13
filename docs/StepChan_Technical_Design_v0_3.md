# Step酱 AI Agent 桌宠 — 技术设计 V0.3

日期：2026-10-13。阶段：Web MVP。依据：用户提供的 V0.2 方案、已确认 Character Bible v1.0、blue_pet_assets_v0_2 实物。

本文是供 Coding Agent 开发的修订方案，不代表应用已经实现。技术栈与 Web 范围沿用 V0.2；新增的调度参数、事件协议和阶段划分是本次工程设计建议，允许在保持人设与行为边界的前提下迭代。人设原文不作改写。

## 1. 产品定位与首版范围

Step酱是聪明、好奇、机灵、轻度幽默的平等探索搭档。正事可靠，闲聊自然，安静时通过轻微动作保持存在感。默认称呼用户“你”，不使用“主人”等仆从称谓；工作失败时先说明真实情况和下一步，不以卖萌掩盖错误。

首版运行于浏览器：展示角色、输入中文、读取流式回复、表现情绪，并在用户提出相应请求时查询时间或提供可点击网页链接。保留可复用的控制器和 Provider 接口，不提前建设复杂插件系统、完整 Agent Harness 或多 Agent 编排。

**P0 必达：** 六种整身表情、轻微待机、idle/think/bounce 三种程序动作、聊天面板、Mock 与单个真实 Provider、流式文本及取消、白名单表现控制、调试页、错误恢复。talk 提供轻微整体动态；neutral 嘴型功能必须完成接入和验收，视觉不合格时允许显式降级关闭，不可伪称通过。

**P1 本轮后续阶段：** 页面内拖动、get_time、open_url 提案、可选的低频陪伴式互动。主动闲聊不阻塞核心 Demo，默认关闭。

**P2：** 眨眼/挥手/独立呆毛动画所需新素材、TTS 与音素口型、桌面壳、长期记忆、提醒系统。首版不实现其他窗口读取、全方向移动、操作系统悬浮或穿透。角色小传中的能力与习惯不自动成为软件功能。

## 2. 架构和责任边界

React 管输入、聊天记录、工具卡片、设置与调试页。PixiJS 8 管贴图、显示对象和每帧渲染。PetController 管状态转换、能力回退、动作调度及嘴型约束。AgentClient 将网络事件交给 UI 与控制器。Fastify 服务端承载 AgentRuntime、Provider Adapter、工具白名单及密钥。

一次请求的顺序：用户提交 → UI 创建 requestId 并进入 thinking → AgentClient 发起 POST → Runtime 校验输入并调用 Provider → 必要时执行工具并将结果回传模型 → 对客户端发送文本、工具与表现事件 → 控制器解释事件 → Renderer 绘制 → 终态清理并恢复 idle。

工具结果决定“事情是否完成”，表现事件只决定“怎样呈现”。模型不能访问 PixiJS 对象，Renderer 不能执行工具，Controller 不能根据一个开心表情宣告任务成功。

使用 npm workspaces，仅设置 `apps/web` 与 `apps/server` 两个应用。共享协议放在根目录 `shared/` 并配置类型引用即可，不为几个枚举建设独立发布包。依赖的具体小版本由开发时选择并锁定；遵循 PixiJS 8 API。

## 3. 素材事实与接入

原始文件位于 `assets/blue_pet_assets_v0_2/`。工程初始化时逐字节复制到 `apps/web/public/assets/characters/blue_pet/`，构建时验证一致性。运行时 manifest URL 是 `/assets/characters/blue_pet/manifest.json`。所有图片路径相对 manifest 目录解析，部署于子路径时统一应用前端的 base 配置。

画布是 **1254×1254**，9 张 PNG 均为 RGBA。锚点 `{x:0.5,y:1}` 为整张画布的底部中心。六张表情全部位于 `expressions/`，包括 neutral；没有 `base/neutral.png`。

原 manifest 的 `renderMode` 为 `full_sprite_swap`。任一时刻仅显示一张全身表情，切换 texture；禁止把 happy 等叠在 neutral 上，禁止直接交叉淡化两张不配准的整身图。相同尺寸不能证明脸、头发和脚底逐像素对齐。

嘴型名是 `closed`、`open_small`、`open_big`。这些是带有局部脸部覆盖内容的全画布透明图，不是通用口部骨骼或精确音素。只在 neutral 上同坐标叠加，底图与嘴型使用相同父容器、缩放与变换；其它表情立即隐藏嘴型。neutral 静止时直接隐藏覆盖层，使用底图嘴巴。

嘴型默认处于“待视觉验收”状态。M2 在浅色、深色、棋盘格背景和实际显示大小检查矩形接缝、双嘴、肤色差异与边缘；通过后开启 runtime capability。失败则默认关闭，继续使用整体 talk，并明确记入素材缺陷。

原 manifest 的 motions 只有 idle、bounce 的程序动画提示，并不包含动画实现。新增 think/talk 在控制器中实现，并在 `contracts/presentation-capabilities.json` 管理运行时能力；不要将原素材 manifest 改写成已经提供动画帧或骨骼。

原方案提到三视图，但本交付没有独立侧面/背面参考文件。首版以现有正面素材为视觉依据，不据此虚构其他视角。

## 4. 角色状态与表现映射

Activity 保留 `idle | listening | thinking | speaking`。listening 仅表示用户正在聊天输入，不代表启用麦克风。thinking 从请求发起持续到首段可展示文本；speaking 表示文本正在呈现，不代表 TTS 发声。错误是请求状态，不添加无限停留的“伤心”活动状态。

Expression 是 `neutral | happy | confused | angry | sleepy | surprised`。Motion 是 `idle | think | bounce | talk`；wave 与 blink 不进入可执行白名单。

语义情绪不等于素材名：好奇优先 neutral + 轻微 think 或文字表达，惊讶才用 surprised；得意可短暂 happy；失落没有专用素材，使用 neutral 和克制语言。角色生气或工具失败不默认使用 angry；angry 仅用于合适的对话表达或调试，避免冲用户发脾气。

输入行为设 listening，提交设 thinking；首个 text_delta 设 speaking；done/error/用户取消/超时均停止嘴型并结束该请求动作。对话内表现优先保留表情；例如 happy + bounce 时不为了嘴型强制改回 neutral。只有当前已经是 neutral 且嘴型 capability 已通过 QA 时运行嘴型。

## 5. 动画调度

分为页面位置、身体姿态和嘴型三个通道。页面位置由拖动修改；姿态是相对稳定基线的位移/缩放/旋转；嘴型是 neutral 下的覆盖层。每帧从基线和当前动作计算结果，不累加上帧位移，防止漂移。

idle：整体微弱呼吸/摇摆，建议周期 3–5 秒、缩放变化不超过约 1%。think：整体轻微倾斜而非独立头部运动，建议不超过约 2 度。bounce：一次轻跳和轻微压缩，建议 450–700 毫秒后回基线。talk：小幅整体变化，嘴型最多约每秒 4–7 次；文本暂停约 600 毫秒或遇到终态即停嘴。这些数值是可调设计建议。

优先级：用户拖动/取消 > 有效当前请求的表现 > 待机。开始拖动先取消未结束的姿态动画，避免 bounce 完成回调把角色拉回旧位置。请求终态后允许当前单次庆祝动作短暂完成，再回 idle；取消和错误立即停止请求动作。所有取消路径清理计时器及完成回调，用 requestId / 动作 token 拒绝过期回调。

默认不模拟眨眼、挥手、抬臂、整理头发或呆毛独立弹动；sleepy 整身图只用于休息状态，不冒充眨眼帧。关闭动态效果或 prefers-reduced-motion 时保留静态表情及文本反馈，减少/停止位移、缩放和嘴型循环。页面不可见时暂停非必要待机。

## 6. 人设落地与注意力边界

后端从固定角色提示模板提供自然中文风格，角色事实以 Character Bible 为准。70/20/10 是风格参考，不按句子机械配比。严肃任务、出错和用户不快时降低幽默；不为了人设编造信息，不制造依赖或离开后的内疚。

“星星笔记”在首版只作为角色习惯，不实现长期保存。聊天只在当前页面内存中维护，清空/刷新即可消失；不得将对话、偏好自动写入 localStorage、IndexedDB、文件或数据库。可单独保存用户明确修改的音效/动态设置；不将界面设置同意扩展为聊天记忆同意。未来记忆功能需逐项展示拟保存内容及保存/删除入口。

主动闲聊开关默认关。若在 P1 实现，建议开关开启、页面可见、非忙碌、无请求、连续空闲 10 分钟以上才可产生一句；建议两次至少间隔 30 分钟。一次未回应后暂停主动闲聊直到下一次用户交互。这些是本次建议默认值，不是既有人设固定数值。

Web 首版通过输入活动、页面可见性和显式“专注/忙碌”开关判断是否打扰；不声称自动知道用户正在开会或使用别的应用。专注状态只抑制主动闲聊，不隐藏用户刚发起请求的结果。提醒日程功能尚未实现，不宣称已经设置提醒。

连续点击的回应可使用 surprised 短暂反应和“怎么啦？有什么急事吗？”；加入节流，不能点击越多弹窗越多。拖动仅影响页面内部位置，设置点击/拖动阈值、指针捕获、边界约束；窗口缩放后重新限位。

## 7. Agent 与事件协议

首版提供 MockProvider 和一个真实兼容服务适配器。这里的“兼容”必须实际验证流式、工具参数和结束语义，不能只凭服务名称认定所有能力一致。Provider 密钥、base URL、模型名只在后端配置；缺失密钥时真实模式提示配置问题，Mock 明确标识为模拟。

客户端 `POST /api/chat`，JSON 包含 requestId、当前页面内的消息历史及用户 IANA 时区；用 fetch 读取 `text/event-stream`。原生 EventSource 不作为此 POST 的实现。每个 SSE frame 使用 `event:` 与 JSON `data:`，以空行结束；解析器支持网络 chunk 拆开一行、多帧合在一个 chunk、UTF-8 多字节拆分及心跳注释。

事件名限定：`status`、`tool_start`、`tool_end`、`text_delta`、`presentation`、`error`、`done`。所有事件带 requestId；工具事件额外带 toolCallId。同一请求的业务事件保持有序，status/tool 在没有实际状态或工具调用时不制造虚假进展。

`text_delta` 的 delta 只包含给用户看的自然语言，不混入 JSON 控制字段。`presentation` 字段只允许 expression、motion，可独立验证并忽略非法字段。结束时发送一次 done，status 为 completed / failed / cancelled；failed 前发送 error。网络直接中断可能没有 done，客户端必须自行转入失败终态并保留已经收到的部分文本。

服务端不直接将供应商事件透传为本协议。先归一化工具调用和文本；使用 SDK/API 已验证的结构化能力取得表现字段。为降低耦合，首版可先按真实请求状态和可校验的最终输出决定表现；无需每 token 判情绪。若必须单独生成最终表现，应限定超时，失败即回退，不延迟文本完成。

建议请求截止时间 60 秒、首个可用事件等待 20 秒，配置化。取消通过 AbortController 关闭连接，服务端收到断开后停止上游请求及可取消工作。首版一会话仅允许一个活跃请求；新请求需先取消旧请求，旧 requestId 的迟到事件全部忽略。重试不自动重复有副作用的操作。

请求历史限制建议为最近 20 条且累计最多 16000 字符，单条用户输入最多 4000 字符；过长在 UI 与服务端一致拒绝或明确裁剪策略，不悄悄丢失当前问题。后端只接受 user/assistant 对话角色，不信任客户端传来的 system 或 tool 结果。页面历史不是长期记忆。

## 8. 工具与服务端边界

get_time：输入 IANA 时区，由服务端校验并获取真实时间。默认优先使用本请求浏览器提供的有效时区；缺失时明确回退 UTC，并在输出携带时区、ISO 时间和可读文本。不能把服务器时区默认为用户时区。

open_url：校验 URL 后返回链接提案，不在服务器或客户端自动打开。仅接受 https，拒绝含用户名密码的 URL、脚本/data/file 协议和解析失败的地址；后端与前端再次校验。卡片显示完整目标 URL 或可检查的地址，按钮“打开网页”，用户点击后用带 noopener/noreferrer 的链接打开。

该工具成功的含义是“链接已准备好”，不是“网页已打开”；模型提示和 UI 都保留这个区别。用户点击也不证明页面加载成功。P1 不下载或读取网页内容，不因此增加任意 URL 抓取能力。

工具名与参数采用运行时 schema 校验；建议每次对话最多执行 4 次工具调用，重复相同 toolCallId 不重复执行，耗时设置上限。不存在的工具或非法参数返回结构化失败，保持 UI 可操作。工具文本当作数据，不解释成新指令或 HTML。

模型 API Key 不放入前端代码或 VITE_*；Vite 会把符合前缀规则的变量暴露给客户端，见 [Vite 官方文档](https://vite.dev/guide/env-and-mode)。开发服务默认绑定本机；公开部署前另行配置访问控制、限流和模型费用限制，不将本地 Demo 的裸代理直接公开。

## 9. 界面和调试页

主界面使用简洁明亮的蓝/青绿配色，角色展示区和可折叠聊天面板。用户应直接看到输入、发送/停止、清空会话、状态、重试和工具链接。Markdown 若支持则使用安全渲染，不接受模型 HTML 脚本。支持键盘发送、可见焦点与合理文本对比度。

`/debug/pet` 不调用 LLM 就能测试六表情、四个可执行动作、四种 Activity、neutral 嘴型、三种背景、不同显示尺寸、锚点、缺资源回退、Mock 事件与取消。未提供的 blink/wave 显示“缺少素材，未启用”，不得提供会假装成功的按钮。

默认启动即加载真实 neutral，不使用占位小人。其它贴图失败回退 neutral，并显示调试错误；neutral 自身也失败则显示明确资源故障面板，避免无限重试空画布。

## 10. 工程结构与生命周期

在本启动包根目录增加 `apps/web`、`apps/server`、`shared` 和根 package.json；保留 docs、sources、assets、contracts。前端建议包括 `pet/PetRenderer.ts`、`pet/PetController.ts`、`pet/animation/`、`agent/AgentClient.ts`、React 组件与 debug 页。后端包括 agent/runtime、providers、tools 和 routes。先使用小模块，不引入额外编排框架。

PixiJS 8 的 Application 先构造再异步 init，使用 canvas 挂载到 React 容器，见 [PixiJS 官方文档](https://pixijs.com/8.x/guides/components/application)。开发时核对所锁定版本的实际类型，避免复制 v7 初始化示例。

React 挂载/卸载时处理初始化尚未完成的竞态；cleanup 移除 canvas、ticker、事件监听、观察器与请求。开发模式 Effect 可能经历额外 setup/cleanup，不能因此出现两张 canvas 或两条循环，见 [React 官方文档](https://react.dev/reference/react/useEffect)。共享贴图缓存与当前 Renderer 的生命周期分开，避免误销毁仍在使用的资源。

资产流程优先实现只读 validate；normalize/build-manifest 仅在确有新素材时增加。任何裁切、缩放、修边写入 derived 目录并记录原图映射。首版不裁图，统一完整画布显示，降低嘴型坐标出错风险。不要为了符合旧文档把 1254 图强制缩成 1024。

## 11. 实施、验收与交付

按 [实施与验收](IMPLEMENTATION_AND_ACCEPTANCE.md) 执行 M1–M5。每阶段区分自动化检查、人工视觉检查和真实 Provider 检查。构建成功不能替代视觉与实际调用验收；文件 CRC 通过也不能代表动画效果完成。

目标工程脚本是 `npm run dev`、`npm run typecheck`、`npm run test`、`npm run build`、`npm run validate-assets`；这些需接手 Agent 实现，本启动包不具备这些命令。Windows PowerShell 中可使用 npm.cmd。README 必须说明 Node 版本、安装与运行、Mock/真实模式、环境文件实际路径和演示流程。

最终完成定义：真实人物显示、核心动画与状态可恢复、Mock 全流程可演示、一个真实 Provider 多轮流式对话通过、两个工具遵守边界、测试与构建通过。若缺少密钥，仅能称“Mock MVP 完成，真实联调待完成”；若嘴型视觉不合格，明确列为降级项。

## 12. 后续能力

有了对齐眼部图层再实现眨眼；有了完整头部、遮挡补全的手臂或动作帧再实现局部动作；呆毛独立运动同样需要素材。现有整图无法稳定恢复被遮挡区域。

Web 验证后再接 Tauri / Electron 平台适配、系统托盘等功能。TTS、新的记忆/提醒权限流和跨平台 UI 独立评估，不阻塞当前 Web MVP。
