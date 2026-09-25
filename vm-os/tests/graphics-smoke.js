#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 图形环境集成冒烟（本机手工执行）：起真 VM，验证 Xvfb + x11vnc + 端口转发 + RFB 握手。
 * noVNC 渲染层无法在无头环境验证，这里验证到"宿主能从转发端口读到 RFB banner"为止。
 *
 * 用法：
 *   node vm-os/tests/graphics-smoke.js --assets <assetsDir> --cmdline "root=PARTUUID=..." [--with-chromium]
 */

'use strict';

const net = require('net');
const path = require('path');

const images = require('../../src/main/vm/vm-images');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmGraphics } = require('../../src/main/vm/vm-graphics');

function parseArgs(argv) {
  const out = { assets: null, variant: 'base', version: null, cmdline: null, withChromium: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--assets') out.assets = val();
    else if (a === '--variant') out.variant = val();
    else if (a === '--version') out.version = val();
    else if (a === '--cmdline') out.cmdline = val();
    else if (a === '--with-chromium') out.withChromium = true;
    else throw new Error('未知参数: ' + a);
  }
  if (!out.assets) throw new Error('缺少 --assets');
  return out;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
}

/** 读 TCP 首包（RFB banner） */
function readBanner(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    const hard = setTimeout(() => finish(null), timeoutMs);
    s.once('data', (d) => { clearTimeout(hard); finish(d.toString('utf8').split('\n')[0].trim()); });
    s.once('error', () => { clearTimeout(hard); finish(null); });
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const assetsDir = path.resolve(opts.assets);
  const st = images.localStatus(assetsDir, { variant: opts.variant });
  const sel = opts.version ? st.versions.find((v) => v.version === opts.version) : st.selected;
  if (!sel || !sel.ok) throw new Error('未找到可用镜像: ' + JSON.stringify(st.missing));

  const inst = new VmInstance({
    assetsDir,
    imagePath: sel.image,
    kernelPath: sel.kernel,
    initrdPath: sel.initrd,
    variant: opts.variant,
    version: sel.version,
    instanceName: 'graphics-smoke',
    config: { smp: 4, memMB: 4096, allowTcg: true, shutdownOnExit: true, kernelCmdline: opts.cmdline || null },
  });
  await inst.start();
  console.log('VM 就绪，加速=' + (inst.accel && inst.accel.backend));

  // 最小 vmService：把图形环境需要的接口桥到真实 SSH
  const forwards = new Map();
  const svc = {
    instance: inst,
    emit: () => {},
    forwardPort: async (guestPort) => {
      const entry = await inst.ssh.forwardToHost(guestPort);
      forwards.set(entry.hostPort, entry);
      return { guestPort, hostPort: entry.hostPort, url: `http://127.0.0.1:${entry.hostPort}/` };
    },
  };
  const g = new VmGraphics({ vmService: svc });
  const t0 = Date.now();
  const startRes = await g.start({ onProgress: (p) => console.log('  [progress]', JSON.stringify(p)) });
  check('图形环境启动成功', startRes.ok && !!startRes.vncHostPort, `用时 ${Date.now() - t0}ms, hostPort=${startRes.vncHostPort}`);

  const banner = await readBanner(startRes.vncHostPort);
  check('宿主经端口转发读到 RFB banner', !!banner && /^RFB \d+\.\d+/.test(banner), banner || '(无)');

  const pg = async (name) => (await inst.exec(`pgrep -x ${JSON.stringify(name)} | head -3`, { timeoutMs: 15000 })).stdout.trim();
  const xvfb = await pg('Xvfb');
  check('guest 内 Xvfb 运行中', /^\d+/m.test(xvfb), xvfb);
  const vnc = await pg('x11vnc');
  check('guest 内 x11vnc 运行中', /^\d+/m.test(vnc), vnc);
  const vncListen = (await inst.exec('ss -ltn | grep 5900 || true', { timeoutMs: 15000 })).stdout.trim();
  check('x11vnc 仅监听 loopback', /127\.0\.0\.1:5900/.test(vncListen), vncListen || '(未监听?)');

  if (opts.withChromium) {
    const t1 = Date.now();
    const cr = await g.startChromium({ url: 'about:blank' });
    check('VM 内 Chromium + CDP 就绪', cr.ok && !!cr.cdpUrl, `${cr.cdpUrl} (${Date.now() - t1}ms)`);
    if (cr.ok) {
      const ver = await inst.exec(`curl -s http://127.0.0.1:9222/json/version | head -3`, { timeoutMs: 20000 });
      check('CDP 版本可读（宿主可 connectOverCDP）', /Chrome|Browser/.test(ver.stdout), ver.stdout.replace(/\n/g, ' ').slice(0, 120));
    }
  }

  await g.stop();
  const after = await pg('x11vnc');
  check('停止后 x11vnc 已退出', !/^\d+/m.test(after), after || '(无进程)');

  await inst.stop({ timeoutMs: 20000 });
  for (const f of forwards.values()) { try { f.close(); } catch { /* ignore */ } }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log('  ✗', f.name, '—', f.detail);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[graphics-smoke 失败]', e.message);
  process.exit(1);
});
