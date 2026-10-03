/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Only these capabilities cross the private parent/child IPC pipe. The VM and
// all settings remain owned by the running TUI, never a second App instance.
const REQUEST_CHANNELS = new Set([
  'theme:get',
  'vm:graphicsStatus',
  'vm:graphicsStart',
  'vm:graphicsStop',
  'vm:graphicsChromium',
]);
const EVENT_CHANNELS = ['theme:apply', 'vm:graphics-log', 'vm:graphics-progress'];

function resolveElectronExecutable() {
  if (process.env.CIBYP_ELECTRON_EXECUTABLE) return process.env.CIBYP_ELECTRON_EXECUTABLE;
  // Requiring "electron" here would return the Node runtime's Electron shim.
  // Resolve its installed executable without executing the auto-downloader.
  const directory = path.dirname(require.resolve('electron'));
  const executable = fs.readFileSync(path.join(directory, 'path.txt'), 'utf8').trim();
  const target = path.join(
    process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(directory, 'dist'),
    executable,
  );
  if (!fs.existsSync(target)) throw new Error('Electron desktop runtime is not installed');
  return target;
}

class VmDesktopCompanion {
  constructor({
    invoke,
    subscribe,
    spawnProcess = spawn,
    executable,
    entryPath,
    timeoutMs = 30000,
  }) {
    this.invoke = invoke;
    this.subscribe = subscribe;
    this.spawnProcess = spawnProcess;
    this.executable = executable;
    this.entryPath = entryPath || path.join(__dirname, 'vm-desktop-entry.js');
    this.timeoutMs = timeoutMs;
  }

  open(theme, systemDark) {
    if (this.opening) return this.opening;
    if (this.child?.connected) {
      this._send(this.child, { type: 'focus' });
      return Promise.resolve({ ok: true });
    }
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = this.spawnProcess(
      this.executable || resolveElectronExecutable(),
      [this.entryPath],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: environment,
      },
    );
    this.child = child;
    child.stdout?.on('data', (data) => console.log('[vm-desktop]', String(data).trim()));
    child.stderr?.on('data', (data) => console.error('[vm-desktop]', String(data).trim()));
    const disposers = EVENT_CHANNELS.map((channel) =>
      this.subscribe(channel, (payload) => this._send(child, { type: 'event', channel, payload })),
    );
    this.opening = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('VM desktop window startup timed out'));
      }, this.timeoutMs);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opening = null;
        if (error) reject(error);
        else resolve({ ok: true });
      };
      child.on('message', async (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready') {
          finish();
          return;
        }
        if (message.type === 'failed') {
          finish(new Error(message.error || 'VM desktop startup failed'));
          child.kill();
          return;
        }
        if (message.type !== 'request' || !Number.isSafeInteger(message.id)) return;
        try {
          if (!REQUEST_CHANNELS.has(message.channel) || !Array.isArray(message.args))
            throw new Error('Unsupported desktop request');
          const result = await this.invoke(message.channel, ...message.args);
          this._send(child, { type: 'response', id: message.id, result });
        } catch (error) {
          this._send(child, { type: 'response', id: message.id, error: error.message });
        }
      });
      const closed = (error) => {
        for (const dispose of disposers) dispose();
        if (this.child === child) this.child = null;
        finish(error instanceof Error ? error : new Error('VM desktop window closed'));
      };
      child.once('error', closed);
      child.once('exit', closed);
      this._send(child, { type: 'init', theme, systemDark });
    });
    return this.opening;
  }

  _send(child, message) {
    if (!child.connected) return;
    child.send(message, (error) => {
      if (error) console.warn('[vm-desktop] IPC delivery failed:', error.message);
    });
  }

  dispose() {
    const child = this.child;
    if (!child) return;
    this._send(child, { type: 'shutdown' });
    const timer = setTimeout(() => {
      if (this.child === child) child.kill();
    }, 2000);
    timer.unref();
  }
}

module.exports = { VmDesktopCompanion, REQUEST_CHANNELS, EVENT_CHANNELS };
