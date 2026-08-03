/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Aria2 Manager — 基于 assets 内置二进制 + 子进程 + JSON-RPC 客户端。
 *
 * 设计目标：
 *   - aria2c 二进制预先放在 assets/aria2/{platform}-{arch}/ 目录
 *   - 打包后通过 extraResources 放到 resources/aria2/ 目录（asar 外）
 *   - 不查系统 PATH、不运行时下载
 *   - 通过 JSON-RPC 控制 aria2（异步下载、状态查询、暂停/恢复/取消）
 *   - 自动同步 Agent 代理设置（settings.proxy）
 *   - 支持会话持久化（中断后可恢复未完成下载）
 */

'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ARIA2_PORT = 16800; // 避开默认 6800 减少冲突
const RPC_ID_PREFIX = 'ar2';

class Aria2Manager {
  constructor() {
    this.process = null;
    this.port = ARIA2_PORT;
    this.binPath = null;
    this.ready = false;
    this.startingPromise = null;
    this.rpcCounter = 0;
    this._aria2Dir = null;
    this._sessionFile = null;
    this.currentProxy = null; // 当前应用的代理 URL
  }

  get userDataDir() {
    return app.getPath('userData');
  }
  get aria2Dir() {
    if (!this._aria2Dir) {
      this._aria2Dir = path.join(this.userDataDir, 'aria2');
    }
    return this._aria2Dir;
  }
  get sessionFile() {
    if (!this._sessionFile) {
      this._sessionFile = path.join(this.aria2Dir, 'session.gz');
    }
    return this._sessionFile;
  }

  /**
   * 获取平台-架构标识（与 electron-builder ${os}-${arch} 变量一致）
   */
  getPlatformKey() {
    const p = process.platform;
    const a = process.arch;
    const platform = p === 'win32' ? 'win' : p === 'darwin' ? 'mac' : 'linux';
    return `${platform}-${a}`;
  }

  /**
   * 查找 aria2c 二进制路径：
   *   1. 打包后：process.resourcesPath/aria2/aria2c[.exe]（extraResources 放置）
   *   2. 开发模式：assets/aria2/{platform}-{arch}/aria2c[.exe]
   * 不查系统 PATH，不运行时下载。
   */
  getBinaryPath() {
    if (this.binPath && fs.existsSync(this.binPath)) return this.binPath;

    const exeName = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';

    // 1. 打包后：extraResources 放到 resources/aria2/
    if (process.resourcesPath) {
      const packedPath = path.join(process.resourcesPath, 'aria2', exeName);
      if (fs.existsSync(packedPath)) {
        this.binPath = packedPath;
        return packedPath;
      }
    }

    // 2. 开发模式：assets/aria2/{platform}-{arch}/
    const platformKey = this.getPlatformKey();
    const devPath = path.join(app.getAppPath(), 'assets', 'aria2', platformKey, exeName);
    if (fs.existsSync(devPath)) {
      this.binPath = devPath;
      return devPath;
    }

    // 3. 回退：尝试 win-x64（Windows arm64 兼容 x64）
    if (process.platform === 'win32' && process.arch === 'arm64') {
      const fallbackPath = path.join(app.getAppPath(), 'assets', 'aria2', 'win-x64', exeName);
      if (fs.existsSync(fallbackPath)) {
        this.binPath = fallbackPath;
        return fallbackPath;
      }
    }

    throw new Error(
      `aria2c 二进制未找到。请运行 "node scripts/download-aria2.js" 下载，` +
      `或将 aria2c${process.platform === 'win32' ? '.exe' : ''} 放到 assets/aria2/${platformKey}/ 目录。`
    );
  }

  /**
   * 解析代理设置并返回 aria2 的 --all-proxy 参数值
   * @param {object} proxy settings.proxy 对象
   * @returns {string|null} 代理 URL 或 null
   */
  resolveProxy(proxy) {
    if (!proxy || proxy.mode === 'none') return null;

    if (proxy.mode === 'manual') {
      // 手动配置：优先 https，其次 http
      const proxyUrl = proxy.https || proxy.http;
      if (proxyUrl) {
        // 补全协议前缀
        if (!/^https?:\/\//i.test(proxyUrl) && !/^socks/i.test(proxyUrl)) {
          return 'http://' + proxyUrl;
        }
        return proxyUrl;
      }
      return null;
    }

    if (proxy.mode === 'system') {
      // 系统代理：通过 Electron session 获取系统代理
      // 这里返回 null，由 Electron 的 session.resolveProxy 异步获取
      // 简化处理：系统代理模式下，aria2 不走代理（由系统网络层处理）
      return null;
    }

    return null;
  }

  /**
   * 启动 aria2c 子进程（带 RPC 服务）
   * @param {object} proxySettings - 代理设置 { mode, http, https, bypass }
   */
  async start(proxySettings) {
    if (this.ready) {
      // 如果代理设置变化，重启 aria2
      const newProxy = this.resolveProxy(proxySettings);
      if (newProxy !== this.currentProxy) {
        console.log('[aria2] 代理设置变化，重启 aria2...');
        await this.shutdown();
      } else {
        return true;
      }
    }
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = this._startInternal(proxySettings);
    try {
      const result = await this.startingPromise;
      return result;
    } finally {
      this.startingPromise = null;
    }
  }

  async _startInternal(proxySettings) {
    const binPath = this.getBinaryPath();
    if (!fs.existsSync(this.aria2Dir)) {
      fs.mkdirSync(this.aria2Dir, { recursive: true });
    }

    // 解析代理设置
    const proxyUrl = this.resolveProxy(proxySettings);
    this.currentProxy = proxyUrl;

    const args = [
      '--enable-rpc',
      `--rpc-listen-port=${this.port}`,
      '--rpc-listen-all=false',
      '--rpc-allow-origin-all=false',
      `--dir=${this.aria2Dir}`,
      `--save-session=${this.sessionFile}`,
      '--input-file=' + (fs.existsSync(this.sessionFile) ? this.sessionFile : ''),
      '--save-session-interval=10',
      '--continue=true',
      '--max-concurrent-downloads=5',
      '--split=5',
      '--max-connection-per-server=5',
      '--min-split-size=1M',
      '--file-allocation=none',
      '--console-log-level=warn',
      '--summary-interval=0',
      '--quiet'
    ].filter(a => !a.endsWith('=') && a !== '--input-file=');

    // 代理设置
    if (proxyUrl) {
      args.push(`--all-proxy=${proxyUrl}`);
      console.log(`[aria2] 使用代理: ${proxyUrl}`);
    } else {
      console.log('[aria2] 不使用代理');
    }

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(binPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });

        this.process.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) console.log(`[aria2] ${msg}`);
        });

        this.process.on('error', (err) => {
          console.error(`[aria2] 进程启动失败: ${err.message}`);
          this.ready = false;
          reject(err);
        });

        this.process.on('exit', (code) => {
          console.log(`[aria2] 进程退出，code=${code}`);
          this.ready = false;
          this.process = null;
        });

        this._waitForReady(15000)
          .then(() => { this.ready = true; resolve(true); })
          .catch((e) => { reject(e); });
      } catch (e) {
        reject(e);
      }
    });
  }

  _waitForReady(timeoutMs) {
    const start = Date.now();
    const tryRpc = () => {
      return this.rpc('aria2.getVersion', [])
        .then(() => true)
        .catch(() => false);
    };
    return new Promise(async (resolve, reject) => {
      while (Date.now() - start < timeoutMs) {
        if (await tryRpc()) return resolve(true);
        await new Promise(r => setTimeout(r, 300));
      }
      reject(new Error('aria2 RPC 启动超时'));
    });
  }

  /**
   * JSON-RPC 2.0 调用
   */
  rpc(method, params = []) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: `${RPC_ID_PREFIX}-${++this.rpcCounter}`,
        method,
        params
      });
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: '/jsonrpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            } else {
              resolve(parsed.result);
            }
          } catch (e) {
            reject(new Error(`RPC 响应解析失败: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('RPC 请求超时')); });
      req.write(body);
      req.end();
    });
  }

  // ===== 高层 API =====

  /**
   * 添加下载任务
   * @param {string} url 下载 URL
   * @param {object} opts { dir, out, headers, split, maxConnections, maxConnectionPerServer, userAgent, referer }
   * @returns {Promise<string>} gid
   */
  async addUri(url, opts = {}) {
    await this.start();
    const uris = [url];
    const options = {};
    if (opts.dir) options.dir = opts.dir;
    if (opts.out) options.out = opts.out;
    if (opts.headers) options.header = Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`);
    if (opts.userAgent) options['user-agent'] = opts.userAgent;
    if (opts.referer) options.referer = opts.referer;
    // 下载参数配置（允许 Agent 自定义）
    if (opts.split) options.split = String(opts.split);
    if (opts.maxConnections) options['max-connection-per-server'] = String(opts.maxConnections);
    if (opts.minSplitSize) options['min-split-size'] = String(opts.minSplitSize);
    if (opts.timeout) options.timeout = String(opts.timeout);
    if (opts.connectTimeout) options['connect-timeout'] = String(opts.connectTimeout);
    if (opts.retryWait) options['retry-wait'] = String(opts.retryWait);
    if (opts.maxRetries !== undefined) options['max-tries'] = String(opts.maxRetries);
    return this.rpc('aria2.addUri', [uris, options]);
  }

  async tellStatus(gid) {
    await this.start();
    const fields = [
      'gid', 'status', 'totalLength', 'completedLength', 'uploadLength',
      'downloadSpeed', 'uploadSpeed', 'connections', 'numPieces', 'pieceLength',
      'completedPieces', 'files', 'errorCode', 'errorMessage', 'dir', 'bittorrent'
    ];
    return this.rpc('aria2.tellStatus', [gid, fields]);
  }

  async pause(gid, force = false) {
    await this.start();
    return this.rpc(force ? 'aria2.forcePause' : 'aria2.pause', [gid]);
  }

  async unpause(gid) {
    await this.start();
    return this.rpc('aria2.unpause', [gid]);
  }

  async cancel(gid, force = false) {
    await this.start();
    return this.rpc(force ? 'aria2.forceRemove' : 'aria2.remove', [gid]);
  }

  async removeDownloadResult(gid) {
    await this.start();
    return this.rpc('aria2.removeDownloadResult', [gid]);
  }

  async tellActive() {
    await this.start();
    return this.rpc('aria2.tellActive', [[
      'gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'files', 'dir'
    ]]);
  }

  async tellWaiting(offset = 0, num = 100) {
    await this.start();
    return this.rpc('aria2.tellWaiting', [offset, num, [
      'gid', 'status', 'totalLength', 'completedLength', 'files', 'dir'
    ]]);
  }

  async tellStopped(offset = 0, num = 100) {
    await this.start();
    return this.rpc('aria2.tellStopped', [offset, num, [
      'gid', 'status', 'totalLength', 'completedLength', 'files', 'dir', 'errorCode', 'errorMessage'
    ]]);
  }

  async listAll() {
    const [active, waiting, stopped] = await Promise.all([
      this.tellActive(),
      this.tellWaiting(0, 100),
      this.tellStopped(0, 100)
    ]);
    return { active, waiting, stopped };
  }

  async shutdown() {
    if (!this.process) return;
    try {
      await this.rpc('aria2.shutdown', []).catch(() => {});
    } catch {}
    try { this.process.kill('SIGTERM'); } catch {}
    this.process = null;
    this.ready = false;
  }
}

const aria2Manager = new Aria2Manager();
module.exports = { aria2Manager, Aria2Manager };
