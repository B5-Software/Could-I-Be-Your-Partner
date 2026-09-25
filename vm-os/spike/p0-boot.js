#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * P0 验证脚本：在宿主上启动一只 headless QEMU 虚拟机，用 cloud-init（NoCloud-net over HTTP）
 * 完成首启配置，然后通过 SSH 跑一组探针，产出可对比的实测数据。
 *
 * 该脚本零第三方依赖，只用 Node 内置模块 + 系统 OpenSSH 客户端。
 * 后续 P1 会把这些逻辑拆进 src/main/vm/*（qemu-runtime / vm-provision / vm-ssh）。
 *
 * 用法：
 *   node vm-os/spike/p0-boot.js --qemu <qemu目录> --image <base.qcow2> --work <工作目录>
 *        [--accel auto|whpx|tcg] [--mem 4096] [--smp 4] [--timeout 420]
 *        [--fresh] [--keep] [--disk virtio|ide] [--skip-apt]
 *
 * 产物（全部落在 --work）：
 *   id_ed25519 / id_ed25519.pub   一次性测试密钥
 *   cloud-init/{user-data,meta-data}
 *   overlay.qcow2                 base 镜像的写时复制层（--fresh 时重建）
 *   qemu.log / serial.log         QEMU stderr 与串口日志
 *   report.json                   实测报告
 */

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = {
    qemu: null,
    image: null,
    work: null,
    accel: 'auto',
    mem: 4096,
    smp: 4,
    timeout: 420,
    fresh: false,
    keep: false,
    disk: 'auto',
    skipApt: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--qemu') out.qemu = val();
    else if (a === '--image') out.image = val();
    else if (a === '--work') out.work = val();
    else if (a === '--accel') out.accel = val();
    else if (a === '--mem') out.mem = parseInt(val(), 10);
    else if (a === '--smp') out.smp = parseInt(val(), 10);
    else if (a === '--timeout') out.timeout = parseInt(val(), 10);
    else if (a === '--disk') out.disk = val();
    else if (a === '--fresh') out.fresh = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--skip-apt') out.skipApt = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(18, 30).join('\n'));
      process.exit(0);
    } else {
      throw new Error('未知参数: ' + a);
    }
  }
  for (const k of ['qemu', 'image', 'work']) {
    if (!out[k]) throw new Error('缺少必填参数 --' + k);
  }
  return out;
}

// ---------------------------------------------------------------- 小工具

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 进度日志落盘（appendFileSync 同步写，避免 stdout 管道缓冲掩盖真实进度）
let PROGRESS_FILE = null;
function plog(msg) {
  try { if (PROGRESS_FILE) fs.appendFileSync(PROGRESS_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

/** 递归查找文件（限定深度），用于定位 QEMU 的 share 目录 */
function findFile(root, name, maxDepth = 4) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
      if (e.isDirectory() && depth < maxDepth) queue.push({ dir: p, depth: depth + 1 });
    }
  }
  return null;
}

function tailFile(file, maxBytes = 4000) {
  try {
    const buf = fs.readFileSync(file);
    return buf.slice(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- SSH

class Ssh {
  constructor(work, keyPath, port, user) {
    this.work = work;
    this.keyPath = keyPath;
    this.port = port;
    this.user = user || 'cibyp';
  }

  /** 执行远程命令；返回 { code, out, err } */
  run(cmd, timeoutMs = 120000) {
    // OpenSSH 在 Windows 上对 -o 值里的反斜杠处理不稳，统一转正斜杠
    const fwd = (p) => p.split(path.sep).join('/');
    const args = [
      '-i', fwd(this.keyPath),
      '-p', String(this.port),
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${fwd(path.join(this.work, 'known_hosts'))}`,
      '-o', 'LogLevel=ERROR',
      '-o', 'ConnectTimeout=8',
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15',
      `${this.user}@127.0.0.1`,
      cmd,
    ];
    const r = spawnSync('ssh', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
  }

  /** 轮询直到命令成功（用于等 cloud-init / sshd 就绪） */
  async waitFor(cmd, { timeoutMs = 180000, intervalMs = 3000, label = cmd } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const r = this.run(cmd, 30000);
      last = r;
      if (r.code === 0) return { ok: true, out: r.out, waitedMs: timeoutMs - (deadline - Date.now()) };
      await sleep(intervalMs);
    }
    return { ok: false, out: last && last.out, err: last && (last.err || (last.error && last.error.message)) };
  }
}

/** 等待 TCP 端口可连接并抓到 banner，返回耗时 */
async function waitTcpBanner(port, timeoutMs) {
  const start = Date.now();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const banner = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let settled = false;
      const finish = (why, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        plog(`waitTcpBanner#${attempt} ${why}${v ? ' ' + JSON.stringify(v) : ''}`);
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(v);
      };
      // 硬超时兜底：slirp 在 guest sshd 未就绪时会直接关闭连接（FIN），
      // 只监听 data/error/timeout 会永久挂住（实测踩坑）
      const hard = setTimeout(() => finish('hard-timeout'), 6000);
      sock.setTimeout(4000);
      sock.once('connect', () => sock.write(''));
      sock.once('data', (d) => finish('data', String(d).split('\n')[0].trim()));
      sock.once('error', (e) => finish('error:' + e.code));
      sock.once('timeout', () => finish('timeout'));
      sock.once('end', () => finish('end'));
      sock.once('close', () => finish('close'));
    });
    if (banner) return { ok: true, banner, ms: Date.now() - start };
    await sleep(800);
  }
  return { ok: false, ms: Date.now() - start };
}

// ---------------------------------------------------------------- cloud-init

function buildCloudInit(work, pubKey) {
  const dir = path.join(work, 'cloud-init');
  fs.mkdirSync(dir, { recursive: true });
  const meta = [
    'instance-id: cibyp-p0-0001',
    'local-hostname: cibyp-vmos',
    '',
  ].join('\n');
  const user = [
    '#cloud-config',
    'users:',
    '  - name: cibyp',
    '    groups: [sudo]',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    ssh_authorized_keys:',
    `      - ${pubKey.trim()}`,
    'ssh_pwauth: false',
    'disable_root: true',
    'growpart: { mode: auto, devices: ["/"] }',
    'resize_rootfs: true',
    'locale: en_US.UTF-8',
    'timezone: Asia/Shanghai',
    'runcmd:',
    '  - [ sh, -c, "mkdir -p /workspace && chown cibyp:cibyp /workspace" ]',
    '  - [ sh, -c, "echo \'CIBYP-VM-OS spike ready\' > /workspace/.cibyp-ready" ]',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'meta-data'), meta);
  fs.writeFileSync(path.join(dir, 'user-data'), user);
  return dir;
}

function startCloudInitServer(dir, port) {
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index';
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(fs.readFileSync(file));
      log(`cloud-init 请求命中: /${name}`);
    } else {
      res.writeHead(404);
      res.end('not found');
      log(`cloud-init 请求未命中: /${name}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- QEMU

class Qemu {
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.exitInfo = null;
  }

  get exe() { return path.join(this.opts.qemuDir, 'qemu-system-x86_64.exe'); }

  get dataDir() {
    // weilnetz 安装包布局：<prefix>/share/qemu 或 <prefix>/share
    const a = path.join(this.opts.qemuDir, 'share', 'qemu', 'bios.bin');
    if (fs.existsSync(a)) return path.join(this.opts.qemuDir, 'share', 'qemu');
    return path.join(this.opts.qemuDir, 'share');
  }

  /** `-accel help` 列出可用加速器 */
  accelHelp() {
    const r = spawnSync(this.exe, ['-accel', 'help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const text = ((r.stdout || '') + (r.stderr || '')).trim();
    return { text, code: r.status, error: r.error && r.error.message };
  }

  /**
   * 加速器可用性硬探测：真实执行（不暂停），存活 5s 且无致命签名才算可用。
   * 实测坑：WHPX + `-cpu max/host` 会打印 `WHPX: Unexpected VP exit code 4`，
   * 进程存活但 guest 永不启动 —— 必须在探针里识别（-S 暂停探测发现不了）。
   */
  probeAccel(accel, cpu) {
    const args = [
      '-L', this.dataDir,
      '-accel', accel,
      '-machine', 'pc',
      '-display', 'none',
      '-nodefaults',
      '-m', '256',
    ];
    if (cpu) args.push('-cpu', cpu);
    const t0 = Date.now();
    const r = spawnSync(this.exe, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const combined = ((r.stderr || '') + (r.stdout || '') + (r.error ? r.error.message : '')).trim();
    const alive = !!r.error && /ETIMEDOUT|timed out/i.test(r.error.message || '');
    const fatal = /WHPX: Unexpected VP exit code|WHPX: Failed|Could not create vCPU|KVM: not found|hvf: failed/i.test(combined);
    return {
      ok: alive && !fatal,
      aliveMs: Date.now() - t0,
      stderr: combined.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 400),
    };
  }

  buildArgv({ accel, cpu, diskIf, sshPort, serialPort, ciPort, overlay, meta }) {
    const argv = [
      '-L', this.dataDir,
      '-name', 'cibyp-vmos-p0',
      '-accel', accel,
      '-machine', 'pc',
      '-smp', String(this.opts.smp),
      '-m', String(this.opts.mem),
      '-display', 'none',
      '-monitor', 'none',
      '-drive', `file=${overlay},if=${diskIf},format=qcow2,cache=writeback,discard=unmap`,
      '-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
      '-device', diskIf === 'virtio' ? 'virtio-net-pci,netdev=n0' : 'e1000,netdev=n0',
      '-chardev', `socket,id=ser0,host=127.0.0.1,port=${serialPort},server=on,wait=off`,
      '-serial', 'chardev:ser0',
      '-smbios', `type=1,serial=ds=nocloud-net;s=http://10.0.2.2:${ciPort}/`,
      '-device', 'virtio-rng-pci',
    ];
    if (cpu) argv.push('-cpu', cpu);
    if (meta && meta.extra) argv.push(...meta.extra);
    return argv;
  }

  start(argv) {
    const logFile = path.join(this.opts.work, 'qemu.log');
    const out = fs.createWriteStream(logFile, { flags: 'w' });
    out.write(`# ${this.exe} ${argv.join(' ')}\n`);
    this.child = spawn(this.exe, argv, {
      cwd: this.opts.qemuDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d) => out.write(d));
    this.child.stderr.on('data', (d) => out.write(d));
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, at: Date.now() };
      out.write(`\n# qemu exited code=${code} signal=${signal}\n`);
    });
    return this.child;
  }

  async stop(timeoutMs = 20000) {
    if (!this.child || this.exitInfo) return;
    this.child.kill();
    const deadline = Date.now() + timeoutMs;
    while (!this.exitInfo && Date.now() < deadline) await sleep(200);
    if (!this.exitInfo) {
      try { spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    }
  }
}

// ---------------------------------------------------------------- 串口采集

function attachSerial(port, work) {
  const state = { firstByteAt: null, buffer: '', connected: false };
  const logFile = fs.createWriteStream(path.join(work, 'serial.log'), { flags: 'w' });
  const tryConnect = () => {
    if (state.client && !state.client.destroyed) return;
    const sock = net.connect({ host: '127.0.0.1', port });
    state.client = sock;
    sock.on('connect', () => { state.connected = true; });
    sock.on('data', (d) => {
      if (!state.firstByteAt) state.firstByteAt = Date.now();
      const text = d.toString('utf8');
      state.buffer = (state.buffer + text).slice(-64 * 1024);
      logFile.write(text);
    });
    sock.on('error', () => { state.connected = false; });
    sock.on('close', () => {
      state.connected = false;
      if (!state.closed) setTimeout(tryConnect, 1000);
    });
  };
  tryConnect();
  state.close = () => {
    state.closed = true;
    try { state.client && state.client.destroy(); } catch {}
    logFile.end();
  };
  return state;
}

const PANIC_PATTERNS = [
  'Kernel panic',
  'Unable to mount root',
  'VFS: Cannot open root device',
  'No root device specified',
  'not syncing',
];

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(opts.work, { recursive: true });
  PROGRESS_FILE = path.join(opts.work, 'progress.log');
  fs.writeFileSync(PROGRESS_FILE, '');
  plog(`p0 开始: qemu=${opts.qemu} image=${opts.image} accel=${opts.accel} mem=${opts.mem} smp=${opts.smp}`);

  const report = {
    startedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1) },
    opts: { accel: opts.accel, mem: opts.mem, smp: opts.smp, disk: opts.disk },
    accel: {},
    timings: {},
    guest: {},
    checks: {},
    notes: [],
  };

  const qemu = new Qemu({ qemuDir: opts.qemu, work: opts.work, mem: opts.mem, smp: opts.smp });

  // --- 预检
  if (!fs.existsSync(qemu.exe)) throw new Error('找不到 qemu-system-x86_64.exe: ' + qemu.exe);
  if (!fs.existsSync(opts.image)) throw new Error('找不到基础镜像: ' + opts.image);
  const qemuImg = path.join(opts.qemu, 'qemu-img.exe');
  if (!fs.existsSync(qemuImg)) throw new Error('找不到 qemu-img.exe: ' + qemuImg);
  if (!fs.existsSync(path.join(qemu.dataDir, 'bios.bin')) && !fs.existsSync(path.join(qemu.dataDir, 'kvmvapic.bin'))) {
    report.notes.push('警告: dataDir 可能不含固件: ' + qemu.dataDir);
  }
  log('QEMU:', qemu.exe);
  log('固件目录:', qemu.dataDir);

  const ver = spawnSync(qemu.exe, ['--version'], { encoding: 'utf8', windowsHide: true });
  report.qemuVersion = ((ver.stdout || '') + (ver.stderr || '')).trim().split('\n')[0];

  // --- 加速器探测（-accel help + 真实存活探测）
  const help = qemu.accelHelp();
  report.accel.help = help.text.replace(/\s+/g, ' ').trim();
  log('可用加速器:', report.accel.help);

  const candidates = [];
  const preferred = opts.accel === 'auto' ? ['whpx', 'tcg'] : [opts.accel];
  for (const a of preferred) {
    if (a === 'whpx' && !/whpx/i.test(help.text)) { report.notes.push('whpx 不在 -accel help 列表'); continue; }
    // CPU 模型：WHPX 不支持 -cpu max（实测 QEMU 11.1 会 WHPX: Unexpected VP exit code 4），
    // 用默认模型；TCG 用 max；KVM/HVF 用 host。
    const cpuSeq = a === 'tcg' ? ['max'] : a === 'whpx' ? [null] : ['host', 'max'];
    for (const cpu of cpuSeq) {
      candidates.push({ accel: a, cpu });
    }
  }
  let chosen = null;
  for (const c of candidates) {
    const key = `${c.accel}${c.cpu ? '+' + c.cpu : ''}`;
    const t0 = Date.now();
    plog(`探测 ${key} ...`);
    const r = qemu.probeAccel(c.accel, c.cpu);
    report.accel[key] = { ok: r.ok, ms: Date.now() - t0, stderr: r.stderr };
    plog(`探测 ${key}: ${r.ok ? '可用' : '不可用'} ${r.stderr || ''}`);
    log(`探测 ${key}: ${r.ok ? '可用' : '不可用'} ${r.stderr ? '(' + r.stderr + ')' : ''}`);
    if (r.ok) { chosen = c; break; }
  }
  if (!chosen) throw new Error('没有任何可用加速器（whpx/tcg 都失败）');
  report.accel.chosen = chosen.accel + (chosen.cpu ? '+' + chosen.cpu : '');
  log('选定加速器:', report.accel.chosen);

  // --- 测试密钥
  const keyPath = path.join(opts.work, 'id_ed25519');
  if (!fs.existsSync(keyPath)) {
    const g = spawnSync('ssh-keygen', ['-t', 'ed25519', '-q', '-N', '', '-C', 'cibyp-p0', '-f', keyPath], { encoding: 'utf8', windowsHide: true });
    if (g.status !== 0) throw new Error('ssh-keygen 失败: ' + (g.stderr || g.error));
  }
  const pubKey = fs.readFileSync(keyPath + '.pub', 'utf8');

  // --- cloud-init 服务
  const ciDir = buildCloudInit(opts.work, pubKey);
  const ciPort = await findFreePort();
  const ciServer = await startCloudInitServer(ciDir, ciPort);
  log('cloud-init 服务:', `http://127.0.0.1:${ciPort}/ (guest 侧走 10.0.2.2)`);

  // --- overlay
  const overlay = path.join(opts.work, 'overlay.qcow2');
  if (opts.fresh && fs.existsSync(overlay)) fs.rmSync(overlay, { force: true });
  if (!fs.existsSync(overlay)) {
    const c = spawnSync(qemuImg, ['create', '-f', 'qcow2', '-b', path.resolve(opts.image), '-F', 'qcow2', overlay], { encoding: 'utf8', windowsHide: true });
    if (c.status !== 0) throw new Error('qemu-img create 失败: ' + (c.stderr || c.error));
    const info = spawnSync(qemuImg, ['info', '--output=json', overlay], { encoding: 'utf8', windowsHide: true });
    report.overlay = { created: true, info: JSON.parse(info.stdout || '{}') };
    log('overlay 已创建');
  } else {
    report.overlay = { created: false, reused: true };
    log('复用已有 overlay（--fresh 可重建）');
  }

  // --- 端口 + 启动（磁盘模式带回退）
  const sshPort = await findFreePort();
  const serialPort = await findFreePort();
  const diskModes = opts.disk === 'auto' ? ['virtio', 'ide'] : [opts.disk];

  let ssh = null;
  for (let attempt = 0; attempt < diskModes.length; attempt++) {
    const diskIf = diskModes[attempt];
    const argv = qemu.buildArgv({
      accel: chosen.accel, cpu: chosen.cpu, diskIf, sshPort, serialPort, ciPort, overlay,
    });
    log(`启动 QEMU（disk=${diskIf}, accel=${chosen.accel}）`);
    plog(`启动 QEMU disk=${diskIf} accel=${chosen.accel} sshPort=${sshPort} serialPort=${serialPort} ciPort=${ciPort}`);
    const t0 = Date.now();
    qemu.start(argv);
    const serial = attachSerial(serialPort, opts.work);

    const banner = await waitTcpBanner(sshPort, attempt === 0 ? 150000 : 90000);
    plog(`banner 结果: ok=${banner.ok} ms=${banner.ms}`);
    const panicked = PANIC_PATTERNS.some((p) => serial.buffer.includes(p));
    report.timings[`spawnToSshBanner${attempt ? '_retry' : ''}`] = banner.ok ? Date.now() - t0 : null;
    report.timings.serialFirstByteMs = serial.firstByteAt ? serial.firstByteAt - t0 : null;
    plog(`banner ok=${banner.ok} ms=${Date.now() - t0} panic=${panicked}`);

    if (banner.ok && !panicked) {
      report.diskIf = diskIf;
      report.sshBanner = banner.banner;
      log(`SSH banner 就绪（${Date.now() - t0}ms）: ${banner.banner}`);
      ssh = new Ssh(opts.work, keyPath, sshPort);
      break;
    }
    log(`第 ${attempt + 1} 次启动未就绪（panic=${panicked}），串口尾部：\n${serial.buffer.slice(-600)}`);
    report.notes.push(`disk=${diskIf} 启动失败 panic=${panicked}`);
    serial.close();
    await qemu.stop();
    await sleep(1500);
    qemu.exitInfo = null;
  }
  if (!ssh) throw new Error('QEMU 启动失败（所有磁盘模式都未就绪），详见 qemu.log / serial.log');

  // --- 等 SSH 认证通过
  const tAuth0 = Date.now();
  plog('等待 SSH 认证 ...');
  const waitAuth = await ssh.waitFor('true', { timeoutMs: 120000, intervalMs: 3000, label: 'ssh auth' });
  report.timings.sshAuthMs = Date.now() - tAuth0;
  report.checks.sshAuth = waitAuth.ok;
  if (!waitAuth.ok) throw new Error('SSH 认证失败: ' + (waitAuth.err || ''));
  plog(`SSH 认证通过 +${report.timings.sshAuthMs}ms`);
  log(`SSH 认证通过（+${report.timings.sshAuthMs}ms）`);

  // --- 等 cloud-init 完成
  const tCi0 = Date.now();
  plog('等待 cloud-init ...');
  const ci = await ssh.waitFor('sudo cloud-init status --wait >/dev/null 2>&1; echo done', { timeoutMs: 300000, intervalMs: 5000 });
  report.timings.cloudInitMs = Date.now() - tCi0;
  report.checks.cloudInit = ci.ok;
  plog(`cloud-init 完成 +${report.timings.cloudInitMs}ms ok=${ci.ok}`);
  log(`cloud-init 完成（+${report.timings.cloudInitMs}ms）`);

  const ready = await ssh.waitFor('test -f /workspace/.cibyp-ready && echo ok', { timeoutMs: 60000, intervalMs: 3000 });
  report.checks.workspaceReady = ready.ok;
  plog(`工作区标记 ok=${ready.ok}`);
  log('工作区标记: ' + (ready.ok ? 'ok' : '缺失'));

  // --- 探针
  plog('开始探针 ...');
  const probe = (cmd) => { const r = ssh.run(cmd); return r.code === 0 ? r.out : `<失败: ${r.err || r.error}>`; };
  report.guest.uname = probe('uname -a');
  report.guest.nproc = probe('nproc');
  report.guest.memMB = probe("free -m | awk '/Mem:/{print $2\" total / \"$7\" available\"}'");
  report.guest.disk = probe("df -h / | tail -1 | awk '{print $2\" size / \"$4\" avail\"}'");
  report.guest.osRelease = probe("grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release");
  report.guest.sudo = probe('sudo -n true && echo ok');
  report.guest.workspaceWrite = probe('echo p0 > /workspace/p0.txt && cat /workspace/p0.txt');
  report.guest.virtio = probe('lsblk -d -o NAME,ROTA 2>/dev/null | tr "\\n" " "');
  report.guest.qga = probe('command -v qemu-ga >/dev/null && echo present || echo absent');
  report.guest.hasNode = probe('command -v node >/dev/null && node -v || echo absent');
  report.guest.hasPython = probe('command -v python3 >/dev/null && python3 -V || echo absent');

  if (!opts.skipApt) {
    const net = ssh.run("curl -s -o /dev/null -w '%{http_code} %{time_total}s' --max-time 20 https://deb.debian.org/debian/ ", 40000);
    report.checks.egress = net.code === 0 && /^200/.test(net.out);
    report.guest.egress = net.out || net.err;
    log('出网测试: ' + (report.guest.egress || '失败'));
  }

  report.serialTail = tailFile(path.join(opts.work, 'serial.log'), 3000);
  report.finishedAt = new Date().toISOString();

  if (opts.keep) {
    report.notes.push(`--keep: 虚拟机保持运行（ssh cibyp@127.0.0.1 -p ${sshPort} -i ${keyPath}）`);
    log(`虚拟机保持运行。SSH: ssh -i "${keyPath}" -p ${sshPort} cibyp@127.0.0.1`);
  } else {
    log('关机中...');
    plog('关机中 ...');
    ssh.run('sudo systemctl poweroff', 20000);
    const deadline = Date.now() + 30000;
    while (!qemu.exitInfo && Date.now() < deadline) await sleep(300);
    await qemu.stop();
    plog('已关机');
  }
  try { ciServer.close(); } catch {}

  const reportFile = path.join(opts.work, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  log('报告已写入:', reportFile);

  console.log('\n================ P0 实测结果 ================');
  console.log('QEMU              :', report.qemuVersion);
  console.log('加速器            :', report.accel.chosen, '|', JSON.stringify(report.accel, null, 0));
  console.log('SSH banner (ms)   :', report.timings.spawnToSshBanner);
  console.log('SSH 认证 (ms)     :', report.timings.sshAuthMs);
  console.log('cloud-init (ms)   :', report.timings.cloudInitMs);
  console.log('guest             :', report.guest.uname);
  console.log('CPU/内存/磁盘     :', report.guest.nproc, '|', report.guest.memMB, '|', report.guest.disk);
  console.log('os-release        :', report.guest.osRelease);
  console.log('出网              :', report.guest.egress);
  console.log('checks            :', JSON.stringify(report.checks));
  console.log('=============================================\n');
}

main().catch((e) => {
  console.error('\n[P0 失败]', e.message);
  process.exit(1);
});
