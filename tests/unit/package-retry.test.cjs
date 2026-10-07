/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packageWithRetry } = require('../../scripts/lib/package-retry.cjs');

const busy = {
  code: 1,
  output: 'hdiutil: create failed - Resource busy\nplistlib.InvalidFileException: Invalid file',
};
const pkg = { name: 'cibyp', build: { productName: 'Could I Be Your Partner' } };
const args = [
  '--mac',
  '--x64',
  '--publish',
  'never',
  '--config.extraMetadata.version=1.9.0-alpha.24+abc1234',
];

function fixture(t, arch = 'x64') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-package-retry-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const appDir = path.join(projectRoot, 'dist', arch === 'x64' ? 'mac' : 'mac-arm64');
  const contents = path.join(appDir, `${pkg.build.productName}.app`, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), '<plist/>');
  return { projectRoot, appDir: path.dirname(contents) };
}

test('a busy disk image retries the existing app with all targets and version metadata preserved', async (t) => {
  const { projectRoot, appDir } = fixture(t);
  const calls = [],
    delays = [];
  const code = await packageWithRetry({
    args,
    pkg,
    projectRoot,
    platform: 'darwin',
    log: () => {},
    sleep: async (ms) => delays.push(ms),
    run: async (invocation) => {
      calls.push(invocation);
      return calls.length === 1 ? busy : { code: 0, output: '' };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [args, [...args, '--prepackaged', appDir]]);
  assert.deepEqual(delays, [10000]);
});

test('repeated disk image failures stop after three attempts and preserve failure', async (t) => {
  const { projectRoot } = fixture(t);
  let calls = 0;
  const delays = [];
  assert.equal(
    await packageWithRetry({
      args,
      pkg,
      projectRoot,
      platform: 'darwin',
      log: () => {},
      sleep: async (ms) => delays.push(ms),
      run: async () => {
        calls++;
        return busy;
      },
    }),
    1,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10000, 20000]);
});

test('signing, disk space and malformed plist errors are not retried', async (t) => {
  const { projectRoot } = fixture(t);
  for (const output of [
    'codesign: Resource busy',
    'hdiutil: create failed - No space left on device',
    'plistlib.InvalidFileException: Invalid file',
  ]) {
    let calls = 0;
    assert.equal(
      await packageWithRetry({
        args,
        pkg,
        projectRoot,
        platform: 'darwin',
        run: async () => {
          calls++;
          return { code: 2, output };
        },
        sleep: async () => assert.fail('Unexpected retry'),
      }),
      2,
    );
    assert.equal(calls, 1);
  }
});

test('missing apps, non-mac builds and ambiguous architecture do not retry', async (t) => {
  const { projectRoot } = fixture(t);
  for (const options of [
    { platform: 'win32', args },
    { platform: 'darwin', args: ['--win', '--x64'] },
    { platform: 'darwin', args: ['--mac', '--x64', '--arm64'] },
    { platform: 'darwin', args: ['--mac', '--arm64'] },
    { platform: 'darwin', args: [...args, '--prepackaged', 'custom-app'] },
    { platform: 'darwin', args: [...args, '--config.directories.output=custom-output'] },
  ]) {
    let calls = 0;
    assert.equal(
      await packageWithRetry({
        pkg,
        projectRoot,
        ...options,
        run: async () => {
          calls++;
          return busy;
        },
        sleep: async () => assert.fail('Unexpected retry'),
      }),
      1,
    );
    assert.equal(calls, 1);
  }
});

test('arm64 retry uses its own app and stops on a different failure', async (t) => {
  const { projectRoot, appDir } = fixture(t, 'arm64');
  const armArgs = ['--mac', '--arm64'];
  const calls = [];
  const code = await packageWithRetry({
    args: armArgs,
    pkg,
    projectRoot,
    platform: 'darwin',
    log: () => {},
    sleep: async () => {},
    run: async (invocation) => {
      calls.push(invocation);
      return calls.length === 1 ? busy : { code: 7, output: 'Code signing failed' };
    },
  });
  assert.equal(code, 7);
  assert.deepEqual(calls, [armArgs, [...armArgs, '--prepackaged', appDir]]);
});

test('success and process launch exceptions do not retry', async (t) => {
  const { projectRoot } = fixture(t);
  assert.equal(
    await packageWithRetry({ args, pkg, projectRoot, run: async () => ({ code: 0, output: '' }) }),
    0,
  );
  await assert.rejects(
    packageWithRetry({
      args,
      pkg,
      projectRoot,
      platform: 'darwin',
      run: async () => {
        throw new Error('ENOENT');
      },
      sleep: async () => assert.fail('Unexpected retry'),
    }),
    /ENOENT/,
  );
  assert.equal(
    await packageWithRetry({
      args,
      pkg,
      projectRoot,
      platform: 'darwin',
      run: async () => ({ ...busy, code: 130, signal: 'SIGINT' }),
      sleep: async () => assert.fail('Interrupted packaging must not restart'),
    }),
    130,
  );
});
