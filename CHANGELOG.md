# 更新日志

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

<!--
在此处记录尚未发布的变更。
格式示例：

### 变更 Added
- 新增 xxx

### 修复 Fixed
- 修复 xxx
-->

## [1.0.0] - 2026-10-04

首个公开版本。功能范围与 `dsh-language-control` 对齐（向系统提示词注入语言约束，
并挂一条运行时 context 对抗语言漂移），但重新做了工程实现。

### 新增 Added

- **语言约束注入**：通过 `systemPrompt.section()` 注册语言约束，`text` 以函数形式
  提供、每次模型请求前重新求值；order 默认 `-200`，落在 harness identity 之后、
  deployment persona 之前。
- **强化 context**：默认额外注册一条运行时 context（order `-199`）。它会作为
  运行时快照进入会话历史，是**防语言漂移的主力**。
- **4 个内置预设**：`zh-think-answer`（默认）、`zh-think-only`、`zh-strict`、
  `en-think-answer`。
- **`extraSections` 扩展点**：可在不改代码的前提下额外注入任意 section（术语表、
  项目约定等）。
- **能力探测 + 双注册路径**：优先走官方注册表；`section()` 不可用或被拒时自动
  退到 `system-prompt/assemble` 瀑布钩子；两条都不可用时只记一条 error 日志，
  **绝不抛出、不影响宿主启动**。
- **`interpolate` 字段的降级重试**：宿主若对 `PromptSection` 做严格键校验而拒绝
  `interpolate` 字段，插件会自动省略该字段整体重试一次，避免为了一个可选字段
  掉进兜底路径导致 order 失控。
- **配置校验与自诊断**：`order` 非有限数、同层重名、类型不符、纯空白文本、
  `{{` 插值风险、未知预设等，全部在注册前拦截并记入启动日志。

### 安全 Security

- 配置输入设有规模上限（`text` 8192 字符、`reinforceText` 与单项扩展 4096 字符、
  扩展项 32 条、启动 issue 逐条 20 条），超限回退默认而非静默接受。
- **日志净化**：所有日志消息压为单行并剥离 ANSI 控制序列，防止含换行/转义序列的
  配置值伪造出额外的日志行。
- 提示词文本不会被宿主当模板插值：能力探测确认宿主支持时显式传
  `interpolate: false`；context 类型无此逃生通道，故其插值风险单独以 error 级
  提示。

### 文档 Documentation

- 记录并适配 `@deepseek-ai/dsh-system-prompt` 0.1.x 与 0.2.x 之间的 API 漂移
  （persona 段拆分为 prefix/suffix、harness identity 位置变更、`interpolate`
  与 `getSectionOrder()` 为 0.2 新增）。

### 工程 Engineering

- **零运行时依赖**：不 import 任何模块，不声明 `dependencies` /
  `peerDependencies` / `engines`，以消除跨宿主版本的解析面。
- 76 项单元测试（模拟宿主）+ 14 项集成测试（驱动官方 `dsh-system-prompt`
  真实实现），全部通过。

[未发布]: https://github.com/Xin-kon/dsh-lang-guard/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Xin-kon/dsh-lang-guard/releases/tag/v1.0.0
