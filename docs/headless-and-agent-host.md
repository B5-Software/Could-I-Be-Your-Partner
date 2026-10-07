# 无头运行时与 AgentHost（多前端架构）

本文说明 Agent 内核与前端的边界（`AgentHost`）、主进程无头运行时，以及 WebUI 独立运行模式。
目标：**同一份 Agent 内核可以被桌面窗口、WebUI、自动化/测试驱动，不再绑定"必须开着某个窗口"**。

## 1. 分层现状

```
┌────────────────────────── 前端（可多个并存） ──────────────────────────┐
│  桌面 GUI（渲染进程）      WebUI（浏览器）        测试 / 自动化        │
│   window.api 门面          WS + HTTP 协议         直接构造 runtime      │
└───────────────┬───────────────────┬────────────────────┬──────────────┘
                │                   │                    │
        AgentHost（能力边界）：api / gui / events / env
                │                   │                    │
┌───────────────┴───────────────────┴────────────────────┴──────────────┐
│  Agent 内核（src/renderer/js/agent.js 等，DOM-free）                    │
│  能力一律经 host：工具/LLM/存储 → host.api；界面专属 → host.gui          │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
┌───────────────────────────────────┴───────────────────────────────────┐
│  主进程服务层：LLM provider / 重试 / 历史 / 设置 / 终端 / MCP / VM …     │
│  事件总线（core/event-bus.js）：按通道 + sessionKey 分发到任意订阅者      │
└───────────────────────────────────────────────────────────────────────┘
```

关键点：

- **Agent 内核不接触 `window`**。改造前内核里有约 330 处 `window.api.*` 与 5 个 UI 全局单例；
  现在全部经 `host`（`src/agent/host.js`）。渲染进程用 `createRendererHost()`（惰性读 `window`，
  行为与改造前一致），主进程/测试用 `createHeadlessHost()`（界面能力优雅失败）。
- **`window.api` 的唯一定义仍在 `src/preload/preload.js`**（含参数整形，如
  `memoryUpdate(id, data) → invoke('memory:update', { id, data })`）。无头侧通过
  `src/agent/preload-api.js` 在沙箱里加载同一份 preload，把 `ipcRenderer.invoke` 指到
  `src/main/core/ipc-dispatch.js`，从而**复用主进程自己的 IPC handler**（457 个通道）。
  新增 API 不需要维护第二份映射表。
- **事件不再写死发给主窗口**。`core/event-bus.js` 按通道（可带 `sessionKey`）分发；
  主窗口只是一个 sink，WebUI 的 WS、无头运行时都是订阅者。

## 2. 无头模式

```bash
electron . --headless
```

启动后：

- 不创建主界面窗口；有桌面环境的 WebUI 启动可以显示 VM 准备进度并创建托盘；
- 主进程承载 Agent 运行时（`src/main/agent-runtime.js`）；
- WebUI 服务自动启动并直连运行时。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `CIBYP_WEB_PASSWORD` | WebUI 访问密码（未设置时读设置里的 Web 控制密码，两者都没有则拒绝启动） |
| `CIBYP_WEB_PORT` | WebUI 端口（默认取设置项，未设置为 3456） |
| `CIBYP_AUTO_APPROVE` | `=1` 时审批/授权自动放行（脚本化与 CI 用；默认 `prompt`，等待前端应答） |

WebUI 与 GUI 共用同一套数据（`userData/data/` 下的设置、历史、记忆、待办），
因此无头跑出来的会话，之后在桌面端打开历史同样可见。

## 3. WebUI 独立运行

`src/main/webui-agent-driver.js` 把 WebUI 的命令直接接到运行时：

| WebUI 命令 | 落点 |
| --- | --- |
| `sendMessage` / `POST /api/chat/send` | `agentRuntime.sendMessage(sessionKey, message)`（非阻塞，事件流实时推送） |
| `newChat` | 新建会话并切换 |
| `stopAgent` | `agentRuntime.stop()` |
| `approvalResponse` | `agentRuntime.respond()` |
| `loadConversation` / `getHistory` / `deleteConversation` | 历史服务（与 GUI 同源） |

运行时事件 → WebUI 既有 push 协议（`message` / `status` / `toolCall` / `approval` /
`title` / `messagesSync` …），WebUI 前端无需改动。

GUI、TUI 与 WebUI 都连接主进程的共享后台，复用同一份 Agent 会话和服务。WebUI 使用与 GUI 相同的渲染页面，通过浏览器预加载适配 HTTP / WebSocket、文件选择和设备能力；关闭 GUI 不会停止浏览器中的会话。

## 4. 交互请求（审批 / 工具授权 / 提问）

内核的三类交互在运行时统一为 `pendingInteraction`：

- `approval`：危险命令、敏感工具执行前的确认；
- `tool-auth`：Playwright / Computer Use 等首次使用授权；
- `questions`：`askQuestions` 工具向用户提问。

任何前端都能应答（`agentRuntime.respond(key, response)`）；`CIBYP_AUTO_APPROVE=1`
则自动放行（审批通过、授权仅本次、提问返回空答复）。

## 5. 新增一个前端要做什么

1. 用 `createHeadlessHost({ api })` 或 `createRendererHost()` 拿到宿主；
2. `new Agent({ host })`（`src/agent/index.js` 的 `createHeadlessAgent()` 已封装）；
3. 订阅 `agent.onMessage(type, data)` 事件（21 种类型，见 `src/main/agent-runtime.js` 的映射）；
4. 需要审批时应答 `agent.resolveApproval()` / `resolveToolAuth()`。

测试沙箱（`vm`）加载 `agent.js` 时，请向沙箱注入 `AgentHostKit`（`require('src/agent/host.js')`）
或 `require`，与注入 `ContextManager` 的做法一致。

## 6. 相关文件

| 文件 | 职责 |
| --- | --- |
| `src/agent/host.js` | AgentHost 抽象（api/gui/events/env），渲染与无头两种实现 |
| `src/agent/preload-api.js` | 从 preload.js 派生 Node 侧能力门面 |
| `src/agent/index.js` | 内核加载器（按 index.html 脚本顺序接线全局标识符） |
| `src/main/core/event-bus.js` | 通道级事件总线（sessionKey 过滤、窗口 sink） |
| `src/main/core/ipc-dispatch.js` | 无头侧 channel→handler 分发桥 |
| `src/main/agent-runtime.js` | 会话注册表 + 交互请求 + 事件流 |
| `src/main/webui-agent-driver.js` | WebUI ↔ 运行时的双向接线 |
| `tests/unit/agent-headless.test.cjs` | 门面派生 / 事件总线 / 完整循环 / 审批闭环 |
| `tests/integration/headless-web.cjs` | 无窗口启动 + HTTP/WS 驱动 WebUI 全流程 |
