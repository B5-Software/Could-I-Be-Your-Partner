const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const {
  resolveHostShell,
  resolveVmShell,
  shellConfiguration,
} = require('../../src/main/core/terminal-shell');
const { VmSsh } = require('../../src/main/vm/vm-ssh');
const { VmFs } = require('../../src/main/vm/vm-fs');

test('host Shell uses custom executables, PATH and arguments without silently changing Shells', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-shell-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'custom shell.exe');
  fs.writeFileSync(file, 'test fixture');
  const settings = {
    terminal: { shell: 'custom', customShellPath: '"' + file + '"', args: ['/D', '/Q'] },
  };
  const resolved = resolveHostShell(settings, { platform: 'win32', env: { PATH: root } });
  assert.equal(resolved.file, file);
  assert.deepEqual(resolved.args, ['/D', '/Q']);
  settings.terminal.customShellPath = 'custom shell';
  assert.equal(resolveHostShell(settings, { platform: 'win32', env: { PATH: root } }).file, file);
  settings.terminal.customShellPath = root;
  assert.throws(() => resolveHostShell(settings, { platform: 'win32' }), /unavailable/);
  settings.terminal.customShellPath = path.join(root, 'missing.exe');
  assert.throws(() => resolveHostShell(settings), /unavailable/);
  settings.terminal.args = '-NoLogo';
  assert.throws(() => shellConfiguration(settings, 'host'), /JSON array/);
});

test('VM Shell is resolved in the guest with separate settings and safe PTY argument quoting', async () => {
  const executable = "/opt/student's shell/fish";
  const settings = {
    terminal: {
      shell: 'cmd',
      customShellPath: 'C:\\host.exe',
      vm: {
        shell: 'custom',
        customShellPath: executable,
        args: ['-i', 'one argument; echo unsafe'],
      },
    },
  };
  let started = 0;
  const service = {
    instance: null,
    async start() {
      started++;
      this.instance = {
        state: 'ready',
        exec: async (command) => {
          assert(command.includes("'/opt/student'\\''s shell/fish'"));
          assert(!command.includes('C:\\host.exe'));
          return { ok: true, stdout: executable + '\n' };
        },
      };
    },
  };
  const shell = await resolveVmShell(settings, service);
  assert.equal(started, 1);
  assert.equal(shell.file, executable);
  const ssh = new VmSsh();
  ssh.connected = true;
  ssh.client = {
    exec(command, options, callback) {
      assert.equal(
        command,
        "cd -- '/workspace/project' && exec '/opt/student'\\''s shell/fish' '-i' 'one argument; echo unsafe'",
      );
      assert.equal(options.pty.term, 'xterm-256color');
      callback(null, new EventEmitter());
    },
  };
  await ssh.shell({ cwd: '/workspace/project', shell: shell.file, args: shell.args });
  settings.terminal.vm.customShellPath = 'C:\\Windows\\cmd.exe';
  await assert.rejects(resolveVmShell(settings, service), /Linux VM/);
  settings.terminal.vm.shell = 'powershell';
  await assert.rejects(resolveVmShell(settings, service), /cannot run/);
  settings.terminal.vm = { shell: 'custom', customShellPath: '/bin/missing' };
  service.instance.exec = async () => ({ ok: false });
  await assert.rejects(resolveVmShell(settings, service), /unavailable/);
});

test('host choices do not leak into VM defaults', async () => {
  const settings = {
    terminal: { shell: 'custom', customShellPath: 'C:\\custom.exe', args: ['/Q'] },
  };
  const result = await resolveVmShell(settings, {
    instance: { state: 'ready', exec: async () => ({ ok: true, stdout: '/bin/bash\n' }) },
  });
  assert.deepEqual(result, { file: '/bin/bash', args: ['-l'], location: 'vm' });
  await assert.rejects(resolveVmShell({}, { start: async () => {} }), /not ready/);
});

test('VM executable picker treats root and host-colliding POSIX paths as guest paths', () => {
  const io = new VmFs({ vmService: { workspaceRoot: os.homedir() }, guestPaths: true });
  for (const file of ['/', '/usr/bin/bash', '/home/student/bin/fish']) {
    assert.equal(io.resolveVmPath(file).vm, file);
  }
  assert.equal(io.resolveVmPath('C:\\Windows\\cmd.exe').ok, false);
  assert.equal(io.resolveVmPath('relative-shell').ok, false);
  assert.equal(io.resolveVmPath('//host/share/shell').ok, false);
});
