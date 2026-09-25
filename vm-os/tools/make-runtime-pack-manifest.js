#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 汇总各平台 QEMU 运行时包（cibyp-qemu-<platform>-<arch>.zip）为 runtime-pack-manifest.json。
 * 由 .github/workflows/vm-runtime.yml 在 publish 阶段调用。
 *
 * 用法：
 *   node vm-os/tools/make-runtime-pack-manifest.js --dir release-artifacts \
 *     --base-url https://github.com/<owner>/<repo>/releases/download/vm-runtime-latest \
 *     --out release-artifacts/runtime-pack-manifest.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = { dir: null, out: null, baseUrl: '', version: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--dir') out.dir = val();
    else if (a === '--out') out.out = val();
    else if (a === '--base-url') out.baseUrl = val();
    else if (a === '--version') out.version = val();
    else throw new Error('未知参数: ' + a);
  }
  if (!out.dir) throw new Error('缺少 --dir');
  if (!out.out) out.out = path.join(out.dir, 'runtime-pack-manifest.json');
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv);
  const files = fs.readdirSync(args.dir);
  const manifest = {
    schema: 1,
    name: 'CIBYP-QEMU-RUNTIME',
    version: args.version || new Date().toISOString().slice(0, 10),
    builtAt: new Date().toISOString(),
    license:
      'QEMU is licensed under GPLv2. This package contains unmodified upstream binaries plus their ' +
      'runtime dependencies; source is available from the upstream project (https://www.qemu.org/download/#source).',
    sourceUrl: 'https://github.com/B5-Software/Could-I-Be-Your-Partner/tree/main/scripts/vm-pack.js',
    packs: {},
  };
  for (const f of files) {
    const m = /^cibyp-qemu-([a-z0-9]+)-([a-z0-9_]+)\.zip$/.exec(f);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    const file = path.join(args.dir, f);
    const metaFile = path.join(args.dir, `.meta-${key}.json`);
    let meta = {};
    try { if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* ignore */ }
    manifest.packs[key] = {
      url: args.baseUrl ? `${args.baseUrl}/${f}` : f,
      sha256: sha256(file),
      sizeBytes: fs.statSync(file).size,
      qemuVersion: meta.qemuVersion || null,
      accel: meta.accel || null,
      bins: meta.bins || null,
    };
    console.log(`  ✓ ${key}  ${(fs.statSync(file).size / 1024 ** 2).toFixed(1)}MB  qemu=${meta.qemuVersion || '?'}`);
  }
  if (!Object.keys(manifest.packs).length) {
    console.error('[pack-manifest] 没有找到任何 cibyp-qemu-<platform>-<arch>.zip');
    process.exit(1);
  }
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2) + '\n');
  console.log('[pack-manifest] →', args.out, `（${Object.keys(manifest.packs).length} 个平台）`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[pack-manifest] 失败:', e.message); process.exit(1); }
}
