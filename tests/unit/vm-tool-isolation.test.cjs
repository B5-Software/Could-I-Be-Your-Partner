const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createToolFiles } = require('../../src/main/vm/tool-files');
const { withToolLocation } = require('../../src/main/vm/tool-location');
const { createRoutedHandler, GUEST_ROUTES } = require('../../src/main/vm/vm-tools');

test('model inference and authentication always use host handlers in VM mode', async () => {
  for (const channel of [
    'llm:chat',
    'llm:chatStream',
    'llm:summarize',
    'vision:describeImage',
    'image:generate',
    'decision:call',
    'decision:models',
    'chatgpt:login',
    'chatgpt:models',
    'shell:openHostBrowser',
  ]) {
    let hostCalls = 0;
    const original = async (_, value) => {
      hostCalls++;
      return { ok: true, value, location: 'host' };
    };
    const handler = createRoutedHandler(channel, original, {
      isLocationVm: () => true,
      getVmService() {
        throw new Error('Inference must not enter the guest');
      },
    });
    assert.equal((await handler(null, 'request')).value, 'request');
    assert.equal(hostCalls, 1, channel);
    assert.equal(GUEST_ROUTES[channel], undefined);
  }
});

function fixture() {
  const contents = new Map();
  const service = {
    runtime: { location: 'vm', workspaceMode: 'isolated', vm: { workspaceMount: '/workspace' } },
    instance: {
      state: 'ready',
      exec: async (command) => ({
        ok: true,
        stdout: [...contents.keys()].some((file) => command.includes("'" + file + "'"))
          ? 'yes'
          : 'no',
        stderr: '',
      }),
      sftp: async () => ({
        writeFile: async (file, data) => contents.set(file, Buffer.from(data)),
        readFile: async (file) => {
          if (!contents.has(file)) throw new Error('ENOENT');
          return contents.get(file);
        },
        stat: async (file) => {
          if (!contents.has(file)) throw new Error('ENOENT');
          return { size: contents.get(file).length, isDirectory: () => false, isFile: () => true };
        },
      }),
    },
  };
  const hostFs = new Proxy(
    {},
    {
      get: (_target, method) => {
        throw new Error(`Unexpected host filesystem access: ${String(method)}`);
      },
    },
  );
  return { service, contents, hostFs };
}

test('VM file access never reads or writes through the supplied host filesystem', async () => {
  const { service, contents, hostFs } = fixture();
  const files = createToolFiles({ fs: hostFs, getVmService: () => service });
  await files.write('/workspace/test.txt', 'VM only');
  assert.equal(await files.read('/workspace/test.txt', 'utf8'), 'VM only');
  assert.equal(contents.get('/workspace/test.txt').toString(), 'VM only');
  assert.throws(() => files.resolve('C:/outside/secret.txt'), /映射范围/);
  service.instance.state = 'idle';
  await assert.rejects(files.write('/workspace/test.txt', 'wrong'), /虚拟机未就绪/);
  assert.equal(contents.get('/workspace/test.txt').toString(), 'VM only');
});

test('An in-flight VM operation keeps its location across settings changes', async () => {
  const { service, contents, hostFs } = fixture();
  const files = createToolFiles({ fs: hostFs, getVmService: () => service });
  await withToolLocation(
    () => service,
    async () => {
      service.runtime.location = 'host';
      await Promise.resolve();
      await files.write('/workspace/leased.txt', 'guest');
    },
  );
  assert.equal(contents.get('/workspace/leased.txt').toString(), 'guest');
  assert.equal(files.active(), false);
});

test('VM file copy, move, creation and searches reject unmapped host paths before execution', async () => {
  const { service } = fixture();
  let calls = 0;
  service.instance.exec = async () => {
    calls++;
    throw new Error('Unexpected execution');
  };
  const io = new (require('../../src/main/vm/vm-fs').VmFs)({ vmService: service });
  assert.equal(io.strictPath('/workspace\\nested\\test.txt'), '/workspace/nested/test.txt');
  assert.equal((await io.deleteDirectory('/workspace/..')).ok, false);
  const outside = 'C:/outside/private.txt';
  for (const run of [
    () => io.copyFile(outside, '/workspace/copy.txt'),
    () => io.moveFile(outside, '/workspace/moved.txt'),
    () => io.createFile(outside, 'text'),
    () => io.localSearch(outside, '*'),
    () => io.searchInFiles([outside], 'text'),
    () => io.listDirectory(outside),
  ]) {
    const result = await run();
    assert.equal(result.ok, false);
    assert.match(result.error, /映射范围/);
  }
  assert.equal(calls, 0);
});

test('A VM session workspace is created only in the guest filesystem', async () => {
  const { service, hostFs } = fixture();
  const handlers = new Map();
  const settings = { workspace: {} };
  require('../../src/main/ipc/workspaces')({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    fs: hostFs,
    path,
    vmService: service,
    getSettings: () => settings,
    scheduleSettingsPersist: () => {},
    workspacesBaseDir: 'C:/host-workspaces',
  });
  const created = await handlers.get('workspace:create')(null, {});
  assert.equal(created.ok, true, created.error);
  assert.match(created.path, /^\/workspace\//);
  assert.equal(settings.workspace.lastWorkspace, created.path);
});

test('WebUI VM uploads never create a host file or fall back on guest failure', async () => {
  const { WebControlService } = require('../../src/main/web-control-service');
  const web = new WebControlService();
  web.workDir = 'C:/must-not-exist/vm-upload-test';
  web.vmUploader = async (buffer) => {
    assert.equal(buffer.toString(), 'VM attachment');
    return { ok: true, vmPath: '/workspace/upload.txt' };
  };
  const result = await web._saveUpload(
    'upload.txt',
    'text/plain',
    Buffer.from('VM attachment').toString('base64'),
  );
  assert.equal(result.path, '/workspace/upload.txt');
  web.vmUploader = async () => {
    throw new Error('Guest unavailable');
  };
  const failed = await web._saveUpload('upload.txt', 'text/plain', 'WA==');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Guest unavailable/);
});

test('Guest tool failures never execute the host implementation', async () => {
  const { service } = fixture();
  service.instance.state = 'idle';
  service.start = async () => {
    throw new Error('VM boot failed');
  };
  for (const channel of Object.keys(GUEST_ROUTES)) {
    let calls = 0;
    const handler = createRoutedHandler(
      channel,
      () => {
        calls++;
      },
      { getVmService: () => service, isLocationVm: () => true },
    );
    const result = await handler(null, '/workspace/test');
    assert.equal(result.ok, false, channel);
    assert.equal(calls, 0, channel);
  }
});

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = {
      send() {},
      executeJavaScript: async (script) => {
        if (script.startsWith('typeof ')) return true;
        if (script.includes('GetState')) return { ok: true, state: { modified: true } };
        if (script.includes('GetDxfString')) return { ok: true, dxf: 'DXF from VM tool' };
        if (script.includes('Get3DOBJ'))
          return { ok: true, data: { obj: 'mtllib wrong.mtl\nv 1 2 3', mtl: 'newmtl board' } };
        return { ok: true, data: { title: 'VM project' } };
      },
    };
  }
  loadFile() {}
  isDestroyed() {
    return false;
  }
  destroy() {
    this.emit('closed');
  }
  focus() {}
}

test('CAD save, DXF export and close recovery write directly to VM', async () => {
  const { service, contents, hostFs } = fixture();
  const handlers = new Map();
  require('../../src/main/ipc/cad')({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: FakeWindow,
    path,
    fs: hostFs,
    dialog: {},
    app: { getPath: () => 'C:/app-profile' },
    getVmService: () => service,
  });
  await handlers.get('cipypcad:open')();
  assert.equal(
    (await handlers.get('cipypcad:saveProject')(null, '/workspace/design.cipyproj')).ok,
    true,
  );
  assert.equal(JSON.parse(contents.get('/workspace/design.cipyproj')).title, 'VM project');
  assert.equal((await handlers.get('cipypcad:exportDxf')(null, '/workspace/design.dxf')).ok, true);
  assert.equal(contents.get('/workspace/design.dxf').toString(), 'DXF from VM tool');
  assert.equal((await handlers.get('cipypcad:agentClose')()).ok, true);
  assert.equal(JSON.parse(contents.get('/workspace/design.cipyproj')).title, 'VM project');
});

test('EDA multi-file exports and OBJ material sidecar both stay in VM', async () => {
  const { service, contents, hostFs } = fixture();
  const handlers = new Map();
  require('../../src/main/ipc/pcb')({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: FakeWindow,
    path,
    fs: hostFs,
    dialog: {},
    app: { getPath: () => 'C:/app-profile' },
    getVmService: () => service,
    requireAdmZip: () => require('adm-zip'),
  });
  await handlers.get('pcbeda:open')();
  const exported = await handlers.get('pcbeda:exportFiles')(
    null,
    '/workspace/gerber',
    [
      { name: 'top.gbr', content: 'G04 VM' },
      { name: 'drill.drl', content: 'M48' },
    ],
    'board.zip',
  );
  assert.equal(exported.ok, true, exported.error);
  assert.ok(contents.has('/workspace/gerber/top.gbr'));
  assert.ok(contents.has('/workspace/gerber/drill.drl'));
  assert.ok(contents.has('/workspace/gerber/board.zip'));
  const obj = await handlers.get('pcbeda:exportTextFile')(null, 'obj', '/workspace/board', 'board');
  assert.equal(obj.ok, true, obj.error);
  assert.match(contents.get('/workspace/board.obj').toString(), /mtllib board.mtl/);
  assert.equal(contents.get('/workspace/board.mtl').toString(), 'newmtl board');
});
