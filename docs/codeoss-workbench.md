# Code 模式：原生 Code-OSS 工作台

Code 模式复用完整桌面工作台、扩展宿主、文件监视、终端、调试、Git、搜索、快捷键、编辑器和扩展管理。资源来自固定版本的 VSCodium 官方发行包，运行在 CIBYP 的 Electron 中，通过 `WebContentsView` 嵌入 Code 页面。主进程保留 Code-OSS 的窗口服务和独立 Electron session；CIBYP 自己的 profile、preload、协议和当前工作目录保持隔离。

## 使用与主题

打开 Code 模式，选择项目文件夹。IDE 自身的“打开文件夹”也会同步工作区、最近项目和 CIBYP Agent 会话。编辑器、资源管理器、终端等沿用原生布局，扩展可通过 Open VSX 或 VSIX 安装。

CIBYP 个性化设置实时发送到工作台，同步深浅色（含跟随系统）、强调色、背景色和减少动画设置。原生组件与 Agent 面板使用同一套颜色；编辑器语法色保留 Default Modern 的深浅色配色。工作台无需重启，工作区及文档继续保留。基础主题配置写在独立 IDE 用户 profile 中；运行期间通过原生配置服务的内存层保证 CIBYP 主题优先，不改写项目的 `.vscode/settings.json`。

原生侧栏提供 CIBYP Agent、会话切换、文件附件、当前选区/文档/诊断上下文、停止、工具审批、AI 修改差异和接受/撤销操作。Agent 沿用 CIBYP 当前模型、工具选择、预算和上下文管理。UTF-8 文本工具读写通过 IDE 文档处理：未保存编辑和读取后发生变化的文档会拒绝覆盖；AI 修改可在原生差异视图中检查。二进制及其他编码继续走原有文件工具。独立 IDE 窗口可运行普通扩展，CIBYP Agent 仅连接主窗口嵌入的工作台，避免混用项目会话。

## VM 工作区

桌面 UI 留在宿主，远程工作区通过 `cibyp-vm` resolver、SSH loopback 转发和匹配版本的远程扩展宿主连接到 VM。Workspace 类扩展、语言服务、Git、终端、调试和文件操作在 guest 执行；UI 类扩展留在宿主。这遵循 Code-OSS 的扩展宿主分类。

后端由独立 `cibyp-vm-os` 仓库的 0.4.1 镜像内置，App 只启动与连接服务。更新 OS 后无需在 App 内安装 IDE。客户端和服务端 commit 必须一致；旧镜像会显示更新提示。

导入宿主外部项目时保留 `.git`，跳过依赖和生成目录。持久来源标记可在 App 重启后恢复映射，避免覆盖 VM 中的新修改。Git worktree 的 `.git` 指针不能跨系统使用，此时应在 VM 内克隆再打开。需要完整 Linux 项目布局（如符号链接或大型非 Git 文件）时同样建议直接在 VM 中克隆。

## 固定版本与构建

`integrations/codeoss/runtime-lock.json` 固定版本、commit、六个桌面平台及两种 Linux 服务端架构的下载地址与 SHA-256。当前是 VSCodium 1.135.06055 / Code-OSS 1.135.0。调整版本时必须同时更新 OS 仓库的 lock 和镜像版本。

```sh
npm ci
npm run prepare:codeoss
npm start
npm run test:codeoss
```

打包钩子会自动准备当前目标的完整资源，存放在 `resources/codeoss/app`，保留上游原生模块、扩展和许可证。资源与下载缓存不提交到 Git。补丁按固定版本锚点校验，数量不符即失败；先校验并补丁临时目录，成功后再替换已有资源。`scripts/package.js` 是项目打包入口，包含可选依赖处理。升级时应检查 Electron 原生 ABI 和所有目标平台。

扩展的公开 API（`vscode.extensions.getExtension('cibyp.workbench').exports`）版本为 1，提供 `getContext`、`readDocument`、`applyEdit`、`getChanges`、`acceptChange`、`revertChange`、`sendTask`。它只能在可信工作区执行 Agent；编辑接口返回冲突状态，调用方必须检查返回结果。

## 验证与生态边界

Windows x64 的实际完整 App 测试覆盖扩展补全、TypeScript、Git、PTY、Node 调试、原生 AI 编辑及撤销、主题热切换、工作区切换和完整 Agent 工具调用。真实 QEMU Linux guest 测试覆盖远程语言服务、Git、终端、调试、AI 文件读写和导入恢复。VM 测试使用临时 overlay，不修改用户 VM：

```sh
npm run test:codeoss:vm -- <已安装的VM资源目录> <镜像版本> full
```

测试旧镜像时可显式追加固定版本服务端压缩包，测试仅向临时 guest 安装夹具；生产连接不执行安装。macOS、Linux 桌面宿主及 arm64 需要对应机器的原生回归。

Code-OSS / VSCodium 的开放扩展机制保留。Microsoft Marketplace 和部分专有扩展的授权、品牌限制或对官方 VS Code 的校验不等同于 Code-OSS API 兼容，不能保证所有专有扩展可用。上游许可证随资源保留；CIBYP 桥接代码遵循本仓库 GPL-3.0-or-later。
