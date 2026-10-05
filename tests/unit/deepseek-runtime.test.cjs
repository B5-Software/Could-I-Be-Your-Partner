const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginHost } = require('../../src/main/ds-compat/plugin-host');
const tools = require('../../src/main/ds-compat/shims/dsh-tools');

async function hostFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-dsh-'));
  const host = new PluginHost();
  t.after(async () => {
    await host.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const api = path.resolve('src/main/ds-compat/shims/dsh-tools/index.js');
  const install = async (id, body) => {
    const entry = path.join(dir, id + '.cjs');
    await fs.writeFile(entry, `const {defineTool}=require(${JSON.stringify(api)});\n${body}`);
    return host.loadPlugin(id, entry);
  };
  return { host, install, dir };
}
test('latest nested schemas and DSL validation match upstream, including integer and json values', () => {
  const spec = {
    data: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        n: { type: 'integer', required: true },
        tags: { type: 'array', items: { type: 'string', enum: ['a'] } },
      },
    },
  };
  assert.equal(tools.validateArgs(spec, { data: { n: 2, tags: ['a'] } }).length, 0);
  assert.ok(tools.validateArgs(spec, { data: { n: 1.5, tags: ['b'] } }).length >= 2);
  assert.deepEqual(tools.valueSchemaSpecToJsonSchema({ type: 'json' }), {});
  assert.equal(typeof tools.renderToolsSdk, 'function');
});
test('real plugin dispatch runs pre/around/post/finalize/result hooks and unload disposes tools', async (t) => {
  const { host, install } = await hostFixture(t);
  const loaded = await install(
    'modern',
    `module.exports = { inject: {tools: {required: true}, unavailable: {required: false}}, apply(ctx) {
    ctx.on('tools/pre-execute', async (exec,next) => { if(exec.arguments.n<0) return {kind:'deny',reason:'negative'}; return next(); });
    ctx.on('tools/execute', async (_exec,next) => next());
    ctx.on('tools/post-execute', async (_exec,result,next) => result.isError ? next() : {kind:'accept',value:result.value+1});
    ctx.on('tools/result', (_exec,result) => { globalThis.__cibypDshResult = result; });
    ctx.tools.register(Object.freeze(defineTool({name:'increment',description:'d',parameters:{n:{type:'integer',required:true}},
      output:{schema:{type:'integer'},render:(_a,v)=>[{type:'text',text:String(v)}]}, execute:async(args,exec)=>{if(exec.name!=='increment')throw Error('identity');return args.n;},
      finalizeContent:(_exec,result)=>result.isError?undefined:[{type:'text',text:'final:'+result.value}] }))); } };`,
  );
  assert.deepEqual(loaded.issues, []);
  assert.equal(loaded.tools[0].name, 'increment');
  assert.equal((await host.callTool('modern', 'increment', { n: 4 })).content, 'final:5');
  assert.equal((await host.callTool('modern', 'increment', { n: -1 })).code, 'TOOL_DENIED');
  assert.equal((await host.callTool('modern', 'increment', { n: 'x' })).invalidArgs, true);
  assert.equal(globalThis.__cibypDshResult.isError, true);
  delete globalThis.__cibypDshResult;
  await host.unloadPlugin('modern');
  assert.equal(host.toolsService.tools.size, 0);
});
test('concurrent async plugin loads keep ownership and guards are removed on unload', async (t) => {
  const { host, install } = await hostFixture(t);
  const plugin = (name, delay) =>
    `module.exports=async(ctx)=>{await new Promise(r=>setTimeout(r,${delay}));ctx.tools.registerGuard(exec=>exec.arguments.deny?'blocked':undefined);ctx.tools.register(defineTool({name:'${name}',parameters:{deny:{type:'boolean'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=> '${name}'}));};`;
  const [a, b] = await Promise.all([
    install('one', plugin('one', 25)),
    install('two', plugin('two', 2)),
  ]);
  assert.equal(a.tools[0].name, 'one');
  assert.equal(b.tools[0].name, 'two');
  assert.equal((await host.callTool('one', 'one', {})).content, 'one');
  assert.equal((await host.callTool('two', 'two', { deny: true })).code, 'TOOL_DENIED');
  await host.unloadPlugin('one');
  await host.unloadPlugin('two');
  assert.equal(host.toolsService.guards.size, 0);
});
test('a tool ignoring cancellation returns a timeout and accepts caller cancellation', async (t) => {
  const { host, install } = await hostFixture(t);
  await install(
    'slow',
    `module.exports=ctx=>ctx.tools.register(defineTool({name:'slow',parameters:{},timeoutMs:30,output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{await new Promise(r=>setTimeout(r,150));return 'late';}}));`,
  );
  assert.equal((await host.callTool('slow', 'slow', {})).code, 'TIMEOUT');
  assert.equal((await host.callTool('slow', 'slow', {})).code, 'TOOL_BUSY');
  await new Promise((r) => setTimeout(r, 160));
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  assert.equal(
    (await host.callTool('slow', 'slow', {}, { signal: controller.signal })).code,
    'CANCELLED',
  );
});

test('an ESM plugin resolves modern subpaths and public helpers with asynchronous Config', async (t) => {
  const { host, dir } = await hostFixture(t);
  const { PluginManager } = require('../../src/main/ds-compat/plugin-manager');
  PluginManager.prototype._ensureShims.call(PluginManager.prototype, dir);
  const entry = path.join(dir, 'modern.mjs');
  await fs.writeFile(
    entry,
    `
    import {defineTool} from '@deepseek-ai/dsh-tools';
    import {valueSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools/schema';
    import {HarnessError} from '@deepseek-ai/dsh-llm';
    import '@deepseek-ai/dsh-tools/presentation';
    import '@deepseek-ai/dsh-tools/types';
    export const Config = {'~standard': {validate: async value => ({value: {...value, greeting: 'hello'}})}};
    export function apply(ctx, config) {
      if (typeof HarnessError !== 'function' || valueSchemaSpecToJsonSchema({type:'string'}).type !== 'string') throw Error('helpers');
      ctx.tools.register(defineTool({name:'esm',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>config.greeting}));
    }
  `,
  );
  const loaded = await host.loadPlugin('esm', entry);
  assert.deepEqual(loaded.issues, []);
  assert.equal((await host.callTool('esm', 'esm', {})).content, 'hello');
});
