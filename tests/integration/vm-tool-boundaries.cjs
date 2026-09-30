/* Explicit real guest integration; all writable data lives in the temporary VM. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { VmFs } = require('../../src/main/vm/vm-fs');
const { runGuestTool, runGuestPlugin } = require('../../src/main/vm/vm-tool-runtime');

module.exports = async (vm, temporary, settings) => {
  const io = new VmFs({ vmService: vm });
  const info = await runGuestTool(vm, 'system:info', [], {});
  assert.equal(info.platform, 'linux');
  assert.equal(info.location, 'vm');
  console.log('PASS guest system information');
  await io.writeBuffer('/workspace/lint-probe.js', Buffer.from('missingVariable();\n'));
  const lint = await runGuestTool(vm, 'eslint:lintFile', ['/workspace/lint-probe.js'], {
    read: [0],
  });
  assert.equal(lint.ok, true, JSON.stringify(lint));
  assert.ok(JSON.stringify(lint).includes('no-undef'), JSON.stringify(lint));
  console.log('PASS ESLint reads guest project and detects actual undefined variable');
  console.log('Checking guest plugin execution');

  const pluginDirectory = path.join(temporary, 'plugin-fixture');
  fs.mkdirSync(pluginDirectory);
  fs.writeFileSync(path.join(pluginDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(pluginDirectory, 'index.js'),
    `
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Context } from '@deepseek-ai/cordis';
import fs from 'node:fs';
export const inject=['tools'];
export function apply(ctx){ctx.tools.register(defineTool({
  name:'guest_probe', description:'Guest filesystem probe', parameters:{},
  output:{schema:{type:'string'}},
  async execute(){fs.writeFileSync('/workspace/plugin-probe.txt',process.platform);return process.platform+':'+Context.is(ctx);}
}));}
`,
  );
  const plugin = await runGuestPlugin(
    vm,
    {
      id: 'native-probe',
      name: 'Guest probe',
      version: '1.0.0',
      installDir: pluginDirectory,
      entry: path.join(pluginDirectory, 'index.js'),
    },
    'guest_probe',
    {},
    { cwd: '/workspace' },
  );
  assert.equal(plugin.ok, true, JSON.stringify(plugin));
  assert.equal(plugin.value, 'linux:true');
  assert.equal((await io.readBuffer('/workspace/plugin-probe.txt')).toString(), 'linux');
  console.log('PASS ESM plugin, SDK imports and filesystem execute inside Linux guest');

  await io.writeBuffer(
    '/workspace/mcp-probe.cjs',
    Buffer.from(`
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;
 let result={};
 if(r.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'guest-probe',version:'1'}};
 if(r.method==='tools/list')result={tools:[{name:'probe',description:'Guest probe',inputSchema:{type:'object'}}]};
 if(r.method==='tools/call'){fs.writeFileSync('/workspace/mcp-result.txt',process.platform);result={content:[{type:'text',text:process.platform}]};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});
`),
  );
  const handlers = new Map();
  const mcp = require('../../src/main/mcp-service')({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getSettings: () => settings,
    persist: () => {},
    getVmService: () => vm,
    defaultTimeoutMs: 60000,
  });
  try {
    const added = await handlers.get('mcp:addServer')(null, {
      name: 'guest-probe',
      type: 'stdio',
      command: 'node',
      args: ['/workspace/mcp-probe.cjs'],
      cwd: '/workspace',
    });
    assert.equal(added.ok, true, added.error);
    const connected = await handlers.get('mcp:connect')(null, 'guest-probe');
    assert.equal(connected.ok, true, connected.error);
    const result = await handlers.get('mcp:callTool')(null, 'guest-probe', 'probe', {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await io.readBuffer('/workspace/mcp-result.txt')).toString(), 'linux');
    console.log('PASS MCP process, protocol and file writes inside guest');
  } finally {
    await mcp.stopAllMcpServers();
  }

  const server = http.createServer((_request, response) => response.end('guest download content'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = await runGuestTool(
      vm,
      'net:httpRequest',
      [{ url: `http://10.0.2.2:${server.address().port}/fixture` }],
      {},
    );
    assert.equal(request.body, 'guest download content');
    assert.equal(request.location, 'vm');
    console.log('PASS HTTP request executes in guest network');
    const download = await vm.downloadFileToVm({
      url: `http://10.0.2.2:${server.address().port}/fixture`,
      filename: 'download-probe.txt',
      dir: '/workspace',
    });
    assert.equal(download.ok, true, download.error);
    assert.equal((await io.readBuffer(download.path)).toString(), 'guest download content');
    console.log('PASS aria2 download writes directly to guest disk');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const connection = await vm.graphicsChromium();
  assert.equal(connection.ok, true, connection.error);
  const capture = await vm
    .graphicsController()
    .capture({ workspacePath: '/workspace', filename: 'desktop-probe.png' });
  assert.equal(capture.path, '/workspace/desktop-probe.png');
  assert.ok((await io.readBuffer(capture.path)).length > 500);
  const browser = await require('playwright').chromium.connectOverCDP(connection.cdpUrl, {
    timeout: 60000,
  });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('data:text/html,<h1>Guest browser</h1>');
    assert.match(await page.evaluate(() => navigator.userAgent), /Linux/);
    await io.writeBuffer('/workspace/browser-probe.png', await page.screenshot());
    assert.ok((await io.readBuffer('/workspace/browser-probe.png')).length > 500);
    console.log('PASS Playwright controls Linux Chromium and screenshot is stored in guest');
  } finally {
    await context.close();
    await browser.close();
  }
};
