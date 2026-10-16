# Step酱当前进度

更新时间：2026-10-14（Asia/Shanghai）。本文件记录**实际**实现状态与验证证据。
没真跑过的一律标为未验证 —— 需要 GUI、麦克风或系统权限的部分大多属于这一类。

## 本轮做了什么

把浏览器标签页里的 Web MVP 重做成 macOS 桌面宠物：

- **形态**：Tauri 2 透明无边框置顶窗口 + 菜单栏配置。Node/Fastify 服务端、SSE、会话恢复、
  「小房间」全部删除；大脑搬进 webview，产物是单个 `.app`，不内嵌 Node 运行时。
- **语音**：`stepaudio-3-realtime-preview` 一条 WebSocket 承载听/想/说/调工具，
  替掉「ASR → 对话 → 按句 TTS」串行链路。实测说完到首帧音频 **235 ms**（最快 7 ms）。
- **美术**：Q 版重绘，保留原角色全部识别特征。分层骨架由像素 diff 算出配准，
  配不准的显式降级；动画程序化（呼吸/眨眼/摇摆/挤压拉伸/交叉淡入/音频驱动口型）。
- **第四面墙**：看屏幕吐槽、前台应用搭话、拖放反应、空闲自主行动。三项感知默认关闭。
- **隐私规则**：`AGENTS.md` 原有的「不读取其他窗口」一刀切禁令被显式改为可控条件
  （默认关 / 关闭时明确拒绝 / 每次读取有可见提示 / 不落盘 / 只持久化设置）。

## 已验证

### 自动化
- `npm test`：**151/151 通过**（realtime 37、brain 52、awareness 21、rig + art + motion 41）
- `npm run typecheck`：通过
- `cargo check`：通过，**无 warning**
- `npm run build:web`：通过（pixi chunk 579 KB 的体积告警是既有现象）
- `npm run build:debug`：**通过**，产出 `Step酱.app`（46.8 MiB）与 `Step酱_2.0.0_aarch64.dmg`（15.8 MiB）

### 打包产物的权限前置条件（逐条验过，不是假定）
- `Info.plist` 内含 `NSMicrophoneUsageDescription`、`LSUIElement=true`、
  `CFBundleIdentifier=com.stepfun.stepchan.pet`、`LSMinimumSystemVersion=13.0`
- `codesign -d --entitlements -` 确认 `com.apple.security.device.microphone` 与
  `.audio-input` **已嵌入**，签名 `adhoc` + `runtime`（hardened）标志
- ⚠️ 这一条差点漏掉：不显式设 `signingIdentity: "-"` 时 Tauri 会跳过 entitlements，
  产物只有 Info.plist 而没有 entitlements —— 麦克风三件套只齐了两件。已修。

### 真实 API 调用
- realtime：subprotocol 鉴权、`session.update`（嵌套工具格式 + server VAD +
  `stepaudio-3-asr-max` 转写）、用户语音实时字幕、VAD start/stop/committed、流式音频输出、
  工具调用往返、`response.cancel` 行为。20 种事件类型抓进 `tests/fixtures/realtime-events.json`，
  全部通过 `parseServerEvent` 且无一降级为 `unknown`
- 采样率 **24000**：用服务端 `audio_end_ms` 在 48000 / 120000 样本两档的斜率测得
  25000 Hz 实测值，VAD 的 320 ms 上报栅格正好解释与 24000 的 120 ms 差；
  对 16000 假设则偏移反号且跨档漂移 1620 ms，排除。输出侧自相关周期 70 样本
  对照已知 24 kHz 参考的 64 样本，同样排除 16 kHz
- 图像生成：8 次 `generations`（Q 版候选）+ 约 40 次 `edits`（变体）
- 系统能力实测值：前台应用 `Ghostty / com.mitchellh.ghostty`；电量 100% full；
  `macOS 26.6.2 (25G83)`；1×1 录屏探针 granted、1125 字节

### 素材
- `rig.json` 通过 `rigManifestSchema` 校验，每个素材的 sha256 与尺寸都在清单里
- 11 表情：8 个真分层，3 个（shy / angry / sad）降级为整脸交叉淡入，原因已记录
- 10 动作：9 个有独立姿势；`tilt` 改为渲染器程序化旋转，原因已记录
- 7 个特效；运行期画布 512×512
- 视觉 QA 拼版 `_qa_220.png` / `_qa_faces.png` 已人工看过：分层合成配准正确，
  棋盘格那一行无晕边

## 未验证

**开放事项（含未验证项、已知缺陷、平台与协议缺口）统一记在
[docs/TODO.md](docs/TODO.md)，不在本文件重复。**

本节原来列了 11 条「代码写了但没在真机见过」。v2.0.0 / v2.0.1 发布之后已经有了
真机使用，其中这些**已经被实际使用验证掉**：窗口外观与置顶、点击穿透的手感、
麦克风授权与采集、实际听感与打断的主观延迟、托盘菜单与勾选、⌥Space、
Pixi 渲染器的运行时表现（动画、交叉淡入、口型跟随）。

仍然未验证的那几条（30 分钟轮换、`response.thinking.delta`、录屏被拒的分支、
以及 v2.0.1 新改的「不可打断」在目标配置下的行为）已经挪进 docs/TODO.md 的 A 组，
那里带上了证据和复现步骤。

人工验收清单在 [docs/DESKTOP_QA.md](docs/DESKTOP_QA.md)，按那个跑完请把结果
（**包括没通过的项**）写回本文件。

## 已知限制与下一步

> 需要**动手修**的条目见 [docs/TODO.md](docs/TODO.md)。本节只留「不打算改、
> 但用的时候必须知道」的事实。

1. **演示前要固定二进制。** TCC 授权绑定代码签名，ad-hoc 签名重建后身份会变，
   麦克风和录屏授权会重新弹、旧授权失效。正确顺序：构建最后一版 → 在那个产物上授权 → 不再重编。
2. **截屏体积**：缩到最长边 2048（base64 约 2.35 MB）。选 2048 而不是 1600 是因为
   「看看这段代码」是明确场景，2560 逻辑点的桌面压到 1600 时文字只有 0.625×。
   如果只需要「她知道我在干什么」，调回 1600 能省一半 body。
3. **多显示器**：截屏固定取主显示器（`screencapture -m`）。她待在副屏时看到的仍是主屏。
4. **`screencapture` 失败时退出码仍是 0**，错误只写 stderr —— 判据是「产物文件存在且非空」
   加 stderr 分类，不能用退出码。这点和最初的假设相反。
5. 没有长期记忆：聊天、录音、截图都不落盘，重启即忘。这是刻意的（见 AGENTS.md）。
6. Android 移植只预留了接缝，**没有做过任何 Android 构建** —— 详见
   [docs/TODO.md](docs/TODO.md) 的 C4（那里写了为什么「透明置顶窗口」这个前提
   在 Android 上很可能不成立）。

## 开发交接

```bash
npm install && npm run dev          # 开发
npm run build:debug                 # 验收语音/权限必须用这个产物
npm test && npm run typecheck
```

key 只存本地被忽略的 `.env`（或 `~/.stepchan/.env`），新机器参考 `.env.example`。
素材重新生成走 `tools/art/`，需要 `~/Desktop/gpt-image-lab` 的 models-proxy key。

原始素材、人设原文与历史设计文档均保留未改。提交以 Git 历史为准，本文件不猜测尚未产生的 commit。
