# DeepSeek 插件兼容运行时

CIBYP 使用真实 Cordis 服务内核，并为部分插件能力提供自己的 Agent、会话、审批、文件与 Shell 适配器。
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

宿主和 VM 部署使用同一组工具 SDK 与公共辅助包，并暴露工具 schema、testing 和类型子路径。
依赖缺失、配置不合法和加载失败会显示为兼容性问题。
这不等于运行完整 Harness：自带 TUI、Web 服务或要求未桥接服务的插件仍可能不兼容。
插件调用本机文件或 Shell 的能力在 VM 模式下由 VM 中的运行时执行。

## 2026-10-08 兼容性核查

结论：目前适合主要通过 `ctx.tools` 注册工具的插件，不能宣称兼容全部 Harness 插件。依赖注入成功、插件安装成功或工具标签显示 `native`，都不代表所依赖的服务已完整实现。没有覆盖插件生态的测试样本，因此不提供“兼容百分比”。

核查基线是本仓库 `1.9.0-alpha.25` 的实现、锁定的 npm 预览 SDK，以及上游源码提交 [`5badb150`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)。npm 的 `alpha` 通道为 `0.2.1-alpha.1`，`@deepseek-ai/dsh` 的 `latest` / `next` 为 `0.2.0-rc.2`；不能仅根据 `latest` 标签判断是否已使用最新预览 API。后续上游修改仍需重新核查。

| 能力 | 当前实现与限制 |
| --- | --- |
| Cordis、插件加载与工具链 | 使用真实服务内核；支持 ESM / CJS、配置校验、工具注册、参数与输出校验、执行钩子、guard、卸载清理、超时与取消。已有自动回归覆盖。 |
| 文件与 Shell | 提供基础读取和一次性命令执行，但不等同于上游文件目标、版本、写入、监听及 Shell 进程句柄。上游 Shell 合约要求 `execute()`，当前桥主要是 `run()`，依赖新接口的插件会失败。 |
| Agent 与会话 | 创建、恢复、发送、停止已连接共享后台；Agent 列表和状态形状仍不同。会话事件与 inbox 是局部对象，缺少权威事件重放和完整队列语义；`sessions.fork()` 只做浅拷贝，`whenIdle` 超时后仍会返回。 |
| LLM | 提供非流式 `chat()` 桥；没有上游 `stream()`、完整分块事件、适配器注册与取消语义，不能替代完整 LLM 服务。订阅等 Provider 路径也需要单独验证。 |
| 提示词与技能 | 插件提示词 section 只收集到数组，尚未接入实际 Agent 提示词装配；技能清单与读取可桥接，插件 `skills.register()` 当前不生效。 |
| 设置、任务与持久化服务 | `settings.get()` 返回空对象，更新会报未桥接；`subprocess`、`jobs`、`subagent`、`session`、`storage`、`compaction` 只有服务名称，没有功能实现。 |
| 插件界面与 HTTP 面板 | `webServer.register()` 不挂载路由；依赖 Harness 自带 TUI / Web 界面的插件没有对应界面适配。 |
| VM 插件宿主 | 每次工具调用新建并销毁 PluginHost，未注入主机的 Agent transport、设置与技能 provider。纯工具可执行，但服务访问和跨调用状态不能等同于主机宿主。 |

证据入口：[`plugin-host.js`](../src/main/ds-compat/plugin-host.js)、[`services.js`](../src/main/ds-compat/services.js)、[`guest-tool-worker.js`](../src/main/vm/guest-tool-worker.js)。上游以独立的服务定义、Provider 和 Consumer 组成运行时，完整插件支持需要匹配这些合约，见 [上游包与服务说明](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/README.md)。

## 距离完整支持的主要工作

1. 建立服务合约测试和真实插件测试矩阵。未实现的方法应明确拒绝，避免空返回或 no-op 让插件看似正常却没有效果。
2. 将 Agent、会话、事件重放、inbox、fork 与后台持久化对齐；实现任务、子 Agent、存储及压缩服务。
3. 对齐文件目标与修改语义、Shell 执行与进程生命周期、LLM 流式事件和 Provider 接口。
4. 将插件提示词、技能注册、设置与审批接入真实能力，保持设置隐私与 CIBYP 权限边界。
5. 为 VM 提供明确的服务转发和可持续的插件生命周期；为 TUI / HTTP 面板插件提供单独的前端适配。

这几项包含后台服务和前端适配工作，仅升级 SDK 或补充包名别名无法解决。即使工具插件支持完善，也不能保证能够直接替换 Harness 的整个 Agent 循环或界面。

本次离线验证中，`tests/unit/deepseek-runtime.test.cjs` 的 5 项测试全部通过，覆盖工具定义与生命周期、异步归属、超时取消、非协作插件及 SDK 子路径。这些是运行时测试，并非所有第三方插件的认证。VM worker 构建另有 `tests/unit/guest-tool-worker.test.cjs` 回归；应与具体插件的主机 / VM 端到端测试一起执行。

验证入口：`tests/unit/deepseek-runtime.test.cjs`。
上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
