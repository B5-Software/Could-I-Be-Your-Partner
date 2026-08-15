# DeepSeek 兼容层总体设计

## 目标

在 **不改变 CIBYP 自有 Agent 逻辑** 的前提下，让 CIBYP：

1. 完全兼容 DeepSeek Harness 插件生态（名称/实现翻译层）。
2. 借鉴 DeepSeek Harness 的沙箱架构（设置新增「沙箱」标签页）。
3. 重构工具页为两级分组视图（主界面表格 + 模态下钻），DeepSeek 导入工具单独分组。
4. 保持提示词前缀缓存友好（会话级冻结 + 追加式重优化）。
5. 重构长对话上下文压缩（真实计量 + 水位线 + 结构化 checkpoint + 缓存友好摘要请求）。

## 红线（防"夺舍"）

- CIBYP 的 agent 循环、系统提示词组装、会话管理、UI 一律保留自研实现。
- **不使用** dsh 的 `agent`、`agent-loop`、`system-prompt`、`session`、`web/web-app`、`preset`、`acp`。
- Cordis 内核与 `dsh-tools` 注册表仅作为 **库（lib）** 使用；Provider/执行逻辑全部自研。

## 模块划分

| 文档 | 模块 | 落点 |
|---|---|---|
| [01-plugin-compat.md](01-plugin-compat.md) | 插件兼容层 + 翻译器 + 插件管理 | `src/main/ds-compat/`、`src/renderer/js/ds-compat/`、设置「插件」页 |
| [02-sandbox.md](02-sandbox.md) | 沙箱运行器 + 设置页 | `src/main/sandbox-runner.js`、设置「沙箱」页 |
| [03-tools-page.md](03-tools-page.md) | 工具页两级重构 | `app-parts/06-*`、`pages/index.html` |
| [04-prompt-cache.md](04-prompt-cache.md) | 前缀缓存纪律 | `agent.js`、`context-manager.js`、`tools-def.js` |
| [05-context-compaction.md](05-context-compaction.md) | 上下文压缩重构 | `context-manager.js`、`agent.js`、`main.js` |

## 依赖与版本

- `@deepseek-ai/cordis`（npm，MIT）作为插件内核 lib；锁精确版本。
- `@deepseek-ai/dsh-tools` + `@deepseek-ai/schemastery` 作为工具注册表/配置 schema 契约 lib。
- 沙箱后端：macOS 用系统自带 `sandbox-exec`（Seatbelt）；Linux 优先 `bwrap`、缺失时 Landlock；Windows 用受限令牌 ACL 的 native 预编译后端 `assets/sandbox/win/cibyp-sandbox.exe`（MinGW-w64 编译，`win.extraResources` 仅 Windows 包带出）。

## 提交纪律

- `src/renderer/js/app.js` 是 `scripts/build-app-bundle.js` 的产物，**绝不手改**；只改 `app-parts/*` 后运行 `npm run build-app-bundle`。
- 每阶段跑 `npm test`；提交信息遵循仓库既有风格（feat/fix/refactor + 中文说明）。
