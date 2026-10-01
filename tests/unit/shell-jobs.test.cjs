const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ShellJobs } = require('../../src/main/services/shell-jobs');
const { shellQuote } = require('../../src/main/vm/vm-paths');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-jobs-test-'));
  const service = new ShellJobs({
    isVmOperation: () => false,
    confine: (_mode, _cwd, argv) => ({ argv }),
    isSandboxDenial: () => false,
  });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, service };
}
function command(file) {
  if (process.platform === 'win32')
    return `& '${process.execPath.replace(/'/g, "''")}' '${file.replace(/'/g, "''")}'`;
  return `${shellQuote(process.execPath)} ${shellQuote(file)}`;
}
async function until(operation, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Job fixture did not reach its expected state');
}

test('persistent server yields a session-owned handle, stays usable, and stops its process tree explicitly', async (t) => {
  const { root, service } = fixture(t);
  const file = path.join(root, 'server.js');
  fs.writeFileSync(
    file,
    `const http=require('node:http');const server=http.createServer((q,r)=>r.end('alive'));server.listen(0,'127.0.0.1',()=>console.log('PORT='+server.address().port));`,
  );
  const started = await service.run(command(file), root, 'danger-full-access', {
    sessionKey: 'first',
    yieldMs: 50,
  });
  assert.equal(started.ok, true);
  assert.equal(started.running, true);
  assert.ok(started.jobId);
  const poll = (options) =>
    service.run(undefined, undefined, undefined, {
      jobId: started.jobId,
      sessionKey: 'first',
      ...options,
    });
  const ready = await until(
    () => poll({}),
    (result) => /PORT=\d+/.test(result.output),
  );
  const port = Number(ready.output.match(/PORT=(\d+)/)[1]);
  assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'alive');
  const secondWait = await poll({ yieldMs: 150 });
  assert.equal(secondWait.running, true, 'a wait budget never terminates the server');
  assert.equal(
    (
      await service.run(null, null, null, {
        jobId: started.jobId,
        sessionKey: 'other',
        action: 'stop',
      })
    ).ok,
    false,
  );
  assert.equal(
    await (await fetch('http://127.0.0.1:' + port)).text(),
    'alive',
    'another session cannot stop this job',
  );
  const stopped = await poll({ action: 'stop' });
  assert.equal(stopped.status, 'stopped');
  await assert.rejects(fetch('http://127.0.0.1:' + port));
  assert.equal((await poll({ action: 'stop' })).status, 'stopped', 'stop is idempotent');
});

test('short command completion and nonzero exit are measured without prompt guessing, with bounded output', async (t) => {
  const { root, service } = fixture(t);
  const file = path.join(root, 'short.js');
  fs.writeFileSync(
    file,
    `process.stdout.write('x'.repeat(100000)+'校园 $ > # %');process.exitCode=7;`,
  );
  const started = await service.run(
    command(file) + (process.platform === 'win32' ? '; exit $LASTEXITCODE' : ''),
    root,
    null,
    { yieldMs: 50 },
  );
  const result = await until(
    () => service.run(null, null, null, { jobId: started.jobId }),
    (value) => !value.running,
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.ok(result.output.endsWith('校园 $ > # %'));
  assert.ok(result.output.length <= 64 * 1024);
  assert.ok(result.code > 0);
});

test('sandbox failures do not start an unconfined task', async (t) => {
  const { root, service } = fixture(t);
  service.confine = () => ({
    error: Object.assign(new Error('no sandbox'), { code: 'SANDBOX_UNAVAILABLE' }),
  });
  const result = await service.run('echo unsafe', root, 'workspace-write');
  assert.equal(result.ok, false);
  assert.equal(result.sandboxUnavailable, true);
  assert.equal(service.jobs.size, 0);
});

test('closing a caller window clears only its jobs and rejects a late relaunch', async (t) => {
  const { root, service } = fixture(t);
  const file = path.join(root, 'running.js');
  fs.writeFileSync(file, 'setInterval(()=>{}, 1000);');
  const first = await service.run(command(file), root, null, {
    sessionKey: 'window:1',
    yieldMs: 50,
  });
  const other = await service.run(command(file), root, null, {
    sessionKey: 'session:2',
    yieldMs: 50,
  });
  await service.releaseOwner('window:1');
  assert.equal(service.jobs.has(first.jobId), false);
  assert.equal(
    (await service.run(command(file), root, null, { sessionKey: 'window:1' })).ok,
    false,
  );
  assert.equal(
    (await service.run(null, null, null, { sessionKey: 'session:2', jobId: other.jobId })).running,
    true,
  );
});
