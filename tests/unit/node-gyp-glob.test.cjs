/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('node-gyp can find generated Windows solution and make files with its glob override', async (t) => {
  const requireFromGyp = createRequire(require.resolve('node-gyp/package.json'));
  const { glob } = requireFromGyp('tinyglobby');
  const cwd = await mkdtemp(path.join(tmpdir(), 'cibyp-gyp-glob-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const build = path.join(cwd, 'build');
  await mkdir(path.join(build, 'nested'), { recursive: true });
  for (const file of ['native.sln', 'native.target.mk', 'nested/other.sln'])
    await writeFile(path.join(build, file), '');

  const matches = async (pattern) =>
    (await glob(pattern, { cwd, expandDirectories: false })).map((file) =>
      file.replaceAll('\\', '/'),
    );
  assert.deepEqual(await matches('build/*.sln'), ['build/native.sln']);
  assert.deepEqual(await matches('build/*.mk'), ['build/native.target.mk']);
});
