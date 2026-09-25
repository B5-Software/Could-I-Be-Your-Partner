#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * CIBYP-VM-OS boot 冒烟测试（CI 用，零第三方依赖）。
 *
 * 验证内容：
 *   1. 内核/initrd 直接引导可用（无需引导器）
 *   2. cloud-init（NoCloud-net over HTTP）完成首启配置
 *   3. 出厂契约：cibyp 用户 + NOPASSWD sudo + /workspace + sshd 仅密钥 + os-release 品牌
 *   4. 网络不依赖 cloud-init（systemd-networkd 起 eth0）
 *   5. 持久化：同一 overlay 重启后 /workspace 数据仍在
 *   6. 重置：删除 overlay 后重启回到出厂态（数据消失）
 *
 * 用法：
 *   node vm-os/tests/boot-smoke.js --image <qcow2> --kernel <vmlinuz> --initrd <initrd.img>
 *        --arch amd64|arm64 --variant base [--work <dir>] [--timeout 900]
 *
 * 退出码：0 全部通过；1 失败（打印失败项与串口尾部）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const QEMU_BIN = { amd64: 'qemu-system-x86_64', arm64: 'qemu-system-aarch64' };
const QEMU_MACHINE = { amd64: 'q35', arm64: 'virt' };
const GUEST_CONSOLE = { amd64: 'ttyS0', arm64: 'ttyAMA0' };

function parseArgs(argv) {
  const out = {
    image: null, kernel: null, initrd: null, arch: 'amd64', variant: 'base',
    work: null, timeout: 900, mem: 2048, smp: 2,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--image') out.image = val();
    else if (a === '--kernel') out.kernel = val();
    else if (a === '--initrd') out.initrd = val();
    else if (a === '--arch') out.arch = val();
    else if (a === '--variant') out.variant = val();
    else if (a === '--work') out.work = val();
    else if (a === '--timeout') out.timeout = parseInt(val(), 10);
    else if (a === '--mem') out.mem = parseInt(val(), 10);
    else if (a === '--smp') out.smp = parseInt(val(), 10);
    else throw new Error('未知参数: ' + a);
  }
  for (const k of ['image', 'kernel', 'initrd']) if (!out[k]) throw new Error('缺少必填参数 --' + k);
  if (!QEMU_BIN[out.arch]) throw new Error('不支持的架构: ' + out.arch);
  if (!out.work) out.work = path.join(os.tmpdir(), `vmos-smoke-${out.variant}-${out.arch}`);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 && !!(r.stdout || '').trim();
}

// ---------------------------------------------------------------- SSH

function sshRun(key, port, knownHosts, cmd, timeoutMs = 120000) {
  const r = spawnSync('ssh', [
    '-i', key, '-p', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15',
    'cibyp@127.0.0.1', cmd,
  ], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function sshWaitFor(key, port, knownHosts, cmd, timeoutMs, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = sshRun(key, port, knownHosts, cmd, 30000);
    if (last.code === 0) return last;
    await sleep(intervalMs);
  }
  return last || { code: -1, out: '', err: 'timeout' };
}

// ---------------------------------------------------------------- QEMU 进程

class Vm {
  constructor(opts, work) {
    this.opts = opts;
    this.work = work;
    this.child = null;
    this.exit = null;
    this.serialFile = path.join(work, 'serial.log');
    this.serialBuf = '';
    this.qemuLog = path.join(work, 'qemu.log');
  }

  detectAccel() {
    const help = spawnSync(QEMU_BIN[this.opts.arch], ['-accel', 'help'], { encoding: 'utf8', timeout: 20000 });
    const text = ((help.stdout || '') + (help.stderr || '')).trim();
    const list = text.split(/\s+/).filter(Boolean);
    // 宿主平台优先级
    const pref = process.platform === 'linux' ? ['kvm', 'tcg'] : process.platform === 'darwin' ? ['hvf', 'tcg'] : ['whpx', 'tcg'];
    const chosen = pref.find((a) => list.includes(a)) || 'tcg';
    return { chosen, list, text };
  }

  start({ accel, sshPort, serialPort, ciPort, overlay }) {
    const cmdline = `root=LABEL=cibyp-root rw console=${GUEST_CONSOLE[this.opts.arch]},115200 net.ifnames=0 rootwait`;
    const argv = [
      '-name', `vmos-smoke-${this.opts.variant}`,
      '-machine', QEMU_MACHINE[this.opts.arch],
      '-accel', accel,
      '-smp', String(this.opts.smp),
      '-m', String(this.opts.mem),
      '-kernel', this.opts.kernel,
      '-initrd', this.opts.initrd,
      '-append', cmdline,
      '-drive', `file=${overlay},if=virtio,format=qcow2,cache=writeback,discard=unmap`,
      '-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
      '-device', 'virtio-net-pci,netdev=n0',
      '-chardev', `socket,id=ser0,host=127.0.0.1,port=${serialPort},server=on,wait=off`,
      '-serial', 'chardev:ser0',
      '-smbios', `type=1,serial=ds=nocloud-net;s=http://10.0.2.2:${ciPort}/`,
      '-device', 'virtio-rng-pci',
      '-display', 'none',
      '-monitor', 'none',
    ];
    if (accel === 'kvm' || accel === 'hvf') argv.push('-cpu', accel === 'kvm' ? 'host' : 'host');
    else argv.push('-cpu', 'max');

    const out = fs.createWriteStream(this.qemuLog, { flags: 'w' });
    out.write(`# ${QEMU_BIN[this.opts.arch]} ${argv.join(' ')}\n`);
    this.child = spawn(QEMU_BIN[this.opts.arch], argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => out.write(d));
    this.child.stderr.on('data', (d) => out.write(d));
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; out.end(); });

    // 串口采集（QEMU 为 server，我们连它）
    const ser = fs.createWriteStream(this.serialFile, { flags: 'w' });
    const connect = () => {
      if (this.exit) return;
      const sock = net.connect({ host: '127.0.0.1', port: serialPort });
      sock.on('data', (d) => { this.serialBuf = (this.serialBuf + d.toString('utf8')).slice(-128 * 1024); ser.write(d); });
      sock.on('error', () => setTimeout(connect, 1000));
      sock.on('close', () => { if (!this.exit) setTimeout(connect, 1000); });
    };
    connect();
    return argv;
  }

  async waitSshReady(port, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const alive = await new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        s.setTimeout(4000);
        s.once('data', () => { s.destroy(); resolve(true); });
        s.once('error', () => { s.destroy(); resolve(false); });
        s.once('timeout', () => { s.destroy(); resolve(false); });
      });
      if (alive) return { ok: true, ms: Date.now() - t0 };
      if (this.exit) return { ok: false, ms: Date.now() - t0, reason: `qemu 提前退出 code=${this.exit.code}` };
      await sleep(1000);
    }
    return { ok: false, ms: Date.now() - t0, reason: '超时' };
  }

  async poweroff(ssh, sshPort, knownHosts) {
    sshRun(ssh, sshPort, knownHosts, 'sudo systemctl poweroff', 15000);
    const deadline = Date.now() + 45000;
    while (!this.exit && Date.now() < deadline) await sleep(300);
    if (!this.exit) { try { this.child.kill('SIGKILL'); } catch {} }
    await sleep(500);
  }
}

// ---------------------------------------------------------------- cloud-init

function writeCloudInit(work, pubKey) {
  const dir = path.join(work, 'cloud-init');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta-data'), 'instance-id: vmos-smoke-0001\nlocal-hostname: cibyp-vmos\n');
  fs.writeFileSync(path.join(dir, 'user-data'), [
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
    'timezone: UTC',
    'runcmd:',
    '  - [ sh, -c, "install -d -o cibyp -g cibyp /workspace && touch /workspace/.cibyp-ready" ]',
    '',
  ].join('\n'));
  return dir;
}

function serveCloudInit(dir, port) {
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index';
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- 断言

class Checks {
  constructor() { this.items = []; }
  assert(name, ok, detail = '') {
    this.items.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
    log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
    return ok;
  }
  get failed() { return this.items.filter((i) => !i.ok); }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv);
  const work = opts.work;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  for (const [label, f] of [['镜像', opts.image], ['内核', opts.kernel], ['initrd', opts.initrd]]) {
    if (!fs.existsSync(f)) throw new Error(`${label}不存在: ${f}`);
  }
  if (!which(QEMU_BIN[opts.arch])) throw new Error(`找不到 ${QEMU_BIN[opts.arch]}（CI 需 apt install qemu-system-*）`);
  if (!which('ssh-keygen')) throw new Error('找不到 ssh-keygen');

  const checks = new Checks();
  const key = path.join(work, 'id_ed25519');
  const g = spawnSync('ssh-keygen', ['-t', 'ed25519', '-q', '-N', '', '-C', 'vmos-smoke', '-f', key], { encoding: 'utf8' });
  if (g.status !== 0) throw new Error('ssh-keygen 失败: ' + (g.stderr || g.error));
  const knownHosts = path.join(work, 'known_hosts');
  const pubKey = fs.readFileSync(key + '.pub', 'utf8');
  const ciDir = writeCloudInit(work, pubKey);
  const ciPort = await freePort();
  const ciServer = await serveCloudInit(ciDir, ciPort);

  const overlay = path.join(work, 'overlay.qcow2');
  const createOverlay = () => {
    fs.rmSync(overlay, { force: true });
    const r = spawnSync('qemu-img', ['create', '-f', 'qcow2', '-b', path.resolve(opts.image), '-F', 'qcow2', overlay], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('qemu-img create 失败: ' + (r.stderr || r.error));
  };

  const vm = new Vm(opts, work);
  const accel = vm.detectAccel();
  log(`架构=${opts.arch} 变体=${opts.variant} 加速器=${accel.chosen}（可用: ${accel.list.join(', ')}）`);

  /** 启动一轮：返回 ssh 端口与就绪信息 */
  async function boot(roundLabel) {
    const sshPort = await freePort();
    const serialPort = await freePort();
    createOverlay();
    const t0 = Date.now();
    vm.start({ accel: accel.chosen, sshPort, serialPort, ciPort, overlay });
    const ready = await vm.waitSshReady(sshPort, Math.min(opts.timeout * 1000, 600000));
    if (!ready.ok) {
      log(`[${roundLabel}] 启动失败：${ready.reason}；串口尾部：\n${vm.serialBuf.slice(-2500)}`);
      throw new Error(`[${roundLabel}] SSH 未就绪（${ready.reason}）`);
    }
    const auth = await sshWaitFor(key, sshPort, knownHosts, 'true', 180000, 3000);
    if (auth.code !== 0) throw new Error(`[${roundLabel}] SSH 认证失败: ${auth.err}`);
    log(`[${roundLabel}] SSH 就绪（banner ${ready.ms}ms）`);
    return { sshPort, ready, t0 };
  }

  // ============ 第一轮：出厂契约 ============
  const r1 = await boot('第1轮');
  const ci = await sshWaitFor(key, r1.sshPort, knownHosts, 'cloud-init status --wait >/dev/null 2>&1; echo ok', 300000, 5000);
  checks.assert('cloud-init 完成', ci.code === 0 && ci.out.includes('ok'), ci.err);

  const readyFile = await sshWaitFor(key, r1.sshPort, knownHosts, 'test -f /workspace/.cibyp-ready && echo ok', 60000, 3000);
  checks.assert('cloud-init runcmd 生效（/workspace 就绪）', readyFile.code === 0, readyFile.err);

  const probe = (cmd) => sshRun(key, r1.sshPort, knownHosts, cmd, 60000);
  const osr = probe(". /etc/os-release && echo \"$ID|$ID_LIKE|$VERSION_ID\"");
  checks.assert('os-release 品牌（ID=cibyp-vmos, ID_LIKE=debian）',
    osr.code === 0 && /^cibyp-vmos\|debian\|/.test(osr.out), osr.out);

  const sudo = probe('sudo -n true && echo ok');
  checks.assert('cibyp 具备 NOPASSWD sudo', sudo.code === 0 && sudo.out === 'ok', sudo.err);

  const ws = probe('echo smoke > /workspace/persist.txt && cat /workspace/persist.txt && stat -c %U /workspace');
  checks.assert('/workspace 可写且属主 cibyp', ws.code === 0 && ws.out.includes('cibyp') && ws.out.includes('smoke'), ws.out + ws.err);

  const netd = probe('systemctl is-active systemd-networkd');
  checks.assert('systemd-networkd 运行（网络不依赖 cloud-init）', netd.out === 'active', netd.out);

  const qga = probe('command -v qemu-ga >/dev/null && echo present || echo absent');
  checks.assert('qemu-guest-agent 已安装', qga.out === 'present', qga.out);

  const info = probe('cibyp-vmos-info | head -3');
  checks.assert('cibyp-vmos-info 可用', info.code === 0 && info.out.includes('CIBYP-VM-OS'), info.out + info.err);

  const pwdAuth = probe("sudo sshd -T 2>/dev/null | grep -E '^passwordauthentication' || grep -i '^PasswordAuthentication' /etc/ssh/sshd_config.d/*.conf");
  checks.assert('sshd 关闭密码认证', /no/i.test(pwdAuth.out), pwdAuth.out);

  const kernel = probe('uname -r');
  checks.assert('内核由宿主直接引导可用', kernel.code === 0 && kernel.out.length > 3, kernel.out);
  log('guest 内核: ' + kernel.out);

  const disk = probe("df -h / | tail -1 | awk '{print $2, $4}'");
  log('根分区容量/可用: ' + disk.out);

  // ============ 第二轮：同一 overlay 重启 → 数据持久 ============
  await vm.poweroff(key, r1.sshPort, knownHosts);
  const r2 = await boot('第2轮');
  const persist = await sshWaitFor(key, r2.sshPort, knownHosts, 'cat /workspace/persist.txt', 120000, 3000);
  checks.assert('持久化：同一 overlay 重启后数据保留', persist.code === 0 && persist.out.includes('smoke'), persist.err);

  // ============ 第三轮：删除 overlay（重置）→ 回出厂态 ============
  await vm.poweroff(key, r2.sshPort, knownHosts);
  const r3 = await boot('第3轮（重置后）');
  const afterReset = await sshWaitFor(key, r3.sshPort, knownHosts, 'test -f /workspace/persist.txt && echo exists || echo gone', 120000, 3000);
  checks.assert('重置语义：删除 overlay 后回到出厂态', afterReset.out === 'gone', afterReset.out);

  await vm.poweroff(key, r3.sshPort, knownHosts);
  ciServer.close();

  const report = {
    ts: new Date().toISOString(),
    arch: opts.arch,
    variant: opts.variant,
    accel: accel.chosen,
    qemuAccelAvailable: accel.list,
    sshReadyMs: r1.ready.ms,
    checks: checks.items,
    passed: checks.items.length - checks.failed.length,
    failed: checks.failed.length,
  };
  fs.writeFileSync(path.join(work, 'smoke-report.json'), JSON.stringify(report, null, 2));

  console.log('\n================ boot 冒烟结果 ================');
  console.log(`架构 ${opts.arch} / 变体 ${opts.variant} / 加速器 ${accel.chosen}`);
  console.log(`通过 ${report.passed} / 失败 ${report.failed}`);
  if (report.failed) {
    for (const f of checks.failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    console.log(`串口尾部:\n${vm.serialBuf.slice(-3000)}`);
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

main().catch((e) => {
  console.error('\n[冒烟失败]', e.message);
  process.exit(1);
});
