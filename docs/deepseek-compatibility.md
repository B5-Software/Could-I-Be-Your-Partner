# DeepSeek 插件兼容运行时

CIBYP 使用真实 Cordis 服务内核，并将插件能力桥接到自己的 Agent、会话、审批、文件与 Shell 服务。
当前锁定 `@deepseek-ai/cordis 4.0.5-alpha.1`、`schemastery 3.18.5-alpha.1`，
以及 Harness `0.2.1-alpha.1` 的工具定义、参数校验、SDK 生成和公共辅助包。
这些是当前预览版本，锁定精确版本以避免上游更新静默改变插件行为。

工具 API 复用上游 MIT 实现的纯逻辑；原始许可证和来源记录保留在
`src/main/ds-compat/shims/dsh-tools/upstream`。同时接受旧版工具参数定义。
支持嵌套结构、必填参数、整数、枚举、联合类型和 JSON 值，工具输出也按定义进行校验。

工具执行支持 `tools/pre-execute`、`tools/execute`、`tools/post-execute`、
`tools/result`、注册的 guard、输出渲染及 `finalizeContent`。
插件生命周期清理自己的工具和 guard；异步加载不会把工具归属到另一个插件。
工具超时、调用取消和卸载会触发 AbortSignal。即使插件忽略取消，调用方也会及时收到失败，
非并发工具在上一轮实际结束前拒绝重复执行；观察者挂起也不会阻塞返回。

宿主和 VM 部署使用同一组工具与公共辅助包，并暴露工具 schema、testing 和类型子路径。
依赖缺失、配置不合法和加载失败会显示为兼容性问题。
这不等于运行完整 Harness：自带 TUI、Web 服务或要求未桥接服务的插件仍可能不兼容。
插件调用本机文件或 Shell 的能力在 VM 模式下由 VM 中的运行时执行。

验证入口：`tests/unit/deepseek-runtime.test.cjs`。
上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
