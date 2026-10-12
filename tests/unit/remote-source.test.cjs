const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Remote source import canonicalizes CRLF before locking and still rejects tampering', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-remote-source-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'upstream');
  const checkout = path.join(temporary, 'checkout');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.mkdirSync(path.join(source, 'schema'));
  fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"0.1.0"}\r\n');
  fs.writeFileSync(path.join(source, 'LICENSE'), 'License\r\nSecond line\r\n');
  fs.writeFileSync(path.join(source, 'src/index.js'), 'module.exports = {};\r\n');
  fs.writeFileSync(path.join(source, 'schema/request.json'), '{}\r\n');
  const script = path.join(checkout, 'scripts/sync-remote.cjs');
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/sync-remote.cjs'), script);
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, CIBYP_REMOTE_SOURCE: source },
      encoding: 'utf8',
    });
  const imported = run();
  assert.equal(imported.status, 0, imported.stderr);
  const target = path.join(checkout, 'packages/remote');
  assert.equal(fs.readFileSync(path.join(target, 'LICENSE'), 'utf8'), 'License\nSecond line\n');
  assert.equal(run('--check').status, 0);
  fs.appendFileSync(path.join(target, 'src/index.js'), 'tampered');
  const rejected = run('--check');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Remote dependency integrity failed: src\/index.js/);
});
