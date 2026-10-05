/* SPDX-License-Identifier: GPL-3.0-or-later */
// Multiple launchers attach to one owner; a Node owner also accepts a GUI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fileFor } = require('../../src/main/core/backend-discovery');
const root = path.resolve(__dirname, '../..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-owner-'));
  const processes = [];
  let client;
  try {
    fs.mkdirSync(path.join(directory, 'data'));
    fs.mkdirSync(path.join(directory, 'documents'));
    fs.writeFileSync(
      path.join(directory, 'data/settings.json'),
      JSON.stringify({
        onboardingCompleted: true,
        runtime: { location: 'host' },
        updates: { autoCheckEnabled: false },
        voice: { wakeEnabled: false },
        notifications: { enabled: false },
        trayEnabled: false,
      }),
    );
    const env = {
      ...process.env,
      CIBYP_USER_DATA: directory,
      CIBYP_DOCUMENTS: path.join(directory, 'documents'),
      CIBYP_NO_GUI: '1',
      CIBYP_ELECTRON_EXECUTABLE: path.join(directory, 'unavailable-desktop-executable'),
    };
    const script =
      'require(' +
      JSON.stringify(path.join(root, 'src/tui/backend-connect')) +
      ").ensureBackend().then(async c=>{console.log('OWNER='+ (await c.request('snapshot')).pid);c.close()}).catch(e=>{console.error(e);process.exitCode=1})";
    const launch = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], { env, windowsHide: true });
        processes.push(child);
        let output = '';
        child.stdout.on('data', (bytes) => (output += bytes));
        child.stderr.on('data', (bytes) => (output += bytes));
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(output));
        }, 90000);
        child.once('error', reject);
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code) reject(new Error(output));
          else resolve(Number(/OWNER=(\d+)/.exec(output)?.[1]));
        });
      });
    const pids = await Promise.all([launch(), launch()]);
    assert.ok(pids[0]);
    assert.equal(pids[0], pids[1], 'Concurrent launches share an owner');
    const address = require('../../src/main/core/backend-discovery').readBackend(directory);
    assert.equal(address.native, false);
    client = require('../../src/tui/backend-connect').clientFor(address);
    const session = await client.request('createSession', { mode: 'chat' });
    const guiEntry = path.join(directory, 'gui.cjs');
    fs.writeFileSync(
      guiEntry,
      `const {app,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(directory)});ipcMain.on('app:renderer-ready',()=>{console.log('GUI_READY');setTimeout(()=>app.quit(),200)});require(${JSON.stringify(path.join(root, 'src/main/main'))});`,
    );
    const gui = spawn(require('electron'), [guiEntry], {
      env: { ...env, CIBYP_NO_GUI: '' },
      windowsHide: true,
    });
    processes.push(gui);
    let output = '';
    gui.stdout.on('data', (bytes) => (output += bytes));
    gui.stderr.on('data', (bytes) => (output += bytes));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        gui.kill();
        reject(new Error(output));
      }, 30000);
      gui.once('exit', (code) => {
        clearTimeout(timer);
        code ? reject(new Error(output)) : resolve();
      });
      gui.once('error', reject);
    });
    assert.match(output, /GUI_READY/);
    assert.equal(
      (await client.request('snapshot')).pid,
      pids[0],
      'Closing the GUI preserves the owner',
    );
    assert.equal((await client.request('getSession', session.key)).key, session.key);
    console.log('[shared-owner] Concurrent launches and Node owner + GUI attachment passed.');
  } finally {
    client?.close();
    const address = require('../../src/main/core/backend-discovery').readBackend(directory);
    if (address) {
      try {
        process.kill(address.pid);
      } catch {}
    }
    for (const child of processes) {
      if (child.exitCode === null) child.kill();
    }
    await pause(300);
    fs.rmSync(fileFor(directory), { force: true });
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-owner-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
