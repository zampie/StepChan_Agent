# 素材授权说明

这个仓库里有三种来源不同的东西，适用不同条款。**代码的开源许可不覆盖美术素材和商标**，
所以单独写一份说明。

| | 内容 | 权利人 | 适用条款 |
|---|---|---|---|
| 源代码 | `apps/` `shared/` `tests/` `tools/` `scripts/` 等 | zampie | [Apache License 2.0](LICENSE) |
| 角色素材 | 「阶跃娘 / Step酱」立绘、Q 版重绘、全部分层与效果件 | 阶跃星辰（StepFun） | 见下「二」 |
| 商标 | 阶跃星辰 logo（Z 字标）、相关名称 | 阶跃星辰（StepFun） | **不授予任何许可** |

## 一、源代码

Apache License 2.0，全文见 [LICENSE](LICENSE)。可以自由使用、修改、再分发，包括商用，
条件是保留版权声明与 [NOTICE](NOTICE) 的内容（Apache-2.0 第 4 条）。

这个项目里真正可复用的工程部分都在这一侧：realtime 语音状态机与打断链路、
像素 diff 算出来的分层配准、程序化动画、透明窗口的点击穿透、
两套大脑实现共用一个 `PetBrain` 契约。换一个自己的角色素材就能跑。

## 二、角色素材

**著作权归阶跃星辰（StepFun）。** 涉及的路径：

```
assets/blue_pet_assets_v0_2/      公司提供的原始立绘（未改动）
assets/stepchan_q_v1/             Q 版重绘、分层素材、配准报告、QA 拼版
apps/web/public/rig/              构建时从上面复制的运行期副本
docs/images/                      README 配图（由上述素材合成）
apps/desktop/src-tauri/icons/     应用图标
```

阶跃星辰**已许可这些素材随本项目一同分发与使用**。也就是说：

- ✅ clone 本仓库、构建、自己使用，带着素材一起
- ✅ fork 本仓库继续开发这个桌宠，带着素材一起
- ✅ 从 Releases 下载安装包使用
- ❌ 把该角色或其素材用到**其他**产品、服务、周边、商业宣传里
- ❌ 以该角色形象对外提供商品或服务
- ❌ 把素材单独抽出来再分发为素材包

超出「使用本项目」范围的用途，请另行向阶跃星辰取得许可。

Q 版是用 `gpt-image-2` 从公司原始立绘派生的（见 `assets/stepchan_q_v1/rig.json` 的
`source.model`）。它是上述角色的衍生作品 —— **由模型生成不改变底层角色的归属**。

## 三、商标

Apache License 2.0 **第 6 条明确不授予商标许可**，这不是疏漏而是该许可证的设计。

「阶跃星辰」「StepFun」「阶跃娘」「Step酱」以及那枚 Z 字标都是阶跃星辰的商标。
本仓库采用开源许可这一事实，**不构成**对这些商标的任何许可 —— 特别是：

- 不能用它们给你自己的产品、服务或组织做标识
- 不能用它们暗示你的衍生项目获得了阶跃星辰的背书或官方认可
- fork 之后如果要对外发布，建议换掉名称与标识

## 四、如果你只想要代码

想拿这套工程实现接自己的角色，把这两处换掉就行：

1. `assets/<你的角色>/` 下按 `shared/pet.ts` 的 `rigManifestSchema` 准备素材，
   或者直接跑 `tools/art/` 的流水线从你自己的立绘生成
2. `scripts/sync-rig.mjs` 指向新目录

这样产物里就不含任何阶跃星辰的素材与商标，只受 Apache-2.0 约束。

## 五、第三方依赖

Tauri、React、PixiJS 及各 Rust crate 各自适用其自身许可，
见 `package.json`、`apps/desktop/src-tauri/Cargo.toml` 与各依赖的授权文件。
