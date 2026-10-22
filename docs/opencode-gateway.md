# OpenCode 免费网关诊断

核实日期：2026-10-20。

## 区分访问限制与请求格式错误

- `ip_blocked`：网关明确报告出口 IP 被标记。修改工具、系统提示词或请求格式不能保证解除服务端标记。
- `client_restricted`：网关返回 `FreeTierError` 或明确要求从 OpenCode 使用免费模型。
- `region_restricted`：网关返回 `RegionError` 或明确报告模型在当前地区不可用。

这些结果统一返回 `kind: provider-policy`、`retryable: false`，保留提供商原文和已提供的 HTTP 状态码。HTTP 错误、HTTP 200 内的 JSON/SSE 错误、非流式 SSE 聚合都遵循同一规则。共享 Agent 不会为这些限制修复或截断上下文、退回非流式重试；普通限流和暂时性网络错误继续按现有策略处理。不会自动切换到收费模型。

## 已知边界

[OpenCode 的公开报告](https://github.com/anomalyco/opencode/issues/56916)中，官方客户端用户也遇到 IP 层的免费模型限制。项目机器人回复称该标记由网关处理，需要团队复核，并给出 `help@anoma.ly` 联系方式。这是公开报告及机器人回复，不代表已独立查明特定用户 IP 被标记的原因。

[OpenCode Server 文档](https://opencode.ai/docs/server/)提供官方运行时、HTTP/OpenAPI 和 SDK 集成路径。接入运行时本身不保证某个免费模型可用，也不解除网关的网络、地区或客户端使用限制。

本次验证只访问公开资料并使用本地 HTTP/SSE 测试夹具，没有针对线上风控发起探测，也没有改变代理、Tor、请求工具或身份配置。
