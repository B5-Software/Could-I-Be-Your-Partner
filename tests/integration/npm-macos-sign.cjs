/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { prepareMacRuntime } = require('../../packages/npm/lib/macos.cjs');

test(
  'local macOS signing repairs a real Electron bundle and runs its renderer',
  {
    skip: process.platform !== 'darwin',
    timeout: 180000,
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-sign-electron-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const electron = require('electron');
    const original = path.dirname(path.dirname(path.dirname(electron)));
    const app = path.join(root, 'Could I Be Your Partner.app');
    await fs.cp(original, app, { recursive: true, verbatimSymlinks: true });
    await fs.writeFile(
      path.join(app, 'Contents/Resources/cibyp-sign-test'),
      'invalidate old resource seal',
    );
    const asset = { executable: 'Could I Be Your Partner.app/Contents/MacOS/Electron' };
    await prepareMacRuntime(root, asset);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const entitlements = (
      await run('/usr/bin/codesign', ['--display', '--entitlements', ':-', app])
    ).stdout;
    assert.match(entitlements, /com.apple.security.cs.allow-jit/);
    assert.match(entitlements, /com.apple.security.cs.disable-library-validation/);
    const script = path.join(root, 'smoke.cjs');
    await fs.writeFile(
      script,
      `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
    const timeout = setTimeout(() => app.exit(1), 30000);
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false });
      await window.loadURL('data:text/html,<p>local signing</p>');
      const value = await window.webContents.executeJavaScript('Array.from({length:100}, (_,i)=>i).reduce((a,b)=>a+b,0)');
      if (value !== 4950) throw new Error('Renderer/JIT failed');
      window.destroy(); clearTimeout(timeout);
      console.log('CIBYP signed Electron renderer passed'); app.exit(0);
    }).catch(error => { console.error(error); app.exit(1); });
  `,
    );
    const result = await run(path.join(root, asset.executable), [script, '--disable-gpu'], {
      timeout: 60000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, /signed Electron renderer passed/);
    // A valid signature is never rewritten, preserving notarized releases too.
    await prepareMacRuntime(root, asset, {
      run: async (file, args, options) => {
        assert.ok(args.includes('--verify'));
        return run(file, args, options);
      },
    });
  },
);
