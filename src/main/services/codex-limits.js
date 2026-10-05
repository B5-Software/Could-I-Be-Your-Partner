/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const exists = require('node:fs').existsSync;

function findCodexBinary() {
  try {
    return require.resolve('@openai/codex/bin/codex.js');
  } catch {
    /* optional dependency */
  }
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidates =
      process.platform === 'win32'
        ? [
            path.join(directory, 'codex.exe'),
            path.join(directory, 'node_modules/@openai/codex/bin/codex.js'),
          ]
        : [path.join(directory, 'codex')];
    for (const candidate of candidates) if (exists(candidate)) return candidate;
  }
  return null;
}

// A fresh CODEX_HOME ensures quota reads cannot use another application's login.
// Externally managed credentials are passed over stdio, never the command line.
async function readCodexLimits({
  token,
  accountId,
  planType,
  signal,
  consume,
  binary = process.env.CIBYP_CODEX_BINARY,
  spawnImpl = spawn,
}) {
  if (signal?.aborted) return { ok: false, error: 'Codex quota request cancelled' };
  if (!accountId)
    return {
      ok: false,
      error:
        'This ChatGPT account did not provide a Codex account identifier; check ChatGPT Usage for plan limits',
    };
  if (!binary) {
    binary = findCodexBinary();
    if (!binary)
      return {
        ok: false,
        error:
          'Codex quota reader is unavailable. Install the official Codex CLI or set CIBYP_CODEX_BINARY to its executable',
      };
  }
  if (/\.(cmd|bat)$/i.test(binary))
    binary = path.join(path.dirname(binary), 'node_modules/@openai/codex/bin/codex.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-codex-quota-'));
  const js = /\.[cm]?js$/.test(binary);
  const executable = js ? process.execPath : binary;
  const args = [...(js ? [binary] : []), 'app-server', '--listen', 'stdio://'];
  const env = { ...process.env, CODEX_HOME: directory };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  if (js && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  let child;
  let lines;
  let closed = false;
  const pending = new Map();
  let id = 0;
  const fail = () => {
    closed = true;
    for (const item of pending.values()) item.reject(new Error('Codex quota reader stopped'));
    pending.clear();
  };
  const abort = () => {
    fail();
    child?.kill();
  };
  try {
    child = spawnImpl(executable, args, {
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    lines = readline.createInterface({ input: child.stdout });
    child.on('error', fail);
    child.on('exit', fail);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        // Native helpers may send their own requests with IDs that collide
        // with ours. They must never settle an outstanding client request.
        if (message.method) {
          if (message.id != null && !closed)
            child.stdin.write(
              JSON.stringify({
                id: message.id,
                error: { code: -32601, message: 'Unsupported server request' },
              }) + '\n',
            );
          return;
        }
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        message.error
          ? item.reject(new Error('Codex quota request failed'))
          : item.resolve(message.result);
      } catch {
        /* ignore unrelated notifications */
      }
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new Error('Codex quota reader stopped'));
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error('Codex quota request timed out'));
        }, 10000);
        pending.set(key, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(
          JSON.stringify({ id: key, method, ...(params ? { params } : {}) }) + '\n',
        );
      });
    await rpc('initialize', {
      clientInfo: {
        name: 'cibyp',
        title: 'Could I Be Your Partner',
        version: require('../../../package.json').version,
      },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    await rpc('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: token,
      chatgptAccountId: accountId,
      ...(planType ? { chatgptPlanType: planType } : {}),
    });
    if (consume) {
      if (!/^[a-f0-9-]{36}$/i.test(consume.idempotencyKey || ''))
        throw new Error('Invalid reset request');
      const redemption = await rpc('account/rateLimitResetCredit/consume', {
        idempotencyKey: consume.idempotencyKey,
        ...(consume.creditId ? { creditId: consume.creditId } : {}),
      });
      // Consumption must never be retried automatically. Quota refresh failure does not hide its outcome.
      const limits = await rpc('account/rateLimits/read').catch(() => null);
      return {
        ok: true,
        redemption,
        limits: limits ? { ok: true, ...limits, fetchedAt: Date.now() } : null,
      };
    }
    return { ok: true, ...(await rpc('account/rateLimits/read')), fetchedAt: Date.now() };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    signal?.removeEventListener('abort', abort);
    lines?.close();
    child?.kill();
    fail();
    // Only remove the fresh private directory created above, never a user's Codex home.
    if (
      path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith('cibyp-codex-quota-')
    )
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { readCodexLimits, findCodexBinary };
