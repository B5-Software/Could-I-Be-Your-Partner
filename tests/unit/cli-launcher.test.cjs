const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { hasGraphicalEnvironment } = require('../../src/main/core/graphical-environment');
const { launch } = require('../../src/tui/launcher');

test('desktop detection checks live X11, authentication, macOS sessions and Windows desktops', async () => {
  const seen = [];
  const run = async (file, args) => seen.push([file, args]);
  assert.equal(
    await hasGraphicalEnvironment({
      platform: 'linux',
      env: {},
      connect: () => assert.fail('No display to probe'),
    }),
    false,
  );
  assert.equal(
    await hasGraphicalEnvironment({
      platform: 'linux',
      env: { DISPLAY: ':7' },
      connect: async (socket) => {
        assert.equal(socket, '/tmp/.X11-unix/X7');
        return true;
      },
      run,
    }),
    true,
  );
  assert.equal(
    await hasGraphicalEnvironment({
      platform: 'linux',
      env: { DISPLAY: 'localhost:10.0' },
      connect: async (address) => {
        assert.deepEqual(address, { host: 'localhost', port: 6010 });
        return false;
      },
      run,
    }),
    false,
  );
  assert.equal(
    await hasGraphicalEnvironment({
      platform: 'linux',
      env: { DISPLAY: ':7' },
      connect: async () => true,
      run: async () => {
        throw new Error('Invalid MIT-MAGIC-COOKIE');
      },
    }),
    false,
  );
  assert.equal(
    await hasGraphicalEnvironment({ platform: 'darwin', env: {}, run, uid: () => 501 }),
    true,
  );
  assert.deepEqual(seen.at(-1), ['/bin/launchctl', ['print', 'gui/501']]);
  assert.equal(
    await hasGraphicalEnvironment({
      platform: 'darwin',
      env: {},
      uid: () => 501,
      run: async () => {
        throw new Error('No domain');
      },
    }),
    false,
  );
  assert.equal(
    await hasGraphicalEnvironment({
      platform: 'win32',
      env: { SSH_CONNECTION: 'remote' },
      run: () => assert.fail('SSH must use TUI'),
    }),
    false,
  );
  assert.equal(await hasGraphicalEnvironment({ platform: 'win32', env: {}, run }), true);
  assert.match(seen.at(-1)[1].at(-1), /OpenInputDesktop/);
  assert.equal(
    await hasGraphicalEnvironment({
      platform: 'win32',
      env: {},
      run: async () => {
        throw new Error('No input desktop');
      },
    }),
    false,
  );
});

test('GUI command launches the installed executable and forwards paths with spaces literally', async (t) => {
  const previous = { ...process.env };
  const resourcesPath = process.resourcesPath;
  t.after(() => {
    process.env = previous;
    process.resourcesPath = resourcesPath;
  });
  let call;
  await launch('gui', ['--workspace=C:\\a folder'], {
    resources: path.resolve('fixture/resources'),
    executable: 'app executable',
    graphical: async () => true,
    spawnProcess: (file, args, options) => {
      call = { file, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(call.file, 'app executable');
  assert.deepEqual(call.args, ['--workspace=C:\\a folder']);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('both command entry points report a clean version without starting the App', () => {
  for (const entry of ['cibyp.js', 'cibyp-tui.js']) {
    const result = cp.spawnSync(process.execPath, [path.resolve('bin', entry), '--version'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), require('../../package.json').version.split('+')[0]);
  }
});

test('no graphical environment routes the GUI command to TUI; the TUI command always stays in TUI', async () => {
  let starts = 0;
  const options = {
    startTui: (args) => {
      assert.deepEqual(args, ['--mode=code']);
      starts++;
    },
    spawnProcess: () => assert.fail('A headless command must not start Electron'),
  };
  await launch('gui', ['--mode=code'], { ...options, graphical: async () => false });
  await launch('tui', ['--mode=code'], {
    ...options,
    graphical: () => assert.fail('TUI never probes a desktop'),
  });
  assert.equal(starts, 2);
});

test(
  'Windows PATH installer preserves other entries, variable expansion and idempotent uninstall',
  { skip: process.platform !== 'win32' },
  () => {
    const script = `$ErrorActionPreference='Stop'; . './build/cli/path-management.ps1'; $original='%SystemRoot%\\System32;C:\\Other;'; $installed=Update-CibypPathValue $original 'C:\\CIBYP\\resources\\cli' $false; $twice=Update-CibypPathValue $installed 'C:\\CIBYP\\resources\\cli' $false; $removed=Update-CibypPathValue $twice 'C:\\CIBYP\\resources\\cli' $true; @{original=$original;installed=$installed;twice=$twice;removed=$removed}|ConvertTo-Json -Compress`;
    const result = cp.spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    const values = JSON.parse(result.stdout.trim());
    assert.equal(values.removed, values.original);
    assert.equal(values.installed, values.twice);
    assert.equal(values.installed, values.original + ';C:\\CIBYP\\resources\\cli');
  },
);

test(
  'macOS installer registers both commands and preserves an existing unrelated command',
  { skip: process.platform === 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-pkg-'));
    const bash =
      process.platform === 'win32'
        ? path.resolve(
            cp.execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
            '../../../bin/bash.exe',
          )
        : '/bin/bash';
    const invoke = () =>
      cp.spawnSync(
        bash,
        ['build/installers/pkg-scripts/postinstall', 'package', '/', root.replaceAll('\\', '/')],
        { encoding: 'utf8', windowsHide: true },
      );
    try {
      assert.equal(invoke().status, 0);
      for (const command of ['cibyp', 'cibyp-tui'])
        assert.equal(
          fs.readlinkSync(path.join(root, 'usr/local/bin', command)).replaceAll('\\', '/'),
          `${root.replaceAll('\\', '/')}/Applications/Could I Be Your Partner.app/Contents/Resources/cli/${command}`,
        );
      assert.equal(invoke().status, 0, 'Reinstall is idempotent');
      fs.unlinkSync(path.join(root, 'usr/local/bin/cibyp'));
      fs.writeFileSync(path.join(root, 'usr/local/bin/cibyp'), 'other command');
      assert.equal(invoke().status, 1);
      assert.equal(
        fs.readFileSync(path.join(root, 'usr/local/bin/cibyp'), 'utf8'),
        'other command',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
