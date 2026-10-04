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
  command.append('\n' + command.current.marker + ':0:' + command.current.marker + '_END\r\n');
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
  command.append(marker.slice(12) + ':127:' + marker + '_END\r\n');
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

test('ConPTY completion needs neither newline nor prompt boundaries and waits for a split exit code', async () => {
  let framed;
  const tracker = new TerminalCommand({ write: (text) => (framed = text) }, 'C:\\Windows\\cmd.exe');
  tracker.start('echo test');
  tracker.append(framed + 'testC:\\work>');
  assert.equal((await tracker.wait(1)).running, true, 'echoed framing cannot finish the command');
  const marker = tracker.current.marker;
  tracker.append(marker + ':1');
  assert.equal((await tracker.wait(1)).running, true, 'partial exit status cannot finish');
  tracker.append('27:' + marker + '_ENDC:\\work>');
  const result = await tracker.wait();
  assert.equal(result.running, false);
  assert.equal(result.exitCode, 127);
});

test('narrow ConPTY redraws preserve completion, exit status and unread output while titles are ignored', async () => {
  const tracker = new TerminalCommand({ write() {} }, 'cmd.exe');
  tracker.start('echo test');
  const marker = tracker.current.marker;
  const completed = marker + ':-127:' + marker + '_END';
  tracker.append('\x1b]0;echo ' + completed);
  assert.equal(
    (await tracker.wait(1)).running,
    true,
    'an incomplete title cannot finish a command',
  );
  tracker.append('\x07');
  const rows = completed.match(/.{1,7}/g);
  const redraw = rows.reduce(
    (text, row, index) =>
      text + (index ? '\x1b[?25h\r\n\x1b[19;20H' + rows[index - 1].at(-1) : '') + row,
    '',
  );
  tracker.append('final output\r\n' + redraw.slice(0, -4));
  assert.equal(tracker.current.running, true);
  tracker.append(redraw.slice(-4));
  const result = await tracker.wait();
  assert.equal(result.running, false);
  assert.equal(result.exitCode, -127);
  assert.match(result.output, /final output/);
  assert(!result.output.includes(marker));
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
