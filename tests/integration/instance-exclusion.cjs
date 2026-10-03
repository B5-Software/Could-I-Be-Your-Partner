/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real startup paths are rejected before VM boot and history crash recovery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { acquireInstanceLock } = require('../../src/main/core/instance-lock');
const root = path.resolve(__dirname, '../..');

function run(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: { ...process.env, ...env }, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Instance exclusion timeout: ' + output));
    }, 30000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-exclusion-'));
  let lease;
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
      }),
    );
    lease = await acquireInstanceLock(directory, 'GUI');
    const blockedTui = await run(process.execPath, [path.join(root, 'bin/cibyp-tui.js')], {
      CIBYP_USER_DATA: directory,
      CIBYP_DOCUMENTS: path.join(directory, 'documents'),
    });
    assert.equal(blockedTui.code, 0, blockedTui.output);
    assert.match(blockedTui.output, /GUI is already running/);
    assert.doesNotMatch(
      blockedTui.output,
      /agent runtime ready|Starting virtual machine|HTTP signal server started/,
    );
    await lease.release();
    lease = await acquireInstanceLock(directory, 'TUI');
    const entry = path.join(directory, 'gui.cjs');
    fs.writeFileSync(
      entry,
      `const {app,dialog}=require('electron');app.setPath('userData',${JSON.stringify(directory)});app.setPath('documents',${JSON.stringify(path.join(directory, 'documents'))});dialog.showErrorBox=()=>console.log('EXCLUSION_DIALOG');require(${JSON.stringify(path.join(root, 'src/main/main.js'))});`,
    );
    const blockedGui = await run(require('electron'), [entry], {});
    assert.equal(blockedGui.code, 0, blockedGui.output);
    assert.match(blockedGui.output, /TUI is already running/);
    assert.match(blockedGui.output, /EXCLUSION_DIALOG/);
    assert.doesNotMatch(
      blockedGui.output,
      /Main window shown|Starting virtual machine|HTTP signal server started/,
    );
    console.log(
      '[instance-exclusion] PASS: GUI/TUI startup blocked before VM, recovery and services',
    );
  } finally {
    await lease?.release();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('cibyp-exclusion-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
