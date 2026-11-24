/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { once, addAbortListener } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { Socks5ProxyAgent, buildConnector } = require('undici');
const { environment } = require('./coinbase-exchange');
const { resolveStreamProxy } = require('../../net-proxy');

const hosts = {
  sandbox: 'fix-ord.sandbox.exchange.coinbase.com',
  live: 'fix-ord.exchange.coinbase.com',
};
const port = 6121;

function httpTunnel(proxy, authority, signal) {
  return new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http;
    const headers = { Host: authority };
    if (proxy.username || proxy.password) {
      const user = decodeURIComponent(proxy.username);
      const password = decodeURIComponent(proxy.password);
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(user + ':' + password).toString('base64');
    }
    const request = transport.request({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: proxy.port || undefined,
      method: 'CONNECT',
      path: authority,
      agent: false,
      headers,
      signal,
      rejectUnauthorized: true,
    });
    request.once('connect', (response, socket, head) => {
      if (signal.aborted || response.statusCode !== 200 || head.length) {
        socket.destroy();
        reject(Error('EXCHANGE_FIX_PROXY'));
        return;
      }
      resolve(socket);
    });
    request.once('error', reject);
    request.end();
  });
}

async function socksTunnel(proxy, host, signal) {
  const connector = buildConnector({ timeout: 6000 });
  let socket;
  const agent = new Socks5ProxyAgent(proxy, {
    connect: (options, done) => {
      socket = connector(options, done);
    },
  });
  let abort;
  try {
    // Undici owns the SOCKS negotiation. The target name stays inside the CONNECT request.
    const tunnel = agent.createSocks5Connection(host, port);
    return await Promise.race([
      tunnel,
      new Promise((_, reject) => {
        abort = addAbortListener(signal, () => reject(signal.reason));
      }),
    ]);
  } catch (error) {
    socket?.destroy();
    throw error;
  } finally {
    abort?.[Symbol.dispose]();
  }
}

async function connectFix(
  env,
  signal,
  { resolveProxy = resolveStreamProxy, tlsConnect = tls.connect } = {},
) {
  const host = hosts[environment(env)];
  const authority = `${host}:${port}`;
  let tunnel;
  try {
    const route = await resolveProxy('https://' + authority);
    signal.throwIfAborted();
    if (route) {
      const proxy = new URL(route);
      if (['http:', 'https:'].includes(proxy.protocol))
        tunnel = await httpTunnel(proxy, authority, signal);
      else if (['socks5:', 'socks:'].includes(proxy.protocol))
        tunnel = await socksTunnel(proxy, host, signal);
      else throw Error('EXCHANGE_FIX_PROXY');
    }
  } catch (error) {
    throw Error(
      error.code === 'CIBYP_PRIVACY_UNAVAILABLE' ? 'EXCHANGE_FIX_PRIVACY' : 'EXCHANGE_FIX_PROXY',
    );
  }
  let socket;
  try {
    signal.throwIfAborted();
    socket = tlsConnect({
      ...(tunnel ? { socket: tunnel } : { host, port }),
      servername: host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    await once(socket, 'secureConnect', { signal });
    if (!socket.authorized) throw Error('EXCHANGE_FIX_TLS');
    socket.setNoDelay(true);
    return socket;
  } catch {
    (socket || tunnel)?.destroy();
    throw Error('EXCHANGE_FIX_TLS');
  }
}

module.exports = { connectFix };
