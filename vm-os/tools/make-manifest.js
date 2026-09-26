#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 生成 runtime-manifest.json：宿主 App 消费的运行时资源清单。
 *
 * 用法（CI 中在所有产物下载齐后执行）：
 *   node vm-os/tools/make-manifest.js \
 *     --dir release-artifacts \
 *     --version 0.1.0 \
 *     --channel stable \
 *     --out release-artifacts/runtime-manifest.json
 *
 * 约定：产物文件名形如 cibyp-vmos-<version>-<variant>-<arch>.qcow2[.sha256]
 *      以及 vmlinuz-<arch> / initrd-<arch>.img。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VARIANTS = ['base', 'desktop', 'full'];
const ARCHES = ['amd64', 'arm64'];
const VARIANT_LIMITS_MB = { base: 520, desktop: 950, full: 1600 };

function parseArgs(argv) {
  const out = { dir: null, version: '0.0.0', channel: 'stable', out: null, baseUrl: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--dir') out.dir = val();
    else if (a === '--version') out.version = val();
    else if (a === '--channel') out.channel = val();
    else if (a === '--base-url') out.baseUrl = val();
    else if (a === '--out') out.out = val();
    else throw new Error('未知参数: ' + a);
  }
  if (!out.dir) throw new Error('缺少 --dir');
  if (!out.out) out.out = path.join(out.dir, 'runtime-manifest.json');
  return out;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** 优先读取同名 .sha256 文件（CI 生成），否则现算 */
function digestOf(file) {
  const side = file + '.sha256';
  if (fs.existsSync(side)) {
    const t = fs.readFileSync(side, 'utf8').trim();
    const m = t.match(/^([0-9a-f]{64})/i);
    if (m) return m[1].toLowerCase();
  }
  return sha256(file);
}

function main() {
  const args = parseArgs(process.argv);
  const files = fs.readdirSync(args.dir).filter((f) => !f.endsWith('.sha256'));

  const manifest = {
    schema: 1,
    name: 'CIBYP-VM-OS',
    version: args.version,
    channel: args.channel,
    builtAt: new Date().toISOString(),
    base: 'Debian GNU/Linux 13 (trixie)',
    compat: {
      minHostApp: '1.8.0',
      qemu: { min: '9.0', recommended: '11.0' },
      notes: '宿主需支持 -kernel/-initrd 直接引导；内核与 initrd 与镜像版本必须一致',
    },
    variants: {},
    kernel: {},
    licenseNote:
      'CIBYP-VM-OS is based on Debian GNU/Linux. Debian is a registered trademark owned by ' +
      'Software in the Public Interest, Inc. CIBYP-VM-OS is not affiliated with or endorsed by the Debian project.',
    sourceUrl: 'https://github.com/B5-Software/Could-I-Be-Your-Partner/tree/main/vm-os',
  };

  const artifacts = [];
  for (const variant of VARIANTS) {
    manifest.variants[variant] = { arches: {}, limitMB: VARIANT_LIMITS_MB[variant] };
    for (const arch of ARCHES) {
      const name = `cibyp-vmos-${args.version}-${variant}-${arch}.qcow2`;
      if (!files.includes(name)) continue;
      const file = path.join(args.dir, name);
      const size = fs.statSync(file).size;
      const mb = +(size / 1024 ** 2).toFixed(1);
      manifest.variants[variant].arches[arch] = {
        url: args.baseUrl ? `${args.baseUrl}/${name}` : name,
        sha256: digestOf(file),
        size,
        sizeMB: mb,
        limitMB: VARIANT_LIMITS_MB[variant],
        withinLimit: mb <= VARIANT_LIMITS_MB[variant],
      };
      artifacts.push({ name, mb, limit: VARIANT_LIMITS_MB[variant] });
    }
  }

  for (const arch of ARCHES) {
    const k = `vmlinuz-${arch}`;
    const i = `initrd-${arch}.img`;
    if (!files.includes(k) || !files.includes(i)) continue;
    manifest.kernel[arch] = {
      kernel: { file: k, url: args.baseUrl ? `${args.baseUrl}/${k}` : k, sha256: digestOf(path.join(args.dir, k)), size: fs.statSync(path.join(args.dir, k)).size },
      initrd: { file: i, url: args.baseUrl ? `${args.baseUrl}/${i}` : i, sha256: digestOf(path.join(args.dir, i)), size: fs.statSync(path.join(args.dir, i)).size },
      cmdline: 'root=LABEL=cibyp-root rw console=ttyS0,115200 net.ifnames=0 rootwait',
    };
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2) + '\n');

  // 体积门禁
  console.log('产物与体积门禁：');
  let bad = 0;
  for (const a of artifacts) {
    const ok = a.mb <= a.limit;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${a.name}  ${a.mb}MB / 上限 ${a.limit}MB`);
  }
  console.log('manifest →', args.out);
  if (bad > 0) {
    console.error(`\n[体积门禁] ${bad} 个产物超限，构建失败`);
    process.exit(1);
  }
}

main();
