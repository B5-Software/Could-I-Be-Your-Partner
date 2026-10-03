const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { patchPtyHelperPaths } = require('../../scripts/lib/packaged-cli.cjs');

test('node-pty helper resolution supports both Node physical paths and Electron ASAR paths', () => {
  const file = require.resolve('node-pty/lib/unixTerminal.js');
  const original = fs.readFileSync(file, 'utf8');
  const patched = patchPtyHelperPaths(original);
  assert.equal(patchPtyHelperPaths(patched), patched, 'Repeated packaging is idempotent');
  const resolver = patched.match(/^helperPath = helperPath\.replace.*$/gm).join('\n');
  for (const [input, expected] of [
    [
      '/App/resources/app.asar/node_modules/node-pty/spawn-helper',
      '/App/resources/app.asar.unpacked/node_modules/node-pty/spawn-helper',
    ],
    [
      '/App/resources/app.asar.unpacked/node_modules/node-pty/spawn-helper',
      '/App/resources/app.asar.unpacked/node_modules/node-pty/spawn-helper',
    ],
    [
      '/App/resources/node_modules.asar/node-pty/spawn-helper',
      '/App/resources/node_modules.asar.unpacked/node-pty/spawn-helper',
    ],
    [
      '/App/resources/node_modules.asar.unpacked/node-pty/spawn-helper',
      '/App/resources/node_modules.asar.unpacked/node-pty/spawn-helper',
    ],
  ])
    assert.equal(vm.runInNewContext(resolver + '\nhelperPath', { helperPath: input }), expected);
  assert.throws(() => patchPtyHelperPaths('unrecognized resolver'), /Unsupported/);
});
