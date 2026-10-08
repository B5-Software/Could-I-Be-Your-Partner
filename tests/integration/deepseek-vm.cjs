/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Opt-in actual QEMU/Linux test. No user profile, live VM, credentials or base
// image is modified. Source-reviewed plugins use the same pins as the host probe.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmService } = require('../../src/main/vm/vm-service');
const { PluginManager } = require('../../src/main/ds-compat/plugin-manager');
const client = require('../../src/main/vm/plugin-runtime-client');
const reviewed = require('../../scripts/test-ds-thirdparty.cjs');
const root = path.resolve(__dirname, '../..');
const reportFile = path.join(root, '.cache/ds-vm-results.json');

const fixture = `
const { defineTool } = require('@deepseek-ai/dsh-tools');
module.exports = { inject: ['tools','llm','terminals','webRuntime'], apply(ctx) {
  let counter = 0, terminal, waiting = false, sending = false;
  const register = (name, execute) => ctx.tools.register(defineTool({
    name, parameters: {text:{type:'string'}}, output: {schema: {type:'json'}, render: (_,v)=>[{type:'text',text:JSON.stringify(v)}]}, execute
  }));
  register('counter', async()=>++counter);
  register('environment', async(_,exec)=>({platform:process.platform,node:process.version,cwd:exec.cwd,
    credentialsPresent:Boolean((await ctx.llm.options.getSettings()).llm?.apiKey),pid:process.pid}));
  register('model', async(_,exec)=>(await ctx.llm.chat({model:'host-owned',messages:[{role:'user',
    content:[{type:'text',text:'VM fixture'}]}]},exec.signal)).content);
  register('wait', async(_,exec)=>{waiting=true;try {return await new Promise((_,reject)=>
    exec.signal.addEventListener('abort',()=>reject(exec.signal.reason),{once:true}));}
    finally {waiting=false;}});
  register('activity', async()=>({waiting,sending}));
  register('carrier', async()=>ctx.webRuntime.publicUrl);
  register('pty_open', async(_,exec)=>{
    terminal = await ctx.terminals.spawn(exec.agent,{type:'shell',cwd:exec.cwd},exec.signal);
    return terminal;
  });
  register('pty_send', async(args,exec)=>{sending=true;try {return await ctx.terminals.startSend(exec.agent,terminal.sessionId,
    {text:args.text,submit:true,signal:exec.signal}).done;}finally {sending=false;}});
  register('pty_read', async(_,exec)=>ctx.terminals.read(exec.agent,terminal.sessionId));
  register('pty_signal', async(_,exec)=>ctx.terminals.signal(exec.agent,terminal.sessionId,'SIGINT'));
  register('pty_close', async(_,exec)=>({killed:await ctx.terminals.kill(exec.agent,terminal.sessionId),
    remaining:ctx.terminals.list(exec.agent).length}));
}};
`;

async function run(assetsDir, version) {
  assert.ok(assetsDir && version, 'Usage: node deepseek-vm.cjs <assetsDir> <full image version>');
  const selected = require('../../src/main/vm/vm-images')
    .localStatus(assetsDir, { variant: 'full' })
    .versions.find((row) => row.ok && row.version === version);
  assert.ok(selected, 'Installed immutable full image required');
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.rm(reportFile, { force: true });
  const artifacts = await reviewed.prepare();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-ds-vm-'));
  const workspace = path.join(profile, 'workspace');
  const repo = path.join(profile, 'repository');
  const dataDir = path.join(profile, 'profile');
  await fs.mkdir(workspace);
  await fs.mkdir(repo);
  const instance = new VmInstance({
    assetsDir,
    imagePath: selected.image,
    kernelPath: selected.kernel,
    initrdPath: selected.initrd,
    appPath: root,
    variant: 'full',
    version,
    config: { smp: 2, memMB: 2048, tcg: true, bootTimeoutMs: 240000 },
  });
  instance.dir = path.join(profile, 'instance');
  instance.overlayPath = path.join(instance.dir, 'overlay.qcow2');
  instance.instanceFile = path.join(instance.dir, 'instance.json');
  const settings = {
    runtime: {
      location: 'vm',
      workspaceMode: 'shared',
      vm: { assetsDir, variant: 'full', workspaceRoot: workspace },
    },
    sandbox: { defaultMode: 'danger-full-access' },
    llm: { model: 'host-owned', apiKey: 'synthetic-secret-must-stay-on-host' },
  };
  const service = new VmService({
    app: { getPath: () => profile, getAppPath: () => root },
    getSettings: () => settings,
  });
  service.instance = instance;
  const checks = [],
    listeners = new Map(),
    modelCalls = [];
  const manager = new PluginManager(dataDir, {
    getVmService: () => service,
    getSettings: () => settings,
    subscribe: (name, cb) => {
      listeners.set(name, cb);
      return () => listeners.delete(name);
    },
    invoke: async (channel, values, options) => {
      assert.equal(channel, 'llm:chatStream');
      assert.equal(options.signal.aborted, false);
      modelCalls.push({ channel, model: values.model });
      listeners.get('llm:stream-chunk')?.({
        requestId: options.requestId,
        content: 'Host fixture answer',
      });
      return { ok: true, data: { choices: [{ message: { content: 'Host fixture answer' } }] } };
    },
  }).init();
  let forwarded;
  const report = {
    date: new Date().toISOString(),
    image: version,
    sources: reviewed.sources,
    artifacts,
    checks,
  };
  instance.on('error', (error) => console.error('[ds-vm]', error.message));
  instance.on('state', (value) => console.log('[ds-vm]', value.state, value.progress));
  const check = async (name, fn) => {
    const begin = Date.now();
    console.log('[ds-vm] checking', name);
    try {
      await fn();
      checks.push({ name, ok: true, durationMs: Date.now() - begin });
    } catch (error) {
      checks.push({ name, ok: false, error: error.message });
    }
    console.log(checks.at(-1).ok ? 'PASS' : 'FAIL', name, checks.at(-1).error || '');
  };
  const raw = (id, name, args = {}, signal = AbortSignal.timeout(45000)) =>
    manager.callTool(id, name, args, { cwd: repo, sessionKey: 'vm-probe', mode: 'code', signal });
  const call = async (id, name, args = {}, signal) => {
    const result = await raw(id, name, args, signal);
    assert.equal(result.location, 'vm');
    assert.equal(result.ok, true, result.error);
    return result;
  };
  const activity = async (key, expected) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await call('capabilities', 'activity')).value[key] === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Guest activity did not become ' + key + '=' + expected);
  };
  const git = (args) =>
    execFileSync('git', ['-c', 'core.hooksPath=' + path.join(profile, 'no-hooks'), ...args], {
      cwd: repo,
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
  const add = async (id, entry, config = {}) => {
    const installDir = path.join(manager.pluginsDir, id);
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, 'package.json'),
      JSON.stringify({ name: 'reviewed-' + id, version: '1.0.0', main: path.basename(entry) }),
    );
    await fs.copyFile(entry, path.join(installDir, path.basename(entry)));
    manager.plugins.push({
      id,
      name: id,
      version: '1.0.0',
      enabled: true,
      config,
      installDir,
      entry: path.join(installDir, path.basename(entry)),
    });
    const loaded = await manager.refreshPlugin(id);
    assert.equal(loaded.ok, true, loaded.error);
    return manager.plugins.find((record) => record.id === id);
  };
  try {
    git(['init', '--initial-branch=main']);
    git(['config', 'user.name', 'CIBYP VM fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'core.autocrlf', 'false']);
    // Import ownership metadata belongs to the mirror, not this Git fixture.
    await fs.appendFile(path.join(repo, '.git/info/exclude'), '\n.cibyp-host-import\n');
    await fs.writeFile(path.join(repo, 'sample.txt'), 'first\n');
    git(['add', 'sample.txt']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'VM fixture']);
    await instance.start();
    report.accel = instance.accel.backend;
    const platform = await instance.exec('uname -sr; node --version');
    assert.equal(platform.ok, true, platform.stderr);
    report.platform = platform.stdout.trim();
    console.log('[ds-vm] guest', report.platform);
    const mounted = await service.mountExternalDir(repo, { preserveGit: true });
    assert.equal(mounted.ok, true, mounted.error);
    await manager.syncAgents([
      { key: 'vm-probe', cwd: repo, mode: 'code', status: 'idle' },
      { key: 'other', cwd: repo, mode: 'code', status: 'idle' },
    ]);
    await check('Git plugin load, real Linux status/history and Windows path mapping', async () => {
      assert.equal(
        (
          await add('git', path.join(reviewed.prepared, 'git.mjs'), {
            workDir: repo,
            destructivePolicy: 'deny',
          })
        ).toolCount,
        12,
      );
      const status = await call('git', 'git_status', {});
      report.gitStatus = status.value;
      assert.equal(status.value.isClean, true, JSON.stringify(status.value));
      assert.equal(
        (await call('git', 'git_log', { maxCount: 5, repoDir: repo })).value.commits[0].subject,
        'VM fixture',
      );
    });
    await check('Git diff and destructive-operation denial keep guest and host HEAD', async () => {
      await fs.writeFile(path.join(repo, 'sample.txt'), 'second\n');
      assert.match((await call('git', 'git_diff', { patch: true })).value.files[0].patch, /second/);
      const before = git(['rev-parse', 'HEAD']);
      const denied = await raw('git', 'git_commit', { message: 'Must not execute', amend: true });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /Destructive git operation blocked/);
      assert.equal(git(['rev-parse', 'HEAD']), before);
      const result = await instance.exec(
        'git -C ' +
          require('../../src/main/vm/vm-paths').shellQuote(mounted.vmRoot) +
          ' rev-parse HEAD',
      );
      assert.equal(result.stdout.trim(), before);
    });
    await check('Calculator expression evaluation and rejected code', async () => {
      await add('calculator', path.join(reviewed.prepared, 'calculator.mjs'));
      assert.equal(
        (await call('calculator', 'calculator', { expression: '15 + 27 * sqrt(9)' })).value,
        96,
      );
      assert.equal(
        (await raw('calculator', 'calculator', { expression: 'process.exit(1)' })).ok,
        false,
      );
    });
    await check('Encoding Unicode round trip and SHA-256', async () => {
      await add('encoding', path.join(reviewed.prepared, 'encoding.mjs'));
      const encoded = (
        await call('encoding', 'encoding', { action: 'base64_encode', input: '你好 CIBYP' })
      ).value;
      assert.equal(
        (await call('encoding', 'encoding', { action: 'base64_decode', input: encoded })).value,
        '你好 CIBYP',
      );
      assert.equal(
        (
          await call('encoding', 'encoding', {
            action: 'hash',
            input: 'CIBYP',
            algorithm: 'sha256',
          })
        ).value,
        createHash('sha256').update('CIBYP').digest('hex'),
      );
    });
    await check('Time IANA conversion and invalid date rejection', async () => {
      await add('time', path.join(reviewed.prepared, 'time.mjs'));
      assert.equal(
        (
          await call('time', 'time', {
            action: 'convert',
            value: '2026-10-08T00:00:00Z',
            timezone: 'Asia/Shanghai',
          })
        ).value.local,
        '2026-10-08T08:00:00+08:00',
      );
      assert.equal(
        (await raw('time', 'time', { action: 'convert', value: '2026-02-30', timezone: 'UTC' })).ok,
        false,
      );
    });
    const sdkPackages = Object.keys(require('../../src/main/ds-compat/sdk-catalog')).map(
      (name) => '@deepseek-ai/' + name,
    );
    for (const id of ['fs', 'bash', 'jobs']) {
      const pluginEntry = path.join(profile, 'official-' + id + '.mjs');
      await require('esbuild').build({
        entryPoints: [require.resolve('@deepseek-ai/dsh-tool-' + id)],
        outfile: pluginEntry,
        bundle: true,
        external: sdkPackages,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        logLevel: 'silent',
      });
      await add(id, pluginEntry);
    }
    await check(
      'Official filesystem plugin read/write/edit, host sync and sandbox denial',
      async () => {
        await call('fs', 'write', { file_path: 'plugin.txt', content: 'one\ntwo\n' });
        assert.match((await call('fs', 'read', { file_path: 'plugin.txt' })).content, /one/);
        await call('fs', 'edit', {
          file_path: 'plugin.txt',
          old_string: 'two',
          new_string: 'three',
        });
        assert.equal(await fs.readFile(path.join(repo, 'plugin.txt'), 'utf8'), 'one\nthree\n');
        settings.sandbox.defaultMode = 'read-only';
        try {
          const denied = await raw('fs', 'write', {
            file_path: 'forbidden.txt',
            content: 'denied',
          });
          assert.equal(denied.ok, false);
          assert.match(denied.error, /sandbox|read.only|denied/i);
        } finally {
          settings.sandbox.defaultMode = 'danger-full-access';
        }
        await assert.rejects(fs.stat(path.join(repo, 'forbidden.txt')), { code: 'ENOENT' });
      },
    );
    await check('Official Bash and jobs plugins retain guest process output', async () => {
      const started = await call('bash', 'bash', {
        description: 'Disposable VM background command',
        command: 'printf "%s\\n" "$DSH_SESSION_ID"; sleep 0.2; printf "VM job finished\\n"',
        run_in_background: true,
      });
      assert.ok(started.value.jobId);
      const output = await call('jobs', 'job_output', {
        job_id: started.value.jobId,
        wait: true,
        timeout_ms: 10000,
      });
      assert.match(output.content, /vm-probe/);
      assert.match(output.content, /VM job finished/);
    });
    const entry = path.join(profile, 'capabilities.cjs');
    await fs.writeFile(entry, fixture);
    await check(
      'Resident runtime state, real guest execution and host-only model bridge',
      async () => {
        await add('capabilities', entry);
        const environment = (await call('capabilities', 'environment')).value;
        assert.equal(environment.platform, 'linux');
        assert.equal(environment.cwd, mounted.vmRoot);
        assert.equal(environment.credentialsPresent, false);
        report.worker = environment;
        assert.equal((await call('capabilities', 'counter')).value, 1);
        assert.equal((await call('capabilities', 'counter')).value, 2);
        assert.equal((await call('capabilities', 'model')).value, 'Host fixture answer');
        assert.equal(modelCalls.length, 1);
      },
    );
    await check('Cancelled tool leaves resident runtime usable', async () => {
      const controller = new AbortController();
      const waiting = raw('capabilities', 'wait', {}, controller.signal);
      waiting.catch(() => {});
      try {
        await activity('waiting', true);
        controller.abort();
        await assert.rejects(waiting);
        await activity('waiting', false);
      } finally {
        controller.abort();
      }
      assert.equal((await call('capabilities', 'counter')).value, 3);
    });
    await check(
      'Real Linux PTY multiline, ownership, cancellation and process cleanup',
      async () => {
        const opened = (await call('capabilities', 'pty_open')).value;
        report.terminalPid = opened.pid;
        const foreign = await manager.callTool(
          'capabilities',
          'pty_read',
          {},
          { cwd: repo, sessionKey: 'other', mode: 'code', signal: AbortSignal.timeout(45000) },
        );
        assert.equal(foreign.ok, false);
        assert.match(foreign.error, /owner|session/i);
        const sent = await call('capabilities', 'pty_send', {
          text: "printf 'first line\\n'; printf 'second line\\n'; stty size",
        });
        assert.match(sent.value.viewport, /first line/);
        assert.match(sent.value.viewport, /second line/);
        assert.match(sent.value.viewport, /40 160/);
        assert.match((await call('capabilities', 'pty_read')).value.text, /second line/);
        const controller = new AbortController();
        const waiting = raw('capabilities', 'pty_send', { text: 'sleep 60' }, controller.signal);
        waiting.catch(() => {});
        try {
          await activity('sending', true);
          controller.abort();
          await assert.rejects(waiting);
          await activity('sending', false);
        } finally {
          controller.abort();
        }
        assert.match(
          (await call('capabilities', 'pty_send', { text: "printf 'after cancel\\n'" })).value
            .viewport,
          /after cancel/,
        );
        const closed = (await call('capabilities', 'pty_close')).value;
        assert.equal(closed.killed, true);
        assert.equal(closed.remaining, 0);
        const leftover = await instance.exec(`ps -o pid= -s ${Number(opened.pid)}`);
        assert.equal(leftover.stdout.trim(), '');
      },
    );
    await check('Exporter HTTP in guest, persisted conversation, origin and unload', async () => {
      await add('export', path.join(reviewed.prepared, 'export.mjs'));
      for (const event of [
        { type: 'title', title: 'VM export fixture' },
        { type: 'message', role: 'user', content: 'A synthetic VM question' },
        {
          type: 'model-response',
          message: { content: 'A synthetic VM answer', reasoning: 'private fixture reasoning' },
        },
        { type: 'status', status: 'idle' },
      ])
        await client.notify(service, 'runtime', { key: 'vm-probe', ...event });
      const url = (await call('capabilities', 'carrier')).value;
      const guestPort = Number(new URL(url).port);
      forwarded = await instance.ssh.forwardToHost(guestPort);
      const local = 'http://127.0.0.1:' + forwarded.hostPort;
      const post = (pathname, headers = {}) =>
        fetch(local + pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ sessionId: 'vm-probe' }),
          signal: AbortSignal.timeout(10000),
        });
      const exported = await post('/api/conversation.export');
      assert.equal(exported.status, 200);
      const content = await exported.text();
      assert.match(content, /VM export fixture/);
      assert.match(content, /A synthetic VM answer/);
      assert.doesNotMatch(content, /private fixture reasoning/);
      const turns = await post('/api/conversation.turns');
      assert.equal(turns.status, 200);
      assert.equal((await turns.json()).turns.length, 1);
      assert.equal(
        (await post('/api/conversation.export', { Origin: 'https://unrelated.invalid' })).status,
        403,
      );
      assert.equal((await manager.setEnabled('export', false)).ok, true);
      assert.equal((await post('/api/conversation.export')).status, 404);
    });
    await check('Disable and re-enable clears tool state without host fallback', async () => {
      assert.equal((await manager.setEnabled('capabilities', false)).ok, true);
      assert.equal((await raw('capabilities', 'counter')).ok, false);
      assert.equal((await manager.setEnabled('capabilities', true)).ok, true);
      assert.equal((await call('capabilities', 'counter')).value, 1);
    });
  } catch (error) {
    report.fatal = error.message;
    console.error('[ds-vm]', error.stack);
  } finally {
    forwarded?.close();
    await manager.dispose().catch((error) => {
      report.cleanupError = error.message;
    });
    if (service._syncTimer) clearInterval(service._syncTimer);
    await instance.stop({ timeoutMs: 15000 }).catch((error) => {
      report.cleanupError = error.message;
    });
    report.ok =
      !report.fatal &&
      !report.cleanupError &&
      checks.length === 12 &&
      checks.every((row) => row.ok);
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    // Remove only the unique disposable profile after stopping its own QEMU.
    if (!instance.child) await fs.rm(profile, { recursive: true, force: true });
    console.log('[ds-vm] report', reportFile, report.ok ? 'PASS' : 'FAIL');
    process.exitCode = report.ok ? 0 : 1;
  }
}
module.exports = { fixture, run };
if (require.main === module)
  run(...process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
