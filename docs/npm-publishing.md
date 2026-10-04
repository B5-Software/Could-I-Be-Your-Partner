# npm 启动器分发

npm **只发布一个纯 JS 包 cibyp**，不包含二进制，不生成平台包或分包。完整 GUI/TUI、Electron、Code-OSS、Node.js 与原生依赖存放于官方 GitHub Release。

```sh
npm i -g cibyp
cibyp            # GUI；没有图形环境则进入 TUI
cibyp-tui        # TUI
cibyp-code       # Code TUI，以终端当前目录为宿主工作区
npx cibyp
npx --package=cibyp cibyp-code
cibyp update     # 更新 App 运行时，无需更新 npm 启动器
```

安装需要 Node.js >= 22.14 和 tar（Windows 10+、macOS、Linux 系统自带）。安装脚本获取当前系统/架构的 GitHub 二进制，验证 SHA-256 后解包缓存，并注册当前用户的应用启动器。设置、历史、VM 和工作区仍由 App 的共享数据目录管理。

## 下载、镜像与更新

GitHub 官方 API 与官方清单提供文件大小及 SHA-256；镜像不能提供校验依据。自动探测 GitHub、gh-proxy.com 和 ghfast.top，选择可用的低延迟来源。支持四连接分段下载、失败重试、流式回退；来源篡改或哈希不一致时删除临时文件并切换来源。校验通过前不解包、不执行。官方元数据不可用且没有有效缓存时明确失败。

正常启动每六小时检查一次 App 更新。更新准备完成后原子切换缓存指针，启动失败的下载不会替换已经验证的旧版。自动检查失败可继续使用旧版；显式 `cibyp update` 会报告失败。旧版本保留以免影响运行中的进程，用户数据不参与缓存替换。Windows 开始菜单、macOS ~/Applications、Linux applications 中的 GUI 入口也经过启动器，支持相同更新行为；npx 临时目录清理不影响它们。

`cibyp --no-update` 强制离线使用缓存。`cibyp --channel=stable` / `--channel=preview` 持久化发布通道，默认 preview 支持 alpha。没有匹配通道的完整二进制时不会偷偷跨通道。

可配置环境变量：

| 变量                       | 作用                                                    |
| -------------------------- | ------------------------------------------------------- |
| CIBYP_CACHE_DIR            | 自定义运行时缓存，安装与启动保持一致                    |
| CIBYP_MIRRORS              | `off` 关闭镜像，或逗号分隔 HTTPS 镜像前缀，支持 `{url}` |
| CIBYP_DOWNLOAD_CONCURRENCY | 并行连接数 1–8，默认 4                                  |
| CIBYP_SKIP_INSTALL         | `1` 跳过安装时下载，首次启动再下载                      |

默认缓存位于 LocalAppData、Library/Caches 或 XDG_CACHE_HOME 下的 cibyp/npm。`cibyp --install-only` 修复缓存与用户启动入口。

`cibyp-code` 将当前宿主目录按 GUI 同样的映射及双向同步进入 VM；`/workspace` 更换工作区，`/workspace sync` 取回产物，`/cwd` 打开同步后的宿主目录。

## 版本与 CI

**App 版本与启动器版本独立。** App 版本来自根 package.json；启动器版本来自 packages/npm/package.json。`cibyp --version` 查看启动器版本，`cibyp --runtime-version` 查看缓存 App 版本。App 更新只发布 GitHub 二进制；启动器无需为了每次 App 发版更新 npm。

build-release 在 App 版本变化时构建六个平台，分别生成完整 runtime tar.gz 和 SHA-256 元数据。脚本核对成功的 main 构建与归档哈希，上传运行时和系统安装包，最后上传 cibyp-runtime.json；启动器只选择具有完整清单的 Release。

已有六平台成功构建可在 build-release 手动填入 `runtime_run_id`，将运行时追加到已有同版本 Release。不会移动标签或覆盖已有安装包；同名资产只有大小及 SHA-256 相同才跳过，否则拒绝替换。

npm-launcher 在 build-release 成功后检查启动器独立版本；已发布则跳过，只有新版本才准备和发布一个小包。也可手动运行 npm-launcher。发布脚本拒绝额外包、dependencies、optionalDependencies、二进制及超过 256 KiB 的压缩包，并等待 registry 确认可安装。npm 不可覆盖已发布版本；仅启动器逻辑变化时递增其自身版本。

## 登录 npm 与配置 CI

公开包安装无需登录。维护者本机登录：

```sh
npm login --registry=https://registry.npmjs.org/ --auth-type=web
npm whoami --registry=https://registry.npmjs.org/
```

按终端提示完成浏览器认证。本机登录与 GitHub Actions 身份独立。首次创建 cibyp 可使用拥有 publish 权限的 granular Token，将其存为仓库 NPM_TOKEN Secret。配置允许无人值守发布所需的认证方式。不要将 Token 写入代码或提交。

cibyp 创建后可仅为这个包配置 Trusted Publisher：GitHub owner B5-Software，repository Could-I-Be-Your-Partner，workflow **npm.yml**。之后删除 NPM_TOKEN Secret 即可使用 OIDC 临时凭据。工作流具有 id-token: write，发布带 provenance。

参考：[npm 登录](https://docs.npmjs.com/cli/v12/commands/npm-login/)、[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。

## 本地核验

```sh
# 启动器打包不需要下载二进制：
npm run prepare:npm -- --output npm-dist
# 输出必须是新的空目录，仅有 cibyp 一个包。
node --test tests/unit/npm-distribution.test.cjs tests/unit/npm-download.test.cjs tests/unit/npm-publication.test.cjs
# 受支持的 CI 中发布并生成 provenance：
npm run publish:npm -- npm-dist
```
