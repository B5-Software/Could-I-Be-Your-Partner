# 前缀缓存纪律

## 事实

- DeepSeek 按输入前缀逐字节匹配；命中价约为未命中 1/10~1/120。
- tools 定义位于缓存前缀内；任意位置改一个字节，其后全部失效。

## 规则

1. **会话级冻结**：会话开始对 `[systemPrompt 稳定段, tools schema]` 快照；会话内变更（插件/MCP/技能/工具开关）默认下会话生效。
2. **稳定序列化**：schema key 固定顺序、工具按规范顺序、无时间戳/随机值。
3. **追加式重优化**：`__reoptimizeToolSelection` 只把新工具**追加**到 tools 尾部（不删不重排）；`__disableAutoOptimize` 追加补全剩余工具。
4. **追加不改头**：会话中注入内容放 messages 尾部，不动 system/tools。
5. **翻译器不重复 schema**：dsh 别名只在 executeTool 入口解析。
6. **压缩字节冻结**：checkpoint/被压缩内容落定后永不改写。

## 验证

单测断言"同一会话连续两轮请求的 system+tools 字节前缀一致"；重优化断言"原工具保持原序、仅尾部追加"。
