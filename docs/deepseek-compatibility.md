# DeepSeek 插件兼容运行时

CIBYP 使用真实 Cordis 内核和 DeepSeek Harness 的能力 SDK，将插件接口转换为自己的后台服务。插件可以提供工具、技能、提示词、任务和会话能力；Agent 循环、模型账号与消费控制、应用启动和各前端继续由 CIBYP 管理，不加载 Harness 的应用或 AgentLoop。

当前锁定 Cordis `4.0.5-alpha.1`、Schemastery `3.18.5-alpha.1` 和能力 SDK `0.2.1-alpha.1`。合约核查对应上游提交 [`5badb150`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)。工具定义、校验和生成器保留 MIT 上游实现与来源记录，位于 `src/main/ds-compat/shims/dsh-tools/upstream`。上游变化需要重新测试，不按包名或“安装成功”判断兼容性。

## 已实现的能力

| 能力                  | 实现与边界                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 加载、配置与生命周期  | ESM / CJS、真实依赖注入、Schema 配置校验、异步注册归属、卸载与失败清理。禁用插件不在启动重审时执行；未知服务明确报错。                                                                                                 |
| 工具                  | 上游参数与输出合约，旧版定义兼容，pre / around / post / result 钩子、guard、渲染与 finalizeContent、并发限制、取消与超时。模型边界使用插件命名空间，SDK 内保持原工具名。非协作任务仍运行时不会重复启动同一非并发工具。 |
| 文件                  | 目标路径解析、版本检查、文本与字节范围读取、目录、监听、写入与编辑、CRLF 保留。写入遵守 CIBYP 的沙箱策略，插件传入的策略不能放宽它。                                                                                   |
| Shell、进程与终端     | 原生 execute 合约、后台句柄、stdin、状态与取消、输出尾部与溢出文件、持久 PTY；Shell 设置在创建终端时读取。持久终端支持 Bash 系 Shell 与 PowerShell，其他方言明确拒绝。                                                 |
| Agent 与会话          | 原生 Registry / SessionStore 接口，事件日志与重放、inbox、followup / steer / stop、等待空闲、带继承切点的 fork、创建与恢复。只清理插件拥有的子会话；创建失败回滚，不认领现有前端会话。CIBYP 驱动实际模型循环。         |
| 提示词与技能          | 原生 SystemPrompt / SkillRegistry、section 与上下文装配、技能 provider 和插件注册。动态贡献仅作用于请求，不覆盖聊天历史；标题等辅助请求不消费 Agent inbox。                                                            |
| LLM                   | 原生流式合约、文本 / 推理 / 工具调用事件、用量与取消。请求转发 CIBYP 主机的 Provider 路由，复用账号、预算、重试和订阅适配；不启动第二套账号或模型后台。                                                                |
| 设置与存储            | 插件配置命名空间、秘密字段默认脱敏、版本冲突检测、校验后持久化、变更通知；真实 Storage / JSON / Domain 存储。插件设置接口不开放任意全局设置写入。                                                                      |
| 任务、子 Agent 与压缩 | 原生 Jobs、Commands 与子 Agent provider；子 Agent 使用共享后台。压缩委托 CIBYP，生成 SDK checkpoint，保留 CIBYP 的聊天记录。任意 DS 消息范围压缩不支持。                                                               |
| 审批与问卷            | 连接 CIBYP 后台，复用前端交互和沙箱策略，支持多选与自定义答案、取消。                                                                                                                                                  |
| 其他能力              | SessionQuery / projections、附件本地存储、TokenMeter、Workspace Registry、LSP 转发到 CIBYP 的编辑器桥。能力未连接时明确失败，不返回伪成功。                                                                            |
| 插件 HTTP 路由        | 原生 WebServer 挂载路由，使用单独的 loopback 载体，生命周期跟随插件宿主；旧版 webRuntime 只暴露只读部署信息。不能替换共享后台监听器。                                                                                  |
| VM                    | 常驻 worker 保留跨调用状态、服务与生命周期；复用同一 SDK 身份。文件 / Shell 留在 VM，LLM 与网络能力转发主机。转换明确的目录参数与配置，不改写命令或正文。                                                              |

## 仍有边界

- Harness 自带 TUI、React / Web 客户端组件、完整应用入口、私有 UI store 没有自动转换为 CIBYP 界面。它们的后端能力可单独适配，不能直接接管界面。会话导出插件的 HTTP 导出已测试，其 Harness 顶栏按钮没有迁移。
- 子 Agent provider 不支持 DS 的 persona、toolFilter、outputSchema 和跨调用 continuation；不能把这些选项当作已实现。浏览器 / computer-use 等未挂载的 DS 服务需要额外适配。
- 部分 SDK 深层子路径、插件自带原生模块、平台专用依赖和自定义 Provider 需要具体测试；包根入口可用不代表所有内部模块可用。
- Commands 注册与调用已提供，插件命令尚未自动加入各前端的斜杠菜单。仅在运行时创建的动态工具还需要补齐前端目录刷新。
- 工具 guard 的验证覆盖 DS 工具链，不表示同一个钩子已经保护 CIBYP 所有内置工具。第三方 Git 插件的 amend 拦截通过测试，不构成所有破坏性 Git 操作的安全保证。
- SDK 事件日志是 CIBYP 对话的适配视图。完整时序 chunk、全部加密推理扩展及 CIBYP 自动压缩后的投影仍需要进一步对齐。它不是用于覆盖聊天记录的权威副本。
- 同进程 JavaScript 插件属于可信代码扩展。接口权限与入口限制不是恶意代码隔离沙箱，插件仍可能直接使用 Node.js API。来源审查、固定版本和独立测试不能证明代码绝对无恶意。
- Windows 持久终端优先使用 node-pty 自带 ConPTY DLL；缺少 DLL 的重编译安装回退系统后端。本机回退测试能正常关闭进程，但上游控制台清理助手仍可能打印 `AttachConsole failed`。这条兼容诊断尚未完全消除。

因此不宣称“全部插件完美兼容”，也不根据少量样本给出兼容百分比。可用范围由服务合约与具体插件测试决定。

## 验证与复现

运行 `npm run test:unit`、`npm run test:legacy`。DeepSeek 专项覆盖原生工具与钩子、文件版本和沙箱、Shell 取消、持久终端、配置脱敏、模型流、队列 / fork / 日志、官方文件 / Bash / Jobs / 问卷 / Todo / 会话查询 / LSP 插件，以及部署后的常驻 worker。

第三方测试见 [固定版本插件实测报告](deepseek-plugin-tests.md)。`npm run test:ds-thirdparty` 是显式启用的本地测试，不自动下载插件、不运行第三方安装脚本、不读取真实账号或聊天记录。另提供 `npm run test:ds-vm -- "<VM 资源目录>" "<完整镜像版本>"`：使用独立覆盖磁盘测试生产 SSH 部署和 VM 路由。已在完整镜像 `2026.10.01`、Linux / Node.js `20.19.2` 上通过 12 项，包括第三方插件、官方文件 / Bash / Jobs、持久 PTY 与取消、主机模型桥及 HTTP 卸载；不涉及真实 Provider 账号验证。

主要实现入口：`src/main/ds-compat/plugin-host.js`、`service-setup.js`、`agents.js`、`src/main/vm/plugin-runtime-client.js`。上游服务组织见 [包与服务说明](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/README.md)。
