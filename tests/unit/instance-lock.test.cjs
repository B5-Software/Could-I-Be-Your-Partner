const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { acquireInstanceLock, instanceIdentity } = require('../../src/main/core/instance-lock');

test('GUI and TUI cannot acquire the same profile; release permits the next interface', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gui = await acquireInstanceLock(directory, 'GUI');
  assert.equal(gui.acquired, true);
  t.after(() => gui.release());
  const tui = await acquireInstanceLock(directory, 'TUI');
  assert.equal(tui.acquired, false);
  assert.equal(tui.owner.mode, 'GUI');
  await gui.release();
  const next = await acquireInstanceLock(directory, 'TUI');
  t.after(() => next.release());
  assert.equal(next.acquired, true);
  assert.equal((await acquireInstanceLock(directory, 'GUI')).owner.mode, 'TUI');
});

test('development and installed product profile names share a lock identity', () => {
  const root = path.join(os.tmpdir(), 'cibyp-identity');
  assert.equal(
    instanceIdentity(path.join(root, 'Could I Be Your Partner')),
    instanceIdentity(path.join(root, 'could-i-be-your-partner')),
  );
});

test('simultaneous processes have one winner and forced termination leaves no stale lock', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-lock-race-'));
  const script = path.join(directory, 'process.cjs');
  fs.writeFileSync(
    script,
    `const {acquireInstanceLock}=require(${JSON.stringify(require.resolve('../../src/main/core/instance-lock'))});process.on('message',async()=>{const lock=await acquireInstanceLock(process.argv[2],process.argv[3]);process.send({acquired:lock.acquired,owner:lock.owner});});`,
  );
  const children = Array.from({ length: 6 }, (_, index) =>
    fork(script, [directory, index % 2 ? 'GUI' : 'TUI'], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    }),
  );
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'exit'),
      ),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const messages = children.map((child) => once(child, 'message'));
  children.forEach((child) => child.send('start'));
  const results = (await Promise.all(messages)).map(([value]) => value);
  assert.equal(results.filter((value) => value.acquired).length, 1);
  const winner = children[results.findIndex((value) => value.acquired)];
  assert(results.every((value) => value.owner.pid === winner.pid));
  const exited = once(winner, 'exit');
  winner.kill('SIGKILL');
  await exited;
  const recovered = await acquireInstanceLock(directory, 'GUI');
  assert.equal(recovered.acquired, true);
  await recovered.release();
});
