# 06 · DeepSeek 服务 API → CIBYP 功能翻译层

为了让真实 DSH 插件不只是“能注册工具”，CIBYP 提供一套**服务表面兼容、底层 CIBYP 实现**
的翻译层（`src/main/ds-compat/services.js`）。不照搬 deepseek-harness 的会话/LLM 引擎，
只镜像插件生态常用 seam 的形状，真实能力全部对接 CIBYP 已有功能。

## seam 映射

| DSH 服务 | 名称 | CIBYP 实现 |
| --- | --- | --- |
| `agents` | AgentRegistry | 渲染进程 SessionManager 会话（IPC 同步元数据） |
| `sessions` | session store | 同上注册表，暴露 `header.cwd/title/mode` |
| `llm` | LlmRuntime | `main/llm-retry.js` 带重试管线 + `llm-providers` 解析 |
| `sandboxPolicy` | sandbox policy | CIBYP 设置中的沙箱模式（默认/Chat/Code/Babe 覆盖） |
| `approval` | ApprovalService | 渲染进程授权模态框（IPC 往返，等待裁决） |
| `fs` / `shell` | 只读 fs + 一次性 shell | 主进程 `fs/promises` + `spawn`（含超时/取消/输出上限） |
| `skills` | skill catalog | CIBYP 内置 + 用户技能清单（惰性 provider） |
| `systemPrompt` | 提示词节 | 收集器（尚未接入渲染层提示词装配） |

仍为占位 stub 的 seam：`subprocess`、`jobs`、`subagent`、`session`（单数）、`storage`、
`compaction`、`webServer`（插件自带 HTTP 面板不接入 CIBYP WebUI）。

## 数据流

1. 渲染进程会话创建/状态变化 → `window.api.dsAgentSync(entries)` → 主进程
   `plugins:agentsSync` → 宿主 `agents/sessions` 注册表。
2. 插件工具调用时，渲染进程附带 `sessionKey`；宿主把 `exec.agent` 替换为真实
   代理句柄（`status` 动态读取、`followup/inject` 经 IPC 送进对应会话）。
3. `agent.followup`：会话空闲且并发槽位可用 → 直接 `sendMessage` 开启后台回合；
   否则进入 SessionManager 队列（沿用既有多会话排队机制）。
4. `approval.request`：主进程 → 渲染进程 `ds:approvalRequest` 模态框 →
   `ds:approvalRespond(id, outcome)` 回传，超时/中止归一为 `cancelled`。

## 验证

- `dsh-monitor`：布防文件 watcher → 追加行 → followup 消息经 transport 送达（真实唤醒）。
- `dsh-context-doctor`：`sessions.get(id)` 可读 `header.cwd`。
- `dsh-test-runner`：`sandboxPolicy.resolve` 返回 CIBYP 沙箱模式。
- fixture `probe_seams`：agents/sessions/sandboxPolicy/approval 五路端到端断言（见测试套件）。
