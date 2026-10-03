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

## 沿用 GUI 的全部设置

TUI 与桌面端读**同一个数据目录**（`app.getPath('userData')` 同名解析，打包/开发
两种布局都能对上），因此设置、记忆、知识库、待办、历史、技能、工作区全部共享：

| 设置项 | TUI 中的生效方式 |
| --- | --- |
| LLM（provider / api / 模型池 / 路由） | Agent 内核直接使用（状态栏显示当前模型） |
| 人格 `aiPersona`、Babe 人设/初始好感度 | 系统提示与好感度随设置生成 |
| 工具开关 / 敏感工具免审 / 工具授权记忆 | 工具面与审批策略沿用 |
| 隐私保护、Token/预算限制 | 内核脱敏与预算护栏沿用 |
| 主题 `theme.mode`（system/dark/light） | TUI 深浅色跟随（system 按终端 `COLORFGBG` 判定） |
| 强调色 `theme.accentColor` | 沿用；**与终端明暗对比不足时回落默认色**（浅色主题的黑色强调不会搬进深色终端） |
| 语言 `language` | 界面/系统提示/工具回显翻译（en/de 词典 + GUI 共用词典，中文为源文回退） |

`CIBYP_USER_DATA` 可指定配置目录（测试/多配置隔离）；`CIBYP_TUI_THEME` 覆盖主题。

- 审批/授权默认弹窗等待应答；`CIBYP_AUTO_APPROVE=1` 可自动放行（脚本化）。
- 主题：`CIBYP_TUI_THEME=dark|light|ansi`（默认 dark 真彩，`NO_COLOR` 自动降 16 色）。
- 用户数据默认与 Electron 共用：Windows 为 `%APPDATA%/<应用名>`，macOS 为 `~/Library/Application Support/<应用名>`，Linux 为 `${XDG_CONFIG_HOME:-~/.config}/<应用名>`。优先使用已有设置的目录；`CIBYP_USER_DATA` 可显式覆盖。

## 界面构成

```
  消息流（滚动区：用户气泡 / 助手正文 / 工具卡片 / 系统提示）
  ────────────────────────────────────────────
  模态（审批 / 授权 / 提问 / 选择器）▔ 顶线 + 标题 + 选项
  ╭───────────────────────────────── 提示 ─╮
  │❯ 输入框（多行 · Alt+Enter 换行）       │
  ╰────────────────────────────────────────╯
  提示 · ctrl+t 待办 · ctrl+r 历史 · /help 命令
  Chat │ stub-model       34.0K (12%) │ Could I Be Your Partner 1.9.0-alpha.x
```

设计语言（与 Claude Code / OpenCode 对齐）：

| 元素 | 规格 |
| --- | --- |
| 指针 / 输入前缀 | `❯`（模式色） |
| 工具卡片 | `● 工具名 (参数摘要)`，运行中闪烁、成功绿、失败红 |
| 工具结果 | 缩进 + `⎿` 前缀，超出 6 行折叠为「… 还有 N 行」 |
| 用户消息 | 底色块 + `❯` 前缀 |
| 代码 / 引用 | `▎` 引用条；行内 `` `code` `` 与 `**bold**` 高亮 |
| 输入框 | 完整圆角边框，多行和软换行均有左右边框；顶线右端内嵌提示，跟随模式色 |
| 模态 | `▔` 顶线 + 标题 + `❯` 选项指针 + `✓` 选中 |
| 状态栏 | 左侧模式/模型/好感度/工作区，右侧上下文和费用，再右侧应用名和版本（不含 Git 哈希） |
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
| `PgUp` / `PgDn` | 消息区滚动；模态打开时翻页，到边界停住 |
| `↑` `↓` | 多行草稿中移动光标，到首末行后调阅历史；`Ctrl+P/N` 直接调阅历史 |
| `Ctrl+A/E` `Home/End` | 行首 / 行尾 |
| `Ctrl+W` / `Ctrl+U` / `Ctrl+K` | 删词 / 删到行首 / 删到行尾 |
| `Ctrl+B/F` | 字符移动 |
| `Alt+B/F` 或 `Ctrl+←/→` | 词移动 |
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
`/mode ` 给出 chat/babe/code。`/open`、`/delete` 打开会话选择器，可附加标题关键词筛选；不需要输入会话 ID。`/rename` 先选择会话，再编辑标题；`/rename 新标题` 快速重命名当前会话。列表显示标题、日期和当前标记，未命名会话显示 `New`，删除前确认所选标题。

`/help` `/mode <chat|babe|code>` `/new [mode]` `/sessions` `/history` `/open [关键词]`
`/rename [标题]` `/delete [关键词]` `/commands` `/thinking` `/vmdesk` `/attach <文件>` `/workspace [路径|sync]`
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

## 推理内容（thinking）

思考模型的推理过程在正文上方单独成块：默认折叠为一行摘要
（`∴ 思考中 (320 字) + 首行预览`），`/thinking` 全局切换折叠/展开。
流式过程中推理与正文分通道累积，互不干扰。

## 状态栏用量与成本

右置 `{占用} ({占比}%) · ${成本}`，例如 `676.1K (64%) · $1.89`：

- 占用与 GUI 圆环同口径（含输出预留），`676.1K` 复刻 `fmtTokenCount`
- 成本按 `settings.budget.models` 定价 + 峰谷倍率计算；**仅在配置了价格时显示 `$`**
- 每轮结束自动推送；状态切换时兜底刷新一次

## 日志隔离

TUI 占用整个终端后，LLM/网络/VM 的进程日志不再打到屏幕上：
`console.*` 与 `stdout/stderr` 写入一律改道 `<userData>/logs/tui-YYYYMMDD.log`
（界面自身的渲染写入放行），退出时恢复。查日志不用来回切窗口了。

## 输入

- 鼠标滚轮滚动聊天记录（输入框/模态的滚轮翻各自选项，不再切输入历史；
  输入历史调阅只走 `↑↓`/`Ctrl+P/N`）
- 直接拖动鼠标选择消息；拖到消息区上下边缘时继续滚动，支持跨屏选择。`Ctrl+C` 复制，`Esc` 取消选区；也可按住 `Shift` 使用终端原生选择。
- 启用括号粘贴，多行内容整体进入草稿，粘贴中的换行不会自动发送；长草稿只展示光标附近的输入行。
- 查看较早消息时，新回复到达会保持当前阅读位置；`Ctrl+L` 回到底部。
- 终端标题实时显示 `CIBYP | 会话标题`，无标题的新对话显示 `CIBYP | New`；退出时恢复原终端标题。
- TUI 启动虚拟机、新对话以及 GUI 启动前的终端使用同一幅 CIBYP ASCII 标识；窄窗口使用紧凑标识。
- 推理默认完整展开，以“思考：”开头，与回复正文间留空行；`/thinking` 的折叠偏好保存至 `data/tui-preferences.json`，跨启动、跨会话生效，仅作用于 TUI。

## VM 模式

虚拟机模式下（设置 → 运行位置 → 虚拟机），TUI 在 VM 启动完成后才进界面，
期间渲染加载进度条（百分比 + 阶段文本，来源与 splash 一致）。

`/vmdesk` 打开 VM 桌面（GUI 命令面板与 TUI 通用）：VM 未启动时自动拉起图形栈，
在独立桌面窗口里展示 noVNC 画面。纯 Node TUI 通过私有 IPC 启动轻量 Electron 窗口，连接原有 VM；重复命令聚焦现有窗口，关闭后可以重开，退出 TUI 时关闭窗口。窗口内的图形控制和主题变化仍由 TUI 的主进程处理。

## 模式切换

- `/mode` **无参数弹出选择器**（当前模式高亮，Enter 确认）
- `/mode <chat|babe|code>` 直接切换（新建该模式的会话）
- `Shift+Tab` 循环切换（chat → babe → code）
- 模式颜色为 Chat 蓝紫、Babe 粉色、Code 绿色。
- 新建 Code 会话会立即准备独立 hash 工作区。`/workspace` 用可导航的本地目录列表选择文件夹，`/workspace 路径` 直接指定目录。VM 模式复用 Code-OSS 的导入、Git 保留、路径映射与同步；界面同时显示 VM 和本地路径。共享模式每轮完成后取回文件，`/workspace sync` 手动导出（包括独立模式和仍在后台运行的服务产物）。
- `/sessions` 切回已有会话时，消息、输入草稿、附件、用量与待应答的审批分别保留；后台会话继续接收自己的事件。
- `/workspace` 验证目录，并在任务运行中拒绝切换；首次发送保持指定的 Code 工作区。

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
| `tests/unit/tui-views.test.cjs` | **光标落位**（回归：跑出输入框/中文横向漂移、软换行、补全面板偏移）、帧宽自检、主题/强调色护栏 |
| `tests/unit/tui-settings.test.cjs` | **i18n 覆盖率（漏译即红）**、t() 回退语义、数据目录与 Electron 对齐、无 DOM 语言切换 |
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
