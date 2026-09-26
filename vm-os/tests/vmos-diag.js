#!/usr/bin/env node
/*
 * 诊断脚本：用 -kernel/-initrd 直接引导 CIBYP-VM-OS 镜像并保持运行，
 * 打印串口输出；若能连上 SSH 则跑一组诊断命令（systemd/网络/cloud-init/sshd）。
 *
 * 用法：node vm-os/tests/vmos-diag.js --image <qcow2> --kernel <vmlinuz> --initrd <initrd> [--arch amd64] [--seconds 240]
 */
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const qemuRuntime = require('../../src/main/vm/qemu-runtime.js');
const provision = require('../../src/main/vm/vm-provision.js');
const { VmSsh } = require('../../src/main/vm/vm-ssh.js');

function parseArgs(argv) {
  const out = { image: null, kernel: null, initrd: null, arch: 'amd64', seconds: 240 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--image') out.image = val();
    else if (a === '--kernel') out.kernel = val();
    else if (a === '--initrd') out.initrd = val();
    else if (a === '--arch') out.arch = val();
    else if (a === '--seconds') out.seconds = parseInt(val(), 10);
    else throw new Error('未知参数: ' + a);
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const work = path.join(os.tmpdir(), 'cibyp-vmos-diag');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const qemu = qemuRuntime.resolveQemuDir({ assetsDir: 'D:/cibyp-vm-p0/assets' });
  const info = qemuRuntime.inspectQemuDir(qemu.dir, 'amd64');
  const sshPort = await freePort();
  const serialPort = await freePort();
  const ciPort = await freePort();

  const keys = provision.generateSshKeyPair();
  const ciDir = path.join(work, 'ci');
  fs.mkdirSync(ciDir, { recursive: true });
  fs.writeFileSync(path.join(ciDir, 'meta-data'), provision.buildMetaData({ instanceId: 'diag-1' }));
  fs.writeFileSync(path.join(ciDir, 'user-data'), provision.buildUserData({
    authorizedKey: keys.publicKey, instanceId: 'diag-1',
  }));
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index';
    const p = path.join(ciDir, name);
    if (fs.existsSync(p)) { res.writeHead(200); res.end(fs.readFileSync(p)); } else { res.writeHead(404); res.end('nf'); }
  });
  await new Promise((r) => server.listen(ciPort, '127.0.0.1', r));

  const overlay = path.join(work, 'overlay.qcow2');
  const c = spawnSync(info.img, ['create', '-f', 'qcow2', '-b', path.resolve(opts.image), '-F', 'qcow2', overlay], { encoding: 'utf8' });
  if (c.status !== 0) throw new Error('overlay 创建失败: ' + c.stderr);

  const accel = qemuRuntime.detectAccel({ exe: info.exe, guestArch: 'amd64', dataDir: info.dataDir });
  console.log('加速器:', accel.backend, accel.detail);
  const argv = qemuRuntime.buildArgv({
    exe: info.exe, dataDir: info.dataDir, guestArch: 'amd64', accel: accel.backend,
    smp: 4, memMB: 4096, overlay, kernel: opts.kernel, initrd: opts.initrd,
    sshPort, serialPort, ciPort, netMode: 'nat', name: 'vmos-diag',
  });
  console.log('SSH 端口:', sshPort, '| 串口:', serialPort, '| cloud-init:', ciPort);
  const child = spawn(info.exe, argv, { cwd: info.dir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write('[qemu] ' + d));

  // 串口日志 + 允许写入（诊断用：可以敲命令）
  const ser = net.connect({ host: '127.0.0.1', port: serialPort });
  let serialBuf = '';
  ser.on('data', (d) => { const t = d.toString('utf8'); serialBuf += t; process.stdout.write(t); });
  ser.on('error', () => {});
  ser.on('connect', () => console.log('\n[diag] 串口已连接（可写入）\n'));
  process.stdin.on('data', (d) => { try { ser.write(d); } catch (_) {} });

  const ssh = new VmSsh({ port: sshPort, privateKey: keys.privateKey });
  try {
    await ssh.waitReady({ timeoutMs: 180000 });
    console.log('\n[diag] SSH 已连接，开始诊断\n');
    const cmds = [
      'cat /etc/os-release | head -3',
      'systemctl is-system-running || true',
      'systemctl --failed --no-pager | head -20',
      'systemctl is-enabled ssh 2>&1; systemctl is-active ssh 2>&1',
      'ip -br a',
      'systemd-networkd 2>/dev/null; systemctl is-active systemd-networkd || true',
      'cloud-init status --long 2>&1 | head -20',
      'ls -la /etc/ssh/ | head; cat /etc/ssh/sshd_config.d/*.conf 2>/dev/null | head',
      'journalctl -u ssh -n 20 --no-pager 2>&1 | tail -20',
      'ss -ltnp 2>/dev/null | head',
      'df -h / | tail -1',
      'sudo -n true && echo sudo-ok',
    ];
    for (const c2 of cmds) {
      const r = await ssh.exec(c2, { timeoutMs: 30000 });
      console.log('$ ' + c2 + '\n' + (r.stdout || '').slice(0, 1200) + (r.stderr ? '\n[stderr] ' + r.stderr.slice(0, 300) : '') + '\n');
    }
  } catch (e) {
    console.log('\n[diag] SSH 未就绪: ' + e.message);
    console.log('[diag] 串口尾部:\n' + serialBuf.slice(-3000));
  }

  console.log(`\n[diag] VM 保持运行 ${opts.seconds}s（ssh -i <key> -p ${sshPort} cibyp@127.0.0.1）`);
  console.log('[diag] 私钥:\n' + keys.privateKey.split('\n').slice(0, 3).join('\n') + '\n...');
  fs.writeFileSync(path.join(work, 'id_ed25519'), keys.privateKey);
  fs.chmodSync(path.join(work, 'id_ed25519'), 0o600);
  console.log('[diag] 私钥文件: ' + path.join(work, 'id_ed25519'));
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } process.exit(0); }, opts.seconds * 1000);
}

main().catch((e) => { console.error('[diag 失败]', e.message); process.exit(1); });
