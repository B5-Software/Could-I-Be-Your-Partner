/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const {
  WalletBrowserConnector,
  bytes,
} = require('../../src/main/services/wallet/browser-connector');
const origin = 'chrome-extension://' + 'a'.repeat(32);
const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-connector-test-'));
  const control = path.join(directory, 'browser-control.json');
  const server = keyPair();
  const client = keyPair();
  const clientId = crypto.randomUUID();
  const serverId = crypto.randomUUID();
  let saved = {
    version: 1,
    id: serverId,
    privateKey: server.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: server.publicKey.export({ format: 'jwk' }),
    port: 0,
    clients: [
      {
        id: clientId,
        name: 'Browser fixture',
        origin,
        publicKey: client.publicKey.export({ format: 'jwk' }),
        createdAt: 1,
        revision: 1,
      },
    ],
  };
  const callbacks = {
    write: (p, data) => {
      assert.equal(p, control);
      fs.writeFileSync(control, JSON.stringify(data));
    },
    save: async () => {},
    revoke: () => {},
  };
  const connector = new WalletBrowserConnector(
    { directory, emit: () => {}, apps: { revokeClient: (id) => callbacks.revoke(id) } },
    (...args) => callbacks.write(...args),
    {
      vault: {
        load: async () => structuredClone(saved),
        save: async (value) => {
          await callbacks.save();
          saved = structuredClone(value);
        },
      },
    },
  );
  t.after(async () => {
    await connector.dispose();
    fs.rmSync(control, { force: true });
    fs.rmdirSync(directory);
  });
  return { connector, client, server, clientId, serverId, callbacks, directory };
}

test('stopping while the port is being saved fences late and queued startup', async (t) => {
  const { connector, callbacks, directory } = fixture(t);
  const { promise: saving, resolve: atSave } = Promise.withResolvers();
  const { promise: finish, resolve: finishSave } = Promise.withResolvers();
  callbacks.save = async () => {
    atSave();
    await finish;
  };
  const start = assert.rejects(connector.start(), /WALLET_STOPPED/);
  await saving;
  const queued = assert.rejects(connector.action('pair'), /WALLET_STOPPED/);
  const stop = connector.action('stop');
  finishSave();
  await Promise.all([start, queued, stop]);
  assert.equal(connector.status().state, 'stopped');
  assert.equal(connector.status().endpoint, null);
  assert.equal(WalletBrowserConnector.shouldStart(directory), false);
  assert.equal((await connector.action('start')).state, 'listening');
});

async function challenged(status, server, serverId) {
  const socket = new WebSocket(status.endpoint, { origin, handshakeTimeout: 2000 });
  await once(socket, 'open');
  const challenge = once(socket, 'message');
  const nonce = crypto.randomBytes(32).toString('hex');
  socket.send(JSON.stringify({ type: 'challenge', nonce }));
  const frame = JSON.parse((await challenge)[0].toString());
  assert.equal(frame.seq, 1);
  assert.equal(
    crypto.verify(
      'sha256',
      bytes('server', frame.session, frame.seq, frame.payload),
      { key: server.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(frame.signature, 'base64url'),
    ),
    true,
  );
  const body = JSON.parse(frame.payload);
  assert.equal(body.serverId, serverId);
  assert.equal(body.clientNonce, nonce);
  return { socket, frame, body };
}

function probe(ctx, client, clientId) {
  const payload = JSON.stringify({ type: 'probe', clientId, serverNonce: ctx.body.serverNonce });
  const signature = crypto
    .sign('sha256', bytes('client', ctx.frame.session, 1, payload), {
      key: client.privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');
  return JSON.stringify({ session: ctx.frame.session, seq: 1, payload, signature });
}

test(
  'loopback accepts a paired key but rejects webpage origin, replay and another channel',
  { timeout: 5000 },
  async (t) => {
    const { connector, client, server, clientId, serverId } = fixture(t);
    const status = await connector.start();
    const webpage = new WebSocket(status.endpoint, {
      origin: 'https://site.example',
      handshakeTimeout: 1000,
    });
    webpage.on('error', () => {});
    await assert.rejects(once(webpage, 'open'));
    const first = await challenged(status, server, serverId);
    const signed = probe(first, client, clientId);
    const result = once(first.socket, 'message');
    first.socket.send(signed);
    assert.equal(JSON.parse(JSON.parse((await result)[0].toString()).payload).type, 'probed');
    const ended = once(first.socket, 'close');
    first.socket.send(signed);
    await ended;
    const second = await challenged(status, server, serverId);
    const disconnected = once(second.socket, 'close');
    second.socket.send(signed);
    await disconnected;
  },
);

test(
  'a failed revocation write immediately denies the paired key, and can be retried',
  { timeout: 5000 },
  async (t) => {
    const { connector, client, server, clientId, serverId, callbacks } = fixture(t);
    const status = await connector.start();
    const write = callbacks.write;
    callbacks.write = () => {
      throw Error('disk unavailable');
    };
    const input = { id: clientId, revision: 1 };
    await assert.rejects(connector.action('revoke', input), /WALLET_BROWSER_PERSIST/);
    assert.equal(connector.status().clients[0].revocationPending, true);
    assert.equal(connector.status().clients[0].revoked, true);
    const ctx = await challenged(status, server, serverId);
    const ended = once(ctx.socket, 'close');
    ctx.socket.send(probe(ctx, client, clientId));
    await ended;
    callbacks.write = write;
    let revoked = null;
    callbacks.revoke = (id) => (revoked = id);
    const current = await connector.action('revoke', input);
    assert.equal(current.clients[0].revocationPending, false);
    assert.equal(current.error, null);
    assert.equal(revoked, clientId);
  },
);
