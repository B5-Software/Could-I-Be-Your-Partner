const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { VmService } = require('../../src/main/vm/vm-service');
const { VmPtyAdapter } = require('../../src/main/vm/vm-pty');
const { VmSsh } = require('../../src/main/vm/vm-ssh');
const { WorkspaceSync } = require('../../src/main/vm/vm-workspace');

function service(t, mode = 'shared') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-terminal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vm = new VmService({
    app: { getPath: () => root },
    getSettings: () => ({ runtime: { workspaceMode: mode, vm: { workspaceRoot: root } } }),
  });
  vm.instance = { state: 'ready', dir: root, exec: async () => ({ ok: true }) };
  return { vm, root };
}

test('terminal prepares even an empty session directory after synchronization completes', async (t) => {
  const { vm, root } = service(t);
  const folder = path.join(root, "empty student's folder");
  fs.mkdirSync(folder);
  const order = [];
  t.mock.method(vm, 'syncWorkspace', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push('synchronized');
    return { ok: true };
  });
  t.mock.method(vm.instance, 'exec', async (command) => {
    order.push('prepared');
    assert.match(command, /mkdir -p --/);
    assert.match(command, /test -d/);
    assert.ok(command.includes("student'\\''s"));
    return { ok: true };
  });
  assert.equal(await vm.prepareTerminalDirectory(folder), "/workspace/empty student's folder");
  assert.deepEqual(order, ['synchronized', 'prepared']);
});

test('terminal preparation stops on sync failure instead of opening a fallback directory', async (t) => {
  const { vm, root } = service(t);
  t.mock.method(vm, 'syncWorkspace', async () => ({ ok: false, error: 'transfer failed' }));
  const exec = t.mock.method(vm.instance, 'exec');
  await assert.rejects(vm.prepareTerminalDirectory(root), /transfer failed/);
  assert.equal(exec.mock.callCount(), 0);
});

test('extra session roots synchronize their own directory with a separate baseline', async (t) => {
  const { vm, root } = service(t);
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-extra-'));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const folder = path.join(extra, 'session');
  fs.mkdirSync(folder);
  vm.addHostRoot(extra);
  const mapped = new (require('../../src/main/vm/vm-fs').VmFs)({ vmService: vm }).mapHostToVm(
    extra,
  );
  assert.match(mapped, /^\/workspace\/_external\/_root-[a-f0-9]+$/);
  t.mock.method(vm, 'syncWorkspace', () => {
    throw new Error('wrong root');
  });
  const synchronize = t.mock.method(WorkspaceSync.prototype, 'sync', async function () {
    assert.equal(this.hostRoot, extra);
    assert.equal(this.vmMount, mapped);
    assert.ok(this.baselineFile.startsWith(path.join(root, 'workspace-pairs')));
    return { ok: true };
  });
  assert.equal(await vm.prepareTerminalDirectory(folder), mapped + '/session');
  assert.equal(vm.toHostPath(mapped + '/session'), folder);
  assert.equal(synchronize.mock.callCount(), 1);
});

test('isolated terminals validate guest directories without creating arbitrary system paths', async (t) => {
  const { vm } = service(t, 'isolated');
  t.mock.method(vm.instance, 'exec', async (command) => {
    assert.ok(!command.includes('mkdir'));
    return { ok: false, stderr: 'no such directory' };
  });
  await assert.rejects(vm.prepareTerminalDirectory('/home/cibyp/missing'), /no such directory/);
});

test('script and MCP working directories cannot automatically import an unmapped host directory', async (t) => {
  const { vm } = service(t, 'isolated');
  const outside = 'C:/unmapped-private-directory';
  const exists = fs.existsSync;
  const stat = fs.statSync;
  t.mock.method(fs, 'existsSync', (value) => value === outside || exists(value));
  t.mock.method(fs, 'statSync', (value) =>
    value === outside ? { isDirectory: () => true } : stat(value),
  );
  const mount = t.mock.method(vm, 'mountExternalDir', async () => {
    throw new Error('Host import must not run');
  });
  const exec = t.mock.method(vm.instance, 'exec');
  await assert.rejects(vm.prepareTerminalDirectory(outside), /映射范围/);
  assert.equal(mount.mock.callCount(), 0);
  assert.equal(exec.mock.callCount(), 0);
});

test('workspace scans quote shell metacharacters in directory names literally', async (t) => {
  const { vm, root } = service(t);
  const mount = "/workspace/student's $(literal) `notes`";
  const sync = new WorkspaceSync({ vmService: vm, hostRoot: root, vmMount: mount });
  t.mock.method(vm.instance, 'exec', async (command) => {
    assert.ok(command.startsWith('node -e '));
    assert.ok(command.includes("student'\\''s $(literal) `notes`"));
    return { ok: true, stdout: '{}' };
  });
  assert.deepEqual(await sync.scanVm(), {});
});

test('VM PTY uses the service instance after start and flushes only user input', async () => {
  let open;
  const writes = [];
  const channel = {
    write: (value) => writes.push(value),
    resize: () => {},
    close: () => {},
    onData: () => {},
    onClose: () => {},
  };
  const vm = {
    instance: null,
    start: async () => {
      vm.instance = {
        state: 'ready',
        shell: (options) => {
          assert.equal(options.cwd, '/workspace/session');
          return new Promise((resolve) => {
            open = resolve;
          });
        },
      };
      return { state: 'ready' }; // start returns status, not the instance.
    },
  };
  const pty = new VmPtyAdapter({ vmService: vm, cwd: '/workspace/session' });
  pty.write('pwd\r');
  await new Promise((resolve) => setImmediate(resolve));
  open(channel);
  await pty.ready();
  assert.deepEqual(writes, ['pwd\r']);
});

test('killing a pending VM terminal emits exit once and closes a later channel', async () => {
  let resolve;
  let closed = 0;
  const pty = new VmPtyAdapter({
    vmService: {
      instance: {
        state: 'ready',
        shell: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    },
  });
  const exits = [];
  pty.onExit((value) => exits.push(value));
  pty.kill();
  pty.kill();
  resolve({
    close: () => {
      closed += 1;
    },
  });
  await pty.ready();
  assert.equal(closed, 1);
  assert.deepEqual(exits, [{ exitCode: 0 }]);
});

test('SSH shell enters a quoted cwd before starting bash with a true PTY', async () => {
  const ssh = new VmSsh();
  ssh.connected = true;
  const stream = new EventEmitter();
  ssh.client = {
    exec: (command, options, callback) => {
      assert.equal(command, "cd -- '/workspace/student'\\''s folder' && exec bash -l");
      assert.deepEqual(options.pty, { term: 'xterm-256color', cols: 80, rows: 24 });
      assert.ok(!command.includes('||'));
      callback(null, stream);
    },
  };
  const result = await ssh.shell({ cwd: "/workspace/student's folder", cols: 80, rows: 24 });
  assert.equal(result.stream, stream);
});

test('VM terminal decodes Chinese characters split across SSH packets', async () => {
  let onData;
  let onClose;
  const pty = new VmPtyAdapter({
    vmService: {
      instance: {
        state: 'ready',
        shell: async () => ({
          onData: (callback) => {
            onData = callback;
          },
          onClose: (callback) => {
            onClose = callback;
          },
          write() {},
          close() {},
        }),
      },
    },
  });
  const output = [];
  pty.onData((value) => output.push(value));
  await pty.ready();
  const bytes = Buffer.from('校园终端');
  for (const byte of bytes) onData(Buffer.from([byte]));
  onClose();
  assert.equal(output.join(''), '校园终端');
});

test('SSH exec decodes split UTF-8 and rejects oversized output instead of silently truncating', async () => {
  const { EventEmitter } = require('node:events');
  const { VmSsh } = require('../../src/main/vm/vm-ssh');
  const ssh = new VmSsh({});
  ssh.connected = true;
  let stream;
  ssh.client = {
    exec(_command, _options, callback) {
      stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => stream.emit('close', 0);
      callback(null, stream);
    },
  };
  const result = ssh.exec('unicode');
  for (const byte of Buffer.from('校园文件')) stream.emit('data', Buffer.from([byte]));
  stream.emit('close', 0);
  assert.equal((await result).stdout, '校园文件');
  const oversized = ssh.exec('too much', { maxBuffer: 2 });
  stream.emit('data', Buffer.from('excess'));
  await assert.rejects(oversized, { code: 'VM_OUTPUT_LIMIT' });
});
