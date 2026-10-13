# V0.2 → V0.3 修订说明

## 保留

Web MVP；React + TypeScript + Vite + PixiJS 8；Node.js + Fastify；Agent/Controller/Renderer/UI 分层；时间与网页两个工具；Mock 和调试页；未来桌面迁移的方向。

## 按素材实物纠正

- 将 1024×1024 改为 1254×1254。
- 删除不存在的 base/neutral 路径；使用原 manifest 的 expressions.neutral。
- 明确六张表情是整身互斥切换，不是面部局部层。
- 保留嘴型键 closed/open_small/open_big；限定 neutral，其他表情隐藏覆盖层。
- blink/wave/独立头部与呆毛运动移到新素材阶段；think 使用轻微整体姿态，不冒充头部绑定。
- 三种可独立验收的动作以 idle/think/bounce 满足，talk 作为附加整体动作与条件嘴型。
- 不将 CRC、解码或同画布等同于视觉配准；加入嘴型 QA 门槛及失败降级。
- 未附三视图不再写成已有开发资源；直接使用已有立绘，不默认占位图。

## 结合人设补齐

将自然中文、平等伙伴、好奇与惊讶区分、失落不等于 angry、真实进展、主动闲聊默认关闭和记忆需同意落实到 Controller、Runtime 与 UI。把“星星笔记”明确为尚无持久化实现的角色习惯，避免提示词描述与产品实际能力混淆。

## 为接手开发补齐

增加请求身份、取消与迟到事件处理、POST 流式契约、工具限额、open_url 提案语义、真实/Mock 验证区别、PixiJS 生命周期清理和分阶段验收。默认时间参数、限额与 companion 冷却均是可调整的工程建议。

## 来源与完成边界

人设文件与原始素材保留字节内容；原 V0.2 文本保存在 sources；V0.3 是本次修订。未生成新美术、未清理图片、未实现应用代码或真实 LLM 接入。启动包校验结果记录在 DELIVERY_MANIFEST.json，应用验收留给接手开发阶段。
