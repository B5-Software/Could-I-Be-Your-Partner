/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Wallet, Transaction, Mnemonic, encryptKeystoreJson, keccak256, concat } = require('ethers');
const { NativeSigner } = require('../../src/main/services/wallet/native-signer');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-native-signer-'));
if (process.argv.includes('--managed')) {
  const resources = path.join(directory, 'resources');
  fs.mkdirSync(resources);
  const spec = require('../../src/main/services/wallet/native-binary').target();
  fs.cpSync(
    path.resolve('assets/wallet-signer', spec.asset),
    path.join(resources, 'wallet-signer'),
    { recursive: true },
  );
  process.env.CIBYP_PACKAGED_RESOURCES = resources;
}
const signer = new NativeSigner(directory),
  pending = new Map();
signer.on('message', (message) => {
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  message.error ? call.reject(Error(message.error)) : call.resolve(message.result);
});
signer.on('error', () => {});
let storeId;
let activeAddress = null;
async function request(action, input = {}) {
  if (action === 'sign') {
    input = {
      expiresAt: Date.now() + 60000,
      storeId,
      operationId: randomUUID(),
      feeReserveWei: String(
        BigInt(input.transaction.gasLimit) * BigInt(input.transaction.maxFeePerGas),
      ),
      ...input,
    };
    if (activeAddress) {
      const nonce = await sendRequest('nonce.inspect', {
        transaction: input.transaction,
        expectedAddress: activeAddress,
      });
      await sendRequest('operation.approve', {
        ...input,
        expiresAt: Date.now() + 60000,
        replacementOf: nonce.hash || undefined,
      });
    }
  }
  const result = await sendRequest(action, input);
  if (action === 'unlock') activeAddress = result.address;
  if (['import', 'create', 'lock', 'reencrypt'].includes(action)) activeAddress = null;
  return result;
}
function sendRequest(action, input) {
  return new Promise((resolve, reject) => {
    const id = randomUUID(),
      timer = setTimeout(() => reject(Error('fixture timeout')), 15000);
    pending.set(id, { resolve, reject, timer });
    signer.send(
      {
        id,
        action,
        input: {
          id: 'test-wallet',
          ...input,
        },
      },
      (error) => {
        if (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}
(async () => {
  try {
    storeId = (await request('receipt.status')).storeId;
    const key = '0x' + '01'.padStart(64, '0'),
      reference = new Wallet(key),
      password = 'test-only-long-password';
    const imported = await request('import', { kind: 'privateKey', secret: key, password });
    assert.equal(imported.address.toLowerCase(), reference.address.toLowerCase());
    const vault = JSON.parse(imported.keystore);
    assert.equal(vault.header.kdf.name, 'argon2id');
    assert.equal(vault.header.cipher.name, 'xchacha20-poly1305');
    assert.ok(!imported.keystore.includes(key.slice(2)));
    assert.ok(!imported.keystore.includes(password));
    await assert.rejects(
      request('unlock', { keystore: imported.keystore, password: 'wrong-password' }),
      /AUTHENTICATION/,
    );
    for (const field of ['address', 'id']) {
      const altered = structuredClone(vault);
      altered.header[field] = field === 'address' ? '0x' + '2'.repeat(40) : 'a'.repeat(32);
      await assert.rejects(
        request('unlock', { keystore: JSON.stringify(altered), password }),
        /AUTHENTICATION/,
      );
    }
    const oversized = structuredClone(vault);
    oversized.header.kdf.memoryKiB = 1000000000;
    await assert.rejects(
      request('unlock', { keystore: JSON.stringify(oversized), password }),
      /KDF_LIMIT/,
    );
    const transaction = {
      type: 2,
      chainId: 8453,
      nonce: 0,
      to: '0x' + '2'.repeat(40),
      value: '1000000000000000',
      data: '0x',
      gasLimit: '21000',
      maxFeePerGas: '1000000000',
      maxPriorityFeePerGas: '1000000',
    };
    await assert.rejects(request('sign', { transaction }), /LOCKED/);
    await request('unlock', {
      keystore: imported.keystore,
      password,
      expectedAddress: reference.address,
      minutes: 0,
    });
    const signed = await request('sign', { transaction }),
      expected = await reference.signTransaction(transaction);
    assert.equal(signed.raw, expected);
    assert.equal(Transaction.from(signed.raw).from, reference.address);
    for (const variant of [
      { ...transaction, chainId: 84532, nonce: 9007199254740991, value: '0', data: '0x00ff' },
      { ...transaction, value: ((1n << 256n) - 1n).toString() },
    ])
      assert.equal(
        (await request('sign', { transaction: variant })).raw,
        await reference.signTransaction(variant),
      );
    await assert.rejects(
      request('sign', { transaction: { ...transaction, chainId: 1 } }),
      /CHAIN_UNAVAILABLE/,
    );
    await assert.rejects(
      request('sign', { transaction: { ...transaction, maxPriorityFeePerGas: '1000000001' } }),
      /TRANSACTION_FORMAT/,
    );
    await request('lock', {});
    await assert.rejects(request('sign', { transaction }), /LOCKED/);
    const legacy = await encryptKeystoreJson(
      { address: reference.address, privateKey: key },
      password,
      { scrypt: { N: 1024, r: 8, p: 1 } },
    );
    await request('unlock', {
      keystore: legacy,
      password,
      expectedAddress: reference.address,
      minutes: 0,
    });
    assert.equal((await request('sign', { transaction })).raw, expected);
    const migrated = await request('reencrypt', {
      keystore: legacy,
      password,
      newPassword: password + '-new',
      expectedAddress: reference.address,
    });
    assert.equal(JSON.parse(migrated.keystore).header.format, 'CIBYP-WALLET');
    await assert.rejects(request('sign', { transaction }), /LOCKED/);
    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const mnemonic = Mnemonic.fromPhrase(phrase),
      legacyWallet = Wallet.fromPhrase(phrase),
      unicodePassword = 'Ｔｅｓｔ-only-password';
    const hdLegacy = await encryptKeystoreJson(
      {
        address: legacyWallet.address,
        privateKey: legacyWallet.privateKey,
        mnemonic: { entropy: mnemonic.entropy, path: "m/44'/60'/0'/0/0", locale: 'en' },
      },
      unicodePassword,
      { scrypt: { N: 1024, r: 8, p: 1 } },
    );
    await request('unlock', { keystore: hdLegacy, password: unicodePassword, minutes: 0 });
    assert.equal(
      (await request('sign', { transaction })).raw,
      await legacyWallet.signTransaction(transaction),
    );
    const hdTamper = JSON.parse(hdLegacy);
    hdTamper['x-ethers'].mnemonicCiphertext = '00'.repeat(16);
    await assert.rejects(
      request('unlock', { keystore: JSON.stringify(hdTamper), password: unicodePassword }),
      /AUTHENTICATION/,
    );
    const crypto = require('node:crypto'),
      salt = Buffer.alloc(32, 9),
      iv = Buffer.alloc(16, 8),
      derived = crypto.pbkdf2Sync(password, salt, 1024, 32, 'sha256'),
      cipher = crypto.createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv),
      encrypted = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()]);
    const pbkdf = JSON.stringify({
      version: 3,
      address: reference.address.slice(2),
      crypto: {
        cipher: 'aes-128-ctr',
        cipherparams: { iv: iv.toString('hex') },
        ciphertext: encrypted.toString('hex'),
        kdf: 'pbkdf2',
        kdfparams: { dklen: 32, c: 1024, prf: 'hmac-sha256', salt: salt.toString('hex') },
        mac: keccak256(concat([derived.subarray(16), encrypted])).slice(2),
      },
    });
    await request('unlock', { keystore: pbkdf, password, minutes: 0 });
    assert.equal((await request('sign', { transaction })).raw, expected);
    const restored = await request('import', { kind: 'mnemonic', secret: phrase, password });
    assert.equal(restored.address.toLowerCase(), Wallet.fromPhrase(phrase).address.toLowerCase());
    assert.ok(!restored.keystore.includes(phrase));
    const created = await request('create', { password });
    assert.equal(created.mnemonic.split(' ').length, 24);
    assert.equal(
      created.address.toLowerCase(),
      Wallet.fromPhrase(created.mnemonic).address.toLowerCase(),
    );
    await assert.rejects(request('sign', { transaction }), /LOCKED/);
    console.log(
      'PASS: actual Rust signer, independent ethers derivation/signature/V3 recovery, AEAD tampering/KDF bounds, lock, re-encryption and 24-word creation. Test keys only.',
    );
  } finally {
    const exited = new Promise((resolve) => signer.process.once('exit', resolve));
    signer.kill();
    await exited;
    for (const p of pending.values()) clearTimeout(p.timer);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-native-signer-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
