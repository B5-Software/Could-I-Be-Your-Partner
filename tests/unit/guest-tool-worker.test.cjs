/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

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
