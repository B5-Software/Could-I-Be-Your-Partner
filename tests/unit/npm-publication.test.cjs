/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForRegistry, verifyLauncher } = require('../../scripts/publish-npm.cjs');
const entry = (name) => ({
  pkg: { name, version: '1.9.0-alpha.20' },
  packed: { integrity: 'sha512-fixture' },
});
const response = (item, status = 200, changes = {}) => ({
  ok: status === 200,
  status,
  json: async () => ({ ...item.pkg, dist: { integrity: item.packed.integrity }, ...changes }),
});

test('npm scan delay and transient registry errors must settle before publication is confirmed', async () => {
  const first = entry('cibyp');
  const second = { ...entry('cibyp'), pkg: { name: 'cibyp', version: '1.0.1' } };
  const attempts = new Map();
  let time = 0;
  await waitForRegistry([first, second], {
    now: () => time,
    pause: async (ms) => {
      time += ms;
    },
    interval: 10,
    timeout: 100,
    log: () => {},
    fetchPackage: async (url) => {
      const item = url.endsWith('/1.0.1') ? second : first;
      const count = (attempts.get(item.pkg.version) || 0) + 1;
      attempts.set(item.pkg.version, count);
      if (item === second && count === 1) throw new Error('Temporary network failure');
      return response(item, count === 1 ? 404 : item === second && count === 2 ? 503 : 200);
    },
  });
  assert.equal(time, 20);
  assert.equal(attempts.get(first.pkg.version), 2, 'confirmed packages should not be polled again');
  assert.equal(attempts.get(second.pkg.version), 3);
});

test('publisher rejects payload packages, dependencies, binaries and oversized archives', () => {
  const pkg = { name: 'cibyp' },
    packed = {
      size: 100,
      unpackedSize: 200,
      files: [{ path: 'lib/runtime.cjs' }, { path: 'package.json' }],
    };
  verifyLauncher(pkg, packed);
  assert.throws(
    () => verifyLauncher({ ...pkg, name: 'cibyp-runtime-win32-x64' }, packed),
    /restricted/,
  );
  assert.throws(
    () => verifyLauncher({ ...pkg, optionalDependencies: { payload: '1' } }, packed),
    /restricted/,
  );
  assert.throws(() => verifyLauncher(pkg, { ...packed, size: 300000 }), /budget/);
  assert.throws(
    () => verifyLauncher(pkg, { ...packed, files: [{ path: 'payload.bin' }] }),
    /binary/,
  );
});

test('npm held uploads time out explicitly instead of reporting a successful installable release', async () => {
  const item = entry('cibyp');
  let time = 0;
  await assert.rejects(
    waitForRegistry([item], {
      now: () => time,
      pause: async (ms) => {
        time += ms;
      },
      interval: 10,
      timeout: 20,
      log: () => {},
      fetchPackage: async () => response(item, 404),
    }),
    /inspect their scan status before retrying: cibyp/,
  );
  assert.equal(time, 20);
});

test('npm availability verification rejects different bytes, invalid metadata and permission errors', async () => {
  const item = entry('cibyp');
  for (const [result, expected] of [
    [response(item, 200, { dist: { integrity: 'sha512-different' } }), /different content/],
    [response(item, 200, { version: '0.0.0-stage' }), /Invalid npm registry metadata/],
    [response(item, 403), /HTTP 403/],
  ])
    await assert.rejects(
      waitForRegistry([item], { fetchPackage: async () => result, log: () => {} }),
      expected,
    );
});
