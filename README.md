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

### 丰富的内置小游戏与扩展

- 内置益智类游戏服务：支持「飞花令」、「谁是卧底」等内嵌交互式娱乐。
- 内联支持：使用应用内的单独页面弹窗直接进行游玩。

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
- **本地 GeoGebra**：内置本地化的 GeoGebra JS 数学引擎
- **OCR 识别**：集成 Tesseract 进行本地文字识别
- **技能系统**：创建、管理、更新自定义 AI 技能

### 工作区与文件管理

- 自动创建工作区用于任务执行
- 支持文件拖拽、粘贴、摄像头导入
- 文件二进制高效传输，无内存溢出风险
- 自动保存到工作区根目录

---

## 系统要求

- **Node.js**: >= 18.x
- **NPM**: >= 9.x
- **操作系统**: Windows 10+、macOS 10.13+、Linux (x64)
- **内存**: >= 4GB RAM
- **存储**: >= 500MB 可用空间

---

## 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd Could-I-Be-Your-Partner-Dev
```

### 2. 安装依赖

```bash
npm install
```

### 3. 开发运行

```bash
npm start
```

### 4. 构建打包

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux

# 所有平台
npm run build
```

### 5. 运行测试

```bash
npm test
```

---

## 项目结构

```text
.
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── main.js             # 主进程文件，IPC 处理器、数据持久化
│   │   ├── email-service.js    # 邮件底层服务
│   │   ├── spreadsheet-io.js   # 基于本地的表格处理 IO
│   │   └── web-control-service.js # Web 自动化控制
│   ├── preload/                 # 预加载脚本
│   │   ├── preload.js          # 主 IPC 通道暴露
│   │   └── *-preload.js        # 多窗口（飞花令/谁是卧底等）专用上下文桥
│   ├── renderer/                # 渲染进程（UI 层）
│   │   ├── js/
│   │   │   ├── app.js          # 主应用控制器
│   │   │   ├── agent.js        # AI Agent 引擎核心包含指令与工具路由
│   │   │   ├── context-manager.js  # 上下文管理系统
│   │   │   ├── spreadsheet.js  # 数据表格前端逻辑
│   │   │   ├── tools-def.js    # 工具定义（120+ 工具）
│   │   │   └── sanguosha.js / undercover.js / flyingflower.js # 子应用小游戏逻辑
│   │   ├── css/
│   │   │   └── *.css           # 聊天、主题与各个小游戏特定功能界面样式
│   │   └── pages/
│   │       ├── index.html      # 主 HTML 模板
│   │       └── *.html          # 小游戏子界面等
│   ├── data/
│   │   └── tarot.js            # 塔罗牌数据（78 张牌）
│   └── tools/
│       └── js-runner.js        # 安全与隔离的 JavaScript 代码执行容器
├── assets/                      # 本地化静态核心资源 (GeoGebra, Tesseract OCR 等)
├── IoT-Firmware/              
│   └── CIBYP-TRNG/              # 真随机数或 IoT 硬件对接固件源码
├── tests/
│   └── run-tests.js            # 测试与 CI 框架
├── package.json                 # NPM 项目配置
├── instruction                  # 项目需求文档
└── README.md                    # 本文件
```

---

## 核心模块说明

### Agent 引擎 (`agent.js`)

AI Agent 的大脑，负责：

- 维护对话上下文和状态
- 执行工具调用和决策
- 管理 SubAgent（子代理）
- 处理终端和长期记忆
- 执行安全检查

**关键类**: `Agent`
**关键方法**: `init()`, `run()`, `handleToolCall()`, `addMessage()`

### 上下文管理 (`context-manager.js`)

智能管理 LLM 上下文窗口，防止溢出：

- 监测令牌使用量
- 自动摘要和清理旧内容
- 优先级管理系统
- 内存和知识库的动态注入

### 应用控制器 (`app.js`)

主 UI 控制器，处理：

- 消息发送/接收
- 文件附件管理（拖拽、粘贴、摄像头）
- 设置面板
- 工作区管理
- IPC 通信

**关键事件**:

- 文件拖拽上传（无 base64 转换，直接 ArrayBuffer）
- 粘贴导入（自动检测图片/文件）
- 摄像头捕获（实时预览）

### 工具定义 (`tools-def.js`)

目前包含 120+ 工具的完整列表（由于种类繁多，仅展示核心类）：

| 分类 | 工具 | 说明 |
|------|------|------|
| **文件** | readFile, editFile, createFile, deleteFile, moveFile, copyFile, listDirectory, 等 | 完整文件系统访问 |
| **代码** | runJavaScriptCode, runShellScriptCode, runNodeJavaScriptCode | 安全代码执行 |
| **终端** | makeTerminal, runTerminalCommand, awaitTerminalCommand, killTerminal | 终端集成 |
| **网络** | webSearch, webFetch, downloadFile, httpRequest, ping, dnsLookup, portScan 等 | 爬虫抓取与网络运维命令对接 |
| **知识与记忆** | knowledgeBaseSearch/Add/Update/Delete, memory* | 长期知识与对话记忆管理 |
| **多模态与格式** | generateImage, extractTextFromImage, officeUnpack, officeWordExtract | 图片生成/文字识别，Office拆解 |
| **计算与表格** | calculator, matrixMath, vectorMath(含7维), solvePolynomial, sum, 等 | 最全的高等数学计算及基于Spreadsheet的表格查询修改 |
| **IoT/串口** | serialListPorts, serialOpenPort, serialWritePort, serialReadPort | 对发开发板和内接硬件支持 |
| **可视化互动** | initGeogebra, addCanvasObject, askQuestions, inviteGame(飞花令等) | 绘画几何、多模态收集与内置小游戏启动 |

### 塔罗数据 (`tarot.js`)

包含 78 张塔罗牌的中英文定义：

- 22 张 Major Arcana
- 56 张 Minor Arcana（4 种花色 × 14 级）
- 每张牌含：正位义、逆位义、Font Awesome 图标

---

## 主要配置

编辑 `src/renderer/js/tools-def.js` 可配置工具启用/禁用。

### 用户可配置项（Settings）

#### LLM 配置

```javascript
{
  "llm": {
    "apiUrl": "xxx",
    "apiKey": "sk-xxx",
    "model": "xxx",
    "temperature": 0.7,
    "maxContextLength": 8192
  }
}
```

#### 生图配置

```javascript
{
  "imageGeneration": {
    "apiUrl": "xxx",
    "apiKey": "xxx",
    "model": "xxx",
    "imageSize": "1024x1024"
  }
}
```

#### AI 人设

```javascript
{
  "aiPersona": {
    "name": "Partner",
    "personality": "活泼可爱、热情友善",
    "bio": "你的全能AI伙伴~",
    "pronouns": "Ta",
    "customPrompt": "..." // 自定义前缀 Prompt
  }
}
```

#### 主题

```javascript
{
  "theme": {
    "mode": "auto",  // "auto" | "light" | "dark"
    "accentColor": "#007AFF",
    "backgroundColor": "#FFFFFF"
  }
}
```

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

### 上下文管理流程

```text
新消息 → 估算令牌数
  ↓
检查 maxContextLength
  ↓
如果超出：
  - 摘要旧消息
  - 优先保留最近对话
  - 保留系统提示和知识库
  ↓
防止 "Maximum call stack exceeded" 错误
```

---

## IPC 通信接口

主进程 (`src/main/main.js`) 暴露以下 IPC 处理器：

### 文件操作

- `fs:readFile` - 读取文件
- `fs:writeFile` - 写入文件
- `fs:saveUploadedFile` - 保存上传文件（二进制）
- `fs:deleteFile` - 删除文件
- `fs:listDirectory` - 列出目录

### 设置

- `settings:get` - 获取设置
- `settings:set` - 保存设置

### 历史记录

- `history:list` - 列出对话历史
- `history:load` - 加载对话记录
- `history:delete` - 删除某条历史
- `history:rename` - 重命名对话

### 工作区

- `workspace:create` - 创建新工作区
- `workspace:getFileTree` - 获取文件树

### 知识库和记忆

- `knowledge:search` - 搜索知识库
- `knowledge:add` - 添加知识
- `knowledge:update` - 更新知识
- `knowledge:delete` - 删除知识

- `memory:search` - 搜索记忆
- `memory:add` - 添加记忆
- `memory:update` - 更新记忆
- `memory:delete` - 删除记忆

### 系统

- `system:getInfo` - 获取系统信息
- `system:screenshot` - 截屏
- `clipboard:read` - 读取剪贴板
- `clipboard:write` - 写入剪贴板

---

## 开发指南

### 添加新工具

1. 在 `tools-def.js` 中添加工具定义：

```javascript
{
  name: 'myTool',
  desc: '我的自定义工具',
  icon: 'fa-star',
  category: '自定义',
  sensitive: false  // true 表示敏感操作需确认
}
```

2. 在 `agent.js` 的 `handleToolCall()` 中实现逻辑：

```javascript
case 'myTool':
  // 实现工具逻辑
  return { ok: true, result: data };
```

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

编辑 `src/renderer/css/theme.css` 的 CSS 变量：

```css
:root[data-theme="light"] {
  --primary: #007AFF;
  --surface: #FFFFFF;
  --text: #000000;
  /* 更多变量... */
}
```

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

### Q: 如何自定义 AI 人设？

A: 进入设置面板 → AI 人设，修改名称、性格、个人简介、代词和自定义 Prompt。

---

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Electron | ^30.x/40.1.0 | 桌面应用框架 |
| Node.js | >= 18.x | 后端运行时 |
| HTML5/CSS3 | - | UI 标记和样式 |
| Vanilla JavaScript | ES2020+ | 前端逻辑 |
| Font Awesome | 6.x | 本地图标库 |
| KaTeX | - | 数学公式渲染 |
| GeoGebra | - | 数学引擎 |
| Tesseract | - | OCR 文字识别 |
| Playwright(概念) / Fetch | - | 基于无头环境和fetch的高级网页渲染抓取 |
| x-spreadsheet | - | 精简内嵌的可视化电子表格面板驱动 |
| electron-builder | ^24.x / 25.x | 应用打包工具 |

---

## 联系方式

- **开发者**: B5-Software
- **项目开始日期**: 2026 年

---

**享受 AI 的力量，让任务自动完成！** 🚀
