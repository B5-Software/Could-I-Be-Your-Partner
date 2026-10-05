const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { readCodexLimits } = require('../../src/main/services/codex-limits');
function processFixture(onRpc) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk);
      if (request.id)
        onRpc(request, (result) =>
          child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'),
        );
      callback();
    },
  });
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('exit', 0));
  };
  return child;
}
test('quota reader isolates credentials and retains all windows and reset timestamps', async () => {
  let child;
  let spawnOptions;
  const windows = {
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1800000100 },
      },
    },
  };
  const result = await readCodexLimits({
    token: 'secret-fixture-token',
    accountId: 'fixture-account',
    binary: 'fixture-codex.exe',
    spawnImpl: (exe, args, options) => {
      assert.doesNotMatch(JSON.stringify({ exe, args }), /secret-fixture-token/);
      spawnOptions = options;
      child = processFixture((request, reply) => {
        if (request.method === 'account/login/start') {
          assert.equal(request.params.type, 'chatgptAuthTokens');
          assert.equal(request.params.accessToken, 'secret-fixture-token');
          assert.equal(request.params.chatgptAccountId, 'fixture-account');
        }
        reply(request.method === 'account/rateLimits/read' ? windows : {});
      });
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rateLimitsByLimitId, windows.rateLimitsByLimitId);
  assert.match(spawnOptions.env.CODEX_HOME, /cibyp-codex-quota-/);
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(child.killed, true);
  assert.equal(require('node:fs').existsSync(spawnOptions.env.CODEX_HOME), false);
});
test('quota cancellation terminates the helper without waiting for a timeout', async () => {
  const controller = new AbortController();
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  let child;
  const pending = readCodexLimits({
    token: 'token',
    accountId: 'account',
    binary: 'fixture.exe',
    signal: controller.signal,
    spawnImpl: () => {
      child = processFixture((request, reply) => {
        if (request.method === 'account/rateLimits/read') ready();
        else reply({});
      });
      return child;
    },
  });
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(child.killed, true);
});
test('a missing account identifier is unavailable rather than fabricated usage', async () => {
  const result = await readCodexLimits({
    token: 'token',
    spawnImpl: () => {
      throw new Error('must not spawn');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /identifier/);
  assert.equal(result.rateLimits, undefined);
});
