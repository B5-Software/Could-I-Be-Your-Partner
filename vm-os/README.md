# CIBYP-VM-OS

**CIBYP-VM-OS 是基于 Debian GNU/Linux 的再打包系统（remix）**，由 CI 生成、发布在 GitHub Release，
供「Could I Be Your Partner」的 QEMU 虚拟机沙盒按需下载。它不随应用安装包分发。

> CIBYP-VM-OS is based on Debian GNU/Linux. Debian is a registered trademark owned by
> Software in the Public Interest, Inc. CIBYP-VM-OS is not affiliated with or endorsed by
> the Debian project.

---

## 1. 定位：Remix，不是 fork

| 做 | 不做 |
|---|---|
| debos 从 Debian 官方源（deb.debian.org）构建 rootfs + 品牌化配置 | ❌ 不建自己的 apt 仓库、不重编任何 deb |
| 自己的 `os-release` / `dpkg origin` / motd / `cibyp-vmos-info` | ❌ 不改 Debian 官方包内容 |
| 安全更新走 Debian 官方源（guest 内 `unattended-upgrades` + CI 月度重建） | ❌ 不维护内核（直接用 `linux-image-{amd64,arm64}`） |
| 只出 VM 镜像（qcow2），内核/initramfs 单独出（宿主直接引导） | ❌ 不做 ISO / 装机器 / 引导菜单 |

## 2. 变体

| 变体 | 定位 | 体积门禁 | 磁盘 |
|---|---|---|---|
| `base` | Agent 默认执行环境：shell/python/node/编译基础 + 沙盒接入 | ≤ 350MB | 8G |
| `desktop` | 图形化 / computer-use：base + Xorg + x11vnc + Chromium + CJK 字体 | ≤ 750MB | 12G |
| `full` | 完整开发环境：base + clang/调试器 + PostgreSQL/MariaDB/Redis + Docker + ffmpeg + Playwright 依赖 | ≤ 1.3GB | 16G |

体积为 qcow2（zstd 压缩）大小，CI 硬门禁，超标直接失败。

## 3. 出厂契约（宿主 App 依赖的不变量）

| 契约 | 值 |
|---|---|
| 用户 | `cibyp`（NOPASSWD sudo，仅密钥登录，密码锁定） |
| 工作区 | `/workspace`，属主 `cibyp` |
| 登录方式 | SSH（宿主经 QEMU `hostfwd` 连接）；串口 `ttyS0` 自动登录 `cibyp` 供排障 |
| 配置注入 | cloud-init，数据源限定 `NoCloud`（宿主经 `-smbios type=1,serial=ds=nocloud-net;s=http://10.0.2.2:<port>/` 提供） |
| 网络 | `systemd-networkd` + `eth0` DHCP（**不依赖 cloud-init**，云配置失败也能连上） |
| 引导 | **无引导器**：宿主 QEMU 用 `-kernel vmlinuz -initrd initrd.img -append "root=LABEL=cibyp-root rw console=ttyS0,115200 net.ifnames=0"` |
| 出厂态 | 每次启动自动重建 machine-id / SSH host key；镜像内无 cloud-init 状态与 apt 缓存 |
| 基础镜像 | 只读 backing file，实例改动全部落在 qcow2 overlay（"重置" = 删 overlay） |

## 4. 构建

```bash
# 需要 Linux + /dev/kvm（debos 的 fakemachine 后端）；Windows 开发机建议用 WSL2 或直接走 CI
debos --fakemachine-backend=kvm -t arch:amd64 -t version:0.1.0 \
      recipe/base.yaml
```

CI（`.github/workflows/vm-os.yml`）：

```
tag vm-os-v*       → 构建 amd64 + arm64 × base/desktop/full → boot 冒烟 → 体积门禁 → 发布 Release + manifest
workflow_dispatch  → 同上（手动）
schedule (每月 1 日)→ 跟随 Debian 安全更新重建
```

产物：

```
cibyp-vmos-<version>-base-amd64.qcow2      vmlinuz-amd64      initrd-amd64.img
cibyp-vmos-<version>-base-arm64.qcow2      vmlinuz-arm64      initrd-arm64.img
cibyp-vmos-<version>-desktop-*.qcow2       ...
cibyp-vmos-<version>-full-*.qcow2          ...
runtime-manifest.json                       ← 宿主 App 消费（URL/sha256/大小/兼容性/许可声明）
```

## 5. 目录

```
vm-os/
  recipe/
    common.yaml          公共层（debootstrap + 基础集 + 品牌化）
    base.yaml            base 变体
    desktop.yaml         desktop 变体
    full.yaml            full 变体
    tail.yaml            落盘层（分区 + 部署 + 收集内核）
    collect-kernel.sh    从镜像中提取 vmlinuz / initrd
    overlay/setup.sh     出厂配置（os-release、用户、sshd、cloud-init、串口、网络、清理）
  tests/
    boot-smoke.js        CI 冒烟：启动 → cloud-init → SSH → 契约校验 → 持久化/重置校验
  tools/
    make-manifest.js     生成 runtime-manifest.json
  spike/
    p0-boot.js           P0 可行性验证脚本（宿主直跑，不需要 debos）
```

## 6. 合规

- **商标**：产品名不含 "Debian"；不使用 Debian swirl logo；`os-release` 用 `ID=cibyp-vmos` + `ID_LIKE=debian`；镜像内
  `/usr/share/doc/cibyp-vmos/README.Debian-derived`、Release 说明、App 关于页三处均含免责声明。
- **许可**：镜像内全部为 Debian 官方二进制包，源代码可得性由 Debian 官方归档（deb.debian.org / snapshot.debian.org）满足；
  构建脚本本体以 GPL-3.0-or-later 发布。
- **不改包**：不修改、不重编译 Debian 包，仅在 rootfs 上叠加配置文件与品牌化文件（`/etc`、`/usr/local`、`/usr/share/doc`）。
