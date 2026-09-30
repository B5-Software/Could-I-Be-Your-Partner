const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createJsonStore } = require('../../src/main/core/json-store');
const { createChannelSubscriptions } = require('../../src/preload/channel-subscriptions');
const { createIpcRouter } = require('../../src/main/core/ipc-router');
const { createWindowSecurity } = require('../../src/main/core/window-security');
const { calculateTokenCost } = require('../../src/shared/generated/pricing.cjs');
const {
  validateManifest,
  assembleLegacy,
  compareParts,
} = require('../../scripts/lib/renderer-parts.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('JSON commit failure preserves the previous file and removes temporary files', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"valid":true}');
  const store = createJsonStore({
    ...fs,
    renameSync: () => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    },
  });
  assert.throws(() => store.saveJSON(file, { valid: false }), /locked/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { valid: true });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('JSON supports compact writes, missing parents and corrupt-file fallbacks', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'nested/settings.json');
  const store = createJsonStore();
  store.saveJSON(file, { text: '中文' }, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"text":"中文"}');
  assert.throws(() => store.saveJSON(file, undefined), TypeError);
  assert.deepEqual(store.loadJSON(file, null), { text: '中文' });
  fs.writeFileSync(file, '{');
  assert.deepEqual(store.loadJSON(file, { fallback: true }), {
    fallback: true,
  });
});

test('equal callbacks have independent subscriptions and old disposers cannot remove a new listener', () => {
  const ipc = new EventEmitter();
  const events = createChannelSubscriptions(ipc);
  const seen = [];
  const callback = (...args) => seen.push(args);
  const a = events.subscribe('event', callback);
  const b = events.subscribe('event', callback);
  assert.equal(ipc.listenerCount('event'), 1);
  ipc.emit('event', { secret: true }, 1, 2);
  assert.deepEqual(seen, [
    [1, 2],
    [1, 2],
  ]);
  a();
  b();
  const c = events.subscribe('event', callback);
  a();
  b();
  assert.equal(ipc.listenerCount('event'), 1);
  c();
  assert.equal(ipc.listenerCount('event'), 0);
});

test('subscriptions added during dispatch start on the next notification; dispose removes all listeners', () => {
  const ipc = new EventEmitter();
  const events = createChannelSubscriptions(ipc);
  const seen = [];
  let added = false;
  events.subscribe('event', () => {
    seen.push('first');
    if (!added) {
      added = true;
      events.subscribe('event', () => seen.push('second'));
    }
  });
  ipc.emit('event', {}, 'payload');
  assert.deepEqual(seen, ['first']);
  ipc.emit('event', {});
  assert.deepEqual(seen, ['first', 'first', 'second']);
  events.dispose();
  assert.equal(ipc.listenerCount('event'), 0);
});

test('IPC rejects untrusted calls and events before routing, without replacing native methods', () => {
  const native = new EventEmitter();
  const handlers = new Map();
  native.handle = (channel, handler) => handlers.set(channel, handler);
  native.removeHandler = (channel) => handlers.delete(channel);
  const originalHandle = native.handle;
  let calls = 0;
  const router = createIpcRouter(native, {
    validateSender: (event) => event.trusted === true,
    routeHandler:
      (_channel, handler) =>
      (event, ...args) =>
        `routed:${handler(event, ...args)}`,
  });
  const handler = (_event, value) => {
    calls++;
    return value;
  };
  router.handle('read', handler);
  assert.throws(() => handlers.get('read')({ trusted: false }, 'secret'), /Untrusted/);
  assert.equal(calls, 0);
  assert.equal(handlers.get('read')({ trusted: true }, 'ok'), 'routed:ok');
  assert.equal(router.originalHandlers.get('read'), handler);
  assert.equal(native.handle, originalHandle);
  router.once('event', handler);
  native.emit('event', { trusted: false }, 'bad');
  assert.equal(calls, 1);
  native.emit('event', { trusted: true }, 'ok');
  native.emit('event', { trusted: true }, 'again');
  assert.equal(calls, 2);
});

test('only registered local top-level pages can use privileged IPC', () => {
  const dir = path.resolve('src/renderer/pages');
  const security = createWindowSecurity({
    pagesDirectory: dir,
    pageNames: ['index.html'],
    preloadDirectory: path.resolve('src/preload/generated'),
  });
  const url = pathToFileURL(path.join(dir, 'index.html')).href;
  const frame = { url: url + '?mode=test#chat' };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  assert.equal(security.validateSender({ sender, senderFrame: frame }), true);
  assert.equal(security.validateSender({ sender, senderFrame: { ...frame } }), false);
  assert.equal(security.isTrustedUrl(pathToFileURL(path.join(dir, '../other.html')).href), false);
  assert.equal(security.isTrustedUrl('https://example.com/index.html'), false);
  assert.equal(security.validateSender({}), false);
});

test('window policy blocks navigation, popups and webviews for app preloads', () => {
  const preloadDirectory = path.resolve('src/preload/generated');
  const security = createWindowSecurity({
    pagesDirectory: path.resolve('src/renderer/pages'),
    pageNames: ['index.html'],
    preloadDirectory,
  });
  const contents = new EventEmitter();
  contents.getLastWebPreferences = () => ({
    preload: path.join(preloadDirectory, 'preload.js'),
  });
  contents.setWindowOpenHandler = (handler) => {
    contents.openHandler = handler;
  };
  security.protectWebContents(contents);
  assert.deepEqual(contents.openHandler({ url: 'https://example.com' }), {
    action: 'deny',
  });
  let prevented = 0;
  contents.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://example.com');
  contents.emit('will-attach-webview', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
});

test('pricing uses the budget timezone and handles overnight peak periods', () => {
  const cost = calculateTokenCost(
    { prompt: 1000000, completion: 1000000 },
    { inputPerM: 2, outputPerM: 4 },
    { enabled: true, start: 22, end: 6, inputMul: 0.5, outputMul: 0.5 },
    '2026-09-30T15:00:00Z',
    'Asia/Shanghai',
  );
  assert.equal(cost.isPeak, true);
  assert.equal(cost.totalCost, 3);
});

test('pricing respects explicit zero prices and multipliers, legacy rates and invalid numbers', () => {
  const usage = { prompt: 1000000, completion: 1000000 };
  assert.equal(
    calculateTokenCost(usage, { inputPerM: 0, promptPerK: 2, outputPerM: 0 }).totalCost,
    0,
  );
  assert.equal(
    calculateTokenCost(usage, { promptPerK: 0.002, completionPerK: 0.004 }).totalCost,
    6,
  );
  assert.equal(calculateTokenCost(usage, { inputPerM: Infinity, outputPerM: 'bad' }).totalCost, 0);
  assert.equal(
    calculateTokenCost(usage, { inputPerM: 2 }, { enabled: true, inputMul: 0 }).totalCost,
    0,
  );
});

test('pricing separates input, cache-read, cache-write and output costs', () => {
  const cost = calculateTokenCost(
    {
      prompt: 1000000,
      cached: 200000,
      cacheCreation: 100000,
      completion: 500000,
    },
    {
      inputPerM: 2,
      cacheReadPerM: 0.2,
      cacheWritePerM: 2.5,
      outputPerM: 4,
      hasCacheWrite: true,
    },
  );
  assert.equal(cost.inputCost, 1.4);
  assert.ok(Math.abs(cost.cacheReadCost - 0.04) < 1e-12);
  assert.equal(cost.cacheWriteCost, 0.25);
  assert.equal(cost.outputCost, 2);
});

test('renderer manifest rejects unlisted, duplicate and missing parts', (t) => {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, '01-first.js'), '');
  fs.writeFileSync(path.join(dir, '02-second.js'), '');
  assert.throws(() => validateManifest(dir, ['01-first.js']), /Unlisted/);
  assert.throws(() => validateManifest(dir, ['01-first.js', '01-first.js']), /Duplicate/);
  assert.throws(() => validateManifest(dir, ['../outside.js']), /Missing/);
  assert.deepEqual(['10-last.js', '2-first.js'].sort(compareParts), ['2-first.js', '10-last.js']);
});

test('renderer compatibility assembly preserves template whitespace and maps every source', (t) => {
  const dir = temporary(t);
  const source = 'const text = `one\n\n\nthree`;';
  fs.writeFileSync(path.join(dir, '01-part.js'), source);
  const code = assembleLegacy(dir, ['01-part.js'], 'const appReady = (async () => {');
  assert.ok(code.includes(source));
  const map = JSON.parse(Buffer.from(code.split('base64,')[1].trim(), 'base64'));
  assert.deepEqual(map.sourcesContent, [source]);
  assert.deepEqual(map.sources, ['app-parts/01-part.js']);
});

test('authenticated WebUI upload retains message type and file MIME type in its response', async (t) => {
  const { WebControlService } = require('../../src/main/web-control-service');
  const service = new WebControlService();
  service.workDir = temporary(t);
  const replies = [];
  const ws = {
    _authenticated: true,
    send: (data) => replies.push(JSON.parse(data)),
  };
  await service._handleWsMessage(ws, {
    type: 'uploadAttachment',
    name: 'test.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello').toString('base64'),
  });
  assert.equal(replies[0].type, 'uploadResult');
  assert.equal(replies[0].mimeType, 'text/plain');
  assert.equal(replies[0].ok, true);
  assert.equal(fs.readFileSync(replies[0].path, 'utf8'), 'hello');
});
