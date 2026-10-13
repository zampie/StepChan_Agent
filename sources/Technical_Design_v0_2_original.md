# AI Agent 桌宠 Demo — 技术设计方案

**版本：** V0.2  
**阶段：** Web MVP  
**技术栈：** React + TypeScript + Vite + PixiJS 8  
**目标：** 实现一个具有拟人化交流能力的轻量 AI 桌宠，并保留未来多平台发布能力。

---

## 1. 项目概述

### 1.1 产品定位

开发一个由 AI Agent 驱动的二次元桌宠。

用户可以通过自然语言与角色交流，角色能够使用表情、嘴型和动作回应，同时具备少量实际工具调用能力。

首版运行在浏览器中，以验证角色表现力及 Agent 交互体验为主要目标。

### 1.2 角色设定

基于提供的角色三视图：

- 浅蓝色长发、顶部呆毛
- 蓝色眼睛
- 白色水手服、青绿色领巾
- 青绿色百褶裙
- 白色长袜、深色皮鞋
- 黑白像素风发饰
- Q 版二次元风格

首版仅制作正面站立角色。侧面和背面视图用于保持人物设计一致性。

### 1.3 MVP 功能

| 功能 | 优先级 | 说明 |
|---|---|---|
| 角色立绘显示 | P0 | PNG 透明素材 |
| 待机动画 | P0 | 呼吸、轻微摇摆、眨眼 |
| 表情切换 | P0 | 至少 5 种 |
| 对话交互 | P0 | 聊天输入与文本气泡 |
| LLM 接入 | P0 | OpenAI 兼容 API |
| 情绪 / 动作驱动 | P0 | 模型输出语义标签 |
| 嘴型动画 | P0 | 简易文本驱动嘴型 |
| 动作播放 | P0 | 至少 3 种 |
| 角色拖动 | P1 | 在浏览器视口内拖动 |
| Agent Tool Calling | P1 | 时间查询、打开网页 |
| TTS 语音 | P2 | 后续实现 |
| 桌面应用 | P2 | 后续迁移至 Tauri |

### 1.4 非目标

首版不实现：

- Spine / Live2D 完整绑定
- 复杂物理动画
- 全方向角色移动
- 长期记忆系统
- 多 Agent 协作
- 完整自主任务规划
- 操作系统级悬浮与鼠标穿透
- 移动端原生应用

---

## 2. 技术架构

### 2.1 技术选型

| 层级 | 技术 | 职责 |
|---|---|---|
| 应用框架 | React | UI 与交互 |
| 语言 | TypeScript | 类型约束 |
| 构建 | Vite | 本地开发与打包 |
| 角色渲染 | PixiJS 8 | 渲染与动画 |
| 动画系统 | Tween + Sprite | 简单程序动画 |
| 行为控制 | TypeScript | 状态管理、动作调度 |
| Agent 接入 | API Adapter | LLM、流式响应、工具调用 |
| 后端 | Node.js + Fastify | API Key 保护与 Tool 执行 |
| 素材 | PNG + JSON | 图像与资产描述 |

PixiJS 不使用 Spine Runtime，避免引入额外动画格式及授权依赖。

### 2.2 总体架构

```text
┌─────────────────────────────────────┐
│             Web App                 │
│                                     │
│  ┌───────────┐   ┌───────────────┐  │
│  │ Chat UI   │   │ Pet Renderer  │  │
│  │ React     │   │ PixiJS        │  │
│  └─────┬─────┘   └──────▲────────┘  │
│        │                │           │
│        ▼                │           │
│  ┌───────────────────────────────┐  │
│  │    Pet Behavior Controller    │  │
│  │ State / Expression / Motion   │  │
│  └─────────────▲─────────────────┘  │
│                │                    │
│  ┌─────────────┴─────────────────┐  │
│  │       Agent Client            │  │
│  │ Streaming / Tool Events       │  │
│  └─────────────┬─────────────────┘  │
└────────────────┼────────────────────┘
                 │ HTTP / SSE
                 ▼
┌─────────────────────────────────────┐
│           API Server                │
│                                     │
│  Agent Runtime                      │
│   ├── LLM Provider Adapter          │
│   ├── Tool Registry                 │
│   ├── Tool Executor                 │
│   └── Response Formatter            │
│                                     │
└─────────────────────────────────────┘
```

### 2.3 分层职责

**Agent Runtime**

负责自然语言理解、模型交互、工具决策与执行，输出回复以及可选表现意图。

**Pet Behavior Controller**

将表现意图映射到表情和动作，并负责优先级、中断、恢复待机及动画组合。

**Pet Renderer**

加载角色素材，维护 PixiJS 显示对象，播放表情与动作。

**React UI**

负责输入框、聊天记录、气泡和配置界面。

各模块通过明确的 TypeScript 接口交互，不相互依赖内部实现。

---

## 3. 角色素材系统

### 3.1 设计原则

首版采用 **PNG 分层与差分 + 程序动画**。

不追求完整骨骼系统，不依赖 Spine 或 Live2D。

优先使用少量高质量素材实现良好表现。

### 3.2 素材规格

| 属性 | 规格 |
|---|---|
| 格式 | PNG RGBA |
| 基准画布 | 1024 × 1024 |
| 色彩空间 | sRGB |
| 角色视角 | 正面 |
| 背景 | 透明 |
| 主锚点 | 底部中心 |
| 缩放 | 保持原始比例 |
| 表情 | 统一坐标与画布 |
| 嘴型 | 局部透明差分 |

固定画布尺寸是坐标对齐规则，不要求每张贴图都以完整画布尺寸上传 GPU。运行时允许裁剪并通过偏移量还原位置。

### 3.3 首批素材

**主立绘**

- neutral

**表情**

- happy
- confused
- angry
- sleepy
- surprised

**嘴型**

- closed
- open_small
- open_big

**动作**

- idle
- talk
- wave
- think
- bounce

动作默认优先通过程序生成。

若需要明显挥手、抬臂等动作，应制作独立肢体层或预绘制动作差分，不使用整张立绘旋转来模拟局部关节运动。

### 3.4 资产目录

```text
public/
  assets/
    characters/
      blue_pet/
        manifest.json

        base/
          neutral.png

        expressions/
          happy.png
          confused.png
          angry.png
          sleepy.png
          surprised.png

        mouths/
          closed.png
          open_small.png
          open_big.png

        parts/
          head.png
          body.png
          arm_left.png
          arm_right.png

        effects/
          question.png
          heart.png
```

`parts` 与 `effects` 均为可选目录，没有可用素材时不必创建。

### 3.5 资产 Manifest

```json
{
  "id": "blue_pet",
  "version": "0.2.0",
  "canvas": {
    "width": 1024,
    "height": 1024
  },
  "anchor": {
    "x": 0.5,
    "y": 1
  },
  "base": "base/neutral.png",
  "expressions": {
    "happy": "expressions/happy.png",
    "confused": "expressions/confused.png",
    "angry": "expressions/angry.png",
    "sleepy": "expressions/sleepy.png",
    "surprised": "expressions/surprised.png"
  },
  "mouths": {
    "closed": "mouths/closed.png",
    "small": "mouths/open_small.png",
    "big": "mouths/open_big.png"
  },
  "motions": [
    "idle",
    "talk",
    "wave",
    "think",
    "bounce"
  ]
}
```

表达层语义约定：

- `neutral` 使用 base 图像。
- `expressions` 是与 base 对齐的面部局部差分，不能简单把另一张全身人物图叠加上去。
- 嘴型图层位于面部之上。
- 每张图片必须保持一致的面部关键点与锚点坐标。
- 如果生成素材无法稳定进行局部对齐，可暂时使用整张人物的表情版本进行互斥切换。

---

## 4. 动画系统

### 4.1 目标

实现简单、自然、可打断的角色动画。

采用声明式 Motion Preset，不直接让模型控制底层动画参数。

### 4.2 状态划分

**Activity State**

```ts
type PetActivity =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking";
```

**Expression State**

```ts
type PetExpression =
  | "neutral"
  | "happy"
  | "confused"
  | "angry"
  | "sleepy"
  | "surprised";
```

**Motion State**

```ts
type PetMotion =
  | "idle"
  | "talk"
  | "wave"
  | "think"
  | "bounce";
```

三个状态维度相互独立。

例如角色可以处于：

```json
{
  "activity": "speaking",
  "expression": "happy",
  "motion": "wave"
}
```

### 4.3 动画规则

| 动画 | 实现方式 |
|---|---|
| idle | 轻微位移、缩放、眨眼 |
| talk | 嘴型切换 + 轻微头部运动 |
| wave | 手臂独立图层动画或姿势差分 |
| think | 歪头 + confused 表情 |
| bounce | 整体位移与 squash/stretch |

动画必须支持：

- Loop
- Play once
- Cancel
- Reset
- Transition
- Priority

### 4.4 动作优先级

建议：

```text
用户交互动作
    >
Agent 回复动作
    >
自主待机动作
```

动作完成后恢复 idle。

嘴型循环属于独立通道，不必打断所有身体动作。

### 4.5 避免动画机械感

加入受约束的随机性：

- 眨眼间隔随机
- 呼吸周期轻微变化
- 偶尔轻微歪头
- 无操作时改变待机节奏

随机变化应平滑且幅度有限，不能造成明显抖动。

---

## 5. Agent 系统

### 5.1 设计原则

Agent 不直接控制 PixiJS。

Agent 输出高层表现意图，由行为控制器执行。

需要明确区分：

1. Agent Tool Calling：执行实际任务。
2. Presentation Control：控制角色表情与动作。

二者不要混为一套工具系统。

### 5.2 Agent 响应结构

```ts
interface PetResponse {
  reply: string;
  presentation?: {
    expression?: PetExpression;
    motion?: PetMotion;
  };
}
```

例如：

```json
{
  "reply": "好呀，今天也要加油哦！",
  "presentation": {
    "expression": "happy",
    "motion": "wave"
  }
}
```

所有表现字段均需使用白名单枚举。

### 5.3 流式响应

建议使用 SSE：

```text
user message
    |
    v
Agent request
    |
    +-- status: thinking
    |
    +-- tool_start
    |
    +-- tool_end
    |
    +-- text_delta
    |
    +-- presentation
    |
    +-- done
```

前端根据事件更新聊天文本与状态。

第一版只要求最终表现指令与流式文本兼容，不要求每个 Token 都产生独立情绪决策。

### 5.4 Agent 工具

第一版只注册两个业务工具。

**get_time**

作用：获取服务器所在时区或指定时区的日期时间。必须明确时区，不能默认等同于浏览器用户的时间。

**open_url**

作用：打开网页。

出于浏览器安全限制，后端工具不能直接操控用户浏览器窗口。建议后端只返回经过校验的 URL 和操作意图，前端征得用户确认后，通过用户点击打开目标地址。

验证 URL 必须为允许的协议，例如 HTTPS，禁止危险的脚本协议。

### 5.5 模型适配

定义统一接口：

```ts
interface LLMProvider {
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[]
  ): AsyncIterable<AgentEvent>;
}
```

首版支持一个 OpenAI 兼容服务即可。

不必提前实现复杂的多 Provider 自动切换、Agent 分布式编排或多模型路由。

### 5.6 API 安全

不要把私有模型 API Key 写入前端代码或 `VITE_*` 环境变量。

由本地开发后端或受控服务端代理请求模型。

前端只访问自身 API 服务。

---

## 6. Web 交互设计

### 6.1 页面布局

默认页面采用桌宠展示区与可折叠聊天面板。

角色初始位于画面下方，背景简洁。

提供调试面板，可以手动测试：

- Expression
- Motion
- Activity
- Tool Calls

调试面板对素材验收和 Coding Agent 开发非常重要。

### 6.2 角色交互

- 点击角色：打开聊天面板
- 拖动角色：改变视口内的位置
- 输入消息：进入 listening/thinking 状态
- 收到回复：切换表情、播放动作
- 回复结束：返回 idle

浏览器中拖动只改变网页内部角色位置，不涉及操作系统窗口移动。

### 6.3 视觉风格

- 简洁、明亮
- 与角色蓝色、青绿色配色统一
- 避免复杂游戏 HUD
- 聊天气泡采用轻量圆角样式
- 动画过渡自然、不频繁闪动

---

## 7. 工程目录

推荐 Monorepo，但首版仅分前端与后端两个小包，不引入 Nx、复杂依赖注入等额外框架。

```text
ai-desktop-pet/
  apps/
    web/
      src/
        components/
        pet/
          PetRenderer.ts
          PetController.ts
          animation/
          assets/
        agent/
          AgentClient.ts
        App.tsx
      public/
        assets/
      package.json

    server/
      src/
        agent/
          AgentRuntime.ts
          providers/
        tools/
          getTime.ts
          openUrl.ts
        routes/
      package.json

  scripts/
    assets/
      normalize.py
      validate.py
      build_manifest.py

  docs/
    architecture.md
    asset-spec.md

  package.json
  README.md
```

首版可以使用 npm workspaces。

应用内部模块通过接口通信，不必为了少量逻辑建立单独的 npm package。

---

## 8. 素材生产与开发工具

### 8.1 工作分工

**ChatGPT / 美术侧**

- 角色主立绘生成
- 表情设计
- 嘴型设计
- 差分素材生成
- 视觉一致性检查

**Coding Agent / 工程侧**

- 图片背景清理
- 裁切与锚点对齐
- 素材检查
- 生成 Manifest
- 动画控制器
- PixiJS 渲染
- Agent 工具接入
- 自动化测试

注意：从单张已合成的角色图中无法稳定还原完全被遮挡的部位。若需要独立运动的手臂或头部，应额外制作带有完整遮挡区域的素材，不能仅依赖自动切图。

### 8.2 资产工具

第一版实现三个 CLI 工具即可。

**normalize-assets**

完成画布尺寸、透明边距及文件命名归一化。

**validate-assets**

检查透明通道、关键文件、画布尺寸、面部坐标及对齐规则。

**build-manifest**

读取已确认的资产目录并生成 `manifest.json`。

不必一开始将这些工具封装为 MCP Server。

### 8.3 动画调试工具

提供一个开发页面：

```text
/debug/pet
```

功能包括：

- 选择表情
- 播放动作
- 调整角色缩放
- 查看关键点与锚点
- 检查差分图层是否错位
- 模拟 Agent 响应

开发页不需要调用 LLM 即可测试所有角色表现功能。

---

## 9. 实施阶段

### Milestone 1：角色可展示

交付：

- Web 工程
- PixiJS 画布
- 加载主立绘
- 角色拖动
- 简单 idle 动画

### Milestone 2：角色可表达

交付：

- 表情差分
- 嘴型
- Motion Preset
- 动画状态调度
- 动画调试页面

### Milestone 3：角色可交流

交付：

- Agent API
- 聊天 UI
- 流式回复
- Thinking / Speaking 状态
- 表情动作映射

### Milestone 4：角色会使用工具

交付：

- Tool Calling
- get_time
- open_url
- 工具执行状态反馈
- 失败回退

### Milestone 5：Demo 打磨

交付：

- UI 优化
- 错误处理
- 动画自然度优化
- 开发说明
- 可部署 Web 构建

---

## 10. 验收标准

### 工程

- `npm install` 后能够启动开发环境
- 一条命令启动必要的前后端服务
- TypeScript 类型检查通过
- 生产构建通过
- 不依赖 Tauri / Electron
- API Key 不暴露给浏览器

### 美术

- 与参考角色保持一致
- 角色背景透明
- 表情切换无明显位移
- 嘴型切换不破坏脸部结构
- 动作播放和恢复无明显跳帧
- 资源缺失时可以回退到默认立绘

### Agent

- 可以进行多轮对话
- 可以流式展示回复
- 可以根据回复改变表情
- 可以调用时间工具
- 外部网页操作需用户确认
- 模型异常时不会阻塞角色 UI

### 表现

- 正常待机时角色有持续微动画
- 回答问题时呈现 thinking / speaking 变化
- 开心时能展示 happy + bounce
- 困惑时能展示 confused + think
- 一次性动作结束能返回 idle

---

## 11. 后续多平台迁移设计

Web Demo 成功后再考虑：

**Tauri / Electron**

支持 Windows、macOS、Linux 的桌面窗口、置顶、透明背景、托盘与系统能力。

**移动端**

重新适配 UI 布局和交互方式，角色渲染与大部分控制逻辑可以复用。

**其他 Web 容器**

保持浏览器兼容性，降低平台耦合。

首版通过以下原则控制迁移成本：

- Renderer 不直接访问桌面 API。
- Agent Runtime 不依赖特定前端框架。
- Tool Executor 独立于角色控制器。
- 宿主平台功能使用 Adapter 接口。
- 角色素材统一使用 Manifest 管理。
- 不在共享业务逻辑里调用 Node.js、Tauri 等平台专属 API。

---

## 12. Coding Agent 执行要求

开发时应严格按照 Milestone 顺序实施。

**第一阶段不要求已有最终素材。**

允许先使用占位 PNG，建立完整的资产加载与渲染流程；当正式素材生成后，可以通过替换资源文件及 Manifest 直接更新角色。

不要提前实现尚未使用的抽象层，不要建立复杂 Plugin Framework、MCP Server 或完整 Agent Harness。

优先保证一个简单、可运行、可迭代的端到端 Demo。

最终应提供：

- 完整项目源码
- README
- 本地运行命令
- `.env.example`
- 资产规范与 Manifest
- 角色调试页面
- 基础自动化检查
- 演示操作步骤

**最终目标：**

用户打开网页，就能看见一个会呼吸、眨眼、表达情绪、回应聊天，并能执行少量工具任务的蓝发二次元 AI 桌宠。