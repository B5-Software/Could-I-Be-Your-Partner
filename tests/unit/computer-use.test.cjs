const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createComputerPermissions } = require('../../src/main/services/computer-permissions');
const { toDesktopPoint } = require('../../src/main/services/computer-coordinates');
const { createMacComputer, loadMacBridge } = require('../../src/main/services/macos-computer');

function permissionsFixture(settings = {}) {
  let state = { accessibility: false, postEvents: false, screen: false };
  const requested = [],
    opened = [];
  const options = {
    platform: 'darwin',
    preferences: {},
    app: {
      getPath: () => '/Applications/CIBYP.app/Contents/MacOS/CIBYP',
      getName: () => 'CIBYP',
      isPackaged: true,
    },
    shell: { openExternal: async (url) => opened.push(url) },
    nativeStatus: () => state,
    nativeRequest: (kind) => requested.push(kind),
    getSettings: () => settings,
    persistSettings: async () => {},
  };
  return {
    options,
    requested,
    opened,
    setState: (value) => {
      state = value;
    },
    service: createComputerPermissions(options),
  };
}

test('permission polling and failed tool preflights never prompt or open settings', async () => {
  const fixture = permissionsFixture();
  for (let i = 0; i < 20; i++) {
    assert.equal(fixture.service.status().ready, false);
    assert.equal(fixture.service.check('input').code, 'accessibility_required');
    assert.equal(fixture.service.check('screen').code, 'screen_permission_required');
  }
  assert.equal(fixture.requested.length, 0);
  assert.equal(fixture.opened.length, 0);
  fixture.setState({ accessibility: true, postEvents: true, screen: true });
  assert.equal(fixture.service.status().ready, true);
  assert.equal(fixture.service.check('input'), null);
  assert.equal(fixture.service.check('screen'), null);
});

test('explicit requests are deduplicated across concurrent clicks and restarts; permissions are never cached', async () => {
  const fixture = permissionsFixture();
  await Promise.all([
    fixture.service.request('accessibility'),
    fixture.service.request('accessibility'),
  ]);
  assert.deepEqual(fixture.requested, ['accessibility']);
  const restarted = createComputerPermissions(fixture.options);
  assert.equal((await restarted.request('accessibility')).alreadyRequested, true);
  assert.equal(fixture.requested.length, 1);
  await restarted.openSettings('accessibility');
  assert.equal(fixture.opened.length, 1);
  fixture.setState({ accessibility: true, postEvents: false, screen: true });
  assert.equal(
    restarted.check('input').ok,
    false,
    'AX grant alone is insufficient for posting events',
  );
  assert.equal(restarted.check('tree'), null);
  assert.equal(restarted.check('screen'), null);
  fixture.setState({ accessibility: false, postEvents: false, screen: false });
  assert.equal(restarted.status().ready, false, 'revoked grant must take immediate effect');
});

test('coordinates use actual captured dimensions, Retina points and the correct secondary display origin', () => {
  const display = {
    bounds: { x: -1280, y: 50, width: 1280, height: 800 },
    physical: { x: -2560, y: 100, width: 2560, height: 1600 },
  };
  const capture = { display, width: 1280, height: 800 };
  assert.deepEqual(toDesktopPoint({ x: 640, y: 400 }, { platform: 'darwin', capture }), {
    x: -640,
    y: 450,
  });
  assert.deepEqual(toDesktopPoint({ x: 640, y: 400 }, { platform: 'win32', capture }), {
    x: -1280,
    y: 900,
  });
  assert.deepEqual(toDesktopPoint({ x: -80, y: 10 }, { platform: 'darwin', space: 'physical' }), {
    x: -80,
    y: 10,
  });
  assert.throws(() => toDesktopPoint({ x: NaN, y: 1 }, { platform: 'darwin', capture }), /finite/);
  assert.throws(() => toDesktopPoint({ x: 1280, y: 0 }, { platform: 'darwin', capture }), /exceed/);
});

test('native input adapter posts proper double-click counts, modifier flags and complete Unicode characters', async () => {
  const calls = [];
  const backend = createMacComputer({
    invoke(action, value) {
      calls.push({ action, ...JSON.parse(value) });
      return '{"ok":true}';
    },
  });
  await backend.mouse.doubleClick(0);
  assert.deepEqual(
    calls.map((c) => c.count),
    [1, 1, 2, 2],
  );
  calls.length = 0;
  await backend.keyboard.pressKey(backend.Key.LeftSuper, backend.Key.C);
  await backend.keyboard.releaseKey(backend.Key.C, backend.Key.LeftSuper);
  assert.deepEqual(
    calls.map((c) => c.flags),
    [1 << 20, 1 << 20, 1 << 20, 0],
  );
  calls.length = 0;
  const text = '校园🌸'.repeat(200);
  await backend.keyboard.type(text);
  assert.equal(calls.map((c) => c.text).join(''), text);
  for (const call of calls) assert.ok(!/[\uD800-\uDBFF]$/.test(call.text));
});

function ipcFixture() {
  const fixture = permissionsFixture();
  const handlers = new Map(),
    positions = [],
    buttons = [];
  let vmMode = false,
    failMove = false,
    nativeReads = 0;
  const native = createMacComputer({
    invoke(action, value) {
      const args = JSON.parse(value);
      if (action === 'permissions') {
        nativeReads++;
        return JSON.stringify({ ok: true, accessibility: true, postEvents: true, screen: true });
      }
      if (action === 'move') {
        if (failMove && positions.length >= failMove) throw new Error('injected move failure');
        positions.push(args);
      }
      if (action === 'button') buttons.push(args);
      return '{"ok":true}';
    },
  });
  const display = {
    id: 5,
    scaleFactor: 2,
    bounds: { x: 100, y: 0, width: 1000, height: 600 },
    size: { width: 1000, height: 600 },
  };
  const electron = {
    app: fixture.options.app,
    shell: fixture.options.shell,
    systemPreferences: {},
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
  };
  const source = fs.readFileSync('src/main/computer-use-service.js', 'utf8');
  const scope = {
    module: { exports: {} },
    process: { platform: 'darwin', versions: process.versions },
    console,
    setTimeout,
    require(name) {
      if (name === 'electron') return electron;
      if (name === './ocr') return {};
      if (name === './services/macos-computer') return { createMacComputer: () => native };
      if (name === './vm/tool-location') return { isVmOperation: () => vmMode };
      if (name.startsWith('./services/')) return require('../../src/main/' + name.slice(2));
      return require(name);
    },
  };
  vm.runInNewContext(source, scope);
  scope.module.exports({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getImagesDir: () => '.',
    getSettings: () => ({}),
    persistSettings: () => {},
    getVmService: () => ({
      graphicsController: () => ({ mouseMove: async () => ({ ok: true, location: 'vm' }) }),
    }),
  });
  return {
    call: (channel, ...args) => handlers.get(channel)({}, ...args),
    positions,
    buttons,
    setVm: (value) => {
      vmMode = value;
    },
    failMove: () => {
      failMove = positions.length + 1;
    },
    reads: () => nativeReads,
    opened: fixture.opened,
  };
}

test('all pointer IPC actions use the same screenshot mapping and release a failed drag', async () => {
  const fixture = ipcFixture();
  assert.equal((await fixture.call('computer:mouseMove', 800, 600)).ok, true);
  assert.deepEqual(fixture.positions[0], { x: 500, y: 300, drag: false });
  assert.equal((await fixture.call('computer:click', 'left', 800, 600, false)).ok, true);
  assert.equal(fixture.positions[1].x, 500);
  assert.equal((await fixture.call('computer:scroll', 800, 600, 'down', 3)).ok, true);
  assert.equal(fixture.positions[2].x, 500);
  assert.equal((await fixture.call('computer:key', 'cmd+made-up-key')).ok, false);
  fixture.failMove();
  const result = await fixture.call('computer:drag', 0, 0, 100, 100);
  assert.equal(result.ok, false);
  assert.equal(fixture.buttons.at(-1).down, false);
});

test('VM control and setup never inspect or request host permissions', async () => {
  const fixture = ipcFixture();
  fixture.setVm(true);
  assert.equal((await fixture.call('computer:permissions')).location, 'vm');
  assert.equal((await fixture.call('computer:mouseMove', 800, 600)).location, 'vm');
  assert.equal((await fixture.call('computer:requestPermission', 'accessibility')).ok, false);
  assert.equal((await fixture.call('computer:openPermissionSettings', 'screen')).ok, false);
  assert.equal(fixture.reads(), 0);
  assert.equal(fixture.opened.length, 0);
  assert.equal(fixture.positions.length, 0);
});

test(
  'macOS CI loads the actual Node-API module and silently reads system grants',
  { skip: process.platform !== 'darwin' },
  () => {
    const state = JSON.parse(loadMacBridge().invoke('permissions', '{}'));
    assert.equal(state.ok, true);
    assert.equal(typeof state.accessibility, 'boolean');
    assert.equal(typeof state.screen, 'boolean');
  },
);
