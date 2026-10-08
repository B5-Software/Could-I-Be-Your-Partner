/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

test('guest bundling embeds the SDK lazy terminal emulator without guest packages', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-emulator-bundle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, '@deepseek-ai/lazy-probe/index.js');
  const bundle = path.join(dir, 'worker.cjs');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(
    source,
    `
    const createLazyRequire=()=>{throw Error('unbundled lazy dependency')};
    const load=createLazyRequire('@xterm/headless',import.meta.url);
    const terminal=new (load().Terminal)({cols:20,rows:2,allowProposedApi:true});
    terminal.write('guest emulator',()=>{
      console.log(terminal.buffer.active.getLine(0).translateToString(true));
      terminal.dispose();
    });
  `,
  );
  await require('esbuild').build({
    entryPoints: [source],
    outfile: bundle,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    nodePaths: [path.resolve('node_modules')],
    plugins: [require('../../scripts/lib/guest-tool-bundle.cjs').sdkMetadataPlugin()],
    logLevel: 'silent',
  });
  const result = await run(process.env.CIBYP_TEST_GUEST_NODE || process.execPath, [bundle], {
    cwd: dir,
    windowsHide: true,
    timeout: 10000,
  });
  assert.match(result.stdout, /guest emulator/);
});

test('guest SDK bridge preserves native tool exports and reserved ESM names', async (t) => {
  const native = require('@deepseek-ai/dsh-tools');
  const shim = require('../../src/main/ds-compat/shims/dsh-tools');
  const worker = require('../../src/main/vm/generated/guest-tool-worker.cjs');
  for (const name of ['TOOL_ABORTED', 'TOOL_ABORTED_BEFORE_DISPATCH', 'ToolRuntime']) {
    assert.equal(shim[name], native[name]);
    assert.ok(Object.hasOwn(worker.vmSdk['dsh-tools'], name));
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-sdk-exports-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ['dsh-tools', 'schemastery']) {
    const api = require('../../src/main/ds-compat/sdk-catalog')[name];
    const files = require('../../src/main/vm/plugin-sdk-files').sdkFiles(
      path.resolve('src/main/vm/generated/guest-tool-worker.cjs'),
      name,
      api,
    );
    const target = path.join(dir, name);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'index.cjs'), files.commonjs);
    await fs.writeFile(path.join(target, 'index.mjs'), files.esm);
    const module = await import(require('node:url').pathToFileURL(path.join(target, 'index.mjs')));
    for (const key of Object.keys(api).filter(
      (key) => /^[A-Za-z_$][\w$]*$/.test(key) && !['default', '__esModule'].includes(key),
    ))
      assert.equal(module[key], worker.vmSdk[name][key]);
  }
});

test('deployed guest worker initializes ESM SDKs without host packages and executes a tool', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-worker-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const worker = path.join(dir, 'worker.cjs');
  await fs.copyFile(path.resolve('src/main/vm/generated/guest-tool-worker.cjs'), worker);
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  await fs.writeFile(input, JSON.stringify({ channel: 'system:info', args: [] }));
  const node = process.env.CIBYP_TEST_GUEST_NODE || process.execPath;
  await run(node, [worker, input, output], { cwd: dir, windowsHide: true, timeout: 30000 });
  const info = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(info.ok, true);
  assert.equal(info.location, 'vm');
  assert.equal(info.platform, process.platform);
  // Also verify the plugin SDK exports share one Cordis instance after bundling.
  const probe = path.join(dir, 'probe.cjs');
  await fs.writeFile(
    probe,
    `const w=require('./worker.cjs');
    const tool=w.vmShimTools.defineTool({name:'probe',parameters:{n:{type:'integer',required:true}},output:{schema:{type:'integer'}},execute:async a=>a.n});
    if(typeof w.vmShimLlm.HarnessError!=='function' || typeof w.vmShimCordis.Context!=='function') throw Error('Missing SDK');
    if(w.vmShimTools.validateArgs({n:{type:'integer',required:true}},{n:1.5}).length===0) throw Error('Schema validation broken');
    tool.execute({n:42}).then(value=>{if(value!==42)throw Error('Tool failed');console.log('SDK_OK')});`,
  );
  const result = await run(node, [probe], { cwd: dir, windowsHide: true, timeout: 30000 });
  assert.match(result.stdout, /SDK_OK/);
});
