# 安全核查：2026-10-23

核查对象为 1.9.0 正式版源码、npm 锁文件、六平台内置 Node/Tor 锁定清单，以及 `cibyp-vm-os` 镜像配方。结论：确实命中新披露的受影响版本；本次处理了可直接升级的依赖和证书信任问题，**尚不能宣称全部 CVE 已修复**。安装包与新镜像须通过各自 CI 的构建和发布流程。

## 已处理的版本与信任库

| 部件 | 核查时版本 | 本地修改后的版本 / 行为 |
| --- | --- | --- |
| npm 依赖审计 | 1 严重、2 高危、7 中危、1 低危 | 0 严重、0 高危、7 中危、0 低危；统计的是依赖节点，不是独立 CVE 数量 |
| DOMPurify（Monaco 间接依赖） | 3.4.16 | 3.4.17；提高 override 下限 |
| markdown-it（TUI Markdown） | 15.0.2 | 15.0.3 |
| follow-redirects（nut-js / Jimp 间接依赖） | 1.16.0 | 1.16.1；提高 override 下限 |
| KaTeX | 0.17.0 | 锁定为 0.18.10，声明下限 0.18.2 |
| 独立 Undici | 7.30.0 | 7.30.1 |
| 六平台内置 CLI Node | 24.21.0 | 24.22.1；按官方 SHASUMS256 更新六个归档的哈希 |
| Electron | 43.7.6 | 43.8.3；其内置 Node 仍为 24.22.0，见下方未解决项 |
| Tor Expert Bundle | 15.0.24 / Linux ARM64 16.0a13 | 15.0.26 / Linux ARM64 16.0a14；逐个下载并校验官方 SHA-256、记录实际字节数 |
| Tor / OpenSSL（实际 Windows 二进制） | 0.4.9.13 / 3.5.8 | 0.4.9.14 / 3.5.9；仍保留 Windows ARM64 使用 x64 运行时的既有兼容策略 |
| Debian VM CA | 老镜像未必达到撤销基线 | trixie 至少 20250419+deb13u1；bookworm 至少 20250419~deb12u2 |

DOMPurify 的严重级别通告需要 `SAFE_FOR_TEMPLATES`、DOM 返回模式、已有 Shadow Root 和后续模板求值等条件；本次确认的是依赖版本命中，未证明 Monaco 的实际调用满足这些条件。markdown-it 的高危性能问题可以在默认配置下触发。follow-redirects 还依赖敏感请求头与跨源重定向等条件；没有把版本命中直接等同于凭据已泄漏。[DOMPurify 通告](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cg2g-xh64-v4q7)、[markdown-it 通告](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-gfr2-rv44-r23c)、[follow-redirects 通告](https://github.com/follow-redirects/follow-redirects/security/advisories/GHSA-q3jh-wrc6-jgq8)。

## 证书维护

此次是 eMudhra 中间 CA 密钥泄漏后的撤销更新，不只是证书到期。按 Debian 安全通告，撤销 `emSign ECC Root CA - G3` 与 `Comodo AAA Services root` 对应根证书的信任。[DSA-6572-1](https://lists.debian.org/debian-security-announce/2026/msg00487.html)、[DLA-4845-1](https://www.debian.org/lts/security/2026/dla-4845)。

已有 VM 在冷启动、快照恢复和重新连接进入 ready 之前执行维护：先按 SHA-256 指纹禁用旧根并验证生成后的非空信任库，再通过 Debian 签名的软件包更新。APT 引导源使用官方 HTTP 源及 Debian archive keyring 校验签名和包哈希，不使用 `trusted=yes`、`--allow-unauthenticated` 或关闭 TLS 校验。联网失败时，只有本地撤销验证已通过才能继续使用，并在状态中保留 `updated:false`；下次启动重试软件包更新。达到基线后无需再次联网下载，每次仍验证本地信任库。

`cibyp-vm-os` 配方补上 security / updates 源，修正 unattended-upgrades 的 security codename 匹配，并取消收尾步骤对更新定时器的禁用。新镜像构建必须验证 CA 版本、受撤销根不在信任库，并保存已安装包清单；启动冒烟检查版本和定时器。镜像由独立仓库 CI 构建；存量磁盘在主程序启动时维护。

宿主 Node 的内置 CA 与系统 CA 是两套信任库：启动时通过 Node API 从默认根集合中过滤上述确切指纹，保留其他根及企业证书。Electron 检查服务端链和 Chromium 验证后的证书链，发现被撤销根时拒绝，其余返回 `-3` 交由 Chromium 正常验证。VM 管理的工具 worker 和插件 daemon 使用 `--use-openssl-ca` 读取已维护的系统信任库。审计还发现 IMAP 固定设置 `rejectUnauthorized:false`，现已恢复证书校验。

发布前审计另修复了隐私路由对 HTTP 重定向只检查首个 URL 的问题。现在每一跳都重新选择直连或 Tor，覆盖本地地址跳转到外部、外部跳转到本地及 Tor 断线时的重定向；Node 后台在隐私关闭时也继续应用共享代理设置。

这些措施不会改变用户宿主 OS 的全局证书库，也不会替换外部浏览器、任意终端程序或已经运行的进程的内存信任库。存量进程和连接需要重启才能读取更新后的根集合。

## 仍需处理 / 不能据此宣布安全的部分

1. **Electron 的内置 Node。** 实际运行 43.8.3 测得 Node 24.22.0、Brotli 1.2.0、内置 Undici 7.29.1。Node 10 月 21 日安全发布修复了 Brotli 越界写 `CVE-2026-111497`、DNS NUL 输入 `CVE-2026-105482`、TLS 地址校验 `CVE-2026-105483 / 106069 / 106072`、HTTP keep-alive `CVE-2026-105481`、快照随机缓存 `CVE-2026-106074`、权限模型 `CVE-2026-106073`。各项可利用性还取决于功能是否使用；本项目没有用 Node Permission Model 或用户启动快照构建应用。最新可取得的 Electron 稳定版仍使用 24.22.0，不能通过单独升级 npm 的 Node/Undici 替换其中的 C/C++ 实现。根证书过滤仅处理 CA 撤销，**不能修复 Brotli/TLS 原生漏洞**。待 Electron 提供含修复的版本后仍须升级并重新打包。[Node 安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)、[24.22.1 发布说明](https://nodejs.org/en/blog/release/v24.22.1)、[Electron 版本表](https://releases.electronjs.org/)。
2. **Debian VM 的 Node。** 隔离的旧 full 0.3.1 镜像实测为 `20.19.2+dfsg-1+deb13u2`，另有 OpenSSL `3.5.7-1~deb13u2`、内核 `6.12.107+deb13-amd64`。Debian 版本号可能包含安全回补，不能直接用上游版本大小判断全部 CVE；但 Debian tracker 目前仍列出该分支未解决的 Node 问题。此次完成 CA 升级和维护链路，**没有把 guest Node 20 迁移到上游 Node 24，也未执行 guest 全系统升级**。新镜像配方会获取 Debian security 更新，不能保证尚未回补的漏洞因此消失。[Debian Node 安全状态](https://security-tracker.debian.org/tracker/source-package/nodejs)。
3. **剩余 npm 中危。** 7 个受影响依赖节点都来自 nut-js → 旧 Jimp → file-type 链，同一 `GHSA-5v7r-6r5c-r473`：畸形 ASF 输入可能让检测过程无限循环。当前依赖组合没有可直接兼容的修复；强行 override 到 ESM 新主版本会破坏旧 Jimp 的 CommonJS 调用，需要替换图像依赖或上游兼容补丁。[file-type 通告](https://github.com/advisories/GHSA-5v7r-6r5c-r473)。
4. **独立分发物。** Code-OSS 的内置 Electron/Node、不同平台的 QEMU 包及移动端不在 npm audit 覆盖范围。本次记录了 Windows QEMU 11.1.0，并未完成所有二进制的 SBOM / 全 CVE 扫描；不得以 npm 高危为零推导整个安装包没有漏洞。

Tor 新包的 OpenSSL 升级包含额外安全修复；不能将上游 DTLS/QUIC 等特定功能的版本命中直接当成 Tor TCP 路径可利用。[Tor 15.0.25 变更](https://blog.torproject.org/new-release-tor-browser-15025/)、[官方运行时清单](https://download.torproject.org/tor/)。

## 验证记录

- `npm run check`：588 项 Node tests，585 通过、3 项平台跳过；388 项 legacy 全通过；lint、format、类型及 API 能力检查通过。
- 实际 GUI 前端冒烟通过：共享组件、设置、模式、输入框、键盘和响应式布局；验证新 Electron 与 KaTeX 资源仍可用。
- 真实 Windows WHPX / QEMU：使用临时 overlay，旧镜像 CA 升级到 `20250419+deb13u1`；重新注入真实被撤销公有根，检查拒绝放行；移除测试根后恢复正常。
- 真实 VM 快照保存、全新宿主对象恢复、进程存活、无效状态回退冷启动通过；三个就绪路径均报告已验证证书基线。
- TLS 信任库保留其他根、重复调用、Chromium 拒绝链及正常验证委托、IMAP 验证、VM 工具边界检查通过。
- 内置 Windows Node 实际运行 `24.22.1`；Node 后台构建通过。Tor 五个唯一平台包与官方哈希一致，新 Windows Tor 显示 `0.4.9.14 / OpenSSL 3.5.9`，配置校验通过；未进行 Tor 公网连通性测试。
- 正式版发布前增加 HTTP 重定向隐私回归、带修复 Node 24.22.1 的信任库测试和固定发布修订的更新概览测试；发布器 3 项测试通过。镜像仓库 Linux 环境下 17 项测试及 shell 语法检查通过，维护提交为 [`850972f`](https://github.com/B5-Software/cibyp-vm-os/commit/850972f)，[镜像构建记录](https://github.com/B5-Software/cibyp-vm-os/actions/runs/39862481911)。
