# Could I Be Your Partner

> 全自动 AI Agent，帮助完成一切任务

一个基于 Electron 的桌面应用，集成最前沿的 AI 技术，提供自动化任务执行、知识管理、长期记忆、MCP 协议支持等功能。

**License**: GPL-3.0-or-later | **Author**: B5-Software

---

## 功能特色

### 智能 AI Agent 引擎

- **自主决策执行**：AI Agent 接收任务后可独立工作，无需人工干预，直到任务完成
- **多轮对话支持**：支持热对话，用户可异步聊天、提供新信息或修改需求，Agent 根据最新内容动态调整行为
- **上下文智能管理**：内置健壮的上下文窗口管理系统，避免过度依赖或忽略重要信息，自动清理过期内容
- **命运之牌**：每个 Agent 启动时自动抽取一张塔罗牌，代表其性格特征和命运走向

### 知识与记忆体系

- **知识库系统**：支持搜索、添加、更新、删除知识库条目
- **长期记忆**：持久化存储重要信息，Agent 可自主访问和更新
- **会话历史**：自动保存所有对话记录，支持历史回溯

### 120+ 专业工具集

包括核心文件操作、安全代码执行、终端命令、高级网络请求（HTTP/DNS/Ping等）、全方位数学求解（几何、代数、矩阵、7维特征向量、微积分、数统等）、数据与文档分析（Office 文件拆解、内嵌 Spreadsheet 表格编辑器处理）、硬件交互（本地串口通信）、图片生成、OCR 识别、GeoGebra 数学引擎、Canvas 图形绘制等。

### 语音交互

- **语音输入（STT）**：本地语音识别（sherpa-onnx），支持中英文模型，听写尾词即发送
- **语音朗读（TTS）**：本地语音合成，多音色多语言，长文本自动分块防 OOM
- **语音唤醒**：常驻麦克风监听，命中唤醒词后弹语音条或主窗口
- **全局热键**：一键开关听写

> **注意**：语音功能依赖 sherpa-onnx-node 原生库，该库**不提供 Windows ARM64 构建**。
> 在 Windows ARM64 平台上语音子系统（STT/TTS/唤醒/热键）整体不可用，
> 所有语音相关界面入口（麦克风按钮、语音设置页）会自动隐藏。
> 其余功能不受影响。详见 [平台支持](#平台支持)。

### 硬件与 IoT 支持

集成了针对物理外设的对接能力，包含 `CIBYP-TRNG` (真随机数生成器) 硬件通信支持和各种基于串口控制的功能扩展。

### 精致的用户界面

- 清新青春的视觉风格，动画流畅、交互友好
- 深浅色主题自动适配系统（跟随系统、浅色、深色）
- 强调色和背景色可自由定制，包含丰富推荐配色
- 本地化 Font Awesome 6.x 图标（无 Emoji）

### 前沿技术集成

- **MCP 协议**：完整支持 Model Context Protocol
- **多模型支持**：LLM 和扩散式生图模型分别配置 API、密钥、参数
- **本地 GeoGebra**：内置本地化的 GeoGebra JS 数学引擎（离线可用）
- **OCR 识别**：集成 Tesseract 进行本地文字识别
- **技能系统**：创建、管理、更新自定义 AI 技能

### 工作区与文件管理

- 自动创建工作区用于任务执行
- 支持文件拖拽、粘贴、摄像头导入
- 文件二进制高效传输，无内存溢出风险
- 自动保存到工作区根目录

---

## 平台支持

| 平台 | 架构 | 构建 | 语音功能 | 备注 |
|------|------|------|----------|------|
| Windows 10/11 | x64 | ✅ | ✅ | 完整功能 |
| Windows 11 | **arm64** | ✅ | ❌ | 语音不可用（见下） |
| macOS | x64 | ✅ | ✅ | Intel |
| macOS | arm64 | ✅ | ✅ | Apple Silicon |
| Linux | x64 | ✅ | ✅ | 社区静态 aria2 构建 |

### Windows ARM64 局限性

- 语音引擎 sherpa-onnx-node 官方不提供 `win32-arm64` 原生库（npm 无
  `sherpa-onnx-win-arm64` 包，addon 加载为空），因此语音功能（STT/TTS/
  语音唤醒/全局热键）在 Windows ARM64 上**整体不可用**。
- 应用会自动检测并隐藏所有语音相关入口：麦克风按钮、语音设置页
  （语音输入、语音朗读、语音唤醒、热键设置均不显示），主进程不初始化
  语音引擎、不注册热键，其余功能完全正常。
- Windows ARM64 打包产物为 arm64 原生版；aria2 无 Windows ARM64 官方
  二进制，使用 x64 版（Windows 11 可原生运行 x64 程序）。

---

## 系统要求

- **Node.js**: >= 18.x
- **NPM**: >= 9.x
- **操作系统**: Windows 10+、macOS 10.15+、Linux (x64)
- **内存**: >= 4GB RAM（语音功能建议 >= 8GB）
- **存储**: >= 1GB 可用空间（语音模型与 OCR 数据额外占用约 500MB）

---

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/B5-Software/Could-I-Be-Your-Partner.git
cd Could-I-Be-Your-Partner
```

### 2. 安装依赖

```bash
npm install
```

### 3. 开发运行

```bash
npm start
```

> `npm start` 会自动拼接 `app.js`（见下文"app-parts 结构"）后启动 Electron。

### 4. 构建打包

所有构建命令都会自动执行 `prepare-build-assets`（下载 aria2、OCR、
Font Awesome、Three.js、IME 词库等被 `.gitignore` 忽略的资源）。

```bash
# Windows x64
npm run build:win:x64

# Windows ARM64（语音不可用，见"平台支持"）
npm run build:win:arm64

# macOS Intel / Apple Silicon
npm run build:mac:x64
npm run build:mac:arm64

# Linux
npm run build:linux

# 所有平台
npm run build
```

打包产物输出到 `dist/`：

- Windows: `*.exe`（NSIS 安装包）
- macOS: `*.dmg` + `*-mac.zip`（自动更新用）
- Linux: `*.AppImage` / `*.deb`

### 5. 运行测试

```bash
npm test
```

---

## 构建资源说明

以下第三方资源被 `.gitignore` 忽略（不在版本库中），**克隆后首次构建
必须先行准备**。所有 `build*` 脚本已自动调用
`scripts/prepare-build-assets.js` 完成该步骤：

| 资源 | 目录 | 来源 | 用途 |
|------|------|------|------|
| aria2 二进制 | `assets/aria2/{os}-{arch}/` | GitHub Releases（官方 win/mac，musl 静态 linux） | 下载管理器，打包必需（extraResources） |
| 语音模型 / 音色 / UI 字体 / GeoGebra 离线包 | `assets/voice-models/`、`assets/ui-fonts/`、`assets/geogebra-app/` | `scripts/download-voice-models.js` | STT/TTS、界面字体、GeoGebra 离线运行 |
| Tesseract OCR 训练数据 | `assets/ocr/` **及根目录**（两处各一份） | `scripts/fetch-assets.sh` / `.ps1` | 本地 OCR 识别 |
| Font Awesome | `assets/fonts/`、`assets/webfonts/` | `scripts/fetch-assets.sh` / `.ps1` | 本地图标库 |
| Three.js | `assets/lib/three/` | `scripts/fetch-assets.sh` / `.ps1` | PCB-EDA 3D 预览 |
| IME 词库 | `assets/ime/` | `scripts/build-ime-dicts.js` | 中文/英文/德文输入预测 |

手动准备（不通过构建命令时）：

```bash
node scripts/prepare-build-assets.js     # aria2 + OCR + FA + Three + IME
node scripts/download-voice-models.js    # 语音模型 + UI 字体 + GeoGebra 离线包
```

`fetch-assets.sh` 支持镜像参数 `--mirror <前缀>`（GitHub 镜像，GFW 环境可用），
以及 `--skip-geogebra`、`--skip-ocr`、`--skip-three`、`--skip-fontawesome`、
`--tessdata-variant <standard|fast|best>`；`fetch-assets.ps1` 提供对应
`-Mirror`、`-Skip*`、`-TessdataVariant` 参数。

---

## 项目结构

```text
.
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── main.js             # 入口：窗口管理、IPC 组装、数据持久化
│   │   ├── voice-ipc.js        # 语音子系统（IPC/语音条/唤醒/热键；win-arm64 自动禁用）
│   │   ├── voice-engine.js     # sherpa-onnx 语音引擎（STT/TTS）
│   │   ├── voice-worker.js     # 语音 worker（按平台加载 sherpa addon）
│   │   ├── ocr.js              # Tesseract OCR（assets/ocr → userData）
│   │   ├── update-checker.js   # GitHub Releases 自动更新检查
│   │   ├── mcp-service.js      # MCP 协议服务
│   │   ├── terminal-service.js # 终端集成（node-pty）
│   │   └── ...                 # 邮件、表格、Web 控制、沙箱、数学工具等
│   ├── preload/                 # 预加载脚本（preload.js 暴露 IPC 桥）
│   ├── renderer/                # 渲染进程（UI 层）
│   │   ├── js/
│   │   │   ├── app.js          # ★ 拼接产物（勿手改！见 app-parts）
│   │   │   ├── app-parts/      # ★ 主控制器源码，按文件名顺序拼接成 app.js
│   │   │   │   ├── 01-app-init.js
│   │   │   │   ├── 05-chat-ui.js
│   │   │   │   ├── 06-tools-skills-settings.js
│   │   │   │   └── ...         # 11 个 part（另有 app-parts/README.md 说明）
│   │   │   ├── voice-ui.js     # 主窗口语音控制器（麦克风按钮/听写）
│   │   │   ├── agent.js        # AI Agent 引擎核心（指令与工具路由）
│   │   │   ├── context-manager.js  # 上下文管理系统
│   │   │   ├── tools-def.js    # 工具定义（120+ 工具）
│   │   │   └── ...             # 表格、主题、历史、小游戏、子应用等
│   │   ├── css/
│   │   └── pages/
│   │       ├── index.html      # 主 HTML 模板
│   │       └── ...             # 语音条、采集页、小游戏子界面等
│   ├── data/
│   │   └── tarot.js            # 塔罗牌数据（78 张牌）
│   └── tools/
│       └── js-runner.js        # 安全与隔离的 JavaScript 代码执行容器
├── assets/                      # 本地化静态资源（大多被 .gitignore，见"构建资源说明"）
├── scripts/                     # 构建/资源下载脚本（见"构建资源说明"）
├── IoT-Firmware/
│   └── CIBYP-TRNG/              # 真随机数硬件对接固件源码
├── tests/
│   └── run-tests.js            # 测试框架
├── package.json                 # NPM 项目配置
└── README.md                    # 本文件
```

---

## app-parts 结构（重要）

`src/renderer/js/app.js` **不是手写源码**，由
`src/renderer/js/app-parts/*.js` 按文件名顺序拼接生成（ESM 输出），
页面通过 `<script type="module">` 加载。

- 所有 part 共享同一个作用域，可互相直接引用
- **修改 UI 控制器请编辑 app-parts 中的对应文件**，不要直接改 `app.js`
- 改完后运行 `npm run build-app-bundle` 重新拼接
- `npm start`、`npm test` 和打包脚本会自动执行拼接，通常无需手动运行

---

## 核心模块说明

### 语音子系统（`voice-ipc.js` / `voice-engine.js`）

- `voice-ipc.js`：语音 IPC、语音条窗口、麦克风采集窗、唤醒词、全局热键
- `voice-engine.js`：sherpa-onnx STT/TTS 引擎封装
- **平台检测**：`VOICE_SUPPORTED = !(win32 && arm64)`。
  不支持时注册最小 IPC 集（`voice:getStatus` 返回 `supported: false`），
  渲染进程据此隐藏全部语音 UI 入口。

### Agent 引擎（`agent.js`）

AI Agent 的大脑，负责：维护对话上下文和状态、执行工具调用和决策、
管理 SubAgent、处理终端和长期记忆、执行安全检查。

### 上下文管理（`context-manager.js`）

智能管理 LLM 上下文窗口：监测令牌使用量、自动摘要和清理旧内容、
优先级管理、内存和知识库的动态注入。

### 更新检查（`update-checker.js`）

启动时检查 GitHub Releases 最新版本（`v<version>` tag），
支持 semver 预发布版本（含 `-` 的版本号按 prerelease 处理），
下载 `*-mac.zip` / `*.exe` 增量更新包。

### 工具定义（`tools-def.js`）

120+ 工具，核心分类：

| 分类 | 工具 | 说明 |
|------|------|------|
| **文件** | readFile, editFile, createFile, deleteFile, listDirectory 等 | 完整文件系统访问 |
| **代码** | runJavaScriptCode, runShellScriptCode, runNodeJavaScriptCode | 安全代码执行 |
| **终端** | makeTerminal, runTerminalCommand, awaitTerminalCommand, killTerminal | 终端集成 |
| **网络** | webSearch, webFetch, downloadFile, httpRequest, ping, dnsLookup 等 | 网络运维 |
| **知识与记忆** | knowledgeBase*, memory* | 知识库与长期记忆 |
| **多模态** | generateImage, extractTextFromImage, officeUnpack 等 | 图片生成/OCR/Office |
| **数学** | calculator, matrixMath, vectorMath, solvePolynomial 等 | 高等数学计算 |
| **IoT/串口** | serialListPorts, serialOpenPort, serialWritePort, serialReadPort | 硬件交互 |
| **可视化** | initGeogebra, addCanvasObject, askQuestions, inviteGame | 数学引擎/小游戏 |

---

## 主要配置

用户配置通过设置面板修改（`settings:get` / `settings:set` IPC），
核心配置项包括：

- **LLM**：`apiUrl`、`apiKey`、`model`、`temperature`、`maxContextLength`
- **生图**：`apiUrl`、`apiKey`、`model`、`imageSize`
- **AI 人设**：`name`、`personality`、`bio`、`pronouns`、`customPrompt`
- **主题**：`mode`（auto/light/dark）、`accentColor`、`backgroundColor`
- **语音**（语音可用平台）：STT 模型（base/tiny）、TTS 音色/语速/音量、
  唤醒词列表、热键

---

## 工作原理

### 对话流程

```text
用户输入
  ↓
Agent.run() 开始自主工作
  ↓
发送消息到 LLM，获取响应
  ↓
解析工具调用（如有）
  ↓
执行工具 → 获取结果
  ↓
将结果注入拓展提示，继续对话
  ↓
重复直到 Agent 认为任务完成
  ↓
返回最终结果给用户
```

### 文件上传流程（优化版）

```text
文件拖拽/粘贴/摄像头
  ↓
读取为 ArrayBuffer（NOT base64！）
  ↓
通过 IPC 发送二进制数据
  ↓
主进程直接写入文件系统
  ↓
避免了 btoa() 导致的大文件栈溢出
```

### 语音不可用平台的降级（Windows ARM64）

```text
应用启动
  ↓
voice-ipc.js 检测 win32 + arm64
  ↓
VOICE_SUPPORTED = false：不初始化引擎/不注册热键
  ↓
voice:getStatus 返回 { supported: false }
  ↓
渲染进程隐藏：麦克风按钮 ×3、语音设置页
```

---

## 开发指南

### 修改 UI 控制器

1. 编辑 `src/renderer/js/app-parts/` 下对应的 part 文件
2. 运行 `npm run build-app-bundle` 重新拼接 `app.js`

### 添加新工具

1. 在 `tools-def.js` 中添加工具定义（name/desc/icon/category/sensitive）
2. 在 `agent.js` 的 `handleToolCall()` 中实现逻辑

### 添加 IPC 处理器

在 `src/main/main.js` 中：

```javascript
ipcMain.handle('custom:action', async (event, params) => {
  try {
    // 执行操作
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
```

### 修改 UI 主题

编辑 `src/renderer/css/theme.css` 的 CSS 变量。

---

## 许可证

本项目采用 **GPLv3 或更新版本** (GPL-3.0-or-later) 许可。

所有源代码文件均包含 SPDX 许可证标识：

```text
SPDX-License-Identifier: GPL-3.0-or-later
Copyright (c) 2026 B5-Software
```

详见 [LICENSE](./LICENSE) 文件。

---

## 常见问题

### Q: 数据存储在哪里？

A: 用户数据存储在系统用户目录下：

- Windows: `%APPDATA%\Could I Be Your Partner`
- macOS: `~/Library/Application Support/Could I Be Your Partner`
- Linux: `~/.config/Could I Be Your Partner`

工作区文件默认存储在 `~/Documents/Could-I-Be-Your-Partner`。

### Q: Windows ARM64 上为什么没有麦克风按钮和语音设置？

A: 语音引擎 sherpa-onnx-node 不提供 Windows ARM64 原生库，该平台上语音
功能整体不可用。应用会自动检测并隐藏全部语音入口，属于预期行为。

### Q: 克隆后直接打包报 aria2 相关错误？

A: 首次克隆缺少被 `.gitignore` 忽略的构建资源。直接使用
`npm run build:*` 会自动准备；若自定义打包流程，先执行
`node scripts/prepare-build-assets.js` 与 `node scripts/download-voice-models.js`。

### Q: GFW 环境下资源下载失败？

A: `fetch-assets.sh` 支持 `--mirror <前缀>`（如
`https://ghproxy.com`）；aria2 二进制下载失败仅警告不阻塞
（`--all` 模式），可重试 `node scripts/download-aria2.js --all`
或手动放置二进制到 `assets/aria2/<os>-<arch>/`。

### Q: 如何自定义 AI 人设？

A: 进入设置面板 → AI 人设，修改名称、性格、个人简介、代词和自定义 Prompt。

---

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Electron | 40.x | 桌面应用框架 |
| Node.js | >= 18.x | 后端运行时 |
| Vanilla JavaScript | ES2020+ | 前端逻辑（ESM） |
| Font Awesome | 6.x | 本地图标库 |
| sherpa-onnx-node | 1.13.x | 本地语音识别与合成（无 win-arm64） |
| node-pty | 1.x | 终端集成（含 win32-arm64 prebuild） |
| Tesseract.js | - | OCR 文字识别 |
| GeoGebra | - | 本地数学引擎（离线包） |
| Three.js | 0.160.x | PCB-EDA 3D 预览 |
| KaTeX | - | 数学公式渲染 |
| x-spreadsheet | - | 内嵌电子表格面板 |
| electron-builder | 25.x | 应用打包工具 |

---

## 联系方式

- **开发者**: B5-Software
- **项目**: https://github.com/B5-Software/Could-I-Be-Your-Partner

---

**享受 AI 的力量，让任务自动完成！** 🚀