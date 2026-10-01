/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { shellQuote } = require('../vm/vm-paths');

const OUTPUT_LIMIT = 64 * 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A wait budget releases the caller; it never terminates the owned process. */
class ShellJobs {
  constructor({ getVmService, isVmOperation, confine, isSandboxDenial }) {
    Object.assign(this, { getVmService, isVmOperation, confine, isSandboxDenial });
    this.jobs = new Map();
    this.closedOwners = new Set();
    this.disposed = false;
  }
  async run(script, cwd, sandboxMode, options = {}) {
    try {
      if (this.disposed) throw new Error('应用正在退出');
      const owner = String(options.sessionKey || '');
      if (this.closedOwners.has(owner)) throw new Error('任务所属窗口已关闭');
      if (options.action === 'list') {
        return {
          ok: true,
          jobs: [...this.jobs.values()]
            .filter((job) => job.owner === owner)
            .map((job) => ({
              jobId: job.id,
              location: job.location,
              status: job.status,
              command: job.command,
            })),
        };
      }
      if (options.jobId) {
        const job = this.jobs.get(String(options.jobId));
        if (!job || job.owner !== owner) throw new Error('命令任务不存在于当前会话');
        if (options.action === 'stop') await this.stop(job);
        return await this.wait(job, options.yieldMs ?? 0);
      }
      if (typeof script !== 'string' || !script.trim()) throw new Error('需要脚本内容或已有 jobId');
      // Retain finished tasks for inspection, but bound the in-memory registry.
      for (const job of this.jobs.values()) {
        if (this.jobs.size < 200) break;
        if (job.status !== 'running') {
          this.jobs.delete(job.id);
          await this.cleanup(job);
        }
      }
      if (this.jobs.size >= 200) throw new Error('命令任务过多，请先停止不再需要的任务');
      const job = {
        id: crypto.randomUUID(),
        owner,
        status: 'running',
        command: script.slice(0, 200),
        output: '',
        stderr: '',
        code: null,
        location: this.isVmOperation() ? 'vm' : 'host',
      };
      if (job.location === 'vm') await this.startVm(job, script, cwd);
      else await this.startHost(job, script, cwd, sandboxMode);
      this.jobs.set(job.id, job);
      if (this.disposed || this.closedOwners.has(owner)) {
        await this.stop(job);
        await this.cleanup(job);
        this.jobs.delete(job.id);
        throw new Error('任务所属窗口已关闭');
      }
      return await this.wait(job, options.yieldMs ?? 1000);
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.sandboxUnavailable ? { sandboxUnavailable: true } : {}),
      };
    }
  }
  async startHost(job, script, cwd, sandboxMode) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cibyp-shell-'));
    const file = path.join(directory, process.platform === 'win32' ? 'run.ps1' : 'run.sh');
    job.directory = directory;
    try {
      await fs.promises.writeFile(file, script, 'utf8');
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const args =
        process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-File', file] : [file];
      const wrapped = this.confine(sandboxMode, cwd, [shell, ...args]);
      if (wrapped.error) {
        wrapped.error.sandboxUnavailable = true;
        throw wrapped.error;
      }
      job.sandboxed = !!wrapped.confined;
      const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: cwd || undefined,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.child = child;
      job.pid = child.pid;
      job.closed = new Promise((resolve) => child.once('close', resolve));
      const attach = (stream, key) => {
        const decoder = new StringDecoder('utf8');
        stream.on('data', (chunk) => {
          job[key] = (job[key] + decoder.write(chunk)).slice(-OUTPUT_LIMIT);
        });
        stream.on('end', () => {
          job[key] = (job[key] + decoder.end()).slice(-OUTPUT_LIMIT);
        });
      };
      attach(child.stdout, 'output');
      attach(child.stderr, 'stderr');
      child.on('error', (error) => {
        job.error = error.message;
        job.status = 'failed';
      });
      child.on('exit', (code, signal) => {
        job.code = code;
        job.signal = signal;
      });
      child.on('close', (code, signal) => {
        job.childClosed = true;
        job.code = code;
        job.signal = signal;
        if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed';
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      await this.cleanup(job);
      throw error;
    }
  }
  async startVm(job, script, cwd) {
    const service = this.getVmService();
    const working = await service.prepareTerminalDirectory(cwd);
    job.service = service;
    job.instance = service.instance; // Poll the original guest even after runtime mode switches.
    job.directory = '/tmp/cibyp-shell-' + job.id;
    const created = await job.instance.exec(`mkdir -m 700 -- ${shellQuote(job.directory)}`, {
      timeoutMs: 20000,
    });
    if (!created.ok) throw new Error(created.stderr || '无法创建 VM 命令任务');
    try {
      const sftp = await job.instance.sftp();
      await sftp.writeFile(job.directory + '/script.sh', script);
      await sftp.writeFile(
        job.directory + '/supervisor.cjs',
        await fs.promises.readFile(path.join(__dirname, '../vm/guest-shell-job.js')),
      );
      await sftp.writeFile(job.directory + '/stdout', '');
      await sftp.writeFile(job.directory + '/stderr', '');
      // Every inherited descriptor is redirected. Even an incorrectly backgrounded
      // server cannot hold the SSH exec request open after its launcher exits.
      const launched = await job.instance.exec(
        `nohup setsid node ${shellQuote(job.directory + '/supervisor.cjs')} ${shellQuote(job.directory)} ${shellQuote(working)} </dev/null >/dev/null 2>${shellQuote(job.directory + '/launcher-error')} & echo $!`,
        { timeoutMs: 20000 },
      );
      job.pid = Number(launched.stdout?.trim());
      if (!launched.ok || !Number.isSafeInteger(job.pid) || job.pid <= 1)
        throw new Error(launched.stderr || 'VM 命令启动失败');
      job.sandboxed = true;
    } catch (error) {
      await this.cleanup(job);
      throw error;
    }
  }
  async readVm(job) {
    const instance = job.instance;
    if (instance.state !== 'ready') throw new Error('原虚拟机已停止，无法查询命令任务');
    const result = await instance.exec(
      `if kill -0 -- -${job.pid} 2>/dev/null; then echo running; elif test -f ${shellQuote(job.directory + '/exit')}; then cat ${shellQuote(job.directory + '/exit')}; else echo stopped; fi`,
      { timeoutMs: 10000 },
    );
    if (!result.ok) throw new Error(result.stderr || 'VM 命令状态查询失败');
    const state = result.stdout.trim();
    if (state !== 'running') {
      job.code = /^\d+$/.test(state) ? Number(state) : null;
      if (job.status !== 'stopped')
        job.status = job.code === 0 ? 'completed' : job.code === null ? 'stopped' : 'failed';
    }
    const sftp = await instance.sftp();
    for (const [file, key] of [
      ['stdout', 'output'],
      ['stderr', 'stderr'],
    ]) {
      const remote = job.directory + '/' + file;
      const stat = await sftp.stat(remote);
      const chunks = [];
      if (stat.size) {
        const stream = sftp.createReadStream(remote, {
          start: Math.max(0, stat.size - OUTPUT_LIMIT),
          end: stat.size - 1,
        });
        for await (const chunk of stream) chunks.push(chunk);
      }
      job[key] = Buffer.concat(chunks).toString('utf8');
    }
    if (job.status !== 'running' && !job.synced && job.service.runtime.workspaceMode === 'shared') {
      job.synced = true;
      // Synchronization runs asynchronously so it cannot block status/results.
      job.service.syncWorkspace({ direction: 'pull', reason: 'shell-job' }).catch(() => {});
    }
  }
  async wait(job, requested) {
    const waitMs = Math.max(0, Math.min(10000, Number(requested) || 0));
    const deadline = Date.now() + waitMs;
    do {
      if (job.location === 'vm') await this.readVm(job);
      if (job.status !== 'running' || Date.now() >= deadline) break;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (true);
    const running = job.status === 'running';
    return {
      ok: running || job.status === 'completed' || job.status === 'stopped',
      jobId: job.id,
      status: job.status,
      running,
      output: job.output,
      stderr: job.stderr,
      code: job.code,
      location: job.location,
      sandboxed: job.sandboxed,
      ...(running
        ? {
            hint: '命令仍在后台运行。使用同一工具的 jobId 读取输出；action=stop 停止。等待时间用完不会杀死进程。',
          }
        : {}),
      ...(job.status === 'failed'
        ? {
            error: job.error || job.stderr || `进程退出码 ${job.code}`,
            sandboxDenied: this.isSandboxDenial(job.sandboxed, job.stderr),
          }
        : {}),
    };
  }
  async stop(job) {
    if (job.status !== 'running') return;
    if (job.stopping) return job.stopping;
    job.stopping = (async () => {
      if (job.location === 'vm') {
        if (job.instance.state !== 'ready') throw new Error('原虚拟机已停止');
        await job.instance.exec(
          `kill -TERM -- -${job.pid} 2>/dev/null || true; sleep 0.2; kill -KILL -- -${job.pid} 2>/dev/null || true`,
          { timeoutMs: 10000 },
        );
      } else if (job.pid) {
        if (process.platform === 'win32')
          await new Promise((resolve) =>
            execFile(
              'taskkill.exe',
              ['/PID', String(job.pid), '/T', '/F'],
              { windowsHide: true, timeout: 10000 },
              () => resolve(),
            ),
          );
        else {
          try {
            process.kill(-job.pid, 'SIGTERM');
          } catch {
            /* exited */
          }
          await delay(200);
          try {
            process.kill(-job.pid, 'SIGKILL');
          } catch {
            /* exited */
          }
        }
        // taskkill returning does not mean Node has observed the final pipe/process
        // closure. Windows can still hold the working directory open at this point.
        await this.waitForHostClose(job);
      }
      job.status = 'stopped';
    })();
    try {
      await job.stopping;
    } finally {
      job.stopping = null;
    }
  }
  async waitForHostClose(job) {
    if (!job.closed || job.childClosed) return;
    let timer;
    try {
      await Promise.race([
        job.closed,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('命令进程未完成退出，请重试停止')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async cleanup(job) {
    if (job.location === 'vm') {
      if (job.instance?.state === 'ready' && job.directory)
        await job.instance
          .exec(`rm -rf -- ${shellQuote(job.directory)}`, { timeoutMs: 10000 })
          .catch(() => {});
    } else if (job.directory) {
      await this.waitForHostClose(job);
      await fs.promises.rm(job.directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }
  async dispose() {
    this.disposed = true;
    await Promise.allSettled(
      [...this.jobs.values()].map(async (job) => {
        await this.stop(job);
        await this.cleanup(job);
      }),
    );
    this.jobs.clear();
  }
  async releaseOwner(owner) {
    this.closedOwners.add(owner);
    await Promise.allSettled(
      [...this.jobs.values()]
        .filter((job) => job.owner === owner)
        .map(async (job) => {
          await this.stop(job);
          await this.cleanup(job);
          this.jobs.delete(job.id);
        }),
    );
  }
}
module.exports = { ShellJobs };
