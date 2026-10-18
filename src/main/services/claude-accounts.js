/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { ClaudeCredentials } = require('./claude-credentials');

function subscriptionEnvironment(directory, parent = process.env) {
  const env = { ...parent };
  for (const name of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|GOOGLE_|GCLOUD_|AZURE_|VERTEX_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(
        name,
      )
    )
      delete env[name];
  }
  return { ...env, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
function executable() {
  if (process.env.CIBYP_CLAUDE_BINARY) {
    const file = process.env.CIBYP_CLAUDE_BINARY;
    if (!path.isAbsolute(file)) throw new Error('CIBYP_CLAUDE_BINARY must be an absolute path');
    return file;
  }
  const musl =
    process.platform === 'linux' && !process.report?.getReport().header.glibcVersionRuntime;
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
  return require
    .resolve(name + (process.platform === 'win32' ? '/claude.exe' : '/claude'))
    .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}
class ClaudeAccounts {
  constructor({
    root,
    publish = () => {},
    spawnImpl = spawn,
    sdkLoader = () => import('@anthropic-ai/claude-agent-sdk'),
    executablePath = executable,
    credentialVaultFactory,
  }) {
    this.root = root;
    this.publish = publish;
    this.spawn = spawnImpl;
    this.sdkLoader = sdkLoader;
    this.executablePath = executablePath;
    this.credentials = new ClaudeCredentials(root, credentialVaultFactory);
    this.requests = new Set();
    this.usage = new Map();
    this.queue = Promise.resolve();
  }
  async init() {
    if (!this.loading)
      this.loading = (async () => {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        try {
          this.data = JSON.parse(await fs.readFile(path.join(this.root, 'accounts.json'), 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          this.data = { accounts: [], activeId: null };
        }
        if (
          !Array.isArray(this.data.accounts) ||
          this.data.accounts.some((a) => !/^[a-f0-9-]{36}$/.test(a.id))
        )
          throw new Error('Invalid Claude account index');
        for (const account of this.data.accounts) await this.credentials.migrate(account.id);
      })();
    return this.loading;
  }
  directory(id) {
    return path.join(this.root, id);
  }
  async save(data = this.data) {
    const file = path.join(this.root, 'accounts.json');
    await fs.writeFile(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  }
  snapshot() {
    return {
      ok: true,
      accounts: this.data?.accounts || [],
      activeId: this.data?.activeId || null,
      pending: this.pending ? { id: this.pending.id, url: this.pending.url || null } : null,
      error: this.error || null,
    };
  }
  changed() {
    this.publish('claude:changed', this.snapshot());
  }
  async status() {
    await this.init();
    return this.snapshot();
  }
  serial(fn) {
    const task = this.queue.then(async () => {
      await this.init();
      return fn();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async run(id, args, signal, raw = false) {
    const directory = this.directory(id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await this.credentials.acquire(id);
    try {
      return await new Promise((resolve, reject) => {
        const child = this.spawn(this.executablePath(), args, {
          cwd: directory,
          env: subscriptionEnvironment(directory),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal,
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.length > 65536) child.kill();
        });
        child.stderr.on('data', () => {});
        child.once('error', reject);
        child.once('close', (code) => {
          if (output.length > 65536)
            return reject(new Error('Claude authentication output is too large'));
          if (code !== 0)
            return reject(new Error('Claude subscription login is unavailable or expired'));
          if (raw) return resolve(output.trim());
          try {
            resolve(JSON.parse(output));
          } catch {
            reject(new Error('Invalid Claude authentication status'));
          }
        });
      });
    } finally {
      await release();
    }
  }
  async verify(id, signal = AbortSignal.timeout(15000)) {
    const status = await this.run(id, ['auth', 'status'], signal);
    if (!status.loggedIn || status.authMethod !== 'claude.ai')
      throw new Error('Sign in with a Claude Pro or Max subscription');
    if (!['pro', 'max'].includes(String(status.subscriptionType).toLowerCase()))
      throw new Error('This connection requires a Claude Pro or Max subscription');
    return status;
  }
  async login(id) {
    return this.serial(async () => {
      if (this.disposed) throw new Error('Claude is shutting down');
      if (this.pending) throw new Error('A Claude login is already in progress');
      const existing = id && this.data.accounts.find((a) => a.id === id);
      if (id && !existing) throw new Error('Unknown Claude account');
      id ||= randomUUID();
      const directory = this.directory(id);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const controller = new AbortController();
      const releaseCredentials = await this.credentials.acquire(id);
      let child;
      try {
        if (this.disposed) throw new Error('Claude is shutting down');
        child = this.spawn(this.executablePath(), ['auth', 'login', '--claudeai'], {
          cwd: directory,
          env: subscriptionEnvironment(directory),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: controller.signal,
        });
      } catch (error) {
        await releaseCredentials();
        throw error;
      }
      const pending = (this.pending = { id, child, controller, releaseCredentials });
      this.error = null;
      let output = '';
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-16384);
        const urls = output.match(/https:\/\/[^\s\u001b]+/g) || [];
        const url = urls.find((value) =>
          /^https:\/\/(?:claude\.ai|platform\.claude\.com|console\.anthropic\.com)\//.test(value),
        );
        if (url && pending.url !== url && this.pending === pending) {
          pending.url = url;
          this.changed();
          this.publish('claude:login-url', { url });
        }
      });
      child.stderr.on('data', () => {});
      const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
      const complete = async (error) => {
        clearTimeout(timer);
        if (pending.completing) return;
        pending.completing = true;
        if (this.pending !== pending) {
          try {
            await releaseCredentials();
          } catch {
            this.error = 'Cannot encrypt Claude credentials; keep the app open and retry';
            this.changed();
          }
          return;
        }
        await this.serial(async () => {
          try {
            if (error) throw error;
            const status = await this.verify(
              id,
              AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            );
            if (this.pending !== pending || controller.signal.aborted) return;
            const account = {
              id,
              label: status.email || 'Claude',
              plan: status.subscriptionType,
              signedIn: true,
            };
            const previous = this.data;
            const next = {
              ...previous,
              accounts: [...previous.accounts.filter((a) => a.id !== id), account],
              activeId: id,
            };
            await this.save(next);
            if (this.pending !== pending || controller.signal.aborted) {
              await this.save(previous);
              return;
            }
            this.abortRequests();
            this.data = next;
          } catch (error) {
            if (this.pending === pending) this.error = error.message;
          } finally {
            try {
              await releaseCredentials();
            } catch {
              this.error = 'Cannot encrypt Claude credentials; keep the app open and retry';
            }
            if (this.pending === pending) {
              this.pending = null;
              this.changed();
            }
          }
        });
      };
      child.once('error', (error) => {
        void complete(error);
      });
      child.once('close', (code) => {
        void complete(code === 0 ? null : new Error('Claude login was cancelled or failed'));
      });
      this.changed();
      return { ok: true, pending: true, id };
    });
  }
  cancel() {
    const pending = this.pending;
    this.pending = null;
    pending?.controller.abort();
    this.changed();
    return { ok: true };
  }
  submitCode(code) {
    if (
      !this.pending ||
      typeof code !== 'string' ||
      !code.trim() ||
      code.length > 4096 ||
      /[\r\n\0]/.test(code)
    )
      throw new Error('No pending Claude login or invalid authorization code');
    this.pending.child.stdin.write(code.trim() + '\n');
    return { ok: true };
  }
  async switchAccount(id) {
    return this.serial(async () => {
      if (this.disposed) throw new Error('Claude is shutting down');
      if (this.pending) throw new Error('Finish or cancel the pending Claude login');
      const account = this.data.accounts.find((a) => a.id === id);
      if (!account) throw new Error('Unknown Claude account');
      await this.verify(id);
      this.abortRequests();
      this.data.activeId = id;
      await this.save();
      this.changed();
      return this.snapshot();
    });
  }
  async logout(id) {
    return this.serial(async () => {
      if (this.pending?.id === id) this.cancel();
      if (!this.data.accounts.some((a) => a.id === id)) throw new Error('Unknown Claude account');
      this.closingProfiles ||= new Set();
      this.closingProfiles.add(id);
      try {
        this.abortRequests();
        // The SDK can refresh credentials while winding down. Drain its leases
        // before deleting the profile so a late release cannot recreate a vault.
        await this.credentials.settle(id);
        // Only CIBYP's private profile is removed. Other Claude installs stay signed in.
        await this.run(id, ['auth', 'logout'], AbortSignal.timeout(15000), true).catch(() => {});
        const target = path.resolve(this.directory(id));
        if (path.dirname(target) !== path.resolve(this.root))
          throw new Error('Invalid Claude account directory');
        await fs.rm(target, { recursive: true, force: true });
        this.usage.delete(id);
        this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
        if (this.data.activeId === id) this.data.activeId = null;
        await this.save();
        this.changed();
        return this.snapshot();
      } finally {
        this.closingProfiles.delete(id);
      }
    });
  }
  abortRequests() {
    for (const controller of this.requests) controller.abort(new Error('Claude account changed'));
  }
  observeLimits(id, info) {
    if (
      !['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].includes(
        info?.rateLimitType,
      ) ||
      !Number.isFinite(info.utilization) ||
      info.utilization < 0 ||
      info.utilization > 1
    )
      return;
    const state = this.usage.get(id) || { windows: [], fetchedAt: 0 };
    state.windows = [
      ...state.windows.filter((w) => w.id !== info.rateLimitType),
      {
        id: info.rateLimitType,
        label: 'Claude',
        period: info.rateLimitType === 'five_hour' ? '5hour' : 'weekly',
        usedPercent: info.utilization * 100,
        resetsAt: Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : null,
      },
    ];
    state.fetchedAt = Date.now();
    this.usage.set(id, state);
  }
  limits() {
    const state = this.usage.get(this.data?.activeId);
    return state
      ? { ok: true, ...state, source: 'official-sdk-response' }
      : {
          ok: true,
          unavailable: true,
          windows: [],
          error: 'View subscription limits in Claude usage settings',
          manageUrl: 'https://claude.ai/settings/usage',
        };
  }
  async lease(id, controller) {
    await this.init();
    if (this.disposed) throw new Error('Claude is shutting down');
    id ||= this.data.activeId;
    if (!id || !this.data.accounts.some((a) => a.id === id))
      throw new Error('Sign in with a Claude Pro or Max subscription');
    if (this.closingProfiles?.has(id)) throw new Error('Claude account changed');
    this.requests.add(controller);
    let releaseCredentials;
    try {
      releaseCredentials = await this.credentials.acquire(id);
      if (this.disposed) throw new Error('Claude is shutting down');
      controller.signal.throwIfAborted();
      if (this.closingProfiles?.has(id)) throw new Error('Claude account changed');
      const status = await this.verify(id, controller.signal);
      controller.signal.throwIfAborted();
      if (id !== this.data.activeId || this.closingProfiles?.has(id))
        throw new Error('Claude account changed');
      return {
        id,
        status,
        directory: this.directory(id),
        env: subscriptionEnvironment(this.directory(id)),
        executable: this.executablePath(),
        release: async () => {
          this.requests.delete(controller);
          await releaseCredentials();
        },
      };
    } catch (error) {
      this.requests.delete(controller);
      await releaseCredentials?.();
      throw error;
    }
  }
  async models() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let query, lease;
    try {
      lease = await this.lease(null, controller);
      const sdk = await this.sdkLoader();
      query = sdk.query({
        prompt: (async function* () {
          await new Promise((resolve) =>
            controller.signal.addEventListener('abort', resolve, { once: true }),
          );
        })(),
        options: {
          abortController: controller,
          cwd: lease.directory,
          env: lease.env,
          pathToClaudeCodeExecutable: lease.executable,
          settingSources: [],
          strictMcpConfig: true,
          settings: { forceLoginMethod: 'claudeai' },
          persistSession: false,
          tools: [],
          permissionMode: 'default',
        },
      });
      const models = await query.supportedModels();
      return {
        ok: true,
        models: models.map((m) => ({
          id: m.value,
          name: m.displayName || m.value,
          description: m.description,
          contextLength: m.contextWindow || 200000,
          vision: true,
        })),
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
      query?.close();
      try {
        await query?.return?.();
      } finally {
        await lease?.release();
      }
    }
  }
  dispose() {
    this.disposed = true;
    this.cancel();
    this.abortRequests();
    this.disposing ||= this.credentials.settle();
    return this.disposing;
  }
}
module.exports = { ClaudeAccounts, subscriptionEnvironment, executable };
