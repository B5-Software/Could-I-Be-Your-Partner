/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { SubprocessRuntime, scrubbedParentEnv } = require('@deepseek-ai/dsh-subprocess');
const { ShellExecutor } = require('@deepseek-ai/dsh-shell');
const { resolveHostShell, hostExecutable } = require('../core/terminal-shell');
const sandbox = require('../sandbox-runner');
const { currentExecution, execution } = require('./execution-context');

function environment(overlay = {}) {
  const result = scrubbedParentEnv();
  for (const [key, value] of Object.entries(overlay)) {
    const existing =
      process.platform === 'win32' &&
      Object.keys(result).find((k) => k.toLowerCase() === key.toLowerCase());
    if (existing) delete result[existing];
    if (value !== undefined) result[key] = String(value);
  }
  return result;
}
function positive(n, label) {
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new TypeError('Invalid ' + label);
  return n;
}
// Retain byte offsets, rather than string lengths. Withhold an incomplete UTF-8
// suffix until the next chunk, so incremental readers cannot lose a code point.
class OutputBuffer {
  constructor(config, root) {
    this.config = config;
    this.root = root;
    this.tail = Buffer.alloc(0);
    this.size = 0;
    this.closed = false;
    this.resource = {};
  }
  push(chunk) {
    const bytes = Buffer.from(chunk);
    this.size += bytes.length;
    this.tail = Buffer.concat([this.tail, bytes]);
    if (this.tail.length > this.config.maxBytes)
      this.tail = this.tail.subarray(this.tail.length - this.config.maxBytes);
    if (this.config.spill) {
      if (this.size > this.config.spill.maxBytes) {
        this.removeSpill();
        this.spillLost = true;
      } else if (!this.spillLost) {
        if (this.fd === undefined) {
          fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
          this.spillPath = this.resource.path = path.join(this.root, randomUUID() + '.log');
          this.fd = fs.openSync(this.spillPath, 'wx', 0o600);
        }
        fs.writeSync(this.fd, bytes);
      }
    }
  }
  finish() {
    this.closed = true;
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
  removeSpill() {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
    if (this.spillPath) fs.rmSync(this.spillPath, { force: true });
    this.spillPath = this.resource.path = undefined;
  }
  readFrom(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.size)
      throw new TypeError('Invalid output offset');
    let start = this.size - this.tail.length;
    let head = 0;
    while (head < this.tail.length && (this.tail[head] & 0xc0) === 0x80) head++;
    start += head;
    let end = this.tail.length;
    if (!this.closed && end > head) {
      let lead = end - 1;
      while (lead > head && (this.tail[lead] & 0xc0) === 0x80) lead--;
      const byte = this.tail[lead],
        needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (end - lead < needed) end = lead;
    }
    const nextOffset = this.size - this.tail.length + end;
    return {
      text: this.tail
        .subarray(Math.max(head, offset - (this.size - this.tail.length)), end)
        .toString('utf8'),
      nextOffset,
      lossy: offset < start,
      ...(this.spillPath ? { spillPath: this.spillPath } : {}),
    };
  }
}
function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32')
    return new Promise((resolve) => {
      const killer = childProcess.spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  return Promise.resolve();
}
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
}
function waitBounded(promise, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      () => {
        cleanup();
        resolve(true);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

class CibypSubprocess extends SubprocessRuntime {
  constructor(ctx, options = {}) {
    super(ctx);
    this.options = options;
    this.live = new Set();
    this.buffers = new Set();
    this.bufferCleanup = new FinalizationRegistry(({ reference, resource }) => {
      this.buffers.delete(reference);
      if (resource.path) {
        try {
          fs.rmSync(resource.path, { force: true });
        } catch {}
      }
    });
    this.root = path.join(options.dataDir || os.tmpdir(), 'ds-output');
    ctx.effect(() => async () => {
      await Promise.allSettled(
        [...this.live].map(async (h) => {
          h.terminate();
          await h.waitForExit();
        }),
      );
      for (const reference of this.buffers) reference.deref()?.removeSpill();
      this.buffers.clear();
    });
  }
  async resolveExecutable(command, env, signal) {
    signal?.throwIfAborted();
    if (
      typeof command !== 'string' ||
      !command ||
      command.includes('\0') ||
      (!path.isAbsolute(command) && /[/\\]/.test(command))
    )
      throw new TypeError('Expected an absolute executable or a PATH name');
    const result = hostExecutable(command, process.platform, environment(env));
    if (!result)
      throw Object.assign(new Error('Executable unavailable: ' + command), {
        code: 'EXECUTABLE_NOT_FOUND',
      });
    signal?.throwIfAborted();
    return result;
  }
  async terminalEnvironment(signal) {
    signal?.throwIfAborted();
    const settings = (await this.options.getSettings?.()) || {};
    return {
      platform: process.platform === 'win32' ? 'windows' : 'posix',
      defaultShell: resolveHostShell(settings).file,
    };
  }
  spawn(spec) {
    spec.signal?.throwIfAborted();
    if (
      !Array.isArray(spec.argv) ||
      !spec.argv.length ||
      spec.argv.some((a) => typeof a !== 'string' || a.includes('\0')) ||
      !path.isAbsolute(spec.cwd)
    )
      throw new TypeError('Invalid subprocess spec');
    const grace = positive(spec.graceMs, 'termination grace');
    const disposition = spec.stdio;
    if (
      !disposition ||
      (!['ignore', 'pipe'].includes(disposition.stdin) &&
        typeof disposition.stdin?.data !== 'string')
    )
      throw new TypeError('Invalid stdin disposition');
    const collected = {},
      buffers = {};
    for (const name of ['stdout', 'stderr']) {
      const mode = disposition[name];
      if (typeof mode === 'object' && mode) {
        positive(mode.maxBytes, 'output cap');
        if (mode.spill) positive(mode.spill.maxBytes, 'spill cap');
        buffers[name] = collected[name] = new OutputBuffer(mode, this.root);
        const reference = new WeakRef(buffers[name]);
        this.buffers.add(reference);
        this.bufferCleanup.register(buffers[name], { reference, resource: buffers[name].resource });
      } else if (!['pipe', 'inherit'].includes(mode))
        throw new TypeError('Invalid ' + name + ' disposition');
    }
    const exec = currentExecution();
    // spawn is synchronous; its caller must resolve policy before entering this seam.
    const confined = sandbox.confine(
      spec.argv,
      exec.policy || { mode: exec.sandboxMode || 'danger-full-access', workspaceRoot: exec.cwd },
    );
    const child = childProcess.spawn(confined.argv[0], confined.argv.slice(1), {
      cwd: spec.cwd,
      env: environment(spec.env),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [
        disposition.stdin === 'ignore' ? 'ignore' : 'pipe',
        disposition.stdout === 'inherit' ? 'inherit' : 'pipe',
        disposition.stderr === 'inherit' ? 'inherit' : 'pipe',
        ...(disposition.control ? ['pipe'] : []),
      ],
    });
    let resolveDone,
      rejectDone,
      closed = false,
      terminating,
      escalation,
      drain;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => {});
    const fail = (error) => {
      rejectDone(error);
      handle.terminate();
    };
    for (const name of ['stdout', 'stderr'])
      if (buffers[name])
        child[name].on('data', (b) => {
          try {
            buffers[name].push(b);
          } catch (e) {
            fail(e);
          }
        });
    child.stdin?.on('error', (error) => {
      if (error.code !== 'EPIPE') fail(error);
    });
    const waitRange = async () => {
      await done.catch(() => {});
      if (terminating) await terminating;
      if (process.platform !== 'win32' && child.pid)
        while (groupAlive(child.pid)) await new Promise((r) => setTimeout(r, 25));
    };
    const handle = {
      stdin: disposition.stdin === 'pipe' ? child.stdin : undefined,
      stdout: disposition.stdout === 'pipe' ? child.stdout : undefined,
      stderr: disposition.stderr === 'pipe' ? child.stderr : undefined,
      control: disposition.control ? child.stdio[3] : undefined,
      collected,
      done,
      terminate() {
        if (terminating) return;
        terminating = killTree(child.pid).catch(fail);
        if (process.platform !== 'win32' && child.pid) {
          escalation = setTimeout(() => {
            killTree(child.pid, 'SIGKILL').catch(rejectDone);
          }, grace);
          escalation.unref();
        }
      },
      waitForExit: (signal) => waitBounded(waitRange(), signal),
    };
    this.live.add(handle);
    const abort = () => handle.terminate();
    spec.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', rejectDone);
    child.once('exit', () => {
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdio[3]?.destroy();
      }, grace);
      drain.unref();
    });
    child.once('close', (exitCode, signal) => {
      closed = true;
      clearTimeout(drain);
      spec.signal?.removeEventListener('abort', abort);
      for (const buffer of Object.values(buffers)) buffer.finish();
      resolveDone({ exitCode, signal });
      if (process.platform === 'win32' || !child.pid || !groupAlive(child.pid)) {
        clearTimeout(escalation);
        this.live.delete(handle);
      }
    });
    if (typeof disposition.stdin === 'object') child.stdin.end(disposition.stdin.data);
    if (spec.signal?.aborted && !closed) abort();
    return handle;
  }
  async spawnTerminal(spec) {
    spec.signal?.throwIfAborted();
    positive(spec.cols, 'columns');
    positive(spec.rows, 'rows');
    positive(spec.graceMs, 'termination grace');
    const exec = currentExecution(),
      confined = sandbox.confine(
        spec.argv,
        exec.policy || { mode: exec.sandboxMode || 'danger-full-access', workspaceRoot: exec.cwd },
      );
    // Loaded lazily: VM workers need no native host addon for ordinary tools.
    let binding;
    try {
      binding = require('node-pty');
    } catch (error) {
      if (process.platform !== 'linux') throw error;
    }
    if (!binding)
      return require('./terminal-process').spawnScriptTerminal(
        { ...spec, argv: confined.argv, env: environment(spec.env) },
        this.live,
      );
    const terminalOptions = {
      cwd: spec.cwd,
      env: environment(spec.env),
      cols: spec.cols,
      rows: spec.rows,
      name: spec.terminalType,
      useConpty: true,
      useConptyDll: process.platform === 'win32',
    };
    let pty;
    try {
      // The bundled ConPTY closes its console directly. The system backend
      // races an AttachConsole helper against process exit during cleanup.
      pty = binding.spawn(confined.argv[0], confined.argv.slice(1), terminalOptions);
    } catch (error) {
      if (process.platform !== 'win32' || !/conpty\.dll|OpenConsole/i.test(error.message))
        throw error;
      // Keep portable installs working when their native addon lacks the DLL.
      pty = binding.spawn(confined.argv[0], confined.argv.slice(1), {
        ...terminalOptions,
        useConptyDll: false,
      });
    }
    const output = new PassThrough();
    let resolveDone,
      revision = 0,
      ended = false,
      cleanup;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const data = pty.onData((chunk) => {
      if (!output.write(chunk)) pty.pause();
      revision++;
    });
    output.on('drain', () => {
      if (!ended) pty.resume();
    });
    const exit = pty.onExit(({ exitCode, signal }) => {
      ended = true;
      output.end();
      resolveDone({ exitCode, signal: signal || null });
      data.dispose();
      exit.dispose();
      this.live.delete(managed);
    });
    const managed = {
      terminate: () => {
        void handle.terminate();
      },
      waitForExit: (signal) => waitBounded(done, signal),
    };
    const handle = {
      pid: pty.pid,
      output,
      done,
      write: async (text) => {
        if (ended) throw new Error('Terminal exited');
        pty.write(text);
        revision++;
      },
      resize: async (cols, rows) => {
        positive(cols, 'columns');
        positive(rows, 'rows');
        pty.resize(cols, rows);
      },
      inspectForeground: async () =>
        ended ? undefined : require('./terminal-process').foreground(pty.pid),
      inspectActivity: async () => ({ state: 'unknown', revision }),
      signalForeground: async (signal) => {
        if (ended) throw new Error('Terminal exited');
        const foreground = require('./terminal-process').foreground(pty.pid);
        if (!foreground) throw new Error('Cannot identify the terminal foreground group');
        if (signal === 'SIGKILL' && foreground.processGroupId === pty.pid)
          throw new Error('Use terminate() to kill the terminal shell');
        if (process.platform === 'win32') {
          if (signal === 'SIGINT') pty.write('\x03');
          else if (['SIGTERM', 'SIGKILL'].includes(signal)) await killTree(pty.pid, signal);
          else throw new Error('Unsupported terminal signal on Windows');
        } else process.kill(-foreground.processGroupId, signal);
        return foreground.processGroupId;
      },
      terminate: () =>
        (cleanup ||= (async () => {
          if (process.platform === 'win32') {
            // Closing ConPTY also releases node-pty's pipe worker. taskkill alone
            // leaves those handles alive even after the shell has exited.
            pty.kill();
            try {
              await waitBounded(done, AbortSignal.timeout(3000));
            } catch {
              if (!ended) await killTree(pty.pid, 'SIGKILL');
            }
          } else if (!ended) {
            await killTree(pty.pid, 'SIGKILL');
            pty.kill();
          }
          await done;
        })()),
    };
    this.live.add(managed);
    if (spec.signal?.aborted) {
      await handle.terminate();
      spec.signal.throwIfAborted();
    }
    return handle;
  }
}

class CibypShell extends ShellExecutor {
  constructor(ctx, options = {}) {
    super(ctx);
    this.options = options;
  }
  get sandboxMode() {
    return this.ctx.root.get('sandboxPolicy')?.defaultMode;
  }
  resolve(request = {}) {
    return {
      ...request,
      command: String(request.command || ''),
      workdir: path.resolve(
        request.workdir ||
          request.cwd ||
          currentExecution().cwd ||
          this.options.cwd ||
          process.cwd(),
      ),
      timeoutMs: positive(request.timeoutMs ?? 120000, 'timeout'),
      onExpiry: request.onExpiry || 'kill',
      stdoutMaxBytes: positive(request.stdoutMaxBytes ?? 1048576, 'output cap'),
    };
  }
  async execute(spec) {
    spec = this.resolve(spec);
    spec.signal?.throwIfAborted();
    const settings = (await this.options.getSettings?.()) || {},
      shell = resolveHostShell(settings);
    const windowsShell = /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell.file);
    const argv = [
      shell.file,
      ...shell.args,
      ...(windowsShell
        ? ['-NoProfile', '-NonInteractive', '-Command', spec.command]
        : /cmd\.exe$/i.test(shell.file)
          ? ['/d', '/s', '/c', spec.command]
          : ['-c', spec.command]),
    ];
    const exec = currentExecution();
    const policy = sandbox.policyForCall(
      settings,
      exec.mode || exec.agent?.mode || 'chat',
      exec.cwd || spec.workdir,
    );
    const effective = policy.mode === 'danger-full-access' ? spec.sandboxPolicy || policy : policy;
    const confined = sandbox.confine(argv, effective);
    const controller = new AbortController();
    let cause,
      status = 'running',
      result,
      timer,
      stdoutCursor = 0,
      stderrCursor = 0;
    const abort = () => {
      cause ||= 'aborted';
      controller.abort();
    };
    spec.signal?.addEventListener('abort', abort, { once: true });
    if (spec.onExpiry === 'kill')
      timer = setTimeout(() => {
        cause ||= 'timeout';
        controller.abort();
      }, spec.timeoutMs);
    let processHandle;
    try {
      // The argv is already confined. Nested seam does not downgrade the policy.
      processHandle = execution.run({ ...exec, policy: effective }, () =>
        this.ctx.subprocess.spawn({
          argv,
          cwd: spec.workdir,
          stdio: {
            stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
            stdout: { maxBytes: spec.stdoutMaxBytes, spill: { maxBytes: 32 * 1024 * 1024 } },
            stderr: { maxBytes: 1048576, spill: { maxBytes: 32 * 1024 * 1024 } },
          },
          graceMs: 1000,
          signal: controller.signal,
          env: {
            ...Object.fromEntries(
              Object.entries(spec.env || {}).filter(([k]) => !k.toUpperCase().startsWith('DSH_')),
            ),
            ...spec.dshEnv,
          },
        }),
      );
    } catch (e) {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', abort);
      throw e;
    }
    if (spec.signal?.aborted) abort();
    const projection = processHandle.done
      .then((outcome) => {
        const stdout = processHandle.collected.stdout.readFrom(0),
          stderr = processHandle.collected.stderr.readFrom(0);
        result = {
          ...outcome,
          timedOut: cause === 'timeout',
          aborted: cause === 'aborted',
          timeoutMs: spec.timeoutMs,
          stdout: { text: stdout.text, truncated: stdout.lossy, spillPath: stdout.spillPath },
          stderr: { text: stderr.text, truncated: stderr.lossy, spillPath: stderr.spillPath },
          sandbox: {
            mode: effective.mode,
            denied: sandbox.isSandboxDenial(confined.confined, stderr.text),
            enforcement: confined.enforcement,
          },
        };
        return result;
      })
      .finally(() => {
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', abort);
        status = cause ? 'killed' : 'completed';
      });
    projection.catch(() => {});
    return {
      get status() {
        return status;
      },
      get exitCode() {
        return result?.exitCode ?? null;
      },
      get signal() {
        return result?.signal ?? null;
      },
      done: projection.then(
        () => {},
        () => {},
      ),
      result: () => projection,
      observed: processHandle.collected,
      get sandbox() {
        return (
          result?.sandbox || {
            mode: effective.mode,
            denied: false,
            enforcement: confined.enforcement,
          }
        );
      },
      kill: () => {
        if (status !== 'running' || cause) return false;
        cause = 'killed';
        controller.abort();
        return true;
      },
      readOutput: () => {
        const a = processHandle.collected.stdout.readFrom(stdoutCursor),
          b = processHandle.collected.stderr.readFrom(stderrCursor);
        stdoutCursor = a.nextOffset;
        stderrCursor = b.nextOffset;
        return {
          delta: a.text + b.text,
          lossy: a.lossy || b.lossy,
          spillPaths: [a.spillPath, b.spillPath].filter(Boolean),
        };
      },
    };
  }
  async run(spec) {
    return (await this.execute(spec)).result();
  }
}
CibypShell.inject = ['subprocess'];
module.exports = { CibypSubprocess, CibypShell, OutputBuffer };
