/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Opt-in source-audited probes. Never downloads or runs package lifecycle scripts.
// Refuses changed trees and commits other than those reviewed in the report.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sources = [
  { id: 'git', directory: 'ds-thirdparty-git', commit: '09df9e9ad56a144d61647f465b54f84bbf90113c' },
  {
    id: 'export',
    directory: 'ds-thirdparty-export',
    commit: 'a7375d3ab5ce07e202b0822f44db15fe8417edf1',
  },
  {
    id: 'toolkit',
    directory: 'ds-thirdparty-toolkit',
    commit: 'c3319d9d3e78a18191e1381461b69e84bc547575',
  },
];
const prepared = path.join(root, '.cache', 'ds-thirdparty-prepared');
const reportFile = path.join(root, '.cache', 'ds-thirdparty-results.json');

async function prepare() {
  const esbuild = require('esbuild');
  await fs.mkdir(prepared, { recursive: true });
  const artifacts = [];
  for (const source of sources) {
    const cwd = path.join(root, '.cache', source.directory);
    const git = (args) =>
      execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
    assert.equal(
      git(['rev-parse', 'HEAD']),
      source.commit,
      'Unreviewed plugin revision: ' + source.id,
    );
    assert.equal(git(['status', '--porcelain']), '', 'Modified plugin checkout: ' + source.id);
    const entries =
      source.id === 'toolkit'
        ? ['calculator', 'encoding', 'time'].map((name) => ({
            id: name,
            entry: `packages/dsh-tool-${name}/lib/index.js`,
          }))
        : [{ id: source.id, entry: 'src/index.' + (source.id === 'git' ? 'ts' : 'js') }];
    for (const entry of entries) {
      const outfile = path.join(prepared, entry.id + '.mjs');
      await esbuild.build({
        entryPoints: [path.join(cwd, entry.entry)],
        outfile,
        bundle: true,
        packages: 'external',
        platform: 'node',
        target: 'node20',
        format: 'esm',
        logLevel: 'silent',
      });
      artifacts.push({
        id: entry.id,
        commit: source.commit,
        sha256: createHash('sha256')
          .update(await fs.readFile(outfile))
          .digest('hex'),
      });
    }
  }
  return artifacts;
}

async function probe() {
  const { PluginHost } = require('../src/main/ds-compat/plugin-host');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-reviewed-plugins-'));
  const host = new PluginHost({ dataDir: path.join(temporary, 'profile') });
  const checks = [];
  const check = async (name, run) => {
    try {
      await run();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, error: error.message });
    }
  };
  const repo = path.join(temporary, 'repository');
  const git = (args) =>
    execFileSync('git', ['-c', 'core.hooksPath=' + path.join(temporary, 'no-hooks'), ...args], {
      cwd: repo,
      windowsHide: true,
      encoding: 'utf8',
    });
  const load = async (id, config) => {
    const result = await host.loadPlugin(id, path.join(prepared, id + '.mjs'), { config });
    assert.deepEqual(result.issues, [], result.issues.join('\n'));
    return result;
  };
  const call = async (id, name, args) => {
    const result = await host.callTool(id, name, args, { cwd: repo, sessionKey: 'probe' });
    assert.equal(result.ok, true, result.error);
    return result;
  };
  try {
    await fs.mkdir(repo);
    git(['init', '--initial-branch=main']);
    git(['config', 'user.name', 'CIBYP compatibility probe']);
    git(['config', 'user.email', 'probe@example.invalid']);
    await fs.writeFile(path.join(repo, 'sample.txt'), 'first\n');
    git(['add', 'sample.txt']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Temporary fixture']);
    await host.init();
    await host.agentsService.sync([{ key: 'probe', cwd: repo, mode: 'code', status: 'idle' }]);
    await check('git: load 12 real tool definitions', async () => {
      assert.equal(
        (await load('git', { workDir: repo, destructivePolicy: 'deny' })).tools.length,
        12,
      );
    });
    await check('git: clean status and history', async () => {
      assert.equal((await call('git', 'git_status', {})).value.isClean, true);
      assert.equal(
        (await call('git', 'git_log', { maxCount: 5 })).value.commits[0].subject,
        'Temporary fixture',
      );
    });
    await check('git: diff and destructive-operation gate', async () => {
      await fs.writeFile(path.join(repo, 'sample.txt'), 'second\n');
      assert.match((await call('git', 'git_diff', { patch: true })).value.files[0].patch, /second/);
      const before = git(['rev-parse', 'HEAD']);
      const denied = await host.callTool(
        'git',
        'git_commit',
        { message: 'Must not execute', amend: true },
        { sessionKey: 'probe', cwd: repo },
      );
      assert.equal(denied.ok, false);
      assert.match(denied.error, /Destructive git operation blocked/);
      assert.equal(git(['rev-parse', 'HEAD']), before);
    });
    for (const id of ['calculator', 'encoding', 'time']) await check(id + ': load', () => load(id));
    await check('calculator: arithmetic and rejected code input', async () => {
      assert.equal(
        (await call('calculator', 'calculator', { expression: '15 + 27 * sqrt(9)' })).value,
        96,
      );
      const bad = await host.callTool(
        'calculator',
        'calculator',
        { expression: 'process.exit(1)' },
        { sessionKey: 'probe', cwd: repo },
      );
      assert.equal(bad.ok, false);
    });
    await check('encoding: Unicode round trip and SHA-256', async () => {
      const encoded = await call('encoding', 'encoding', {
        action: 'base64_encode',
        input: '你好 CIBYP',
      });
      assert.equal(
        (await call('encoding', 'encoding', { action: 'base64_decode', input: encoded.value }))
          .value,
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
    await check('time: IANA timezone conversion and invalid date rejection', async () => {
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
        (
          await host.callTool(
            'time',
            'time',
            { action: 'convert', value: '2026-02-30', timezone: 'UTC' },
            { sessionKey: 'probe', cwd: repo },
          )
        ).ok,
        false,
      );
    });
    await check(
      'export: native routes, title, reasoning filtering and origin rejection',
      async () => {
        await load('export');
        const event = (value) => host.agentsService.consumeRuntimeEvent({ key: 'probe', ...value });
        event({ type: 'title', title: 'Reviewed fixture' });
        event({ type: 'message', role: 'user', content: 'A synthetic question' });
        event({
          type: 'model-response',
          message: { content: 'A synthetic answer', reasoning: 'private test reasoning' },
        });
        event({ type: 'status', status: 'idle' });
        await host.ctx.sessions.flush(host.ctx.agents.get('probe').session);
        const url = host.ctx.webRuntime.publicUrl;
        const post = (pathname, headers = {}) =>
          fetch(url + pathname, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ sessionId: 'probe' }),
          });
        const exported = await post('/api/conversation.export');
        assert.equal(exported.status, 200);
        const text = await exported.text();
        assert.match(text, /Reviewed fixture/);
        assert.match(text, /A synthetic answer/);
        assert.doesNotMatch(text, /private test reasoning/);
        const turns = await post('/api/conversation.turns');
        assert.equal(turns.status, 200);
        assert.equal((await turns.json()).turns.length, 1);
        assert.equal(
          (await post('/api/conversation.export', { origin: 'https://untrusted.invalid' })).status,
          403,
        );
        await host.unloadPlugin('export');
        assert.equal((await post('/api/conversation.export')).status, 404);
      },
    );
    await check('unload: tools and plugin hook registrations are removed', async () => {
      for (const id of ['git', 'calculator', 'encoding', 'time']) await host.unloadPlugin(id);
      assert.equal(host.ctx.tools.registrations.size, 0);
    });
    await check(
      'resident worker: real third-party ESM plugins share the deployed SDK identities',
      async () => {
        const { RpcPeer } = require('../src/main/ds-compat/rpc-peer');
        const { once } = require('node:events');
        const guest = path.join(temporary, 'guest');
        await fs.mkdir(guest);
        const worker = path.join(guest, 'worker.cjs');
        await fs.copyFile(path.join(root, 'src/main/vm/generated/guest-tool-worker.cjs'), worker);
        for (const id of ['git', 'calculator', 'encoding', 'time', 'export'])
          await fs.copyFile(path.join(prepared, id + '.mjs'), path.join(guest, id + '.mjs'));
        for (const [name, api] of Object.entries(require('../src/main/ds-compat/sdk-catalog'))) {
          const directory = path.join(guest, 'node_modules/@deepseek-ai', name);
          await fs.mkdir(directory, { recursive: true });
          const files = require('../src/main/vm/plugin-sdk-files').sdkFiles(worker, name, api);
          await fs.writeFile(
            path.join(directory, 'package.json'),
            JSON.stringify({
              type: 'commonjs',
              exports: { '.': { require: './index.cjs', import: './index.mjs' } },
            }),
          );
          await fs.writeFile(path.join(directory, 'index.cjs'), files.commonjs);
          await fs.writeFile(path.join(directory, 'index.mjs'), files.esm);
        }
        const child = spawn(process.execPath, [worker, '--plugin-daemon'], {
          cwd: guest,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const exited = once(child, 'exit');
        let stderr = '';
        child.stderr.on('data', (bytes) => {
          stderr = (stderr + bytes).slice(-8000);
        });
        const peer = new RpcPeer(child.stdout, child.stdin, {
          request: async () => {
            throw new Error('External host capabilities are disabled in third-party probes');
          },
        });
        const agents = [{ key: 'guest-probe', cwd: repo, status: 'idle', mode: 'code' }];
        const dispatch = (id, name, args = {}, config = {}) =>
          peer.ask(
            'call',
            {
              plugin: { id, entry: path.join(guest, id + '.mjs'), config },
              name,
              arguments: args,
              context: { sessionKey: 'guest-probe', cwd: repo },
              version: 'reviewed-' + id,
              agents,
            },
            { timeoutMs: 10000 },
          );
        try {
          await peer.ask(
            'init',
            { dataDir: path.join(guest, 'profile'), settings: {}, agents },
            { timeoutMs: 15000 },
          );
          assert.equal(
            (await dispatch('calculator', 'calculator', { expression: '6 * 7' })).value,
            42,
            stderr,
          );
          assert.equal(
            (await dispatch('encoding', 'encoding', { action: 'base64_decode', input: 'Q0lCWVA=' }))
              .value,
            'CIBYP',
            stderr,
          );
          assert.equal(
            (
              await dispatch('time', 'time', {
                action: 'diff',
                from: '2026-10-08',
                to: '2026-10-09',
              })
            ).value.days,
            1,
            stderr,
          );
          const gitResult = await dispatch('git', 'git_status', {}, { workDir: repo });
          assert.equal(gitResult.ok, true, gitResult.error || stderr);
          assert.equal(
            (await dispatch('git', 'git_log', { maxCount: 1 }, { workDir: repo })).value.commits[0]
              .subject,
            'Temporary fixture',
            stderr,
          );
          assert.equal((await dispatch('export', null)).ok, true, stderr);
          await peer.ask('dispose', null, { timeoutMs: 10000 });
        } finally {
          peer.close();
          child.stdin.end();
          const timer = setTimeout(() => child.kill(), 3000);
          await exited;
          clearTimeout(timer);
        }
      },
    );
  } finally {
    await host.dispose();
    // The only deleted tree is the unique directory created by this probe.
    await fs.rm(temporary, { recursive: true, force: true });
  }
  await fs.writeFile(
    reportFile,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        sdk: require('@deepseek-ai/dsh-tools/package.json').version,
        sources,
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  for (const check of checks)
    process.stdout.write(
      `${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.error ? ': ' + check.error : ''}\n`,
    );
  process.exitCode = checks.some((check) => !check.ok) ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--worker')) return probe();
  await fs.rm(reportFile, { force: true });
  const artifacts = await prepare();
  const childHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-plugin-probe-home-'));
  const env = {};
  // Pass the executable search path and OS runtime variables only. No API keys,
  // npm tokens, SSH agent sockets, real HOME or Git config reach plugin code.
  for (const [key, value] of Object.entries(process.env))
    if (/^(?:path|systemroot|windir|comspec|pathext|lang|lc_all)$/i.test(key)) env[key] = value;
  Object.assign(env, {
    HOME: childHome,
    USERPROFILE: childHome,
    APPDATA: childHome,
    LOCALAPPDATA: childHome,
    TEMP: childHome,
    TMP: childHome,
    TMPDIR: childHome,
    GIT_CONFIG_GLOBAL: path.join(childHome, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  try {
    const child = spawn(process.execPath, [__filename, '--worker'], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    report.artifacts = artifacts;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    process.exitCode = status || 0;
  } finally {
    await fs.rm(childHome, { recursive: true, force: true });
  }
}
module.exports = { prepare, prepared, sources };
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
