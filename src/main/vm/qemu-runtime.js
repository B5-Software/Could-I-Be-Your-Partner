/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * QEMU 运行时：定位二进制、探测加速后端、构造启动参数。
 *
 * 设计要点：
 *   - 宿主架构 → guest 架构一对一（x64→amd64 / arm64→arm64），避免跨架构 TCG 慢速
 *   - 加速探测分两步：`-accel help`（列举）→ 真实拉起空机器存活 4s（硬证据），
 *     与 sandbox-runner 的 --self-test 思路一致
 *   - fail-closed：受限模式下后端不可用就报 SANDBOX_UNAVAILABLE 一类错误，不静默降级
 *   - 本模块纯函数 + 少量 spawnSync，无 Electron 依赖，便于单测
 *
 * 镜像引导契约（与 vm-os/README.md 一致）：
 *   宿主直接引导内核：-kernel vmlinuz -initrd initrd.img
 *   -append "root=LABEL=cibyp-root rw console=<tty> net.ifnames=0 rootwait"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VMSANDBOX_UNAVAILABLE = 'VM_SANDBOX_UNAVAILABLE';
const ROOT_FS_LABEL = 'cibyp-root';

/** 宿主架构 → guest 架构 */
const HOST_ARCH_TO_GUEST = { x64: 'amd64', arm64: 'arm64' };
/** guest 架构 → QEMU 二进制后缀 */
const GUEST_ARCH_TO_QEMU = { amd64: 'x86_64', arm64: 'aarch64' };
/** guest 架构 → 机器类型与串口控制台设备 */
const GUEST_ARCH_PROFILE = {
  amd64: { machine: 'q35', console: 'ttyS0' },
  arm64: { machine: 'virt', console: 'ttyAMA0' },
};

/**
 * 加速后端 → CPU 模型。
 * 实测坑：WHPX 不支持 `-cpu max`/`-cpu host` 之外的自定义模型，
 * QEMU 11.1 + WHPX 传 `-cpu max` 会直接 `WHPX: Unexpected VP exit code 4` 且虚拟机不启动，
 * 因此 WHPX 一律用 QEMU 默认 CPU 模型（qemu64）。
 */
function cpuModelFor(accel) {
  if (accel === 'whpx') return null;
  if (accel === 'kvm' || accel === 'hvf') return 'host';
  return 'max'; // tcg
}

function guestArchOf(hostArch = process.arch) {
  return HOST_ARCH_TO_GUEST[hostArch] || 'amd64';
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function qemuBinName(kind, guestArch) {
  const suffix = GUEST_ARCH_TO_QEMU[guestArch] || 'x86_64';
  if (kind === 'img') return process.platform === 'win32' ? 'qemu-img.exe' : 'qemu-img';
  return process.platform === 'win32' ? `qemu-system-${suffix}.exe` : `qemu-system-${suffix}`;
}

/**
 * 定位 QEMU 运行目录（含 qemu-system-* / qemu-img / share 固件目录）。
 * 查找顺序：
 *   1. <assetsDir>/qemu/<platform-arch>   （应用内下载的 runtime pack）
 *   2. <resourcesPath>/qemu               （打包随应用的场景，默认不启用）
 *   3. <appPath>/assets/qemu/<platform-arch>（开发模式）
 * @returns {{ dir: string, source: string }|null}
 */
function resolveQemuDir({ assetsDir, resourcesPath, appPath, platform = process.platform, arch = process.arch } = {}) {
  const key = platformKey(platform, arch);
  const candidates = [];
  if (assetsDir) candidates.push({ dir: path.join(assetsDir, 'qemu', key), source: 'assets' });
  if (resourcesPath) candidates.push({ dir: path.join(resourcesPath, 'qemu'), source: 'resources' });
  if (appPath) candidates.push({ dir: path.join(appPath, 'assets', 'qemu', key), source: 'dev' });
  for (const c of candidates) {
    if (fs.existsSync(c.dir)) return c;
  }
  return null;
}

/** 在给定目录内定位二进制；缺任一必需件返回 null */
function inspectQemuDir(dir, guestArch) {
  if (!dir) return null;
  const exe = path.join(dir, qemuBinName('system', guestArch));
  const img = path.join(dir, qemuBinName('img', guestArch));
  if (!fs.existsSync(exe) || !fs.existsSync(img)) return null;
  // 固件目录：Windows 安装布局为 <dir>/share，部分构建为 <dir>/share/qemu
  let dataDir = null;
  for (const cand of [path.join(dir, 'share', 'qemu'), path.join(dir, 'share')]) {
    if (fs.existsSync(path.join(cand, 'bios.bin')) || fs.existsSync(path.join(cand, 'kvmvapic.bin'))) {
      dataDir = cand;
      break;
    }
  }
  return { dir, exe, img, dataDir };
}

/** 解析 QEMU 版本字符串（首行） */
function qemuVersion(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return (((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || null);
}

/** `-accel help`：列出二进制内支持的加速器 */
function accelHelp(exe) {
  const r = spawnSync(exe, ['-accel', 'help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const text = ((r.stdout || '') + (r.stderr || '')).trim();
  const list = text
    .split('\n')
    .filter((l) => !/accelerators supported/i.test(l))
    .join(' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z]+$/.test(s));
  return { ok: r.status === 0, list, raw: text };
}

/**
 * 加速器硬探测：真实执行（不暂停），存活 probeMs 且 stderr 无致命签名才算可用。
 *
 * 为什么不能暂停探测：`-S` 下 vCPU 从不执行，WHPX 的 vCPU 级故障探测不到。
 * 实测 QEMU 11.1.0 + WHPX + `-cpu max/host` 会打印
 *   `WHPX: Unexpected VP exit code 4`
 * 且进程存活但 guest 永不启动（串口零输出）—— 必须在探针里识别。
 */
const FATAL_ACCEL_SIGNATURES = [
  'WHPX: Unexpected VP exit code',
  'WHPX: Failed to',
  'WHPX: No accelerator found',
  'Could not create vCPU',
  'KVM: not found',
  'kvm_init_vcpu failed',
  'hvf: failed',
  'failed to initialize',
];

function probeAccel(exe, accel, guestArch, { probeMs = 5000, dataDir = null } = {}) {
  const profile = GUEST_ARCH_PROFILE[guestArch] || GUEST_ARCH_PROFILE.amd64;
  const argv = ['-accel', accel, '-machine', profile.machine, '-display', 'none', '-nodefaults', '-m', '256'];
  if (dataDir) argv.unshift('-L', dataDir);
  const cpu = cpuModelFor(accel);
  if (cpu) argv.push('-cpu', cpu);
  const t0 = Date.now();
  const r = spawnSync(exe, argv, { encoding: 'utf8', timeout: probeMs, windowsHide: true });
  const combined = ((r.stderr || '') + (r.stdout || '') + (r.error ? r.error.message : '')).trim();
  const alive = !!r.error && /ETIMEDOUT|timed out/i.test(r.error.message || '');
  const fatal = FATAL_ACCEL_SIGNATURES.find((s) => combined.includes(s)) || null;
  return {
    ok: alive && !fatal,
    alive,
    fatal,
    aliveMs: Date.now() - t0,
    stderr: combined.split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 600),
  };
}

/** 各平台的加速器优先级 */
function accelPreference(platform = process.platform) {
  if (platform === 'win32') return ['whpx', 'tcg'];
  if (platform === 'darwin') return ['hvf', 'tcg'];
  if (platform === 'linux') return ['kvm', 'tcg'];
  return ['tcg'];
}

/**
 * 探测可用的加速后端。
 * @param {object} opts { exe, guestArch, dataDir, platform, preferred, allowTcg = true, probe = true }
 * @returns {{ backend: string|null, hardware: boolean, available: boolean, detail: string, probes: object[] }}
 */
function detectAccel({ exe, guestArch, dataDir = null, platform = process.platform, preferred = null, allowTcg = true, probe = true } = {}) {
  const help = accelHelp(exe);
  const preference = (preferred && preferred.length ? preferred : accelPreference(platform))
    .filter((a) => (a === 'tcg' ? allowTcg : true));
  const probes = [];
  for (const accel of preference) {
    if (!help.list.includes(accel)) {
      probes.push({ accel, listed: false, ok: false, detail: '不在 -accel help 列表' });
      continue;
    }
    if (!probe) return { backend: accel, hardware: accel !== 'tcg', available: true, detail: '未做硬探测', probes };
    const r = probeAccel(exe, accel, guestArch, { dataDir });
    probes.push({ accel, listed: true, ok: r.ok, aliveMs: r.aliveMs, detail: r.stderr });
    if (r.ok) {
      return {
        backend: accel,
        hardware: accel !== 'tcg',
        available: true,
        detail: accel === 'tcg' ? 'TCG 纯软件模拟（较慢）' : `${accel} 硬件加速`,
        probes,
      };
    }
  }
  return {
    backend: null,
    hardware: false,
    available: false,
    detail: `无可用加速后端（候选: ${preference.join(', ')}）`,
    probes,
  };
}

/** guest 内核命令行 */
function kernelCmdline(guestArch, { label = ROOT_FS_LABEL } = {}) {
  const profile = GUEST_ARCH_PROFILE[guestArch] || GUEST_ARCH_PROFILE.amd64;
  return `root=LABEL=${label} rw console=${profile.console},115200 net.ifnames=0 rootwait`;
}

/**
 * 构造 QEMU 启动参数（与 vm-os/tests/boot-smoke.js 保持同一契约）。
 * @param {object} o
 * @param {string} o.exe        qemu-system-* 路径
 * @param {string} o.dataDir    固件目录（可空）
 * @param {string} o.guestArch  amd64 | arm64
 * @param {string} o.accel      whpx|hvf|kvm|tcg
 * @param {number} o.smp
 * @param {number} o.memMB
 * @param {string} o.overlay    qcow2 overlay 路径
 * @param {string} o.kernel     vmlinuz 路径
 * @param {string} o.initrd     initrd 路径
 * @param {number} o.sshPort    宿主侧 SSH 端口（hostfwd）
 * @param {number} o.serialPort 宿主侧串口 chardev 端口
 * @param {number} o.ciPort     cloud-init HTTP 端口（guest 经 10.0.2.2 访问）
 * @param {string} [o.netMode]  nat | restricted
 * @param {boolean} [o.daemonize] 预留：Windows 不支持 -daemonize
 */
function buildArgv(o) {
  const profile = GUEST_ARCH_PROFILE[o.guestArch] || GUEST_ARCH_PROFILE.amd64;
  const argv = [];
  if (o.dataDir) argv.push('-L', o.dataDir);
  argv.push(
    '-name', o.name || 'cibyp-vmos',
    '-machine', profile.machine,
    '-accel', o.accel,
    '-smp', String(o.smp || 4),
    '-m', String(o.memMB || 4096),
    '-kernel', o.kernel,
    '-initrd', o.initrd,
    // cloud-init 种子：SMBIOS 之外再走内核命令行（ARM virt 上 SMBIOS 不可靠，实测会回退 DataSourceNone）
    '-append', (o.cmdline || kernelCmdline(o.guestArch)) + ` ds=nocloud-net;s=http://10.0.2.2:${o.ciPort}/`,
    '-drive', `file=${o.overlay},if=virtio,format=qcow2,cache=writeback,discard=unmap`,
  );
  if (o.netMode === 'restricted') {
    // 完全隔离：guest 无法访问宿主（含 10.0.2.2），仅保留 hostfwd 显式转发
    argv.push('-netdev', `user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:${o.sshPort}-:22`);
  } else {
    argv.push('-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${o.sshPort}-:22`);
  }
  argv.push(
    // romfile= 关闭 virtio 网卡的 option ROM（我们用不到 PXE；且部分平台/发行版不带 efi-virtio.rom，
    // 缺失会导致 QEMU 直接启动失败：failed to find romfile "efi-virtio.rom"）
    '-device', 'virtio-net-pci,netdev=n0,romfile=',
    '-chardev', `socket,id=ser0,host=127.0.0.1,port=${o.serialPort},server=on,wait=off`,
    '-serial', 'chardev:ser0',
    '-smbios', `type=1,serial=ds=nocloud-net;s=http://10.0.2.2:${o.ciPort}/`,
    '-device', 'virtio-rng-pci',
    '-display', 'none',
    '-monitor', 'none',
  );
  const cpu = cpuModelFor(o.accel);
  if (cpu) argv.push('-cpu', cpu);
  return argv;
}

/** 创建 qcow2 overlay（backing = 只读基础镜像；重置 = 删除该文件） */
function createOverlay(qemuImg, baseImage, overlayPath) {
  if (fs.existsSync(overlayPath)) fs.rmSync(overlayPath, { force: true });
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  const r = spawnSync(qemuImg, ['create', '-f', 'qcow2', '-b', path.resolve(baseImage), '-F', 'qcow2', overlayPath], {
    encoding: 'utf8', windowsHide: true,
  });
  if (r.status !== 0) throw new Error('qemu-img create 失败: ' + ((r.stderr || '') + (r.error ? r.error.message : '')).trim());
  return overlayPath;
}

/** overlay 信息（容量等） */
function overlayInfo(qemuImg, overlayPath) {
  const r = spawnSync(qemuImg, ['info', '--output=json', overlayPath], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout || '{}'); } catch { return null; }
}

module.exports = {
  VM_SANDBOX_UNAVAILABLE: VMSANDBOX_UNAVAILABLE,
  ROOT_FS_LABEL,
  HOST_ARCH_TO_GUEST,
  GUEST_ARCH_PROFILE,
  guestArchOf,
  platformKey,
  qemuBinName,
  resolveQemuDir,
  inspectQemuDir,
  qemuVersion,
  accelHelp,
  probeAccel,
  accelPreference,
  detectAccel,
  cpuModelFor,
  kernelCmdline,
  buildArgv,
  createOverlay,
  overlayInfo,
};
