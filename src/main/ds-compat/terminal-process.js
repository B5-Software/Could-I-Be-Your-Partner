/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const { shellQuote } = require('../vm/vm-paths');
function stat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return {
      pid: Number(pid),
      state: fields[0],
      pgrp: Number(fields[2]),
      session: Number(fields[3]),
      tty: fields[4],
      foreground: Number(fields[5]),
      started: fields[19],
    };
  } catch {
    return undefined;
  }
}
function members(session) {
  return fs
    .readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(stat)
    .filter((entry) => entry?.session === session && !['Z', 'X'].includes(entry.state));
}
function foreground(pid) {
  // Like the upstream Windows provider, a shell PID is a logical console group;
  // Windows provides no POSIX foreground process group or stdin-wait evidence.
  if (process.platform === 'win32') return { processGroupId: pid, inputWaiting: false };
  if (process.platform === 'darwin') {
    try {
      const pgid = Number(
        cp
          .execFileSync('/bin/ps', ['-o', 'tpgid=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 1000,
          })
          .trim(),
      );
      return pgid > 0 ? { processGroupId: pgid, inputWaiting: false } : undefined;
    } catch {
      return undefined;
    }
  }
  const shell = stat(pid);
  if (!shell || shell.foreground <= 0) return undefined;
  const waiting = members(shell.session).some((entry) => {
    if (entry.pgrp !== shell.foreground || entry.tty !== shell.tty) return false;
    try {
      return /(?:n_tty_read|tty_read)/.test(fs.readFileSync(`/proc/${entry.pid}/wchan`, 'utf8'));
    } catch {
      return false;
    }
  });
  return { processGroupId: shell.foreground, inputWaiting: waiting };
}
async function spawnScriptTerminal(spec, live) {
  spec.signal?.throwIfAborted();
  const child = cp.spawn(
    'script',
    ['-q', '-f', '-e', '-c', 'exec ' + spec.argv.map(shellQuote).join(' '), '/dev/null'],
    {
      cwd: spec.cwd,
      env: { ...spec.env, TERM: spec.terminalType },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let ended = false,
    revision = 0,
    cleanup,
    resolveDone,
    rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  child.on('error', rejectDone);
  child.on('close', (exitCode, signal) => {
    ended = true;
    resolveDone({ exitCode, signal });
  });
  child.stderr.resume();
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') rejectDone(error);
  });
  let pid, shell;
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline && !ended) {
      spec.signal?.throwIfAborted();
      try {
        pid = Number(
          fs
            .readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')
            .trim()
            .split(' ')[0],
        );
        shell = stat(pid);
        if (shell && shell.tty !== '0') break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!shell || shell.tty === '0') throw new Error('Linux script did not allocate a PTY');
  } catch (error) {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    child.stdout.destroy();
    throw error;
  }
  const tracked = new Map();
  const observe = () => {
    if (stat(pid)?.started === shell.started)
      for (const entry of members(shell.session)) tracked.set(entry.pid, entry);
    return [...tracked.values()].filter(
      (entry) =>
        stat(entry.pid)?.started === entry.started && !['Z', 'X'].includes(stat(entry.pid)?.state),
    );
  };
  const signalMembers = (signal) => {
    // Fence PID reuse. Only signal members of this owned terminal session.
    for (const entry of observe())
      if (stat(entry.pid)?.started === entry.started) {
        try {
          process.kill(entry.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
  };
  const handle = {
    pid,
    output: child.stdout,
    done,
    async write(text) {
      if (ended) throw new Error('Terminal exited');
      revision++;
      await new Promise((resolve, reject) =>
        child.stdin.write(text, (error) => (error ? reject(error) : resolve())),
      );
    },
    async resize(cols, rows) {
      if (!Number.isSafeInteger(cols) || cols < 1 || !Number.isSafeInteger(rows) || rows < 1)
        throw new Error('Invalid terminal size');
      await new Promise((resolve, reject) =>
        cp.execFile(
          'stty',
          ['-F', `/proc/${pid}/fd/0`, 'cols', String(cols), 'rows', String(rows)],
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    },
    async inspectForeground() {
      observe();
      return ended ? undefined : foreground(pid);
    },
    async inspectActivity() {
      const group = foreground(pid);
      return {
        state:
          ended && !observe().length
            ? 'idle'
            : group?.processGroupId !== pid && group
              ? 'busy'
              : 'unknown',
        revision,
      };
    },
    async signalForeground(signal) {
      const group = foreground(pid);
      if (!group) throw new Error('Cannot identify foreground process group');
      if (signal === 'SIGKILL' && group.processGroupId === pid)
        throw new Error('Use terminate() to kill the shell');
      process.kill(-group.processGroupId, signal);
      revision++;
      return group.processGroupId;
    },
    terminate() {
      return (cleanup ||= (async () => {
        signalMembers('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, spec.graceMs));
        signalMembers('SIGKILL');
        if (!ended && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
        await done;
        live.delete(managed);
      })());
    },
  };
  const managed = {
    terminate: () => {
      handle.terminate().catch(() => {});
    },
    waitForExit: () => handle.terminate().then(() => true),
  };
  live.add(managed);
  try {
    await handle.resize(spec.cols, spec.rows);
  } catch (error) {
    await handle.terminate();
    throw error;
  }
  if (spec.signal?.aborted) {
    await handle.terminate();
    spec.signal.throwIfAborted();
  }
  return handle;
}
module.exports = { foreground, spawnScriptTerminal };
