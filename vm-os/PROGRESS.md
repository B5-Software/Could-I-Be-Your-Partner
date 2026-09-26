# CIBYP-VM-OS / QEMU 沙盒 —— 实施进度（P0 → P4）

> 全部数据来自本机（Windows 11 / WHPX / Intel x64，32 线程 / 31GB）实测，不是估算。
> 复现脚本都在 `vm-os/tests/`，用 `node` 直接跑。

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| P0 | QEMU 可行性验证（加速探测 / Debian 云镜像启动 / cloud-init over HTTP / SSH / overlay 重置） | ✅ | `vm-os/P0-REPORT.md` |
| P1 | 运行时骨架：qemu-runtime / vm-instance / vm-ssh / vm-provision + Splash 门控 + 紧急回退 + VM 终端 + 设置页 | ✅ | 整机 E2E：`electron . --user-data-dir=<隔离>` → `[vm] 主窗口已显示（虚拟机门控已放行）` |
| P2 | 工作区同步（双向增量 + 冲突保留 + 时钟偏移校正）、端口预览、脚本类工具路由、WHPX 一键开启 | ✅ | `vm-os/tests/sync-smoke.js` **12/12** |
| P3 | QEMU 运行时裁剪打包（PE/DLL 闭包）+ 六平台 CI + 应用内下载安装 | ✅ | 1.25GB → **511MB（zip 80.6MB）**，裁剪包启动 VM **8/8** |
| P3.5 | CIBYP-VM-OS（debos 三变体配方 + 出厂契约 + CI 构建/boot 冒烟/体积门禁/Release/manifest） | ✅ 本机完整验证（WSL 构建 → Windows 引导） | `vm-os/P0-REPORT.md` + 下方数据 |
| P4 | 图形化 VM：Xvfb + x11vnc + noVNC 内嵌 + Chromium CDP（浏览器沙盒） | ✅ | `vm-os/tests/graphics-smoke.js` **6/6**（RFB banner / 进程 / 仅 loopback / 清理） |

## CIBYP-VM-OS 实测（0.1.0-test / base / amd64）

构建路径（**不需要 loop/mount/特权**，容器与 WSL 都能跑）：

```
debos --disable-fakemachine（debootstrap + apt + overlay 出厂配置 + finalize 清理 + pack rootfs.tar.gz）
  → vm-os/tools/assemble-image.js（mke2fs -d 免挂载写入整盘 ext4 → qemu-img convert -zstd）
  → QEMU -kernel/-initrd 直接引导（root=LABEL=cibyp-root，无分区表、无引导器）
```

| 项 | 数值 |
|---|---|
| debos 构建耗时 | 5m10s（含 debootstrap + 全部 apt + 打包） |
| 镜像体积 | **457.8MB** qcow2（zstd；门禁 520MB） |
| rootfs | 1.2GB（tar.gz 456MB，组装后即删） |
| 内核 / initrd | 11.6MB / 33.8MB |
| 首启到 SSH | 56.4s（含 cloud-init；后续可继续优化 initramfs/cloud-init 模块） |
| boot 冒烟 | **12/12**（cloud-init 契约 / 品牌 os-release / cibyp+sudo+/workspace / 静态网络 / qemu-ga / 直接引导 / **持久化** / **重置回出厂态**） |

镜像自查发现的并已修复的问题：
- 缺 `e2fsprogs` → cloud-init 的整盘扩容（resize2fs）首启报错
- 未生成 locale → cloud-init locale 模块报错
- 变体 apt 装在清理之后 → 镜像多出 ~200MB（清理移入 finalize，在所有 apt 之后）
- `debos` 的 `script:` 子目录路径不稳 → 改 `overlay` + `command: sh ...`
- `pack` 不支持 zstd（noble 的 debos 1.1.x）→ 用 gz/xz
- parted/losetup 在容器里必然失败 → 彻底改为免挂载组装（本文件「构建路径」）

## 关键实测数字（WHPX）

| 指标 | 数值 |
|---|---|
| QEMU 版本 | 11.1.0（官方 w64 包，裁剪后 80.6MB zip） |
| 到 SSH 就绪 | 34.0s（云镜像）/ 36.2s（直接内核引导） |
| cloud-init 完成 | +0.8s |
| exec / PTY / sftp | 8/8（`runtime-smoke.js`） |
| 工作区同步 | 首轮全量 23ms（4 文件）；二次幂等 0 传输；冲突保留副本 |
| 图形环境 | 启动 111s（含依赖安装；desktop 变体预装后仅数秒）；RFB 003.008 |
| TCG（无加速）| 61.5s 到 SSH，可用但慢 |

## 已修的实现级坑（都写进了代码注释）

1. **WHPX 不支持 `-cpu max/host`** → `WHPX: Unexpected VP exit code 4`（进程活、vCPU 死）；且加速探测不能加 `-S`（暂停探测发现不了）。
2. **slirp 在 guest sshd 未就绪时会关连接（FIN）** → 只监听 data/error/timeout 的等待会假死。
3. **ssh2 只认 OpenSSH 私钥**（Node crypto 的 PKCS#8 被拒）→ 改用 `ssh2.utils.generateKeyPairSync`。
4. **EventEmitter 的 error 无监听会抛出** → 连接期 ECONNREFUSED 曾打挂主进程。
5. **串口重连在 error+close 双触发时指数分裂** → 4GB OOM（实测复现并修复：一次性闸门）。
6. **跨主机时钟偏移**会把冲突"较新方"判反 → 用 guest `date +%s` 校正 mtime。
7. **删除方向**（宿主删→删 VM、VM 删→删宿主）曾写反 → 单测抓出。
8. **tar 长路径**：GNU longname 在 libarchive 下不稳 → 改 ustar prefix 拆分（≤255）+ pax 兜底。
9. 反复确认的边界：官方 QEMU 安装包是 `requireAdministrator`（只能解包不能静默安装）；残留 QEMU 会占住 overlay 写锁（已加启动前清理）。

## 目录速览（新增）

```
src/main/vm/
  qemu-runtime.js     二进制定位 / 加速探测（真实执行 + 致命签名） / argv 构造 / overlay
  vm-instance.js      状态机（checking→booting→preparing→ready/failed）+ 串口 + 残留清理
  vm-ssh.js           ssh2 通道（exec / PTY / sftp / forward），error 安全转发
  vm-pty.js           VM PTY 适配器（对 terminal-service 透明）
  vm-provision.js     cloud-init NoCloud-net + OpenSSH 密钥对
  vm-images.js        变体目录 / manifest / 本地状态 / 镜像前缀
  vm-download.js      aria2 优先 + sha256 校验 + 断点续传
  vm-tar.js           tar 编解码（ustar prefix + pax + 校验和）
  vm-workspace.js     三方比较增量同步 / 冲突保留 / 分批 tar over SSH
  vm-graphics.js      Xvfb + x11vnc + Chromium CDP
  vm-service.js       门面（配置 ↔ 运行时、下载、同步、端口、图形）
vm-os/
  recipe/             debos 三变体配方 + 出厂配置脚本 + 内核收集
  tests/              boot-smoke / runtime-smoke / sync-smoke / graphics-smoke
  tools/              runtime-manifest 与 runtime-pack-manifest 生成（含体积门禁）
  P0-REPORT.md        可行性验证报告
scripts/vm-pack.js    QEMU 裁剪打包（PE/Linux/macOS 依赖闭包）
.github/workflows/
  vm-os.yml           镜像构建（debos，6 变体作业 + boot 冒烟 + 体积门禁 + Release）
  vm-runtime.yml      QEMU 运行时包构建（6 平台 + 清单 + Release）
```

## 复现命令

```bash
# 依赖：本机需有 QEMU 解包目录 + 一份镜像（含 vmlinuz/initrd）
node vm-os/tests/runtime-smoke.js --assets <assets> --variant base --version <v> [--cmdline "..."]
node vm-os/tests/sync-smoke.js    --assets <assets> --variant base --version <v> [--cmdline "..."]
node vm-os/tests/graphics-smoke.js --assets <assets> --variant base --version <v> [--cmdline "..."] [--with-chromium]
node scripts/vm-pack.js --src <qemu解包目录> --out <输出> --platform win32 --arch x64 --zip
```

`--cmdline` 用于第三方镜像（如 Debian 官方云镜像根分区无 LABEL，需 `root=PARTUUID=...`）；
自产 CIBYP-VM-OS 默认 `root=LABEL=cibyp-root`，无需覆盖。

## 与用户需求的对应

| 需求 | 落点 |
|---|---|
| 设置里加"运行位置"（本机/虚拟机），切换需重启 | 设置 → 运行位置；`runtime:setLocation` + 重启提示与一键重启 |
| 虚拟机带重置按钮，默认不重置 | 「重置虚拟机」按钮（确认后才删 overlay 回出厂态） |
| 工作目录跟着改变 | 工作区同步：宿主为权威副本，VM 内 `/workspace` 双向增量同步（共享/独立两种模式） |
| 终端改成虚拟机的 PTY | `terminal:make` VM 分支 → ssh2 真 PTY（xterm 侧零改动） |
| Splash 窗口加载虚拟机，就绪才进入 | `vmRuntimeGate` + Splash 进度/串口日志面板 |
| 紧急按钮切回本机 | Splash「以本机模式启动（本次）」+ 失败 20s 自动回退 + 运行期可随时切 |
| 图形化 VM / computer-use | VM 桌面窗口（noVNC）+ VM 内 Chromium CDP（Playwright 可 connectOverCDP） |
| 不占安装包体积 | 全部运行时资源按需下载（QEMU 包 + 镜像 + 内核/initrd），走 aria2 + sha256 |
