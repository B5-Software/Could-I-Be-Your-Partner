/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const pkg = require('../../../package.json');

function instanceIdentity(userData) {
  let directory = path.resolve(userData);
  try {
    directory = fs.realpathSync(directory);
  } catch {
    /* First launch has no profile yet. */
  }
  // Development and packaged application names still refer to the same App.
  const names = [pkg.name, pkg.build?.productName || 'Could I Be Your Partner'].map((name) =>
    name.toLowerCase(),
  );
  if (names.includes(path.basename(directory).toLowerCase())) {
    directory = path.join(path.dirname(directory), pkg.name);
  }
  if (process.platform === 'win32') directory = directory.toLowerCase();
  return createHash('sha256').update(directory).digest('hex');
}

function readOwner(port, identity) {
  return new Promise((resolve) => {
    let data = '';
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('end', () => finish(null));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 1024) return finish(null);
      if (!data.includes('\n')) return;
      try {
        const owner = JSON.parse(data.trim());
        finish(owner.identity === identity ? owner : null);
      } catch {
        finish(null);
      }
    });
  });
}

/** A kernel-owned exclusive loopback endpoint: shared by Node and Electron,
 * released even on forced termination, with no stale PID files or heartbeats. */
async function acquireInstanceLock(userData, mode) {
  const identity = instanceIdentity(userData);
  // Stay below Windows/Linux ephemeral port ranges and above common dev ports.
  const port = 20000 + (parseInt(identity.slice(0, 8), 16) % 10000);
  const clients = new Set();
  const owner = { identity, mode, pid: process.pid };
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.end(JSON.stringify(owner) + '\n');
    socket.setTimeout(1000, () => socket.destroy());
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const existing = await readOwner(port, identity);
    if (!existing)
      throw new Error('Instance lock endpoint is occupied by another process (port ' + port + ')');
    return { acquired: false, owner: existing };
  }
  server.unref();
  let released = false;
  return {
    acquired: true,
    owner,
    release: () => {
      if (released) return;
      released = true;
      for (const socket of clients) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { instanceIdentity, acquireInstanceLock };
