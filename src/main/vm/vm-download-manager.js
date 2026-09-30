/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const crypto = require('node:crypto');
const { VmFs } = require('./vm-fs');
const { shellQuote } = require('./vm-paths');

class VmDownloadManager {
  constructor(service) {
    this.service = service;
    this.current = null;
    this.pending = null;
  }
  get ready() {
    return (
      !!this.current &&
      this.current.identity === this.service.instance?.ciServer?.instanceId &&
      this.service.instance.state === 'ready'
    );
  }
  get port() {
    return this.current?.hostPort;
  }
  get binPath() {
    return '/usr/bin/aria2c';
  }
  async ensureStarted() {
    if (!this.service.instance || this.service.instance.state !== 'ready')
      await this.service.start();
    const instance = this.service.instance;
    const identity = instance.ciServer.instanceId;
    if (this.current?.identity === identity) return this.current;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const installed = await instance.exec(
        'command -v aria2c >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq aria2)',
        { timeoutMs: 300000 },
      );
      if (!installed.ok) throw new Error('VM 内 aria2 不可用: ' + installed.stderr);
      const secret = crypto.randomBytes(32).toString('hex');
      const script = `import socket,subprocess,os,json
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
p=subprocess.Popen(['aria2c','--enable-rpc','--rpc-listen-all=false','--rpc-listen-port='+str(port),'--rpc-secret='+${JSON.stringify(secret)},'--dir=/workspace','--enable-color=false','--console-log-level=error'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print(json.dumps({'port':port,'pid':p.pid}))`;
      const started = await instance.exec(`python3 -c ${shellQuote(script)}`);
      if (!started.ok) throw new Error(started.stderr);
      const { port, pid } = JSON.parse(started.stdout);
      const forward = await this.service.forwardPort(port);
      const current = {
        identity,
        secret,
        pid,
        url: forward.url + 'jsonrpc',
        hostPort: forward.hostPort,
      };
      this.current = current;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await this.rpc('aria2.getVersion', [], current);
          return current;
        } catch (error) {
          if (attempt === 19) {
            this.current = null;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  async rpc(method, params = [], ready) {
    const state = ready || (await this.ensureStarted());
    const response = await fetch(state.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params: ['token:' + state.secret, ...params],
      }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (result.error) throw new Error(result.error.message);
    return result.result;
  }
  async start() {
    await this.ensureStarted();
    return this.status();
  }
  status() {
    return { running: !!this.current, location: 'vm' };
  }
  async addUri(url, options = {}) {
    const io = new VmFs({ vmService: this.service });
    const target = io.resolveVmPath(options.dir || '/workspace');
    if (!target.ok) throw new Error(target.error);
    if (options.out && /[/\\]|^\.{1,2}$/.test(options.out)) throw new Error('下载文件名无效');
    const normalized = { dir: target.vm };
    const aliases = {
      maxConnections: 'max-connection-per-server',
      maxConnectionPerServer: 'max-connection-per-server',
      userAgent: 'user-agent',
    };
    for (const [key, value] of Object.entries(options)) {
      if (key === 'dir' || value === undefined) continue;
      if (key === 'headers')
        normalized.header = Object.entries(value).map(([name, item]) => `${name}: ${item}`);
      else normalized[aliases[key] || key] = String(value);
    }
    const proxy = this.service.getSettings().proxy;
    if (proxy?.mode === 'manual' && (proxy.https || proxy.http)) {
      const url = new URL(proxy.https || proxy.http);
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) url.hostname = '10.0.2.2';
      normalized['all-proxy'] = url.href;
    }
    return this.rpc('aria2.addUri', [[url], normalized]);
  }
  tellStatus(gid) {
    return this.rpc('aria2.tellStatus', [gid]);
  }
  async listAll() {
    const [active, waiting, stopped] = await Promise.all([
      this.rpc('aria2.tellActive'),
      this.rpc('aria2.tellWaiting', [0, 1000]),
      this.rpc('aria2.tellStopped', [0, 1000]),
    ]);
    return { active, waiting, stopped };
  }
  pause(gid, force) {
    return this.rpc(force ? 'aria2.forcePause' : 'aria2.pause', [gid]);
  }
  unpause(gid) {
    return this.rpc('aria2.unpause', [gid]);
  }
  cancel(gid, force) {
    return this.rpc(force ? 'aria2.forceRemove' : 'aria2.remove', [gid]);
  }
  removeDownloadResult(gid) {
    return this.rpc('aria2.removeDownloadResult', [gid]);
  }
}
module.exports = { VmDownloadManager };
