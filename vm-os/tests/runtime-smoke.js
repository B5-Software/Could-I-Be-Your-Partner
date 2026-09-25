#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 运行时集成冒烟（本机手工执行；CI 里由 vm-os/tests/boot-smoke.js 覆盖镜像层）：
 * 直接使用 src/main/vm/* 的真实模块，验证 ssh2 通道（exec / PTY / sftp）与实例生命周期。
 *
 * 前置资源布局（--assets 指向的目录）：
 *   qemu/<platform-arch>/                      QEMU 运行时
 *   images/<variant>/<version>/cibyp-vmos-<version>-<variant>-<arch>.qcow2 + vmlinuz-<arch> + initrd-<arch>.img
 *
 * 用法：
 *   node vm-os/tests/runtime-smoke.js --assets D:\path\to\assets [--variant base] [--version <v>]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const images = require('../../src/main/vm/vm-images');
const { VmInstance } = require('../../src/main/vm/vm-instance');

function parseArgs(argv) {
  const out = { assets: null, variant: 'base', version: null, keep: false, cmdline: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--assets') out.assets = val();
    else if (a === '--variant') out.variant = val();
    else if (a === '--version') out.version = val();
    else if (a === '--cmdline') out.cmdline = val();
    else if (a === '--keep') out.keep = true;
    else throw new Error('未知参数: ' + a);
  }
  if (!out.assets) throw new Error('缺少 --assets');
  return out;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
}

async function main() {
  const opts = parseArgs(process.argv);
  const assetsDir = path.resolve(opts.assets);
  const st = images.localStatus(assetsDir, { variant: opts.variant });
  const sel = opts.version
    ? st.versions.find((v) => v.version === opts.version)
    : st.selected;
  if (!sel || !sel.ok) throw new Error(`未找到可用镜像（assets=${assetsDir}, variant=${opts.variant}）: ${JSON.stringify(st.missing)}`);
  console.log(`镜像: ${sel.image}`);
  console.log(`内核: ${sel.kernel}`);
  console.log(`initrd: ${sel.initrd}`);

  const inst = new VmInstance({
    assetsDir,
    imagePath: sel.image,
    kernelPath: sel.kernel,
    initrdPath: sel.initrd,
    variant: opts.variant,
    version: sel.version,
    instanceName: 'runtime-smoke',
    config: { smp: 4, memMB: 4096, allowTcg: true, tcg: true, shutdownOnExit: true, kernelCmdline: opts.cmdline || null },
  });

  let lastState = null;
  inst.on('state', (s) => {
    if (s.state !== lastState || s.progress % 10 === 0) {
      lastState = s.state;
      console.log(`  [state] ${s.state} ${s.progress}% ${s.detail || ''}`);
    }
  });
  inst.on('error', (e) => console.error('  [error]', e.message));

  const t0 = Date.now();
  await inst.start();
  const startMs = Date.now() - t0;
  check('实例启动到 ready', inst.state === 'ready', `${startMs}ms, accel=${inst.accel && inst.accel.backend}`);

  // exec
  const uname = await inst.exec('uname -srm && nproc');
  check('exec 返回输出', uname.ok && /Linux/.test(uname.stdout), uname.stdout.replace(/\n/g, ' | '));

  const ws = await inst.exec('echo runtime-smoke > /workspace/rt-smoke.txt && cat /workspace/rt-smoke.txt');
  check('/workspace 读写', ws.ok && ws.stdout.includes('runtime-smoke'), ws.stdout);

  const bad = await inst.exec('exit 3');
  check('退出码透传', bad.code === 3, `code=${bad.code}`);

  // sftp
  try {
    const sftp = await inst.sftp();
    const osRel = await sftp.readFile('/etc/os-release');
    check('sftp 读文件', Buffer.isBuffer(osRel) && osRel.toString().includes('ID='), osRel.toString().split('\n')[0]);
    const tmp = '/workspace/rt-sftp.txt';
    await sftp.writeFile(tmp, 'hello-sftp');
    const back = await sftp.readFile(tmp);
    check('sftp 写文件', back.toString() === 'hello-sftp', back.toString());
  } catch (e) {
    check('sftp 通道', false, e.message);
  }

  // PTY：真终端（含窗口大小变更）
  try {
    const shell = await inst.shell({ cols: 100, rows: 30 });
    let out = '';
    shell.onData((d) => { out += d.toString('utf8'); });
    shell.write('echo PTY-$((6*7))\n');
    shell.resize(120, 40);
    await new Promise((r) => setTimeout(r, 2500));
    check('PTY 交互输出', /PTY-42/.test(out), JSON.stringify(out.slice(-120)));
    shell.close();
  } catch (e) {
    check('PTY 通道', false, e.message);
  }

  if (!opts.keep) {
    const tStop = Date.now();
    await inst.stop({ timeoutMs: 20000 });
    check('优雅关机', inst.state === 'idle', `${Date.now() - tStop}ms`);
  } else {
    console.log(`保持运行：ssh -i <instance key> ... pid=${inst.child && inst.child.pid} port=${inst.ports.ssh}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('[runtime-smoke 失败]', e.message);
  process.exit(1);
});
