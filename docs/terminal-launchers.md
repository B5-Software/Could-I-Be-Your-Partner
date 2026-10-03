# GUI 与 TUI 启动

安装 Windows Setup、macOS PKG 或 Linux DEB 后，新开终端即可运行：

```sh
cibyp
cibyp-tui
cibyp-tui --mode=code --workspace="你的本地目录"
```

`cibyp` 默认打开 GUI；当前没有可用的图形环境时，自动进入 TUI。
`cibyp-tui` 始终打开 TUI。两者共用设置、历史、待办和工作区同步，不能同时运行。
进程退出或崩溃后，单例锁由系统释放。

安装包自带经过 SHA-256 校验的 Node.js，用户无需另外安装 Node.js 或 npm。
Windows 安装器按所选的当前用户或所有用户安装范围追加命令目录到 PATH；
macOS PKG 在 `/usr/local/bin` 注册命令；Linux DEB 在 `/usr/bin` 注册命令。
安装器保留已有的其他 PATH 条目和命令。Windows 与 Linux 卸载时移除本安装添加的条目。
macOS 删除 App 后，可删除 `/usr/local/bin/cibyp`、`/usr/local/bin/cibyp-tui` 两个链接。

DMG、ZIP、AppImage 属于便携分发，不执行系统安装脚本。macOS 自动注册命令请使用 PKG；
DMG 用户也可以从 App 的 `Contents/Resources/cli` 目录直接运行两个命令。
Linux AppImage 可以直接执行 `./应用.AppImage --tui`；无图形环境时默认也进入 TUI。
Windows 可直接运行安装目录 `resources\cli` 下的 `cibyp.cmd`、`cibyp-tui.cmd`。

源码开发环境运行 `node bin/cibyp.js` 或 `npm run tui`。
TUI 中 `/sessions`、`/open`、`/delete`、`/rename` 提供会话选择列表，
`/workspace` 选择本地目录，`/workspace sync` 导出 VM 的文件到本地。
