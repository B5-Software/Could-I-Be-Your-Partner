#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * CIBYP-VM-OS 镜像组装：把 debos 产出的 rootfs tar 组装成可引导镜像。
 *
 * 关键设计：**不需要 loop 设备、不需要 mount、不需要分区表**
 *   - mke2fs -d <dir> 直接把目录树写进 ext4 镜像文件（免挂载）
 *   - 宿主 QEMU 直接 -kernel/-initrd 引导，整盘作为 root（root=LABEL=cibyp-root）
 *   → 容器 / WSL / 普通 CI runner 都能构建（parted+losetup 那套在容器里直接失败）
 *
 * 用法：
 *   node vm-os/tools/assemble-image.js --rootfs <tar.zst> --out <dir> \
 *        --version 0.1.0 --variant base --arch amd64 [--size 8G] [--keep-raw]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const out = { rootfs: null, out: null, version: '0.0.0', variant: 'base', arch: 'amd64', size: '8G', keepRaw: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--rootfs') out.rootfs = val();
    else if (a === '--out') out.out = val();
    else if (a === '--version') out.version = val();
    else if (a === '--variant') out.variant = val();
    else if (a === '--arch') out.arch = val();
    else if (a === '--size') out.size = val();
    else if (a === '--keep-raw') out.keepRaw = true;
    else throw new Error('未知参数: ' + a);
  }
  if (!out.rootfs || !out.out) throw new Error('缺少 --rootfs / --out');
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败(code=${r.status}): ${((r.stderr || '') + (r.stdout || '')).slice(-500)}`);
  }
  return r.stdout || '';
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

function main() {
  const args = parseArgs(process.argv);
  const rootfs = path.resolve(args.rootfs);
  if (!fs.existsSync(rootfs)) throw new Error('rootfs 不存在: ' + rootfs);
  fs.mkdirSync(args.out, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vmos-'));
  console.log('[assemble] 解包 rootfs →', tmp);
  run('tar', ['-xf', rootfs, '-C', tmp]);

  // 内核与 initramfs（宿主直接引导用；与镜像版本严格同源）
  const bootDir = path.join(tmp, 'boot');
  const pick = (prefix) => {
    const files = fs.readdirSync(bootDir).filter((f) => f.startsWith(prefix)).sort();
    if (!files.length) throw new Error(`rootfs 中缺少 ${prefix}*`);
    return path.join(bootDir, files[files.length - 1]);
  };
  const kernelSrc = pick('vmlinuz-');
  const initrdSrc = pick('initrd.img-');
  const kernelDst = path.join(args.out, `vmlinuz-${args.arch}`);
  const initrdDst = path.join(args.out, `initrd-${args.arch}.img`);
  fs.copyFileSync(kernelSrc, kernelDst);
  fs.copyFileSync(initrdSrc, initrdDst);
  console.log(`[assemble] 内核: ${path.basename(kernelSrc)} (${(fs.statSync(kernelDst).size / 1024 ** 2).toFixed(1)}MB)`);
  console.log(`[assemble] initrd: ${path.basename(initrdSrc)} (${(fs.statSync(initrdDst).size / 1024 ** 2).toFixed(1)}MB)`);

  // 组装整盘 ext4（无分区表）
  const raw = path.join(args.out, `cibyp-vmos-${args.version}-${args.variant}-${args.arch}.raw`);
  const qcow = path.join(args.out, `cibyp-vmos-${args.version}-${args.variant}-${args.arch}.qcow2`);
  if (fs.existsSync(raw)) fs.rmSync(raw);
  console.log(`[assemble] 创建稀疏 ${args.size} 镜像并写入 rootfs（mke2fs -d，无需 loop/mount）`);
  run('truncate', ['-s', args.size, raw]);
  run('mke2fs', ['-t', 'ext4', '-F', '-L', 'cibyp-root', '-d', tmp, '-m', '1', '-E', 'lazy_itable_init=1', raw]);

  // 校验文件系统结构（只读检查，不挂载）
  try {
    run('e2fsck', ['-fn', raw]);
  } catch (e) {
    console.warn('[assemble] e2fsck 报告问题（继续）: ' + e.message.slice(0, 200));
  }

  console.log('[assemble] 转 qcow2（zstd 压缩）');
  run('qemu-img', ['convert', '-O', 'qcow2', '-c', '-o', 'compression_type=zstd', raw, qcow]);

  const qcowSize = fs.statSync(qcow).size;
  const rawSize = fs.statSync(raw).size;
  const meta = {
    schema: 1,
    version: args.version,
    variant: args.variant,
    arch: args.arch,
    qcow2: path.basename(qcow),
    qcow2Bytes: qcowSize,
    rawBytes: rawSize,
    kernel: path.basename(kernelDst),
    initrd: path.basename(initrdDst),
    cmdline: 'root=LABEL=cibyp-root rw console=ttyS0,115200 net.ifnames=0 rootwait',
    builtAt: new Date().toISOString(),
    sha256: {
      [path.basename(qcow)]: sha256(qcow),
    },
  };
  fs.writeFileSync(path.join(args.out, `image-meta-${args.variant}-${args.arch}.json`), JSON.stringify(meta, null, 2));
  console.log(`[assemble] 完成: ${path.basename(qcow)} ${(qcowSize / 1024 ** 2).toFixed(1)}MB（raw ${(rawSize / 1024 ** 3).toFixed(1)}GB 稀疏）`);

  if (!args.keepRaw) {
    fs.rmSync(raw, { force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[assemble] 失败:', e.message); process.exit(1); }
}
