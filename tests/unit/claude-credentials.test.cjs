/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ClaudeCredentials } = require('../../src/main/services/claude-credentials');
const { AccountVault } = require('../../src/main/services/account-vault');
const id = '11111111-1111-4111-8111-111111111111';

test('settle drains a queued encryption acquire even while its lease count is still zero', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-credential-drain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let finishEncryption;
  const encrypting = new Promise((resolve) => {
    finishEncryption = resolve;
  });
  const profiles = new ClaudeCredentials(root, () => ({
    load: async () => null,
    save: async () => encrypting,
  }));
  const acquiring = profiles.acquire(id);
  const settling = profiles.settle(id);
  assert.equal(profiles.profile(id).count, 0);
  finishEncryption();
  const release = await acquiring;
  await release();
  await settling;
  assert.equal(profiles.profile(id).count, 0);
});

test('Claude credential leases protect idle tokens, preserve refreshes and wait for the last user', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-credential-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const codec = {
    encode: async (data) => {
      const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
      return {
        protection: 'test-aes',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        content: content.toString('base64'),
      };
    },
    decode: async (value) => {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
      cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(value.content, 'base64')), cipher.final()]),
      );
    },
  };
  const profiles = new ClaudeCredentials(root, (file) => new AccountVault(file, codec));
  const directory = path.join(root, id),
    plain = path.join(directory, '.credentials.json'),
    vault = path.join(directory, 'credentials.vault');
  await fs.mkdir(directory);
  await fs.writeFile(
    plain,
    JSON.stringify({ claudeAiOauth: { accessToken: 'old-private-token' } }),
  );
  await profiles.migrate(id);
  await assert.rejects(fs.stat(plain), { code: 'ENOENT' });
  assert.doesNotMatch(await fs.readFile(vault, 'utf8'), /old-private-token/);
  const one = await profiles.acquire(id),
    two = await profiles.acquire(id);
  assert.match(await fs.readFile(plain, 'utf8'), /old-private-token/);
  await fs.writeFile(
    plain,
    JSON.stringify({ claudeAiOauth: { accessToken: 'refreshed-private-token' } }),
  );
  await one();
  assert.ok((await fs.stat(plain)).isFile());
  await two();
  await assert.rejects(fs.stat(plain), { code: 'ENOENT' });
  assert.doesNotMatch(await fs.readFile(vault, 'utf8'), /refreshed-private-token/);
  const three = await profiles.acquire(id);
  assert.match(await fs.readFile(plain, 'utf8'), /refreshed-private-token/);
  await three();
  await three();
  assert.throws(() => profiles.profile('../other-profile'), /Invalid/);
});
