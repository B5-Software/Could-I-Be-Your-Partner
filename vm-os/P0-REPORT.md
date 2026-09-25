# P0 验证报告 —— QEMU 沙盒可行性（Windows / 本机实测）

> 结论：**可行，P0 通过。** WHPX 硬件加速可用，Debian 13 云镜像 34 秒内到达 SSH 就绪；
> 同时发现两个必须写进实现的硬坑（已修进 `src/main/vm/qemu-runtime.js`）。

- 日期：2026-09-25
- 宿主：Windows 11 Insider（build 26340）/ x64 / 32 线程 / 31.3GB RAM
- QEMU：11.1.0（`qemu-w64-setup-20260811.exe`，197MB，来自 qemu.weilnetz.de）
- 客户机：Debian GNU/Linux 13 (trixie) genericcloud qcow2（325MB，cdimage.debian.org，SHA512 校验通过）
- 验证脚本：`vm-os/spike/p0-boot.js`（零第三方依赖）

## 1. 实测数据

| 指标 | 结果 |
|---|---|
| 加速器 | **whpx（硬件加速）**；`-accel help` = tcg, whpx |
| 加速器硬探测耗时 | 5.0s（真实执行 + 故障签名检查） |
| 串口首字节 | **1,516 ms**（内核开始输出） |
| 到达 SSH banner | **33,945 ms** |
| SSH 认证通过 | +741 ms |
| cloud-init 完成 | +815 ms |
| `/workspace` 就绪 | ✓ |
| 出网（guest → deb.debian.org） | HTTP 200，0.48s |
| guest 规格 | 4 vCPU / 3,921 MB / 2.8G 根分区 / 内核 6.12.107 |
| guest 预装 | Python 3.13.5 ✓；node ✗（stock 云镜像没有，自产镜像会带） |
| QEMU 安装后体积 | **1.25 GB / 3,387 文件**（必须裁剪重打包） |

启动耗时构成（估算）：QEMU+SeaBIOS+GRUB ≈ 2~3s，内核+initramfs ≈ 5~8s，
cloud-init 数据源重试 ≈ 10s，systemd+sshd 启动 ≈ 10s，其余为镜像 IO。

> 自产 CIBYP-VM-OS 用 `-kernel/-initrd` 直接引导（无 GRUB/固件），并预置
> static networkd 配置（省掉 cloud-init 的网络探测重试），预期可压到 **15~25s**。

### TCG（无硬件加速）对照

| 指标 | WHPX（硬件加速） | TCG（纯软件模拟） |
|---|---|---|
| 到达 SSH banner | **33,945 ms** | 61,521 ms |
| 串口首字节 | 1,516 ms | 4,566 ms |
| SSH 认证 | 741 ms | 2,227 ms |
| cloud-init | 815 ms | 2,713 ms |
| 结论 | 日常可用 | **能启动、能跑轻任务**；CPU 密集任务（npm install / 编译）会慢一个数量级 |

→ 无 WHPX 的机器（或在虚拟机里跑虚拟机）不阻断功能，但必须在 UI 明确标注"以软件模拟模式运行，较慢"，
并把「开启 Windows Hypervisor Platform」的一键引导放在设置页。

## 2. 关键发现（硬坑，已修复）

### 2.1 WHPX 不接受 `-cpu max` / `-cpu host`

```
WHPX: Unexpected VP exit code 4
```

- 现象：QEMU 进程**存活**、TCP 端口可连，但 vCPU 已死 → guest 永不启动（串口零输出）。
- 危害：如果探测只看"进程活着"，会误判为可用 → 表现为"虚拟机永远起不来"。
- 修复：
  1. `cpuModelFor(accel)`：**WHPX 一律用 QEMU 默认 CPU 模型**（不传 `-cpu`）；KVM/HVF 用 `host`；TCG 用 `max`。
  2. 加速探测必须**真实执行**（不能加 `-S` 暂停），并检查致命签名（`WHPX: Unexpected VP exit code` 等）。

### 2.2 slirp 会在 guest sshd 未就绪时直接关闭连接（FIN）

- 现象：QEMU hostfwd 端口 TCP 连接成功，随后**收不到任何数据也不报错**；
  只监听 `data/error/timeout` 的等待逻辑会永久挂起。
- 危害：启动等待逻辑假死，表现与"虚拟机卡住"完全一样，极难排查。
- 修复：等待连接必须同时监听 `end`/`close`，并加硬超时兜底；
  正式实现里改用 **ssh2**（协议层会正确报错并重试），不用裸 TCP 嗅探。

### 2.3 官方安装包需要管理员权限

`qemu-w64-setup-*.exe` 的清单是 `requestedExecutionLevel=requireAdministrator`，
**不能**作为应用内的静默安装路径（会弹 UAC）。→ 必须走 CI 裁剪重打包（zip）：
- 只保留 `qemu-system-x86_64` / `qemu-system-aarch64` / `qemu-system-xtensa`（ESP32 固件模拟）/
  `qemu-img` + `share/` 固件目录 + 必要 DLL；
- 预计 60~90MB（对比 1.25GB 安装后体积）。

## 3. 已验证的宿主↔guest 通道

| 通道 | 用途 | 验证结果 |
|---|---|---|
| `-smbios type=1,serial=ds=nocloud-net;s=http://10.0.2.2:<port>/` | cloud-init 首启配置（仅监听 127.0.0.1） | ✓ 命中 `/user-data`、`/meta-data` |
| `-netdev user,hostfwd=tcp:127.0.0.1:<port>-:22` | 宿主经 SSH 进入 guest | ✓ |
| `-chardev socket,...,server=on` + `-serial chardev:ser0` | 串口日志（Splash 排障面板） | ✓ |
| `-drive if=virtio` + qcow2 overlay（backing=只读基础镜像） | 可重置的系统盘 | ✓ |
| `qemu-img create -b` | 重置 = 删除 overlay | ✓（overlay 生成耗时 < 200ms） |

## 4. 对实现的影响（已落地到代码）

- `src/main/vm/qemu-runtime.js`
  - `cpuModelFor()`、真实执行的 `probeAccel()`（含致命签名表）
  - `buildArgv()` 与 P0 脚本保持同一契约（`-kernel/-initrd/-append root=LABEL=... console=...`）
- `src/main/vm/vm-provision.js`：cloud-init 一次性 HTTP 服务（随机端口 + 仅 loopback + `served` 信号）
- `src/main/vm/vm-ssh.js`：ssh2 封装（exec / PTY / sftp / 端口转发）
- `src/main/vm/vm-instance.js`：状态机（checking → booting → preparing → ready/failed）
- `src/main/vm/vm-service.js`、`vm-images.js`、`vm-download.js`：门面 / 资源目录 / 下载（aria2 + sha256）
- `vm-os/`：debos 配方三变体（base/desktop/full） + boot 冒烟 + manifest 生成 + CI

## 5. P1 运行时验证（真实应用模块）

`vm-os/tests/runtime-smoke.js` 直接调用 `src/main/vm/*`，用 **直接内核引导**（`-kernel/-initrd/-append`）
跑完整链路，结果 **8/8 通过**：

| 项 | 结果 |
|---|---|
| 实例启动到 ready | ✓ 36,183 ms（whpx） |
| `exec` 输出 / 退出码透传 | ✓ `uname` 正常；`exit 3` → code=3 |
| `/workspace` 读写 | ✓ |
| sftp 读 / 写 | ✓（读 `/etc/os-release`、写回校验一致） |
| PTY 交互（含 resize） | ✓ 拿到 bash 提示符与 ANSI 颜色输出 |
| 优雅关机 | ✓ 3.8 s |

过程中修掉的两个实现级坑（已落地）：

1. **ssh2 不认 Node crypto 导出的 PKCS#8 私钥**
   （`Cannot parse privateKey: Unsupported key format`）→ 改用 `ssh2.utils.generateKeyPairSync('ed25519')`，
   它输出 OpenSSH 私钥格式，且直接给出 authorized_keys 行。
2. **EventEmitter 的 `error` 事件无监听会抛出**
   （连接期 ECONNREFUSED 直接把进程打挂）→ vm-ssh 只在有监听者时转发 `error`；
   vm-instance 显式订阅并写入串口日志。

另外为兼容第三方镜像（如 Debian 官方云镜像，根分区无 LABEL、按 PARTUUID 引导），
`vm-instance` 支持 `config.kernelCmdline` 覆盖内核命令行；自产 CIBYP-VM-OS 仍用 `root=LABEL=cibyp-root`。

### 整机 E2E（Electron，隔离 userData）

命令：`electron . --user-data-dir=D:\cibyp-vm-p0\udtest`（settings 里 `runtime.location=vm`）

```
[vm] 开始虚拟机启动编排（Splash 门控生效）
[vm] 主窗口已显示（虚拟机门控已放行）
[vm] 虚拟机就绪 {"accel":"whpx"}
```

结论：
- Splash 先出现并保持，**VM 就绪后才显示主窗口**（主窗口渲染器早已 ready，被门控挡住）——符合"启动完成才进入"的要求；
- 运行期发现并修复：应用被强杀后残留的 QEMU 会占住 `overlay.qcow2` 写锁 → 新增
  `vm-instance._cleanupStaleInstance()`（启动前探活并按需软杀/强杀，等待锁释放）。
- 正常退出路径（`before-quit` → 优雅关机，上限 10s）已接；强杀场景由上面的清理兜底。

## 6. 下一步（P1 收尾）

1. Splash 集成：`settings.runtime.location === 'vm'` 时在 Splash 展示启动进度，就绪后再进主界面
2. 紧急回退：Splash 上的「以本机模式启动」+ 运行期 VM 掉线横幅
3. 终端接管：`terminal-service` 增加 `vm-ssh` PTY 后端（xterm 侧零改动）
4. 设置页：运行位置（本机/虚拟机）+ 虚拟机沙盒资源页（下载/校验/重置/自检）
5. CIBYP-VM-OS 首次 CI 构建（debos + boot 冒烟 + 体积门禁）
