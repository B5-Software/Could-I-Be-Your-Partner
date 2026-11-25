/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const { createHash, createHmac, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { realpath, stat } = require('node:fs/promises');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const QUICKNET = {
  chain: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  key: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis: 1692803367,
  period: 3,
};
const sha256 = (value) => createHash('sha256').update(value).digest();
const number = (value) => {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
};

function verifyBeacon(value, now) {
  if (
    !Number.isSafeInteger(value?.round) ||
    value.round < 1 ||
    !/^[a-f\d]{96}$/i.test(value.signature || '')
  )
    throw Error('DRAND_INVALID_BEACON');
  const time = QUICKNET.genesis + (value.round - 1) * QUICKNET.period;
  if (time > now + 6 || now - time > 120) throw Error('DRAND_STALE_ROUND');
  const signature = Buffer.from(value.signature, 'hex');
  const random = sha256(signature);
  if (random.toString('hex') !== value.randomness) throw Error('DRAND_RANDOMNESS_MISMATCH');
  const { bls12_381: bls } = require('@noble/curves/bls12-381');
  const signed = bls.G1.ProjectivePoint.fromHex(signature);
  const key = bls.G2.ProjectivePoint.fromHex(QUICKNET.key);
  const message = bls.G1.hashToCurve(sha256(number(value.round)), {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  });
  if (
    !bls.fields.Fp12.eql(
      bls.pairing(signed, bls.G2.ProjectivePoint.BASE),
      bls.pairing(message, key),
    )
  )
    throw Error('DRAND_SIGNATURE_INVALID');
  return { bytes: random, round: value.round };
}

async function fetchBeacon(fetcher, now) {
  const response = await fetcher('https://api.drand.sh/' + QUICKNET.chain + '/public/latest', {
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  });
  const reader = response.body?.getReader();
  try {
    if (!response.ok || !reader) throw Error('DRAND_UNAVAILABLE');
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw Error('DRAND_RESPONSE_LIMIT');
      chunks.push(Buffer.from(value));
    }
    return verifyBeacon(JSON.parse(Buffer.concat(chunks).toString('utf8')), now);
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

async function readDevice(device) {
  if (process.platform === 'win32') throw Error('POSIX_RNG_DEVICE_UNAVAILABLE');
  if (typeof device !== 'string' || !/^\/dev\/[a-z\d/_-]{1,160}$/i.test(device))
    throw Error('RNG_DEVICE_PATH');
  const resolved = await realpath(device);
  // Only open RNG endpoints. Opening an arbitrary character device (for
  // example a watchdog or a TTY) can itself change system state.
  if (
    !/^\/dev\/(?:random|urandom|hwrng|rng[\w-]*|hwrng[\w-]+)$/.test(resolved) ||
    !(await stat(resolved)).isCharacterDevice()
  )
    throw Error('RNG_DEVICE_NOT_RANDOM');
  const { stdout } = await execute('/usr/bin/head', ['-c', '32', '--', resolved], {
    encoding: 'buffer',
    timeout: 1500,
    maxBuffer: 64,
    windowsHide: true,
  });
  if (stdout.length !== 32) throw Error('RNG_DEVICE_READ');
  return { bytes: stdout };
}

function normalizedPools(input) {
  if (!Array.isArray(input) || input.length > 8) throw Error('INVALID_ENTROPY_POOLS');
  const ids = new Set();
  return input.map((pool) => {
    if (
      !pool ||
      typeof pool.id !== 'string' ||
      !/^[a-z\d-]{1,40}$/i.test(pool.id) ||
      ids.has(pool.id) ||
      typeof pool.name !== 'string' ||
      !pool.name.trim() ||
      pool.name.length > 60 ||
      (pool.device &&
        (typeof pool.device !== 'string' || !/^\/dev\/[a-z\d/_-]{1,160}$/i.test(pool.device)))
    )
      throw Error('INVALID_ENTROPY_POOL');
    ids.add(pool.id);
    return {
      id: pool.id,
      name: pool.name.trim(),
      drand: pool.drand === true,
      hardware: pool.hardware === true,
      device: pool.device || '',
    };
  });
}

class EntropyPools {
  constructor({
    getSettings,
    fetcher = (...args) => global.fetch(...args),
    hardware,
    device = readDevice,
  }) {
    Object.assign(this, { getSettings, fetcher, hardware, device });
    this.latest = new Map();
    this.beacon = null;
  }
  selection(id) {
    const settings = this.getSettings()?.entropy || {};
    return normalizedPools(settings.pools || []).find(
      (pool) => pool.id === (id ?? settings.activePoolId),
    );
  }
  report(id) {
    return this.latest.get(this.selection(id)?.id) || null;
  }
  readBeacon(now) {
    if (!this.beacon || now - this.beacon.time >= 2500) {
      this.beacon = { time: now, response: fetchBeacon(this.fetcher, now / 1000) };
    }
    return this.beacon.response;
  }
  async mix(id, context = '') {
    const pool = this.selection(id);
    if (!pool) throw Error('ENTROPY_POOL_UNAVAILABLE');
    const sample = randomBytes(32);
    const now = Date.now();
    const providers = [
      ...(pool.drand ? [['drand', () => this.readBeacon(now)]] : []),
      ...(pool.hardware
        ? [
            [
              'hardware',
              async () => {
                const hardware = await this.hardware(this.getSettings().entropy);
                return { bytes: Buffer.from([hardware.cardIndex, Number(hardware.isReversed)]) };
              },
            ],
          ]
        : []),
      ...(pool.device ? [['device', () => this.device(pool.device)]] : []),
    ];
    const results = await Promise.allSettled(
      providers.map(([, read]) => Promise.resolve().then(read)),
    );
    const hash = createHmac('sha256', sample).update('CIBYP entropy pool v1\0');
    sample.fill(0);
    const include = (name, bytes) =>
      hash.update(name).update('\0').update(number(bytes.length)).update(bytes);
    include('context', Buffer.from(String(context).slice(0, 4096), 'utf8'));
    const sources = [{ kind: 'os', status: 'used' }];
    for (const [index, [kind]] of providers.entries()) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        include(kind, result.value.bytes);
        sources.push({
          kind,
          status: 'used',
          ...(result.value.round && { round: result.value.round }),
        });
      } else sources.push({ kind, status: 'unavailable' });
    }
    const report = { id: pool.id, time: Date.now(), sources };
    this.latest.delete(pool.id);
    this.latest.set(pool.id, report);
    if (this.latest.size > 8) this.latest.delete(this.latest.keys().next().value);
    // The fresh OS key is always present. Public and device inputs only supplement it.
    return { key: hash.digest(), report };
  }
  async use(id, context, operation) {
    const { key, report } = await this.mix(id, context);
    let counter = 0;
    const bytes = (length) =>
      createHmac('sha256', key).update(number(counter++)).digest().subarray(0, length);
    try {
      return { result: operation(bytes), report };
    } finally {
      key.fill(0);
    }
  }
}

module.exports = { EntropyPools, normalizedPools, verifyBeacon, QUICKNET };
