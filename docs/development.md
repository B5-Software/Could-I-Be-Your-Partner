# 开发、构建与发布

日常使用的安装与命令见 [README](../README.md)。本文说明源码开发与发布流程。

## 本地运行

需要 Node.js ≥ 24.13.0、npm ≥ 11，以及对应平台的原生模块编译工具链。Windows 通常需要 Visual Studio C++ Build Tools；macOS 需要 Xcode Command Line Tools；Linux 需要 C/C++ 编译工具和 Electron 运行依赖。

```sh
npm ci
npm run prepare-build-assets
npm run download-assets
npm start
```

`npm start` 准备锁定版本的 Code-OSS、构建 macOS Computer Use 辅助程序及渲染入口，再启动 Electron。资源下载需要联网，首次构建时间较长。

```sh
npm run build-app-bundle
npm run tui
npm run webui
```

源码 TUI 与 WebUI 也需要先构建入口；它们连接同一个后台。可以用 `CIBYP_USER_DATA` 指定隔离的配置目录，避免开发进程操作日常数据。

## 源码与生成文件

- `src/main/`：后台、IPC、模型、存储、VM 与工具服务。
- `src/agent/`：前端无关的 Agent 宿主与能力门面。
- `src/renderer/js/app-parts/`：GUI / WebUI 共用界面源码，按 [清单](../src/renderer/js/app-parts/README.md) 合并。
- `src/renderer/core/`：TypeScript 界面组件。
- `src/preload/`：桌面预加载与浏览器能力适配。
- `src/shared/`：各前端共用的协议、设置与显示逻辑。
- `src/tui/`：终端界面及后台客户端。
- `packages/npm/`：纯 JavaScript 下载启动器；版本独立于桌面运行时。
- `integrations/`：Code-OSS、Tor 等组件的运行时锁定配置。

修改源码后运行 `npm run build-app-bundle`。请不要直接改生成的渲染包和预加载包，也不要将用户配置、密钥、下载缓存或截图混入发布产物。

## 验证

```sh
npm run check
npm run test:backend
npm run test:desktop
npm run test:codeoss
npm run test:codeoss:vm
npm run test:npm
```

`check` 包含 lint、格式、类型检查、单元测试和离线回归。集成测试使用隔离的用户目录和替身模型；GUI / WebUI 交互测试需要可用的图形环境。VM、Code-OSS 和平台原生能力的检查需要对应运行资源。

`npm run test:live` 会使用实际配置的模型，可能产生费用，只应显式运行。

## 平台打包

```sh
npm run build:win:x64
npm run build:win:arm64
npm run build:mac:x64
npm run build:mac:arm64
npm run build:linux:x64
npm run build:linux:arm64
```

这些命令先构建入口、准备资源，再调用 `scripts/package.js`。通常应在目标系统打包；原生依赖及签名不能仅靠更改架构参数跨平台完成。

`npm run dist` 只执行打包阶段，适合已完成资源准备的环境。移除命运之牌资源的构建入口是 `build:no-tarot` 及对应平台脚本。

打包资源包括 Code-OSS、Tor、下载器、CLI Node.js 和本地模型等。具体目录和筛选规则以 `package.json` 的 `build`、`scripts/prepare-build-assets.js` 及运行时锁定文件为准。

## CI 与发布

| Workflow | 职责 |
| --- | --- |
| [check.yml](../.github/workflows/check.yml) | 代码与平台检查 |
| [release.yml](../.github/workflows/release.yml) | 构建各平台产物并发布 GitHub Release / Prerelease |
| [npm.yml](../.github/workflows/npm.yml) | 发布纯 JS npm 启动器 |

桌面运行时发布到 GitHub；npm 包下载匹配系统和架构的运行时并校验 SHA-256。不要将六个平台的二进制分别上传为 npm 包。启动器的版本只在启动器本身改变时更新。

Release / Prerelease 发布时，`scripts/publish-runtime-assets.py` 从 GitHub 获取已公开版本，选择当前构建祖先中版本号最大的较早版本，收集两者之间的全部提交。日志包含分类后的提交标题、完整提交正文与 Compare 链接，同时写入发布说明并上传 `CHANGELOG.md`，最后才上传运行时清单。直接提交和合并提交都会收录，未发布的标签会跳过；重跑只替换标记范围内的自动日志，保留手写说明，并拒绝覆盖内容不同的已有附件。

本地预览指定版本的提交日志：

```sh
git fetch --tags
node scripts/generate-release-notes.cjs --repo B5-Software/Could-I-Be-Your-Partner --version 1.9.0-alpha.25 --output CHANGELOG.preview.md
```

本地默认依据 Git 标签选取上一版本；可用 `--from v<版本>` 显式指定范围，或用 `--published-tags <JSON文件>` 传入已发布标签数组以复现 CI。`--to <提交SHA>` 可固定待发布构建，避免分支继续推进改变日志。发布流程回归测试运行 `python3 tests/release-publisher.test.py`。

修改版本、提交和标签前，应完成相应离线及集成验证。已公开的版本和标签应保持不可变。npm 使用 Trusted Publishing，配置方法见 [npm 发布指南](npm-publishing.md)。
