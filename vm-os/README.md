# VM 沙盒（应用侧）

本目录只保留**应用侧**的运行时与集成验证；**镜像与 QEMU 运行时包的构建/发布**已拆分到独立公开仓库：

> **构建仓库：<https://github.com/B5-Software/cibyp-vm-os>**
> （debos 配方、镜像组装、QEMU 裁剪、boot 冒烟、体积门禁、Release 与 manifest）

拆分的理由：镜像/运行时包构建很重（debootstrap + 3 变体 × 2 架构 + boot 冒烟），
不应该和主应用的四平台发布流水线混在一起；产物本身也是可独立分发的 GPL 合规物
（含 COPYING 与源码链接），单独一个仓库更清晰、也便于外部复现。

## 本目录内容

```
vm-os/
  README.md            本文件
  P0-REPORT.md         P0 可行性验证报告（QEMU/WHPX/cloud-init/SSH 实测）
  PROGRESS.md          P0→P4 实施进度与实测数据汇总
  spike/p0-boot.js     P0 验证脚本（历史留存：宿主直接跑，不需要 debos）
  tests/
    runtime-smoke.js   运行时集成冒烟：实例启停 / exec / PTY / sftp（用 src/main/vm/* 真模块）
    sync-smoke.js      工作区同步冒烟：首轮全量 / 双向增量 / 删除 / 冲突保留 / 幂等
    graphics-smoke.js  图形环境冒烟：Xvfb + x11vnc + 端口转发 + RFB 握手
```

## 应用侧运行时（`src/main/vm/`）

| 文件 | 职责 |
|---|---|
| `qemu-runtime.js` | 二进制定位 / 加速探测（真实执行 + 致命签名）/ argv 构造（**WHPX 不传 `-cpu max`**）/ overlay |
| `vm-instance.js` | 状态机（checking→booting→preparing→ready/failed）+ 串口（一次性重连闸门）+ 残留进程清理 |
| `vm-ssh.js` | ssh2 通道：exec / 真 PTY / sftp / 端口转发（error 安全转发） |
| `vm-pty.js` | VM PTY 适配器（对 `terminal-service` 透明，xterm 侧零改动） |
| `vm-provision.js` | cloud-init NoCloud-net + **OpenSSH 格式**密钥对（ssh2 不认 PKCS#8） |
| `vm-images.js` | 变体目录 / manifest 拉取 / 本地状态 / 镜像前缀（指向 `cibyp-vm-os` 仓库） |
| `vm-download.js` | aria2 优先 + sha256 校验 + 断点续传；`downloadAll` 一键拉 QEMU 包 + 镜像 |
| `vm-tar.js` | tar 编解码（ustar prefix 拆分 ≤255 + pax 兜底），供工作区同步 |
| `vm-workspace.js` | 三方比较增量同步 / 冲突保留（`.cibyp-conflicts/`）/ 分批 tar over SSH / guest 时钟偏移校正 |
| `vm-graphics.js` | Xvfb + x11vnc（仅 guest loopback）+ Chromium CDP |
| `vm-service.js` | 门面：配置 ↔ 运行时、资源下载、同步、端口预览、图形环境 |

## 本地跑集成冒烟

```bash
# 需要一份已安装的镜像（可从 cibyp-vm-os 的 Release 下载，或本地按该仓库 README 构建）
node vm-os/tests/runtime-smoke.js  --assets <assetsDir> --variant base --version <v> [--cmdline "..."]
node vm-os/tests/sync-smoke.js     --assets <assetsDir> --variant base --version <v> [--cmdline "..."]
node vm-os/tests/graphics-smoke.js --assets <assetsDir> --variant base --version <v> [--with-chromium]

# 单测（含 vm-tar / vm-workspace diff / qemu argv / manifest 等纯函数覆盖）
npm test
```

`--cmdline` 只在使用第三方镜像时需要（如 Debian 官方云镜像根分区无 LABEL，需 `root=PARTUUID=...`）；
自产 CIBYP-VM-OS 默认 `root=LABEL=cibyp-root`，无需覆盖。
