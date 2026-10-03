# 网络搜索与网页读取

设置 → 网络搜索可选择 Bing、Exa、Parallel、TinyFish 或 Fusion。Fusion 并行查询可用引擎，按查询相关性、排名与来源一致性排序，移除重复 URL；不额外调用语言模型。部分服务失败时仍返回其他来源，并列出失败来源。Bing 只提取结果条目，页面导航、天气等附属模块不再混入搜索结果。

Exa、Parallel 和 TinyFish 的默认连接沿用 OpenCode 公开实现中的免登录 MCP 协议。各引擎也能配置自己的 Provider、Endpoint、API Key 和 MCP 工具名；支持 MCP、Exa、Parallel、TinyFish、Tavily、Brave 和 SearXNG 等协议。密钥保存在设置中，不需要放进 Agent 的工具参数。免登录服务的配额与可用性由提供方控制。

实现依据：[OpenCode Exa](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/plugin/websearch/exa.ts)、[Parallel](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/plugin/websearch/parallel.ts)、[TinyFish](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/plugin/websearch/tinyfish.ts)。TinyFish 默认使用 `https://agent.tinyfish.ai/mcp` 的 `search` 工具和 `X-TinyFish-Access-Mode: keyless`；填写自己的密钥后使用 `X-API-Key`。

VM 模式下搜索和网页请求通过 VM 内的 Node 执行。Bing 浏览器查询也在 VM 内运行；不会在 VM 不可用时偷偷切回宿主。

## 控制上下文大小

`webSearch` 默认返回 8 条结果，每条摘要最多 500 字符；`webFetch` 默认返回 6000 字符的正文。二者保留完整快照并返回 `ref`、总长度和下一页位置，Agent 可以继续读取，不需要重新请求或猜测被截断的内容。

```json
{"query":"查询内容","engine":"fusion","numResults":8,"snippetChars":500}
{"ref":"搜索返回的 ref","resultOffset":8,"numResults":8}
{"ref":"搜索返回的 ref","includeContent":true,"offset":0,"maxChars":6000}
{"url":"https://example.com","format":"markdown","maxChars":6000}
{"ref":"网页返回的 ref","offset":6000,"maxChars":6000}
```

`maxChars: 0` 读取整个快照；`snippetChars: 0` 返回完整摘要。`webFetch` 支持 `markdown`、`text` 和 `html`，并可设置 `maxBytes` 调整网络读取上限；超过限制会明确报错，不会静默丢弃后文。刷新页面用 `refresh: true`。

快照在进程内保留 30 分钟，并受数量与总内存限制；同一 URL 的读取缓存 5 分钟。过期引用明确报错，需要重新查询。调用方应优先分页读取，确实需要完整内容时再指定不限制字符。
