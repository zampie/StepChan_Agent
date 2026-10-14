# Step酱 · 桌面宠物

macOS 桌面上一个无背景、常驻置顶的 AI 桌宠。全双工实时语音，可以随时打断；分层骨架 + 程序化动画；
菜单栏配置；在你允许的前提下，她能看一眼你的屏幕、知道你在用什么应用、接住你拖过去的文件。

Tauri 2 + React 19 + PixiJS 8 + Rust。没有服务端进程，产物就是一个 `.app`。

**当前状态与验证证据见 [PROGRESS.md](PROGRESS.md)** —— 里面写清了哪些真跑过、哪些还没验。

## 运行

需要 Node ≥ 22.12（实测 26.8.1）、Rust（实测 1.98.1）、macOS 13+（实测 26.6.2）。

```bash
cp .env.example .env     # 填 STEPFUN_API_KEY
npm install
npm run dev
```

**语音功能必须在打包产物上验收，`tauri dev` 下麦克风可能静默失败** —— dev 跑的是裸二进制，
不是带 usage description 和 entitlements 的签名 bundle：

```bash
npm run build:debug
open "apps/desktop/src-tauri/target/debug/bundle/macos/Step酱.app"
```

从构建产物目录直接打开**不会被 Gatekeeper 拦**（quarantine 属性只在下载/AirDrop 时附加）。
完整的人工验收清单见 [docs/DESKTOP_QA.md](docs/DESKTOP_QA.md)。

浏览器里也能跑 `npm run web` 调界面，此时所有系统能力降级为不可用、凭据走 vite 的 dev-only 端点。
这条路径只是为了保留调试手段，不是产品形态。

## 用法

启动后她出现在屏幕右下角。**透明区域的点击会穿透到下层应用**，只有她身上能点、能拖。

- **说话**：直接开口。她说到一半时你开口，她会立刻停下（服务端 VAD + `response.cancel`）。
- **⌥Space**：唤起输入框，也可以打字。
- **摸她**：头顶、脸颊、徽章、手各有不同反应。
- **菜单栏图标**：语音开关、音色、三个感知开关、大小、开机自启、设置、退出。
- **拖文件给她**：她会看文件名做反应（只读文件名，不读内容）。

## 她能感知什么

三项感知**默认全部关闭**，在菜单栏或设置窗口里开。关闭时她会明确说「你得先打开那个开关」，
而不是假装看不见：

| 能力 | 开启后 | 边界 |
|---|---|---|
| 看屏幕 | 截一张当前屏幕交给 `step-1o-turbo-vision`，聊你正在做的事 | 需系统「屏幕与系统录制」权限；每次都有可见提示；只在内存中处理，用完即删，**不落盘** |
| 知道前台应用 | 切换应用时她偶尔搭话 | 只读应用名和 bundle id，**不读窗口标题**（那需要辅助功能权限，没申请）；8 秒冷却 + 每分钟 4 次上限 |
| 读剪贴板 | 她需要时读一次文字 | 每次都有提示；不主动轮询；最多 4000 字 |
| 自己行动 | 空闲时换位置、久了打瞌睡 | 不读取任何内容 |

**不保存聊天内容、不保存录音、不保存截图。** 只持久化开关、音色、大小、热键。
详见 [AGENTS.md](AGENTS.md) 的隐私条款 —— 原来那条「不读取其他窗口」的一刀切禁令本轮被显式改成了
上面这组条件，不是悄悄越过的。

## 语音

模型 `stepaudio-3-realtime-preview`，一条 WebSocket 承载整个对话回路（听、想、说、调工具），
不再是「ASR → 对话 → 按句 TTS」的串行链路。

实测延迟：**说完到首帧音频 235 ms**（最快一次 7 ms）。旧版按句合成，句间要等。

音色可选元气少女 / 机灵少女 / 软萌女声 / 邻家妹妹 / 活力轻快，默认元气少女。
**换音色会重建会话** —— 模型首次出音后 `voice` 不可改。单会话上限 30 分钟，到期自动静默重建。

三个实测结论，记在这里免得以后重新踩：

- **浏览器设不了 `Authorization` 头**，所以 webview 直连 realtime 必须用 subprotocol 带 key：
  `['realtime', 'openai-insecure-api-key.<KEY>']`。query param 形式会被拒。
- **她会声称做了没真做的事。** 规划阶段只在文本输入下观察到，实测语音输入下同样会：
  说「挪到右下角去」她回「好的我这就挪」但一个工具都没调。现在两条路径都有 `tool_choice` 收紧，
  且宁可降级成「我做不到」也不让她撒谎。
- **`response.cancel` 有尾巴。** 取消后还会到 4 个音频分片，不拦就会在被打断后又蹦出半个字。
  现在有抑制闸门，到下一个 `response.created` 才打开。

PCM 采样率是 **24000**，文档没写。确定方法是测服务端自己报的 `audio_end_ms` 在两种缓冲长度下的
**斜率**以抵消 VAD 偏移；单点读数不可用，而「时长对比文本长度」这种启发式会给出错误答案
（同一音色同一文本的语速能差 2 倍）。

## 美术

角色是 Q 版重绘，保留原立绘的全部识别特征（呆毛、浅蓝长发、水手服配青绿领、青绿百褶裙、step 徽章）。
原始素材 `assets/blue_pet_assets_v0_2/` 保留未改。

流水线在 `tools/art/`，prompt 的唯一来源是 `character.py`：

1. `/images/generations` + `background=transparent` 出 Q 版候选，筛选后定为 `master.png`
   —— 筛选是把候选缩到 220 px 放在浅色和深色底上比，因为那才是真实显示条件；
   同样条件下 `high` 相对 `medium` 看不出差别，所以变体一律用 `medium`
2. 从 master 出发用 `/images/edits` 派生所有变体 —— **edits 会忽略 `background=transparent`**，
   所以走「纯品红幕布 + 本地抠色」（实测晕边 0.35%）
3. 每个变体与 master 做像素 diff，变化区域紧凑的裁成配准覆盖层，不紧凑的降级为整图交叉淡入
4. 归一化、阈值化 alpha（模型给的主体 alpha 上限只到 253–254）、降采样到 512 px，写 `rig.json`

**分层是算出来的，不是声称的。** 原 manifest 当初禁止脸部合成，就是因为没人验证过配准。
现在 11 个表情里 8 个真分层，3 个（害羞 / 生气 / 难过）因为要画腮红、怒气符号、眼泪而降级为
整脸图交叉淡入；10 个动作里 9 个有独立姿势，`tilt` 三版 prompt 都没能让模型真的歪头，
于是改成渲染器对整身图做程序化旋转 —— 头身比 40% 的 Q 版，整体倾斜在视觉上就读作歪头。
每一条降级都带原因写在 `rig.json` 的 `degraded` 里，**没有任何动作是静默空转的**。

动画是程序化的，不靠堆逐帧素材：呼吸、随机眨眼（带偶发连眨）、摇摆、拖拽时的挤压拉伸与惯性、
落地回弹、表情 150 ms 交叉淡入、口型由播放音频的 RMS 驱动（不是按文字节奏瞎摆）。

视觉 QA 拼版：`assets/stepchan_q_v1/_qa_220.png`（全身，浅底 / 深底 / 棋盘格）
与 `_qa_faces.png`（脸部特写）。

## 代码地图

```
apps/desktop/src-tauri/      Rust：窗口 / 托盘 / 热键 / 系统能力 / key 保管
  window.rs                  透明置顶窗口、全屏共存、位移补间
  hittest.rs                 光标轮询驱动的点击穿透（为什么必须在 Rust 侧，见文件头）
  tray.rs                    菜单栏菜单与全局热键
  os/                        截屏、前台应用、电量、剪贴板
apps/web/src/
  App.tsx                    唯一的集成层：把下面三块缝起来
  brain/                     人设、工具执行、会话编排
  voice/                     realtime 客户端、麦克风与播放 worklet、打断
  pet/                       Pixi 骨架渲染器与程序化动画
  awareness/                 主动感知：前台应用搭话、拖放反应、空闲行动
  platform/                  Desktop 契约的两套实现（Tauri / 浏览器）
  ui/                        气泡、设置窗
shared/                      冻结契约：realtime / pet / desktop / brain
tools/art/                   素材生成流水线
```

三块业务层（`brain` / `pet` / `awareness`）互相不 import，耦合只落在 `App.tsx`。
系统能力一律走 `shared/desktop.ts` 的 `Desktop` 契约 —— 这也是将来移植 Android 的接缝。

## 检查

```bash
npm test                 # 147 个用例
npm run typecheck
npm run build:web
npm run build:debug      # 语音/权限只能在这个产物上验
cd apps/desktop/src-tauri && cargo check

node scripts/realtime-probe.mjs   # 会用真实 API 额度：鉴权、VAD、工具调用、打断
```

素材接口的真实行为（透明背景、分辨率下限、400 重试、`edits` 的坑）记在
`~/Desktop/gpt-image-lab/docs/findings.md`，本项目发现的结论都已回填进去。

设计来源 `docs/StepChan_Character_Bible_v1.md`（人设，仍然有效）、
`docs/StepChan_Technical_Design_v0_3.md` 与 `sources/`（Web MVP 时期的方案，已被本版取代，
保留作历史）。`DELIVERY_MANIFEST.json` 是启动包的历史快照，不是当前清单。
