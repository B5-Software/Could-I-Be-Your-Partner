const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VmGraphics } = require('../../src/main/vm/vm-graphics');

test('concurrent graphics starts share the same startup operation', async () => {
  const graphics = new VmGraphics({ vmService: { emit() {} } });
  let finish;
  let calls = 0;
  graphics._start = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = graphics.start();
  const second = graphics.start();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish({ ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal(graphics._startingPromise, null);
});

test('stopping graphics targets recorded processes instead of process names', async () => {
  const commands = [];
  const graphics = new VmGraphics({
    vmService: {
      emit() {},
      instance: {
        state: 'ready',
        exec: async (command) => {
          commands.push(command);
          return { ok: true, stdout: '' };
        },
      },
    },
  });
  graphics._ownedProcesses.push({ pid: 1234, start: '5678' });
  await graphics.stop();
  assert.equal(commands.length, 1);
  assert.ok(!commands[0].includes('pkill'));
  assert.ok(commands[0].includes('os.killpg'));
  assert.deepEqual(graphics._ownedProcesses, []);
});
