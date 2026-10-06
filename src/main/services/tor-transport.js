/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { TRANSPORTS } = require('../../shared/tor-bridges');

async function startTransport(binary, directory, requested) {
  const transports = [...new Set(requested)];
  if (!transports.length || transports.some((name) => !TRANSPORTS.includes(name)))
    throw new Error('Invalid Tor transport selection');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const child = spawn(binary, [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TOR_PT_MANAGED_TRANSPORT_VER: '1',
      TOR_PT_CLIENT_TRANSPORTS: transports.join(','),
      TOR_PT_STATE_LOCATION: directory,
      TOR_PT_EXIT_ON_STDIN_CLOSE: '1',
    },
  });
  const stop = () => {
    child.stdin.end();
    child.kill();
  };
  // Closing the transport during application shutdown must not raise EPIPE.
  child.stdin.on('error', () => {});
  try {
    const ports = await new Promise((resolve, reject) => {
      const ports = {};
      let output = '';
      const timer = setTimeout(
        () => reject(new Error('Tor bridge transport startup timed out')),
        15000,
      );
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', (code) => fail(new Error('Tor bridge transport exited (' + code + ')')));
      child.stderr.on('data', () => {});
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.length > 16384) return fail(new Error('Invalid Tor transport handshake'));
        let newline;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline).trim();
          output = output.slice(newline + 1);
          if (/^(?:ENV-ERROR|VERSION-ERROR|CMETHOD-ERROR)\b/.test(line))
            return fail(new Error('Tor bridge transport could not initialize'));
          const match = /^CMETHOD (\w+) socks5 127\.0\.0\.1:(\d+)$/.exec(line);
          if (
            match &&
            transports.includes(match[1]) &&
            Number(match[2]) > 0 &&
            Number(match[2]) <= 65535
          )
            ports[match[1]] = Number(match[2]);
          if (line === 'CMETHODS DONE') {
            if (transports.some((name) => !ports[name]))
              return fail(new Error('Tor bridge transport is unavailable'));
            clearTimeout(timer);
            resolve(ports);
          }
        }
      });
    });
    return { child, ports, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
module.exports = { startTransport };
