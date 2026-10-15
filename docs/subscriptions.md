# 订阅账号与用量

## Claude Pro / Max

设置 → 模型与连接 → Claude Pro / Max 账号，点击“使用 Claude 登录”，在主机浏览器中完成官方授权，然后选择模型并点击“添加并设为默认”。可以保存多个独立账号、切换、重新授权和注销。TUI 使用 `/claude login`，完成后 `/claude model` 选择模型；`/claude` 选择账号，`/claude logout` 注销。无本机浏览器时，登录地址会显示在 TUI，必要时使用 `/claude code 授权码` 完成官方客户端的手动流程，授权码不进入输入历史。

此连接使用官方 `@anthropic-ai/claude-agent-sdk` 及其平台原生运行时，通过 `auth login --claudeai` 选择订阅认证。默认随应用携带对应平台运行时；省略 npm optional dependencies 的安装需要补装它们，或用绝对路径 `CIBYP_CLAUDE_BINARY` 指定兼容的官方客户端。每个账号使用 CIBYP 数据目录下独立的 `claude-accounts/<ID>` 配置目录，认证凭据由官方客户端管理，不读取其他应用的凭据。Pro / Max 身份以官方 `auth status` 为准，不接受 API Key / Console / 第三方云平台认证。

所有模型与登录请求都在主机执行。SDK 每次只运行一轮，模型提出的工具调用返回 CIBYP 原有 Agent 循环，由 CIBYP 执行权限审批及宿主 / VM 工具路由。SDK 自带工具、其他 MCP 配置、项目配置和独立历史持久化关闭；历史及工具结果以角色标注的上下文传入，每次调用重新构造上下文，压缩继续由 CIBYP 负责。图片使用原生图片块传递，历史中的 Base64 图片不会变成正文 Token。停止、超时、切换账号和注销均取消对应 SDK 请求。该适配不是通用 Anthropic HTTP API：温度等 SDK 未提供的 API 参数不可保证生效，输出上限经官方环境变量传递。

不会自动改走 API Key、Console 或云平台计费，也不会主动开启 Claude 额外用量。Claude 账号已经启用的额外用量仍由其服务端设置决定；需要严格避免额外消费时，在 Claude 用量页关闭额外用量。订阅请求记录 Token 和 API 等效参考消费，不把参考价格计作实际 API 支出。官方 SDK 响应提供的五小时 / 周额度事件会更新共享指示器；没有返回的额度保持不可用，界面提供 Claude 用量管理入口，不猜测限额。

官方说明目前有差异：[帮助页 2026-10-07 更新](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)提及 SDK / 第三方应用的订阅限额；[SDK 文档](https://code.claude.com/docs/en/agent-sdk/overview)仍要求第三方产品提供 Claude 登录需预先获批。此实现采用官方运行时、不伪装 HTTP 客户端，不代表 Anthropic 已单独批准 CIBYP；服务端的访问与额度判定仍为最终结果。

隔离模拟授权、真实 SDK 工具定义、完整 GUI → IPC → SDK 适配链路及原生运行时初始化均已验证。没有使用真实 Pro / Max 账号消耗额度；真实账号需由账号持有人通过界面完成授权和验证。

## ChatGPT / Codex

在设置 → 模型与连接登录自己的 ChatGPT 账号。授权采用官方 Sign in with ChatGPT 流程：浏览器登录、PKCE、本地回调和身份签名验证；账号可切换、注销。账号凭据保存在独立本地存储，Windows 使用当前用户 DPAPI，Unix 使用仅当前用户可读的文件。不会导入其他应用的登录凭据。

订阅模型使用官方固定 Responses 地址，流式请求且不保存服务端记录。模型池的其他 Provider 可选择自动识别 API 格式；连接测试只在明确的协议不兼容响应下尝试其他格式，鉴权、额度和连接错误不会反复切换协议。格式测试会产生少量 Token 用量。

## 价格与进度条

价格从 models.dev 按渠道匹配，不借用另一渠道的价格。设置中的价格表逐字段覆盖自动值：留空继承、0 表示免费、删除条目恢复自动价格。没有价格的请求只记录 Token，不把未知消费显示成免费。

ChatGPT/Codex、OpenCode Go 按订阅额度计量；API 等效消费只是参考估算，不计入实际 API 美元消费。预算中的 Token 限制仍可使用。

设置 → 消费与用量上限可选择进度条显示：API 等效消费、5 小时限额、周限额、月限额、当前最紧迫限额。GUI/Code/WebUI 共用这些数据与偏好；TUI 通过 `/usage` 按需显示全部可用窗口、重置时间和参考消费，不常驻额度条，也不在空闲时轮询额度。不存在的窗口显示不可用。

OpenCode Go 从其已发布的 `/zen/go/v1/usage` 接口读取 5 小时、周和月窗口。需要实际 Go Key；Zen 免费访问不能提供 Go 订阅额度。

Codex 额度通过官方 Codex CLI 的 `app-server` 读取，采用独立临时配置目录与当前授权账号。需安装官方 CLI，或设置 `CIBYP_CODEX_BINARY`。官方登录若没有返回可验证的 Codex 账号标识，则不能读取原生额度：界面会提示不可用，并提供 ChatGPT 用量页面入口。不会从邮箱、用户 ID 或其他应用的授权数据猜测账号标识。

## 额度重置卡

仅 GUI 设置页提供手动入口。先刷新服务端卡片状态，再显示使用按钮；点击后还须在系统确认框二次确认，默认取消。账号发生切换、卡片过期或没有可用卡片时拒绝执行。Agent、TUI 和 WebUI 没有消耗卡片的工具入口。失败后不会自动重试消耗操作；手动重试复用请求标识以防重复消费。

## 验证范围

登录、安全存储、模型解析、额度协议、取消、账号切换、手动确认和价格覆盖已通过隔离配置及模拟服务验证。没有使用用户的真实付费账号消耗额度或重置卡；真实订阅登录与卡片操作仍需由账号持有人执行。SIWC 通道目前不支持服务端输出 Token 上限，界面会明确说明。

Zen 免费模型采用渠道元数据和保守安全窗口，而不直接套用模型的上游最大上下文。安全窗口不是所有免费模型的官方统一承诺。模型列表可能包含已下线条目，连接测试会识别不可用模型，支持重试和重新选择。

参考：[OpenAI SIWC](https://developers.openai.com/siwc/)、[OpenCode Go](https://opencode.ai/docs/go/)、[Go 用量接口源码](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts)。
