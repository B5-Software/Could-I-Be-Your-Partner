/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerNetworkIpc({ ipcMain, path, fs, getVmService }) {
  // ---- IPC: Network Tools ----
  const toolFiles = require('../vm/tool-files').createToolFiles({ fs, getVmService });
  ipcMain.handle('net:httpRequest', async (_, opts) => {
    try {
      const { URL } = require('url');
      const url = String(opts.url || '').trim();
      if (!url) return { ok: false, error: '缺少url' };
      const method = (opts.method || 'GET').toUpperCase();
      const headers = opts.headers || {};
      const timeout = Number(opts.timeout) || 30000;
      const followRedirects = opts.followRedirects !== false;
      const encoding = opts.encoding || 'utf8';
      if (!headers['User-Agent'] && !headers['user-agent']) {
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
      }
      const fetchOpts = {
        method,
        headers,
        redirect: followRedirects ? 'follow' : 'manual',
        signal: AbortSignal.timeout(timeout),
      };
      if (opts.body && method !== 'GET' && method !== 'HEAD') fetchOpts.body = opts.body;
      const resp = await fetch(url, fetchOpts);
      const buf = Buffer.from(await resp.arrayBuffer());
      const bodyStr =
        encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8').substring(0, 500000);
      const respHeaders = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return {
        ok: true,
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
        body: bodyStr,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:httpFormPost', async (_, opts) => {
    try {
      const url = String(opts.url || '').trim();
      if (!url) return { ok: false, error: '缺少url' };
      const fields = opts.fields || {};
      const files = opts.files || [];
      const extraHeaders = opts.headers || {};
      if (files.length > 0) {
        // multipart/form-data
        const { Readable } = require('stream');
        const boundary = '----CIBYPFormBoundary' + Date.now().toString(36);
        const parts = [];
        for (const [k, v] of Object.entries(fields)) {
          parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
        }
        for (const f of files) {
          const fname = f.fileName || path.basename(f.filePath);
          const content = await toolFiles.read(f.filePath);
          parts.push(
            `--${boundary}\r\nContent-Disposition: form-data; name="${f.fieldName}"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          );
          parts.push(content);
        }
        const tail = `\r\n--${boundary}--\r\n`;
        const bodyParts = [];
        for (const p of parts) bodyParts.push(Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'));
        bodyParts.push(Buffer.from(tail, 'utf8'));
        const body = Buffer.concat(bodyParts);
        const resp = await fetch(url, {
          method: 'POST',
          body,
          headers: {
            ...extraHeaders,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
        });
        const text = await resp.text();
        return {
          ok: true,
          status: resp.status,
          body: text.substring(0, 500000),
        };
      } else {
        const body = new URLSearchParams(fields).toString();
        const resp = await fetch(url, {
          method: 'POST',
          body,
          headers: {
            ...extraHeaders,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });
        const text = await resp.text();
        return {
          ok: true,
          status: resp.status,
          body: text.substring(0, 500000),
        };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:dnsLookup', async (_, hostname, rrtype) => {
    try {
      const dns = require('dns');
      const { promisify } = require('util');
      const rr = (rrtype || 'A').toUpperCase();
      if (rr === 'A' || rr === 'AAAA') {
        const lookup = promisify(dns.resolve4.bind(dns));
        const lookup6 = promisify(dns.resolve6.bind(dns));
        const records = await (rr === 'AAAA' ? lookup6 : lookup)(hostname);
        return { ok: true, hostname, rrtype: rr, records };
      }
      const resolve = promisify(dns.resolve.bind(dns));
      const records = await resolve(hostname, rr);
      return { ok: true, hostname, rrtype: rr, records };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:ping', async (_, host, count) => {
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const n = Math.min(Math.max(Number(count) || 4, 1), 20);
      const isWin = process.platform === 'win32';
      const args = isWin ? ['-n', String(n), host] : ['-c', String(n), host];
      const { stdout, stderr } = await execFileAsync(isWin ? 'ping' : '/bin/ping', args, {
        timeout: n * 5000 + 5000,
      });
      return {
        ok: true,
        host,
        output: (stdout || stderr || '').substring(0, 10000),
      };
    } catch (e) {
      return {
        ok: true,
        host,
        output: (e.stdout || e.stderr || e.message || '').substring(0, 10000),
        timedOut: e.killed,
      };
    }
  });

  ipcMain.handle('net:urlShorten', async (_, url) => {
    try {
      const chain = [url];
      let current = url;
      for (let i = 0; i < 10; i++) {
        const resp = await fetch(current, {
          redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const loc = resp.headers.get('location');
        if (
          !loc ||
          (resp.status !== 301 &&
            resp.status !== 302 &&
            resp.status !== 303 &&
            resp.status !== 307 &&
            resp.status !== 308)
        )
          break;
        const next = new URL(loc, current).href;
        chain.push(next);
        current = next;
      }
      return {
        ok: true,
        originalUrl: url,
        finalUrl: current,
        redirectChain: chain,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:urlEncodeDecode', async (_, input, operation) => {
    try {
      let result;
      switch (operation) {
        case 'urlEncode':
          result = encodeURIComponent(input);
          break;
        case 'urlDecode':
          result = decodeURIComponent(input);
          break;
        case 'base64Encode':
          result = Buffer.from(input, 'utf8').toString('base64');
          break;
        case 'base64Decode':
          result = Buffer.from(input, 'base64').toString('utf8');
          break;
        default:
          return { ok: false, error: `未知操作: ${operation}` };
      }
      return { ok: true, operation, input, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:checkSSLCert', async (_, hostname, port) => {
    try {
      const tls = require('tls');
      const p = Number(port) || 443;
      return new Promise((resolve) => {
        const sock = tls.connect(
          {
            host: hostname,
            port: p,
            servername: hostname,
            rejectUnauthorized: false,
            timeout: 10000,
          },
          () => {
            const cert = sock.getPeerCertificate(true);
            sock.destroy();
            if (!cert || !cert.subject) return resolve({ ok: false, error: '无法获取证书' });
            resolve({
              ok: true,
              hostname,
              port: p,
              subject: cert.subject,
              issuer: cert.issuer,
              validFrom: cert.valid_from,
              validTo: cert.valid_to,
              serialNumber: cert.serialNumber,
              fingerprint: cert.fingerprint,
              fingerprint256: cert.fingerprint256,
              subjectAltName: cert.subjectaltname,
              bits: cert.bits,
              protocol: sock.getProtocol && sock.getProtocol(),
            });
          },
        );
        sock.on('error', (err) => {
          sock.destroy();
          resolve({ ok: false, error: err.message });
        });
        sock.setTimeout(10000, () => {
          sock.destroy();
          resolve({ ok: false, error: '连接超时' });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:traceroute', async (_, host) => {
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'tracert' : 'traceroute';
      const args = isWin ? ['-d', '-w', '2000', host] : ['-n', '-w', '2', host];
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        timeout: 60000,
      });
      return {
        ok: true,
        host,
        output: (stdout || stderr || '').substring(0, 30000),
      };
    } catch (e) {
      return {
        ok: true,
        host,
        output: (e.stdout || e.stderr || e.message || '').substring(0, 30000),
        timedOut: e.killed,
      };
    }
  });

  ipcMain.handle('net:portScan', async (_, host, portsStr, timeout) => {
    try {
      const net = require('net');
      const perTimeout = Math.min(Math.max(Number(timeout) || 2000, 200), 10000);
      // 解析端口: 80,443,8000-8100
      const ports = [];
      for (const part of String(portsStr).split(',')) {
        const trimmed = part.trim();
        if (trimmed.includes('-')) {
          const [a, b] = trimmed.split('-').map(Number);
          if (!isNaN(a) && !isNaN(b)) {
            for (let i = Math.min(a, b); i <= Math.min(Math.max(a, b), Math.min(a, b) + 1000); i++)
              ports.push(i);
          }
        } else {
          const p = Number(trimmed);
          if (!isNaN(p) && p > 0 && p <= 65535) ports.push(p);
        }
      }
      if (ports.length === 0) return { ok: false, error: '无效端口范围' };
      if (ports.length > 1024) return { ok: false, error: '端口范围过大(最大1024个)' };
      const scanPort = (p) =>
        new Promise((resolve) => {
          const sock = new net.Socket();
          sock.setTimeout(perTimeout);
          sock.once('connect', () => {
            sock.destroy();
            resolve({ port: p, open: true });
          });
          sock.once('timeout', () => {
            sock.destroy();
            resolve({ port: p, open: false });
          });
          sock.once('error', () => {
            sock.destroy();
            resolve({ port: p, open: false });
          });
          sock.connect(p, host);
        });
      // 并发扫描，每批 50
      const openPorts = [];
      for (let i = 0; i < ports.length; i += 50) {
        const batch = ports.slice(i, i + 50);
        const results = await Promise.all(batch.map(scanPort));
        for (const r of results) if (r.open) openPorts.push(r.port);
      }
      return { ok: true, host, scannedCount: ports.length, openPorts };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
