# 插件兼容层 + 翻译器

## 架构（核心当 lib）

三层，自上而下：

1. **内核 lib**：`@deepseek-ai/cordis`（Context/Service/inject/effect/事件）。插件 `apply(ctx)` 跑在 Cordis 上下文上。
2. **契约 lib**：`@deepseek-ai/dsh-tools`（`defineTool`/注册表/参数校验/output.render/presentationMeta）、`@deepseek-ai/schemastery`（Config）。
3. **Provider 自研**：`ctx.tools` 背后的执行环境桥接 CIBYP 的 `executeTool`/IPC；`ctx.skills`/`ctx.settings`/`ctx.sandbox` 接 CIBYP 现有实现。

若 npm 安装 `@deepseek-ai/*` 失败（离线/代理），回退：`ds-compat/mini-context.js` 自实现最小 Context（`inject`/`effect`/`on` 语义）与 `defineTool`，保持插件源码不变。回退模式在 `pluginRegistry.backend = 'mini'` 标注。

## 翻译器 `src/renderer/js/ds-compat/translator.js`

纯函数，主/渲染进程共用：

- `DS_TO_CIBYP_TOOL`：dsh 标准工具名 → CIBYP 工具名映射表（read_file→readFile、bash→runShellScriptCode、web_search→webSearch、todo_write→todoList、skill→activateSkill、task→runSubAgent 等）。
- `adaptArgs(dsName, args)` / `adaptResult(dsName, cibypResult)`：参数与结果适配。
- `resolveAlias(name)`：executeTool 入口别名解析（模型表面只暴露一个规范名）。

## 插件清单 `plugins.json`（用户数据目录）

```json
{ "plugins": [ { "id", "name", "version", "source", "bundlePatch", "config", "enabled", "compatTier", "compatIssues", "tools": ["..."] } ] }
```

三档兼容：`native`（标准工具/技能/设置插件）/ `translated`（映射到 CIBYP 实现）/ `declared`（仅 schema，执行报不支持）。

## 插件管理页

- 安装：本地目录 / npm 名 / GitHub URL / tgz；安装需确认。
- 启停/卸载/更新；启用变更 **下个会话生效**（缓存冻结纪律），UI 明示。
- 配置表单：Schemastery schema → JSON Schema → 轻量自研渲染器。
- 安全：插件为受信代码（与 dsh 同模型）；默认禁用；子进程走沙箱。
