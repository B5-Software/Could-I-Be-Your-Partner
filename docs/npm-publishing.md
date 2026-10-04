# npm 完整应用分发

用户安装与启动：

```sh
npm install -g cibyp
cibyp
cibyp-tui
cibyp-code
# 无全局安装：
npx cibyp
npx --package=cibyp cibyp-code
# 更新（替换启动入口，保留用户数据）：
npm install -g cibyp@latest
```

`cibyp-code` 固定进入 Code TUI，使用执行命令时的宿主当前目录。VM 模式下，
该目录通过与 GUI 相同的外部工作区映射/双向同步进入 VM。`/workspace` 可以再次选择，
`/workspace sync` 取回产物，`/cwd` 打开同步后的宿主目录。

## 安装内容与用户启动器

`cibyp` 是统一命令入口，optionalDependencies 按 OS/CPU 选择六种平台之一。
平台包依赖相同版本的 payload 分包（每段最多 64 MiB），避免单个 npm 上传请求过大。
完整运行时来自正式 CI 打包输出，包含 Electron、Code-OSS、Node.js 和原生依赖。
内嵌 tar 保留 macOS Framework 链接和 Unix 执行权限；postinstall 在本地拼接、校验 SHA-256
并解包到用户缓存。运行时不依赖首次启动再下载 GitHub 资产。VM 镜像仍使用现有独立下载机制。

安装与更新注册同一个用户入口：Windows 开始菜单 `CIBYP.lnk`、macOS
`~/Applications/CIBYP.app`、Linux 用户 applications 下的 `cibyp.desktop`。
新版本使用独立缓存目录，再更新启动入口。不会删除运行中的旧版或用户数据。
忽略安装脚本时，可运行 `cibyp --install-only` 进行本地修复；无需额外下载。
默认缓存位置为 LocalAppData、Library/Caches 或 XDG_CACHE_HOME 下的 `cibyp/npm`。

## 登录 npm 与配置 CI

公开包的安装和运行无需登录。维护者发布时，在本机终端执行：

```sh
npm login --registry=https://registry.npmjs.org/ --auth-type=web
npm whoami --registry=https://registry.npmjs.org/
```

按终端提示打开浏览器，使用 npm 账号登录并完成认证；没有账号可先在
[npm 注册](https://www.npmjs.com/signup)。`npm whoami` 显示账号名即表示本机登录成功。
显式指定官方 registry 可以避免本机镜像源影响登录。

本机登录不会自动授权 GitHub Actions。首次 CI 发布需要：

1. 登录 npm 网站，头像菜单 → Access Tokens → Generate New Token，创建 granular token。
2. Packages and scopes 权限选择 **Read and write (publish and stage)**；首次创建这些未发布的
   非 scope 包时使用 **All Packages**。启用 **Bypass two-factor authentication**，供无人值守 CI 发布；
   设置合适的有效期，后续定期轮换。
3. 打开仓库 [Actions Secrets](https://github.com/B5-Software/Could-I-Be-Your-Partner/settings/secrets/actions)，
   选择 New repository secret，名称填 `NPM_TOKEN`，值填刚创建的 Token。
4. 下次版本发布时，CI 自动发布完整平台运行时和 `cibyp`。普通提交不改版本，不触发新版本发布。

Token 只填入 GitHub Secret，不写入代码、提交或聊天。首次发布完成后，可收窄 Token 的包权限，
或按下文切换 Trusted Publishing。详见 [npm 登录](https://docs.npmjs.com/cli/v12/commands/npm-login/)
与 [创建 Token](https://docs.npmjs.com/creating-and-viewing-access-tokens/)。

npm 在勾选 Bypass 2FA 时会显示安全提示：这是因为长期 Token 可以直接授权发布，
不是配置失败。Token 仅用于首次创建包；后续推荐使用 Trusted Publishing 的临时 OIDC 凭据，
然后删除 GitHub Secret 并在 npm 撤销旧 Token。

## CI 与首次发布配置

release.yml 在版本变化时构建六个平台，生成完整运行时归档及 SHA-256 元数据，
发布 GitHub Release 后准备 npm 分包。先发布分包，再发布平台包，最后发布 `cibyp`。
重跑时，仅跳过版本及完整性都一致的包；内容不一致则拒绝覆盖不可变 npm 版本。
`latest` 包含当前 alpha 版本，使普通 `npm i -g cibyp` 和 `npx cibyp` 可直接安装。
普通代码提交不递增版本，因此不触发重复发版。

首次 npm 发布需要包含新分发代码的完整构建。无需改版本：在 GitHub Actions 的
`build-release` 页面点击 Run workflow，选择 `main`，勾选 `npm_only`。
CI 使用当前提交构建六个平台并发布 npm，不移动已有版本标签、不覆盖 GitHub Release。
发布失败时可重跑 npm job，复用同一批归档；也可再次手动运行，勾选 `npm_only` 并把
原构建的 run ID 填入 `publish_run_id`。CI 检查它来自本仓库 `main` 发布工作流，
检出该构建的原始提交，并要求版本一致；工作流修复无需重新打包应用。
已经发布的 npm 版本不可覆盖；若本版本已发布且内容有变化，需要在下次发版时递增版本。

npm 发布只提取六个平台的运行时归档，不解包重复的系统安装器；逐个处理 artifact，
并在生成、校验分包后移除临时源归档，控制 Runner 的磁盘占用。

首次需要按上面的步骤配置有权创建这些公开包的 npm 账号与 `NPM_TOKEN`。
未配置发布身份时，CI 会验证分包，
明确记录未发布的原因，不伪报 npm 发布成功。

首次发布后可以切换到 npm Trusted Publishing：为 `cibyp` 及 CI 生成的每个平台包、
分包配置 GitHub publisher，owner 为 `B5-Software`，repository 为
`Could-I-Be-Your-Partner`，workflow 文件名为 `release.yml`；设置仓库变量
`NPM_TRUSTED_PUBLISHING=true`，删除 `NPM_TOKEN` 即可使用 OIDC。增加分包数时，
新包仍需首次创建/配置发布身份。CI 的 Node 24/npm 版本支持 OIDC，job 拥有
`id-token: write`，发布带 provenance。

## 本地核验

```sh
node scripts/prepare-npm.cjs --archive
# 把六个平台的 cibyp-runtime-*.tar.gz 与 *.json 放入 npm-assets：
npm run prepare:npm -- --assets npm-assets --output npm-dist
# 必须是新的空目录；不覆盖任意现有目录。
npm run publish:npm -- npm-dist
```

本地发布命令需要 npm 身份，并且 provenance 发布应在受支持的 CI 上运行。
安装器、GUI/TUI 的行为与普通桌面安装保持一致，设置目录名称不因 npm 包名改变。

参考：[OpenCode 发布源码](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/publish.ts)、
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
