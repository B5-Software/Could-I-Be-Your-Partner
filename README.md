<p align="center">
  <img src="assets/icons/icon.png" width="72" height="72" alt="CIBYP Logo">
</p>

# Could I Be Your Partner

**CIBYP** 是一个支持桌面、终端和浏览器的 AI Agent 应用。你可以用它聊天、处理文件、编写代码和执行任务，也可以在自己的虚拟机工作区中运行工具。

GUI、TUI 和 WebUI 连接同一个后台，共享模型、设置、会话、待办与工作区。WebUI 复用桌面前端；Android 和 Wear OS 客户端连接电脑上的后台，任务与模型调用仍由电脑执行。

[下载安装](#安装) · [使用方式](#使用方式) · [模型配置](#模型与用量) · [开发构建](#开发与构建) · [文档](#文档导航)

## 状态与版本

| 项目 / 渠道 | 状态 | 版本 | 入口 |
| --- | --- | --- | --- |
| 工程检查 | [![Checks][checks-badge]][checks-url] | [![main][source-version-badge]][source-url] | [检查与回归][checks-url] |
| App 构建 | [![Build][build-badge]][build-url] | [![App source][source-version-badge]][source-url] | [六平台构建与发布][build-url] |
| Release | [![Released][release-date-badge]][release-url] | [![Stable][release-version-badge]][release-url] | [正式版下载][release-url] |
| Prerelease | [![Preview][prerelease-channel-badge]][prerelease-url] | [![Prerelease][prerelease-version-badge]][prerelease-url] | [预发布版下载][prerelease-url] |
| npm 启动器 | [![npm publish][npm-build-badge]][npm-build-url] [![Downloads][npm-downloads-badge]][npm-url] | [![npm][npm-version-badge]][npm-url] | [npm 包][npm-url] |

App 和 npm 启动器独立版本化。`main` 徽章显示源码版本，下载版本以 Release 为准；构建工作流成功不一定产生新版本。正式版与预发布版分别显示，npm 默认下载包含 alpha 的 preview 通道。

## 安装

### 使用 npm / npx

需要 **Node.js ≥ 22.14** 和系统 `tar`。

```sh
npm install -g cibyp
cibyp
```

也可以不全局安装：

```sh
npx cibyp
npx --package=cibyp cibyp-tui
npx --package=cibyp cibyp-code
npx --package=cibyp cibyp-webui
```

npm 包只包含纯 JavaScript 启动器。安装或首次使用时，它从 GitHub Release 下载当前系统与架构的完整 App，探测 HTTPS 镜像、并发下载，并在解压和运行前校验文件大小与 SHA-256。VM 镜像和语音模型按需另行下载。

安装后会注册名为 **Could I Be Your Partner** 的用户应用入口：Windows 开始菜单、macOS `~/Applications` 或 Linux 用户应用菜单。更新会替换受管理的入口，保留设置、历史和工作区。

```sh
cibyp --channel=stable       # 选择正式版通道
cibyp --channel=preview      # 选择包含预发布版的通道
cibyp update                # 下载并更新 App 运行时
cibyp --no-update           # 使用已校验的缓存，不检查更新
cibyp --version             # npm 启动器版本
cibyp --runtime-version     # 缓存中的 App 版本
```

启动器默认最多每六小时检查一次 App 更新。缓存、下载镜像、并发数及 macOS 本地签名说明见 [npm 启动器文档](packages/npm/README.md)。安装公开包不需要 npm 登录。

应用设置 → 版本更新会识别安装来源：npm 安装更新缓存中的运行时；直接下载的 Release 安装获取对应系统的官方安装包。默认自动检查、手动下载，可选择任务空闲时后台下载；两条下载路径都校验 SHA-256，安装始终需要手动确认。WebUI 中的更新操作针对连接的电脑后台，多个前端共用同一次下载。启动器自己的六小时检查策略单独见上面的文档。

### 使用系统安装包

从 [GitHub Releases][prerelease-url] 选择对应系统、架构和版本。

| 系统 | 架构 | 分发形式 |
| --- | --- | --- |
| Windows | x64 / ARM64 | NSIS 安装器 |
| macOS | Intel / Apple Silicon | DMG、PKG、ZIP |
| Linux | x64 / ARM64 | AppImage、DEB |

系统安装包附带命令运行时，无需另外安装 Node.js。Windows 安装器、macOS PKG、Linux DEB 会注册命令；安装后重新打开终端。DMG、ZIP、AppImage 的命令用法见 [终端启动说明](docs/terminal-launchers.md)。

本地 STT / TTS / 语音唤醒依赖原生语音引擎及下载的模型；**Windows ARM64 不支持该本地语音引擎**。VM 需要额外的镜像、磁盘空间与可用的虚拟化环境。实际系统要求还取决于 Electron、原生依赖和所使用的资源。

## 使用方式

### 启动不同前端

| 命令 | 行为 |
| --- | --- |
| `cibyp` | 打开 GUI；无可用图形环境时进入 TUI |
| `cibyp-tui` | 打开终端前端 |
| `cibyp-code` | 进入 Code TUI，以当前终端目录作为宿主工作区 |
| `cibyp-webui` | 启动 WebUI，后台进程不占用当前终端 |

这些前端可以同时连接同一后台。关闭某个前端与退出后台是不同操作；退出共享后台会影响所有已连接的前端和任务。

### 三种模式

| 模式 | 用途 |
| --- | --- |
| **Chat** | 通用对话、文件处理、搜索及工具任务 |
| **Code** | 项目编程、编辑器上下文、终端、修改审阅 |
| **Babe** | 使用独立人设与关系状态的陪伴对话 |

桌面 Code 模式内嵌 Code-OSS 工作台，包含文件浏览、Git、终端、调试与扩展管理。CIBYP AI 侧栏与 IDE 并排显示，支持选区和诊断上下文、AI 修改差异、接受与撤销，以及沉浸模式。功能和扩展兼容范围见 [Code-OSS 工作台](docs/codeoss-workbench.md)。

### TUI 常用操作

输入 `/` 查看命令建议；会话操作使用选择列表，无需记住会话 ID。

| 命令 / 按键 | 用途 |
| --- | --- |
| `/help`、`/mode`、`/new` | 帮助、模式切换、新对话 |
| `/sessions`、`/open`、`/rename`、`/delete` | 选择、打开、重命名和删除会话 |
| `/workspace`、`/workspace <路径>` | 选择本地工作区 |
| `/workspace sync` | 从 VM 取回工作区文件 |
| `/attach <路径>` | 为下一条消息添加文件 |
| `/config [关键词]` | 搜索和修改共享设置 |
| `/usage` | 查看 Token、参考消费和可用订阅额度 |
| `/undo` | 停止并撤回上一条消息及其回复，恢复草稿 |
| `/minimal [on\|off]` | 切换 Chat / Code 的极简工具模式 |
| `/thinking`、`/theme [on\|off]`、`/mouse [on\|off]` | 推理展开、沿用 GUI 配色、鼠标捕获偏好 |
| `/cwd`、`/vmdesk` | 打开宿主工作区或 VM 桌面，需要可用图形环境 |
| `Ctrl+F`、`Ctrl+T`、`Ctrl+R` | 搜索会话、待办、历史 |
| `PgUp / PgDn`、`Ctrl+L` | 翻页、回到底部 |

鼠标支持滚轮、菜单选择、输入光标定位和消息拖选；拖到边缘可继续滚动选择。使用 `/mouse off` 或按住 `Shift` 可使用终端原生选择。Markdown 表格会根据终端宽度排版。

`/undo` 撤回消息和上下文，**不会回滚已执行的文件修改或外部操作**。完整键位、自定义命令和 TUI 偏好见 [TUI 文档](docs/tui.md)。

### WebUI 与 Remote

先在 **设置 → WebUI** 配置访问密码、监听地址、端口和可选二次认证，再运行 `cibyp-webui`，或在设置中开启随前端启动。默认地址为 `http://127.0.0.1:3456`，实际以启动输出为准。

WebUI 使用同一套桌面 HTML、样式和界面逻辑，直接连接后台。Remote 模式连接目标电脑的后台；模型、文件和工具操作发生在目标电脑。

有图形环境时，可从系统托盘打开 GUI、WebUI 或退出；无桌面环境时可执行：

```sh
cibyp-webui --stop           # 退出共享后台，会影响其他已连接前端
```

浏览器访问麦克风和摄像头需要设备权限及安全上下文（HTTPS 或 localhost）。远程部署、认证、Tor 连接与原生客户端说明见 [共享后台与远程控制](docs/mobile-remote-control.md)。

### 自定义命令别名

```sh
cibyp alias add kamisato
kamisato
kamisato-tui
kamisato-code
kamisato-webui
cibyp alias list
cibyp alias remove kamisato
```

一组别名保留原命令的参数和当前目录。命令目录会加入用户 PATH / Shell 配置，创建后重新打开终端；已有文件或被手动修改的别名不会被覆盖。可用 `CIBYP_ALIAS_DIR` 指定目录。

## 模型与用量

首次启动可通过向导配置；之后在 **设置 → 模型与连接 → 模型池** 添加、发现、测试和切换模型。

- **API 模型**：配置 Provider、Endpoint 和 Key，支持自动识别或指定请求格式。
- **OpenCode Zen**：发现当前可用免费模型，自动处理所需 SessionID、UA 和兼容工具定义；仅对 Zen 免费模型注入这些工具定义。免费模型列表、上下文和配额受渠道限制，不直接套用上游模型最大容量。
- **ChatGPT 订阅**：通过官方 Sign in with ChatGPT 授权，支持切换和注销账号；使用该通道实际提供的模型与能力。
- **视觉、生图和摘要**：可分别配置模型与连接，沿用对应预算和上下文策略。
- **System One**：可选的独立决策服务，支持多家服务及本地兼容协议，见 [决策模型说明](docs/system-one.md)。

价格按渠道自动获取，设置中的价格表作为覆盖。没有价格的数据会标记为未知；本地估算不代表供应商账单。

GUI、Code AI 侧栏和 WebUI 共享用量指示器，可选择 API 等效消费、5 小时 / 周 / 月限额或当前最紧迫限额；TUI 使用 `/usage` 按需查看。额度只显示服务端实际提供的数据，无法读取时提供管理入口。额度重置卡只能由用户手动操作并二次确认。

模型测试可能产生请求费用；授权支持和订阅可用范围以账号、渠道与返回能力为准。详细说明见 [订阅与用量](docs/subscriptions.md) 和 [设置与限额](docs/settings-and-limits.md)。

## 工作区与能力

### 本机与 VM

在设置中选择运行位置。未指定项目时可创建独立工作区；`cibyp-code` 和 `/workspace` 可使用已有宿主目录，在 VM 模式下建立对应映射。

VM 模式的文件工具、Shell、终端及工作区扩展在 VM 执行；**LLM、外置视觉、生图和 System One 请求由主机后台执行**。工作区同步与模型请求位置分别管理。

共享工作区使用内容摘要和双向基线比较，冲突保留副本；被占用或无法读取的文件不会当作删除传播。设置中的 VM 文件管理器支持宿主 / VM 双向传输。同步范围、跳过规则与 Shell 任务见 [VM 工作区文档](docs/vm-workspace-and-shell-jobs.md)。

### Agent、工具与扩展

- **执行任务**：文件、Shell、网页搜索、网页读取、浏览器、Computer Use、OCR、生图、文档、数学和串口等工具；可控制工具暴露、审批与预算。
- **搜索**：Bing、Exa、Parallel、TinyFish 或 Fusion；支持自定义 Provider / Key，以及通过引用、偏移和分页控制结果上下文，见 [搜索文档](docs/web-search.md)。
- **知识与记忆**：持久化知识库、长期记忆、技能与跨会话待办。
- **MCP 与插件**：管理连接、修改配置及连接状态；兼容 DeepSeek Harness 插件运行时，见 [MCP](docs/mcp-connections.md) 和 [插件兼容说明](docs/deepseek-compatibility.md)。
- **自动化**：定时或事件触发任务，连接共享 Agent 后台，见 [自动化文档](docs/automation.md)。
- **设置助手**：临时会话中查找、定位和调整设置，敏感字段引导用户自行配置。

### 上下文与界面

完整聊天记录与压缩后的上下文独立持久化。压缩失败保留原始上下文，完成提示短期显示；删除消息同时清理可对应的原始上下文，已合入摘要的信息不能逐条移除。

推理正文与可读摘要分别处理；加密推理不作为文字显示，可通过设置保留并随记录导出，见 [推理与验证](docs/reasoning-and-verification.md)。

界面支持中文、英文、德文，深浅色、强调色、背景色、头像与头像框，以及统一动画开关。文件和图片使用结构化附件卡片，历史保留附件信息。

### Android 与 Wear OS

[CIBYP-Mobile](https://github.com/B5-Software/CIBYP-Mobile) 是独立的原生客户端仓库，拥有自己的 CI 和 APK 发布流程。

手机使用 Kotlin / Jetpack Compose Material Design 3，支持预测性返回、桌面小组件、多电脑连接、审批、聊天和待办。Wear OS 经已授权的手机转发连接，不需要手表扫码。两端同步目标电脑的主题；网络与界面更新频率针对 Tor 和手表调整。

Tor 是可选远程连接方案，桌面与手机可配置网桥，包括 meek。网桥与受限网络的连接结果取决于实际网络环境。安装和连接步骤见 [远程客户端文档](docs/mobile-remote-control.md)。

## 更新

GUI、TUI 和 WebUI 中可执行 `/update` 下载新版；下载经过校验，完成后提示安装。

```text
/update
/update install
```

安装前需要确认，任务运行中拒绝重启。npm 启动器版本会暂存更新后的运行时，确认退出后重新运行原启动命令即可使用。更新通道与设置中的正式版 / 预发布版选择一致。

## 开发与构建

源码开发需要 **Node.js ≥ 24.13.0、npm ≥ 11**；原生模块和打包还需要对应平台工具链。

```sh
git clone https://github.com/B5-Software/Could-I-Be-Your-Partner.git
cd Could-I-Be-Your-Partner
npm ci
npm run prepare-build-assets
npm run download-assets
npm start
```

首次资源准备会下载本地图标、OCR、字体、数学与其他资源。`npm start` 准备固定版本 Code-OSS、构建渲染入口和预加载脚本，然后启动 Electron。

```sh
npm run tui                 # 源码 TUI
npm run webui               # 源码 WebUI
npm run check               # lint、格式、类型检查、离线回归
npm run test:desktop        # 隔离配置的完整桌面 / TUI 集成检查
npm run test:backend        # 共享后台与传输检查
npm run test:codeoss        # Code-OSS 工作台检查
```

`npm run test:live` 会使用已配置模型并可能产生费用，需显式运行。各平台打包命令、资源目录、生成文件边界和 CI 发布流程见 [开发与构建指南](docs/development.md)。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 安装、命令、更新 | [终端启动](docs/terminal-launchers.md) · [npm 启动器](packages/npm/README.md) · [npm 发布](docs/npm-publishing.md) |
| 使用与远程 | [TUI](docs/tui.md) · [共享后台 / Android / Wear OS / Tor](docs/mobile-remote-control.md) |
| 模型与上下文 | [订阅用量](docs/subscriptions.md) · [设置限额](docs/settings-and-limits.md) · [推理与验证](docs/reasoning-and-verification.md) · [System One](docs/system-one.md) |
| Code 与 VM | [Code-OSS 工作台](docs/codeoss-workbench.md) · [工作区同步 / Shell](docs/vm-workspace-and-shell-jobs.md) · [VM 工具隔离](docs/vm-tool-isolation.md) |
| 工具与扩展 | [网络搜索](docs/web-search.md) · [MCP](docs/mcp-connections.md) · [DeepSeek 插件](docs/deepseek-compatibility.md) · [自动化](docs/automation.md) |
| 开发 | [构建指南](docs/development.md) · [架构改造](docs/modernization.md) · [UI 源码清单](src/renderer/js/app-parts/README.md) |

## 数据与问题反馈

默认用户数据目录如下；旧安装可能使用 `Could I Be Your Partner` 目录名，命令前端会优先识别已有配置。

| 系统 | 默认用户数据目录 |
| --- | --- |
| Windows | `%APPDATA%\could-i-be-your-partner` |
| macOS | `~/Library/Application Support/could-i-be-your-partner` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/could-i-be-your-partner` |

设置位于 `data/settings.json`，运行日志位于 `logs/`。默认工作区位于用户 Documents 下的 `Could-I-Be-Your-Partner`；可在设置或 `/workspace` 中更改。`CIBYP_USER_DATA` 可为开发和测试指定隔离的数据目录。

遇到问题请提交 [GitHub Issue](https://github.com/B5-Software/Could-I-Be-Your-Partner/issues)，附 App 版本、系统 / 架构、前端、运行位置和复现步骤。日志中请移除密钥、访问令牌与个人信息。

## 许可证

[GPL-3.0-or-later](LICENSE) · B5-Software。Code-OSS、VSCodium 与随包第三方组件保留各自许可证。

[checks-badge]: https://img.shields.io/github/actions/workflow/status/B5-Software/Could-I-Be-Your-Partner/check.yml?branch=main&label=checks&logo=githubactions&logoColor=white&style=flat-square
[checks-url]: https://github.com/B5-Software/Could-I-Be-Your-Partner/actions/workflows/check.yml
[build-badge]: https://img.shields.io/github/actions/workflow/status/B5-Software/Could-I-Be-Your-Partner/release.yml?branch=main&label=build&logo=githubactions&logoColor=white&style=flat-square
[build-url]: https://github.com/B5-Software/Could-I-Be-Your-Partner/actions/workflows/release.yml
[source-version-badge]: https://img.shields.io/github/package-json/v/B5-Software/Could-I-Be-Your-Partner/main?label=main&logo=github&style=flat-square
[source-url]: https://github.com/B5-Software/Could-I-Be-Your-Partner/blob/main/package.json
[release-date-badge]: https://img.shields.io/github/release-date/B5-Software/Could-I-Be-Your-Partner?display_date=published_at&label=released&logo=github&style=flat-square
[release-version-badge]: https://img.shields.io/github/v/release/B5-Software/Could-I-Be-Your-Partner?label=stable&logo=github&style=flat-square
[release-url]: https://github.com/B5-Software/Could-I-Be-Your-Partner/releases/latest
[prerelease-channel-badge]: https://img.shields.io/badge/channel-Prerelease-orange?logo=github&style=flat-square
[prerelease-version-badge]: https://img.shields.io/github/v/release/B5-Software/Could-I-Be-Your-Partner?include_prereleases&filter=*-*&sort=semver&label=preview&logo=github&style=flat-square
[prerelease-url]: https://github.com/B5-Software/Could-I-Be-Your-Partner/releases
[npm-build-badge]: https://img.shields.io/github/actions/workflow/status/B5-Software/Could-I-Be-Your-Partner/npm.yml?branch=main&label=npm%20publish&logo=npm&style=flat-square
[npm-build-url]: https://github.com/B5-Software/Could-I-Be-Your-Partner/actions/workflows/npm.yml
[npm-downloads-badge]: https://img.shields.io/npm/dm/cibyp?label=downloads&logo=npm&style=flat-square
[npm-version-badge]: https://img.shields.io/npm/v/cibyp/latest?label=latest&logo=npm&style=flat-square
[npm-url]: https://www.npmjs.com/package/cibyp
