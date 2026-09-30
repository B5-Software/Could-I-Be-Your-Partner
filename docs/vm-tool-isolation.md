# VM 工具运行与文件边界

运行位置选择 VM 后，工具失败会明确报错，禁止自动执行宿主文件处理器。
这次修复覆盖了旧实现里的宿主暂存文件、自动导入未映射文件、离线回退、错误工作目录和跨模式复用浏览器的问题。

| 功能 | 实际执行与文件位置 |
| --- | --- |
| 文件读写、搜索、移动、复制、目录创建 | VM 的 SFTP / SSH 文件系统；未映射的宿主路径报错 |
| Shell、Python、Node、JS | VM 中的解释器；进入实际工作目录，失败时不会落到默认目录或宿主 |
| Word、PPT、表格、Office 解包、知识文件导入 | Linux Node worker 在 VM 中处理和写入文件 |
| 图片 OCR、二维码、音视频、ESLint、网络工具 | 在 VM 中执行；依赖缺失时安装到 VM 或明确报错 |
| Playwright | App 运行控制代码，经 SSH 转发连接 VM 的 Chromium；网页、浏览器资料和截图在 VM |
| CAD、EDA、GeoGebra | 界面与编辑计算在 App；打开、保存、恢复文件及所有导出直接读写 VM |
| 文件下载 | VM 内 aria2 下载，直接写入 VM 目录；校验和、进度、取消同样作用于该任务 |
| 附件、WebUI 上传、聊天媒体文件、生图文件 | 内容通过内存传输；工具的输入和输出文件存储在 VM |
| 本地 MCP | Linux 命令通过 guest SSH 启动；本地 HTTP 地址转发到 guest loopback；位置切换后旧连接须重连 |
| DeepSeek 插件工具 | 将插件发行代码传入 VM，在 Linux worker 加载和调用；不在宿主调用插件工具 |

App 的设置、会话历史、模型配置、资源安装目录和界面仍保存在宿主，这是应用管理数据。
远程 HTTP MCP、模型、生图和聊天平台 API 属于外部服务；其服务端执行位置不能由 VM 模式改变。
MCP 状态及工具返回值会标出 `host`、`vm` 或 `remote`。

**独立工作区**不回写宿主工程文件。**共享工作区**按用户配置同步副本到宿主；这些同步副本不改变工具的处理位置。
用户打开宿主项目时，既有导入流程把选中的项目复制进 guest。
普通文件工具及路径转换接口不再自动读取未映射的宿主文件。文件选择器在 VM 模式列出 VM 目录。

未配置串口透传时，串口工具明确报错。依赖宿主 Windows UIA 的桌面元素工具在 VM 模式保持禁用；VM 截图、键鼠和浏览器控制继续可用。
插件和 MCP 命令需要兼容 Linux；Windows 专属可执行文件不能在 VM 中运行，也不会因此回退到宿主。

验证包括完整应用启动、沙箱文件选择器、CAD/EDA 导出与恢复文件边界、错误与跨模式隔离测试，
以及正式 `0.3.1` Full 镜像的真实 QEMU 测试：Office、OCR、二维码、媒体、Linux Chromium、下载、ESLint、网络、插件、MCP。
真实 VM 测试使用临时用户盘，不访问或重置现有用户盘。

```powershell
npm run check
npm run test:desktop
node node_modules/electron/cli.js tests/integration/vm-file-picker-smoke.cjs
node tests/integration/vm-image-native.cjs "$env:APPDATA/could-i-be-your-partner/vm" 0.3.1 full tools
node tests/integration/vm-image-native.cjs "$env:APPDATA/could-i-be-your-partner/vm" 0.3.1 full boundaries
```

原生 VM 测试要求正式镜像与 QEMU 已安装。Linux / macOS 将镜像目录替换为相应 App 资源路径。
