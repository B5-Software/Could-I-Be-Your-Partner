# TUI 终端前端

类 Claude Code / OpenCode 的完整终端界面，是 Agent 内核的第四个前端
（桌面 GUI / WebUI / Remote / **TUI**），共享同一运行时与历史数据。

```bash
npx cibyp-tui                              # Chat 模式（推荐入口）
node bin/cibyp-tui.js                      # 同上（仓库内）
node bin/cibyp-tui.js --mode=babe          # Babe 模式
node bin/cibyp-tui.js --mode=code --workspace=/path
node bin/cibyp-tui.js --web                # 同时提供 WebUI 服务
node bin/cibyp-tui.js --headless --web     # 只跑服务（不开终端界面）
```

**纯 Node 运行，不依赖 Electron**：原生模块（node-pty / OCR / 语音 / 截图）都是 N-API，
Node 与 Electron 共用同一份编译产物；服务装配通过 `src/tui/electron-shim.js` 在纯 Node
里复用 `src/main` 的同一套代码（457 个 IPC handler 照常注册）。

> 为什么不是 `electron . --tui`：Electron 是 GUI 子系统程序，**Windows 下它的
> `process.stdin` 不是 TTY（`setRawMode` 都不存在）**，无法接收逐键输入。
> `electron . --tui` 因此只渲染一帧预览并提示改用 `node bin/cibyp-tui.js`。

- 审批/授权默认弹窗等待应答；`CIBYP_AUTO_APPROVE=1` 可自动放行（脚本化）。
- 主题：`CIBYP_TUI_THEME=dark|light|ansi`（默认 dark 真彩，`NO_COLOR` 自动降 16 色）。
- 用户数据：`CIBYP_USER_DATA` 可指定配置目录（默认 `~/.cibyp`）。

## 界面构成

```
  消息流（滚动区：用户气泡 / 助手正文 / 工具卡片 / 系统提示）
  ────────────────────────────────────────────
  模态（审批 / 授权 / 提问 / 选择器）▔ 顶线 + 标题 + 选项
  ╭───────────────────────────────── 提示 ─╮
  ❯ 输入框（多行 · Alt+Enter 换行）
  ╰────────────────────────────────────────╯
  提示 · ctrl+t 待办 · ctrl+r 历史 · /help 命令
  Chat │ stub-model │ Context 12% (34k/200k) │ 1.2k tokens │ ♥ 42
```

设计语言（与 Claude Code / OpenCode 对齐）：

| 元素 | 规格 |
| --- | --- |
| 指针 / 输入前缀 | `❯`（模式色） |
| 工具卡片 | `● 工具名 (参数摘要)`，运行中闪烁、成功绿、失败红 |
| 工具结果 | 缩进 + `⎿` 前缀，超出 6 行折叠为「… 还有 N 行」 |
| 用户消息 | 底色块 + `❯` 前缀 |
| 代码 / 引用 | `▎` 引用条；行内 `` `code` `` 与 `**bold**` 高亮 |
| 输入框 | 仅上下两条圆角线，顶线右端内嵌提示；模式换色（Chat 蓝紫 / Babe teal / Code 粉） |
| 模态 | `▔` 顶线 + 标题 + `❯` 选项指针 + `✓` 选中 |
| 状态栏 | `模式 │ 模型 │ Context% │ tokens │ ♥ 好感度 │ 工作区`，` │ ` 为暗色分隔 |
| spinner | `· ✢ ✱ ✶ ✻ ✽` 正放+倒放（120ms 时钟） |
| 进度条 | `▏▎▍▌▋▊▉█` 1/8 块细分 |
| 状态图标 | `✓ ✗ ⚠ ℹ ○ …` |
| 窄屏 | 所有行按显示宽度排版（CJK 按 2 格），逐行不超宽 |

## 键位

| 键 | 作用 |
| --- | --- |
| `Enter` | 发送（模态中为确认） |
| `Alt+Enter` / `Ctrl+J` | 输入换行 |
| `Esc` | 运行中=停止；空闲=清空输入；模态=取消（审批视为拒绝） |
| `Ctrl+C` | 运行中=停止；空闲连按两次=退出 |
| `Ctrl+D` | 空输入时同 Ctrl+C |
| `Ctrl+L` | 回到底部 |
| `Ctrl+T` | 待办面板 |
| `Ctrl+R` | 历史会话（按模式） |
| `Shift+Tab` | 循环切换模式（chat → babe → code） |
| `PgUp` / `PgDn` | 消息区滚动 |
| `↑` `↓` | 输入历史调阅 |
| `Ctrl+A/E` `Home/End` | 行首 / 行尾 |
| `Ctrl+W` / `Ctrl+U` / `Ctrl+K` | 删词 / 删到行首 / 删到行尾 |
| `Ctrl+B/F` 或 `Ctrl+←/→` | 词移动 |
| `Tab` | 补全选中的命令 / 参数建议 |
| 补全面板 `↑↓` `Ctrl+P/N` | 选择建议 |
| 补全面板 `Enter` / `Esc` | 补全并执行 / 关闭 |
| 模态 `↑↓` `j/k` `Ctrl+P/N` | 选项移动 |
| 模态 `1-9` | 序号速选 |
| 审批 `y` `a` `n` | 允许一次 / 总是允许 / 拒绝 |
| 授权 `a` `y` `n` | 允许并记住 / 仅本次 / 拒绝 |

## 斜杠命令体系

**补全面板**：输入 `/` 时输入框上方弹出建议列表（命令 + 描述），`↑↓`/`Ctrl+P/N` 选择、
`Tab` 补全、`Enter` 补全并执行、`Esc` 关闭（同一段文本不再弹回）。参数也会补全：
`/mode ` 给出 chat/babe/code，`/open `、`/delete ` 给出历史会话。

`/help` `/mode <chat|babe|code>` `/new [mode]` `/sessions` `/history` `/open <id>`
`/rename <标题>` `/delete <id>` `/commands` `/attach <文件>` `/workspace [路径]`
`/todo` `/usage` `/model` `/status` `/clear` `/stop` `/continue [说明]`
`/compact` `/quit`

**自定义命令**：把 `*.md` 放到 `~/.cibyp/commands/`（用户级）或
`<工作区>/.cibyp/commands/`（项目级），文件名即命令名：

```markdown
---
description: 整理并提交改动
agent: code            # 可选：限定模式（chat|babe|code）
---
请把工作区改动整理成一次提交，并说明取舍。$ARGUMENTS
```

执行 `/commit 先跑测试` 时正文作为提示词发送，`$ARGUMENTS` / `{{args}}` 替换为参数；
`agent` 与当前模式不同时自动切模式。`/commands` 查看与重载。

## 模式切换

- `/mode` **无参数弹出选择器**（当前模式高亮，Enter 确认）
- `/mode <chat|babe|code>` 直接切换（新建该模式的会话）
- `Shift+Tab` 循环切换（chat → babe → code）

## 三种模式

- **Chat**：完整工具面（文件/终端/网络/办公/记忆/知识库/子代理…）、附件、待办、
  上下文用量、热消息（工作中继续输入即注入）。
- **Babe**：独立系统提示词与工具白名单、好感度（状态栏 `♥`，变化弹提示）、
  好感度随 babe 历史持久化、独立历史通道。
- **Code**：以工作区为中心的纯 Agent（`/workspace` 设定），代码工具 + 交互式终端 +
  工作区内的 `.cibyp-code-history/` 历史。**不接 CodeOSS/IDE**：无界面环境下
  `codeIDE` 工具被显式禁用。

## 测试

| 用例 | 覆盖 |
| --- | --- |
| `tests/unit/tui-core.test.cjs` | CJK 排版/换行/截断、按键解码（含跨 chunk 与粘贴）、行编辑器 |
| `tests/unit/tui-app.test.cjs` | 状态机：发送/流式/工具卡片/审批三态/提问/三模式/命令/补全面板/自定义命令/快捷键/窄屏 |
| （契约）原始按键字节 → 解码器 → 应用 | 回归：Ctrl+ 组合键因键形状不一致全部失效 |
| `tests/integration/tui-session.cjs` | 真实运行时 + TUI：Chat 一整轮、审批弹窗 y 批准、Babe 好感度+历史、Code 工作区+历史 |
| `tests/integration/tui-tty.test.cjs` | **真终端（node-pty PTY）**：界面驻留渲染、键入+回车、stub 回复、Ctrl+C 两次干净退出 |

```bash
npm run test:tui        # TUI 集成（真实运行时）
npm run test:tui:tty    # 真终端回归（PTY 驱动纯 Node CLI）
npm run test:desktop    # 全部集成（GUI 冒烟 / WebUI 无头 / TUI / 真终端）
npm run check           # lint + format + typecheck + 单元 + legacy
```
