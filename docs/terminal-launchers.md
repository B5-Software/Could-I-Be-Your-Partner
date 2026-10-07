# GUI、TUI 与 WebUI 启动

安装 Windows Setup、macOS PKG 或 Linux DEB 后，新开终端即可运行：

```sh
cibyp
cibyp-tui
cibyp-code
cibyp-webui
cibyp-tui --mode=code --workspace="你的本地目录"
```

`cibyp` 默认打开 GUI；当前没有可用的图形环境时，自动进入 TUI。
`cibyp-tui` 始终打开 TUI。GUI、TUI 和 WebUI 可同时连接同一个后台，共用设置、会话、历史、待办和工作区同步。
单例锁约束后台实例；启动其他前端会复用已运行的后台。

`cibyp-webui` 后台启动 WebUI，不持续占用终端。需先配置访问密码；VM 模式下等待虚拟机就绪后开放服务器。有桌面环境时可从托盘打开 GUI、WebUI 或退出。`cibyp-webui --stop` 关闭共享后台，会断开其他已连接前端。

安装包自带经过 SHA-256 校验的 Node.js，用户无需另外安装 Node.js 或 npm。
Windows 安装器按所选的当前用户或所有用户安装范围追加命令目录到 PATH；
macOS PKG 在 `/usr/local/bin` 注册命令；Linux DEB 在 `/usr/bin` 注册命令。
安装器保留已有的其他 PATH 条目和命令。Windows 与 Linux 卸载时移除本安装添加的条目。
macOS 删除 App 后，可删除 `/usr/local/bin/cibyp`、`/usr/local/bin/cibyp-tui`、`/usr/local/bin/cibyp-code`、`/usr/local/bin/cibyp-webui` 四个链接。

DMG、ZIP、AppImage 属于便携分发，不执行系统安装脚本。macOS 自动注册命令请使用 PKG；
DMG 用户也可以从 App 的 `Contents/Resources/cli` 目录直接运行命令。
Linux AppImage 可以直接执行 `./应用.AppImage --tui`；无图形环境时默认也进入 TUI。
Windows 可直接运行安装目录 `resources\cli` 下的 `cibyp.cmd`、`cibyp-tui.cmd`、`cibyp-code.cmd`、`cibyp-webui.cmd`。

源码开发环境运行 `node bin/cibyp.js` 或 `npm run tui`。
TUI 中 `/sessions`、`/open`、`/delete`、`/rename` 提供会话选择列表，
`/workspace` 选择本地目录，`/workspace sync` 导出 VM 的文件到本地。

`cibyp-code` 进入 Code TUI，当前终端目录作为宿主工作区，VM 自动映射同步。

也可通过纯 JS npm 启动器下载经 SHA-256 校验的 GitHub GUI/TUI 二进制，并注册用户应用启动器，见 [npm 分发](npm-publishing.md)。
