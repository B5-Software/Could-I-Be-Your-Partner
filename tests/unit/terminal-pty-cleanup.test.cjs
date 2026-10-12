/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

for (const useConptyDll of [false, true]) {
  for (const naturalExit of [false, true]) {
    test(
      `Windows ConPTY releases its process after ${naturalExit ? 'natural exit' : 'kill'} (DLL=${useConptyDll})`,
      { skip: process.platform !== 'win32', timeout: 20000 },
      async () => {
        const source = `
          const pty = require('node-pty');
          const { releaseExitedPty } = require(${JSON.stringify(require.resolve('../../src/main/core/terminal-pty-cleanup'))});
          const options = { cols: 80, rows: 24, env: process.env, useConpty: true, useConptyDll: ${useConptyDll} };
          let terminal;
          try { terminal = pty.spawn('cmd.exe', ['/q'], options); }
          catch (error) {
            if (!/conpty\\.dll|OpenConsole/i.test(error.message)) throw error;
            terminal = pty.spawn('cmd.exe', ['/q'], { ...options, useConptyDll: false });
          }
          let ready = false;
          terminal.onData(text => {
            if (ready || !text.includes('cibyp-cleanup-ready')) return;
            ready = true;
            ${naturalExit ? "terminal.write('exit\\r');" : 'terminal.kill();'}
          });
          terminal.onExit(() => {
            releaseExitedPty(terminal);
            releaseExitedPty(terminal);
            console.log('cibyp-cleanup-exited');
          });
          terminal.write('echo cibyp-cleanup-ready\\r');
        `;
        // Await the real OS process close, not just the PTY's onExit event.
        // A leaked pipe/worker keeps this child alive and fails the deadline.
        const result = await promisify(execFile)(process.execPath, ['-e', source], {
          cwd: require('node:path').resolve(__dirname, '../..'),
          timeout: 15000,
          windowsHide: true,
        });
        assert.match(result.stdout, /cibyp-cleanup-exited/);
      },
    );
  }
}
