/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 本文件属于 Could I Be Your Partner.
 *
 * VNC WebSocket 桥：noVNC（vm-desktop.html）只能连 ws://，而 wayvnc / x11vnc
 * 都是裸 TCP。此前页面直接连 ws://<裸 VNC 端口>，握手必然失败
 * （界面表现为"连接已断开（异常）"）。
 *
 * 这里在宿主 loopback 上起一个极小的 WS↔TCP 桥：
 *   - 仅监听 127.0.0.1；URL 带随机 token（防止本机其它进程蹭 VNC）
 *   - 二进制帧直通（noVNC 1.7 默认不请求子协议；若请求则回选 first）
 *   - 任一端断开/出错都双向收敛，错误不冒泡（EPIPE/ECONNRESET 不能打断主进程）
 */

'use strict';

const net = require('net');
const crypto = require('crypto');

class VncWsBridge {
  constructor({ host = '127.0.0.1', log = () => {} } = {}) {
    this.host = host;
    this.log = log;
    this._wss = null;
    this._port = 0;
    this._token = '';
  }

  get url() {
    return this._port ? `ws://${this.host}:${this._port}/?token=${this._token}` : null;
  }

  /**
   * 启动桥并指向 guest VNC 端口（经 SSH 转发后的宿主端口）。
   * @param {number} targetPort 宿主 loopback 上的 VNC 端口
   * @returns {Promise<{port:number,url:string}>}
   */
  async start(targetPort) {
    this.stop();
    const { WebSocketServer } = require('ws');
    this._token = crypto.randomBytes(16).toString('hex');
    const wss = new WebSocketServer({ host: this.host, port: 0, perMessageDeflate: false });
    this._wss = wss;
    await new Promise((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    this._port = wss.address().port;
    // listen 之后的运行期错误（客户端异常等）一律不冒泡
    wss.on('error', () => { /* ignore */ });
    wss.on('connection', (ws, req) => {
      let token = '';
      try {
        token = new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams.get('token') || '';
      } catch { /* ignore */ }
      if (token !== this._token) {
        try { ws.close(1008, 'invalid token'); } catch { /* ignore */ }
        return;
      }
      const tcp = net.connect({ host: '127.0.0.1', port: targetPort });
      let closed = false;
      const shutdown = () => {
        if (closed) return;
        closed = true;
        try { tcp.destroy(); } catch { /* ignore */ }
        try { ws.close(); } catch { /* ignore */ }
      };
      try { tcp.setNoDelay(true); } catch { /* ignore */ }
      tcp.on('connect', () => this.log(`[vnc-ws] 已桥接 → 127.0.0.1:${targetPort}`));
      tcp.on('data', (chunk) => {
        try { if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true }); } catch { shutdown(); }
      });
      tcp.on('error', shutdown);
      tcp.on('close', shutdown);
      ws.on('message', (data) => {
        try { tcp.write(data); } catch { shutdown(); }
      });
      ws.on('error', shutdown);
      ws.on('close', shutdown);
    });
    this.log(`[vnc-ws] WebSocket 桥就绪 ws://${this.host}:${this._port}/（VNC 目标 127.0.0.1:${targetPort}）`);
    return { port: this._port, url: this.url };
  }

  stop() {
    try { if (this._wss) this._wss.close(); } catch { /* ignore */ }
    this._wss = null;
    this._port = 0;
  }
}

module.exports = { VncWsBridge };
