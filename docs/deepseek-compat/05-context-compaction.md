# 上下文压缩重构

## 现状根因

1. token 估算漏算 tools schema（270+ 工具 ≈ 数万 token）→ 触发阈值系统性低估。
2. 固定百分比阈值（70/85/95）不按模型窗口路由。
3. `lightTrim` 每次追加消息就截断工具结果 → 工作视图被破坏。
4. 按"消息条数"切历史 → 拆散 tool 调用/结果配对。
5. 摘要冷请求 + 扁平文本 + 弱指令 → 丢结构/文件/代码/决策。
6. 摘要塞 system 头 → 全前缀失效；无字节冻结。
7. 无 shrink 验证/重试/溢出恢复/持久锁。

## 目标设计（借鉴 dsh，自研实现）

- **计量**：tiktoken 近似 + API 真实 `prompt_tokens` 滑动校准；预算 = system + tools + messages + 输出预留。
- **水位线**：step 边界测压；阈值 = 模型窗口 × ratio（默认 0.80 触发 / 0.16 保留尾巴），支持 per-model 覆盖。
- **Tier0 无模型剪枝**：超大的**旧**工具结果确定性截断；回落后不调 LLM。
- **Tier1 结构化摘要**：切点对齐 tool 配对；摘要请求**复用当前会话 system+tools+被压缩区消息原样回放**（命中暖前缀），末尾追加压缩指令；输出八段式 Markdown（Primary Request / Key Concepts / Files & Code / Errors & Fixes / Pending Jobs / Current Work / Next Step / Critical Context）。
- **checkpoint 替换 head 范围**：一条 user 消息（`<compacted-summary>` + 前言）替换最老区间；落定后字节冻结；后续压缩合并更早 head。
- **收敛**：摘要必须短于源；`compactionRetries`；失败保持原状。
- **Tier2 溢出恢复**：捕获 provider 400 context overflow → 旁路容量直接最大 head 缩减后重试；`compaction/start…end` 持久锁防并发/孤儿。
- **摘要模型可配置**（默认同主模型）；只取 content。

## 管理入口

保留 `manageContext` 工具（语义更新）；设置新增「上下文压缩」组；新增手动压缩按钮（idle 执行）。
