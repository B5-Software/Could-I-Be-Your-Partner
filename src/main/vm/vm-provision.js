/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 首启配置（cloud-init NoCloud-net over HTTP）：
 *   - 宿主起一个只监听 127.0.0.1 的一次性 HTTP 服务，提供 meta-data / user-data
 *   - QEMU 以 -smbios type=1,serial=ds=nocloud-net;s=http://10.0.2.2:<port>/ 告知 guest 拉取地址
 *     （SLIRP 把 guest 的 10.0.2.2 映射到宿主 loopback，因此服务不需要对外暴露）
 *   - user-data 注入：cibyp 用户 + 每实例独立 SSH 公钥 + /workspace 初始化 + 时区
 *   - 两份文件都被取走后 emit 'served'，供启动进度条使用
 *
 * 安全：端口随机、仅 loopback、内容只含公钥（无私钥/无口令），不写磁盘敏感数据。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const FETCH_TIMEOUT_MS = 120000;

/**
 * 生成一份 deploy 密钥对（ed25519）。
 * 优先用 ssh2 自带生成器：它输出 OpenSSH 私钥格式（`-----BEGIN OPENSSH PRIVATE KEY-----`），
 * 这是 ssh2 客户端唯一稳定支持的私钥格式（实测 Node crypto 的 PKCS#8 PEM 会被拒：
 * `Cannot parse privateKey: Unsupported key format`）。
 */
function generateSshKeyPair() {
  try {
    const { utils } = require('ssh2');
    if (utils && typeof utils.generateKeyPairSync === 'function') {
      const kp = utils.generateKeyPairSync('ed25519');
      return { privateKey: kp.private.toString(), publicKey: kp.public.toString().trim() };
    }
  } catch { /* 回退到 Node crypto */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** 把 SPKI PEM 公钥转成 OpenSSH authorized_keys 单行格式 */
function toAuthorizedKey(spkiPem, comment = 'cibyp-vmos') {
  const der = Buffer.from(
    spkiPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  // ed25519 SPKI：固定 12 字节前缀 + 32 字节原始公钥
  const raw = der.subarray(der.length - 32);
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]), type,
    Buffer.from([0, 0, 0, raw.length]), raw,
  ]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

/** 宿主 SSH 客户端用：把 PKCS#8 PEM 私钥转成 OpenSSH 私钥格式由 ssh2 直接支持（ssh2 接受 PEM/OpenSSH） */

function buildUserData({ authorizedKey, instanceId, hostname = 'cibyp-vmos', timezone = DEFAULT_TIMEZONE, extraRuncmd = [], locale = 'en_US.UTF-8' }) {
  const lines = [
    '#cloud-config',
    `# instance: ${instanceId}`,
    'users:',
    '  - name: cibyp',
    '    groups: [sudo]',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    ssh_authorized_keys:',
    `      - ${authorizedKey}`,
    'ssh_pwauth: false',
    'disable_root: true',
    'growpart: { mode: auto, devices: ["/"] }',
    'resize_rootfs: true',
    `locale: ${locale}`,
    `timezone: ${timezone}`,
    'runcmd:',
    '  - [ sh, -c, "install -d -o cibyp -g cibyp -m 0755 /workspace" ]',
    '  - [ sh, -c, "touch /workspace/.cibyp-ready && chown cibyp:cibyp /workspace/.cibyp-ready" ]',
    ...extraRuncmd.map((c) => `  - ${c}`),
    '',
  ];
  return lines.join('\n');
}

function buildMetaData({ instanceId, hostname = 'cibyp-vmos' }) {
  return [`instance-id: ${instanceId}`, `local-hostname: ${hostname}`, ''].join('\n');
}

/** 取一个空闲端口（loopback） */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 一次性 cloud-init 服务。
 * @param {object} opts { files: { 'user-data': string, 'meta-data': string }, timeoutMs }
 * @returns {Promise<{ port, served: Promise<void>, close(): void, requests: string[] }>}
 */
async function createProvisionServer({ files = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const emitter = new EventEmitter();
  const requests = [];
  const needed = new Set(Object.keys(files));
  const got = new Set();

  const server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index';
    requests.push(`${new Date().toISOString()} ${req.method} /${name} from ${req.socket.remoteAddress}`);
    if (files[name] !== undefined) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(files[name]) });
      res.end(files[name]);
      got.add(name);
      emitter.emit('file', name);
      if ([...needed].every((n) => got.has(n))) emitter.emit('served');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  const served = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloud-init 未在超时内拉取配置')), timeoutMs);
    emitter.once('served', () => { clearTimeout(timer); resolve(); });
  });
  served.catch(() => {}); // 避免无人 await 时的 unhandledRejection

  return {
    port,
    served,
    requests,
    close: () => { try { server.close(); } catch { /* ignore */ } },
  };
}

/**
 * 落盘 cloud-init 配置 + 服务（vm-instance 使用）。
 * @param {object} opts { dir, instanceId, hostname, timezone, keyPair, extraRuncmd }
 * @returns {Promise<{ port, close, served, dir, requests }>}
 */
async function provision({ dir, instanceId, hostname, timezone, keyPair, extraRuncmd = [] } = {}) {
  const id = instanceId || `cibyp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const keys = keyPair || generateSshKeyPair();
  const authorizedKey = keys.publicKey.includes('ssh-ed25519')
    ? keys.publicKey.trim()
    : toAuthorizedKey(keys.publicKey, id);
  const files = {
    'user-data': buildUserData({ authorizedKey, instanceId: id, hostname, timezone, extraRuncmd }),
    'meta-data': buildMetaData({ instanceId: id, hostname }),
  };
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'user-data'), files['user-data']);
    fs.writeFileSync(path.join(dir, 'meta-data'), files['meta-data']);
  }
  const server = await createProvisionServer({ files });
  return {
    instanceId: id,
    keys,
    authorizedKey,
    ...server,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  generateSshKeyPair,
  toAuthorizedKey,
  buildUserData,
  buildMetaData,
  findFreePort,
  createProvisionServer,
  provision,
};
