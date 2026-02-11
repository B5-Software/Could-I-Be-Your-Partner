# Could I Be Your Partner

## 项目简介

**Could I Be Your Partner** 是一个基于 Electron 的桌面应用程序，旨在提供一个交互式的聊天和任务管理平台。用户可以通过该应用与智能代理进行交互，管理任务，上传附件，并使用内置的工具。

## 功能特性

- **聊天功能**：与智能代理进行实时对话。
- **任务管理**：添加、编辑和删除任务。
- **附件管理**：支持拖拽、粘贴和拍照上传附件。
- **主题切换**：支持多种主题样式。
- **工具集成**：内置多种工具，支持扩展。
- **GPLv3 许可**：完全开源，遵循 GPLv3 协议。

## 安装与运行

### 环境要求

- **操作系统**：Windows, macOS, Linux
- **Node.js**：版本 >= 16
- **npm**：版本 >= 7

### 安装步骤

1. 克隆项目到本地：

   ```bash
   git clone https://github.com/your-repo/Could-I-Be-Your-Partner.git
   cd Could-I-Be-Your-Partner
   ```

2. 安装依赖：

   ```bash
   npm install
   ```

3. 启动开发模式：

   ```bash
   npm start
   ```

4. 构建应用：

   ```bash
   npm run build
   ```

## 文件结构

```text
Could-I-Be-Your-Partner/
├── src/                # 源代码目录
│   ├── main/           # 主进程代码
│   ├── preload/        # 预加载脚本
│   ├── renderer/       # 渲染进程代码
│   └── data/           # 数据文件
├── assets/             # 静态资源
├── tests/              # 测试代码
├── package.json        # 项目配置文件
└── README.md           # 项目说明文件
```

## 许可证

本项目基于 [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) 协议开源。
