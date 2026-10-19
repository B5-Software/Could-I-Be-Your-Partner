/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

test('desktop OS storage injection protects POSIX vaults and migrates legacy plaintext without an Electron dependency', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-vault-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module = { exports: {} };
  const source = await fs.readFile(
    path.resolve(__dirname, '../../src/main/services/account-vault.js'),
    'utf8',
  );
  vm.runInNewContext(source, {
    module,
    require: (name) => {
      assert.notEqual(name, 'electron', 'Shared account storage imported the desktop runtime');
      return require(name);
    },
    process: { platform: 'linux', getuid: process.getuid || (() => 0) },
    Buffer,
  });
  const { AccountVault, setAccountStorage } = module.exports;
  const file = path.join(root, 'accounts.vault');
  const vault = new AccountVault(file);
  const value = { accounts: [{ accessToken: 'fixture-private-token' }] };
  await assert.rejects(vault.save(value), /encryption is unavailable/);
  const key = crypto.randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString();
    },
  };
  setAccountStorage(storage);
  await vault.save(value);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /fixture-private-token/);
  assert.deepEqual(JSON.parse(JSON.stringify(await vault.load())), value);
  await fs.writeFile(file, JSON.stringify({ protection: 'owner-only', data: value }));
  assert.deepEqual(JSON.parse(JSON.stringify(await vault.load())), value);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).protection, 'safe-storage');
  storage.getSelectedStorageBackend = () => 'basic_text';
  await assert.rejects(vault.save(value), /encryption is unavailable/);
  setAccountStorage(undefined);
});
