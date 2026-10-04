/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalCommand } = require('../../src/main/services/terminal-command');

test('prompt characters and echoed framing cannot end a command; polling keeps unread output', async () => {
  let framed;
  const command = new TerminalCommand({ write: (text) => (framed = text) }, 'bash (VM)');
  command.start('echo "price $10 > 5 # %"');
  command.append(framed + '\r\nprice $10 > 5 # %\r\n');
  const first = await command.wait(1);
  assert.equal(first.running, true);
  assert.match(first.output, /price/);
  assert.equal(command.start('second').ok, false);
  command.append('\n' + command.current.marker + ':0\r\n');
  assert.equal((await command.wait()).exitCode, 0);
});

test('split completion markers retain nonzero exit codes and do not kill a long process', async () => {
  const writes = [];
  const command = new TerminalCommand({ write: (text) => writes.push(text) }, 'bash');
  command.start('sleep 10; false');
  assert.equal(command.start('another').ok, false);
  command.append('first chunk\n');
  const first = await command.wait(1);
  assert.equal(first.running, true);
  assert.equal(first.output, 'first chunk\n');
  assert.equal(writes.length, 1);
  const marker = command.current.marker;
  const waiting = command.wait(1000);
  command.append('second chunk\n' + marker.slice(0, 12));
  command.append(marker.slice(12) + ':127\r\n');
  const result = await waiting;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 127);
  assert.equal(result.running, false);
  assert.equal(result.output, 'second chunk');
  assert.equal((await command.wait()).output, '');
  assert.equal(command.start('echo next'), null);
  command.end('closed');
  assert.equal((await command.wait()).error, 'closed');
});

test(
  'persistent shell runs real commands, keeps cwd/environment and reports exit status',
  { timeout: 30000 },
  async (t) => {
    const pty = require('node-pty');
    const windows = process.platform === 'win32';
    const shell = windows ? 'powershell.exe' : '/bin/bash';
    const term = pty.spawn(shell, windows ? ['-NoProfile', '-NoLogo'] : ['--noprofile', '--norc'], {
      cols: 160,
      rows: 24,
      env: { ...process.env, TERM: 'xterm' },
    });
    t.after(() => term.kill());
    const tracker = new TerminalCommand(term, shell);
    term.onData((data) => tracker.append(data));
    term.onExit(() => tracker.end());
    tracker.start(
      windows ? "$env:CIBYP_SHELL_TEST='persisted'" : 'export CIBYP_SHELL_TEST=persisted',
    );
    assert.equal((await tracker.wait(10000)).exitCode, 0);
    tracker.start(windows ? 'echo $env:CIBYP_SHELL_TEST' : 'echo "$CIBYP_SHELL_TEST"');
    assert.match((await tracker.wait(10000)).output, /persisted/);
    tracker.start(windows ? 'cmd /c exit 7' : 'false');
    const failure = await tracker.wait(10000);
    assert.equal(failure.exitCode, windows ? 7 : 1);
    assert.equal(failure.ok, false);
  },
);
