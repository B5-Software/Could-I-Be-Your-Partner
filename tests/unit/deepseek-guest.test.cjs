/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { RpcPeer } = require('../../src/main/ds-compat/rpc-peer');
test(
  'deployed resident DS runtime keeps state, proxies model calls to host and survives cancellation',
  { timeout: 30000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-ds-daemon-'));
    const worker = path.join(dir, 'worker.cjs');
    await fs.copyFile(path.resolve('src/main/vm/generated/guest-tool-worker.cjs'), worker);
    const entry = path.join(dir, 'plugin.cjs');
    await fs.writeFile(
      entry,
      `const {defineTool}=require('./worker.cjs').vmSdk['dsh-tools'];
    module.exports={inject:['tools','llm'],apply(ctx){let n=0;
      ctx.tools.register(defineTool({name:'counter',parameters:{},output:{schema:{type:'integer'},render:(_,v)=>[{type:'text',text:String(v)}]},execute:async()=>++n}));
      ctx.tools.register(defineTool({name:'model',parameters:{},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},execute:async(_,exec)=>(await ctx.llm.chat({model:'host-owned',messages:[{role:'user',content:[{type:'text',text:'hello'}]}]},exec.signal)).content}));
      ctx.tools.register(defineTool({name:'wait',parameters:{},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},execute:async(_,exec)=>new Promise((_,reject)=>exec.signal.addEventListener('abort',()=>reject(exec.signal.reason),{once:true}))}));
    }};`,
    );
    const child = spawn(
      process.env.CIBYP_TEST_GUEST_NODE || process.execPath,
      [worker, '--plugin-daemon'],
      { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr = (stderr + b).slice(-10000);
    });
    const calls = [];
    const peer = new RpcPeer(child.stdout, child.stdin, {
      request: async (method, args, signal) => {
        assert.equal(method, 'invoke');
        assert.equal(args[0], 'llm:chatStream');
        assert.equal(args[2].signal, undefined);
        assert.equal(signal.aborted, false);
        calls.push(args);
        peer.emit('llm:stream-chunk', { requestId: args[2].requestId, content: 'host reply' });
        return { ok: true, data: { choices: [{ message: { content: 'host reply' } }] } };
      },
    });
    const exit = once(child, 'exit');
    t.after(async () => {
      peer.close();
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      await exit;
      clearTimeout(timer);
      await fs.rm(dir, { recursive: true, force: true });
    });
    assert.deepEqual(
      await peer.ask(
        'init',
        {
          dataDir: path.join(dir, 'state'),
          settings: {},
          agents: [{ key: 'test', cwd: dir, mode: 'code', status: 'idle' }],
        },
        { timeoutMs: 10000 },
      ),
      { ok: true },
      stderr,
    );
    const invoke = (name, options) =>
      peer.ask(
        'call',
        {
          plugin: { id: 'p', entry },
          name,
          arguments: {},
          context: { sessionKey: 'test', cwd: dir },
          version: 'one',
          agents: [{ key: 'test', cwd: dir, mode: 'code', status: 'idle' }],
        },
        options,
      );
    const first = await invoke('counter');
    assert.equal(first.value, 1, JSON.stringify(first) + stderr);
    assert.equal((await invoke('counter')).value, 2);
    assert.equal((await invoke('model')).value, 'host reply');
    assert.equal(calls.length, 1);
    const controller = new AbortController();
    const waiting = invoke('wait', { signal: controller.signal });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(waiting);
    assert.equal((await invoke('counter')).value, 3);
    await peer.ask('unload', 'p');
    assert.equal((await invoke('counter')).value, 1);
    await peer.ask('dispose', null);
  },
);
