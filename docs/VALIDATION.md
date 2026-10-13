# Step酱 Web MVP 验证记录

验证日期：2026-10-13。本文件区分自动检查、浏览器操作、截图目视与真实 Provider 调用，不把设计说明当作执行证据。

## 结果

M1–M5 的 Web MVP 已实现。Mock 与 OpenRouter 实际调用通过；不需要重新生成角色素材。测试产物在项目的 `artifacts/` 中，包含截图和合成测试对话，不含 API 密钥。实际应用的聊天只在页面内存中存在。

### M1：真实角色与工程

- `npm install` 成功；`package-lock.json` 已保存。开发服务成功启动在 5173/3001。
- 浏览器加载真实 neutral，StrictMode 开发环境观察到 1 个 canvas，无浏览器 pageerror。初始化/销毁代码处理异步初始化与共享贴图缓存。
- 9 张 PNG 的路径、1254px 源尺寸、512px 派生尺寸、alpha 通道与 SHA-256 校验通过。原始素材 11 个文件和人设原文共 12 项，与 `DELIVERY_MANIFEST.json` 哈希全部一致。
- neutral 加载失败的浏览器路由拦截测试显示明确故障；happy 缺失的调试场景回退 neutral。
- 截图：`artifacts/main.png`、`artifacts/mobile.png`。

### M2：表现、嘴型与中断

- 六表情分别由浏览器按钮切换并截图，只有一张 body texture，不使用交叉叠加；底部锚点固定。原图轮廓并非逐像素一致，小幅形态差异保留，没有宣称已配准修复。
- 检查 neutral 的 none/closed/open_small/open_big，3 种背景 × 3 种尺寸（250/350/500px），共 36 张浏览器截图。对 3 张嘴部对照拼图和实际舞台截图进行了目视检查，未发现明显双嘴、矩形接缝或肤色块跳变。250px 放大后有缩小采样造成的细节损失，实际尺寸可用。
- 运行嘴型默认开启，但仅 neutral、speaking、有近期文本且未减少动态时循环；设置可关闭。600ms 无文本、取消、失败、终态均停嘴。其它表情不显示覆盖层。
- 控制器单测覆盖 bounce 回基线、同一时间计算无漂移、旧请求不得回写、减少动态时零变换。页面隐藏时停止 ticker；未增加定时嘴型回调。
- 截图：`artifacts/expression-*.png`、`artifacts/mouth-*.png`；目视辅助拼图 `expressions-contact.png`、`mouth-contact-250.png`、`mouth-contact-350.png`、`mouth-contact-500.png`。
- 没有 blink/wave/局部头部或呆毛能力，实验室明确标注缺素材。

### M3：聊天与 Provider

- SSE 单测覆盖任意字节拆分、中文/emoji UTF-8、CRLF、注释心跳、合帧、截断、非法 JSON、非法表现、旧 requestId、重复 done。
- 客户端单测覆盖取消传播、20 秒初始事件超时、60 秒总时限（用测试时钟加速，并非等待真实一分钟）。浏览器覆盖正在生成时停止、立即再次发送、模拟失败后重试、缺少 done 的断流恢复。
- 本次实际 OpenRouter 四个请求全部完成：第一轮给虚构小猫取名“蓝莓”；第二轮只问名字，正确回答“蓝莓”；第三轮使用 get_time；第四轮使用 open_url。首次文本约 2.8–4.3 秒，调用时长只代表该次测试，不保证未来延迟。
- 保存证据：`artifacts/live-results.json`。前期实测 HTTP 400 确认 Step 5 强制推理，修正为低推理预算后通过；未掩盖为 Mock 成功。
- 生产浏览器另一次实际中文对话成功，回复说明了真实能力边界。截图 `artifacts/live-browser.png`。
- 模型 HTML 被跳过，HTTPS 链接再次校验并带 noopener/noreferrer；Markdown 图片仅显示说明文本，禁止自动获取远程图片。`scripts/markdown-qa.mjs` 验证无 HTML 脚本、危险链接或第三方图片请求。

### M4：受限工具

- get_time 在 Mock 和真实 Provider 中均返回实时 ISO 时间、显示文本与 Asia/Shanghai；单测验证 UTC 缺省、无效时区拒绝、与真实时钟误差小于 2 秒。
- open_url 实际返回 `https://example.com/` 链接卡片；浏览器检查卡片存在、完整地址和 rel 属性，点击前没有自动创建新页面。测试没有把“链接已准备”称为页面已加载。
- javascript/data/file/http、带账号密码的 URL、未知工具、额外参数均拒绝。重复 ID 不重复执行，超过四次调用停止；工具结果先加入 provider 上下文再生成后续文本。
- 前端 18 个生产公开文件扫描无提供的 API 密钥；浏览器请求也不含密钥、没有直连 OpenRouter。服务端错误向前端提供受控消息，不包含供应商原始响应或堆栈。

### M5：交互与交付

- 浏览器验证拖动、越界拖动后重置、折叠/展开聊天；390px 手机截图无横向溢出，仍可聊天。页面尺寸变化通过 ResizeObserver 重新限位。
- 清空后消息消失；localStorage/sessionStorage 均为零。应用没有聊天持久化接口。
- Mock 中问候、疲惫关心和出错恢复可演示。真实模型使用审阅过的人设裁剪提示；有限实测不代表对所有生成内容的人设保证。
- 主动闲聊默认关闭且本版未实现开启流程；长期记忆、音频、提醒、系统桌面悬浮、穿透与其他窗口读取均不在当前交付范围。

## 可复现检查

根目录运行：

```powershell
npm.cmd run validate-assets
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd audit
```

结果：素材通过、类型通过、15/15 自动测试通过、前后端生产构建通过、依赖审计 0 已知漏洞。

开发服务运行时：

```powershell
node scripts/browser-qa.mjs
node scripts/markdown-qa.mjs
node scripts/live-smoke.mjs
```

生产端到端检查（已构建且配置密钥；会产生一次真实模型调用）：

```powershell
node scripts/production-check.mjs
```

该脚本启动临时 3002 服务，检查主页面/调试页/图片 HTTP 200，执行浏览器 Mock 流程，实际调用一次模型、测试 neutral 故障，扫描前端密钥，然后停止自己的临时服务。本次全部通过。

## 已知限制

- 构建保留上游 Zod 注释位置警告与 Pixi chunk 约 579KB 的体积提示；未影响类型检查、构建或浏览器执行。主要应用与 Markdown 已拆分，不把“无错误”写成“无警告”。
- 512px 素材在高像素密度或放大检查时不如原图锐利；原始边缘少量杂色仍保留。没有修改/重绘来源。
- 表现采用状态与保守文本规则，没有复杂情绪识别、TTS 音素同步或局部骨骼动画。
- 真实服务需要网络与有效额度；输出达到 1024 token 上限时会明确显示未完成。请求窗口为当前页内存中的最近完整对话，达到数量/长度限制后需清空。
- 仅验证 Windows 本机 Edge/Chromium 与本地生产服务，没有声称已验证所有浏览器、公网部署或原生桌面发行包。
