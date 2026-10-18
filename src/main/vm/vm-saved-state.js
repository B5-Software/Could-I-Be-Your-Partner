/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const TAG = 'cibyp-quick-resume';
const SCHEMA = 2;

function fileIdentity(file) {
  const stat = fs.statSync(file);
  return { path: path.resolve(file), bytes: stat.size, mtime: stat.mtimeMs };
}

function compatibility(instance, qemu, version) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        schema: SCHEMA,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        guest: instance.guestArch,
        accel: instance.accel?.backend,
        smp: instance.config.smp,
        memMB: instance.config.memMB,
        netMode: instance.config.netMode,
        cmdline: instance.config.kernelCmdline || null,
        timezone: instance.config.timezone,
        version,
        files: [
          qemu.exe,
          instance.opts.imagePath,
          instance.opts.kernelPath,
          instance.opts.initrdPath,
        ].map(fileIdentity),
      }),
    )
    .digest('hex');
}

class VmSavedState {
  constructor(instance, storage) {
    this.instance = instance;
    this.storage = storage;
    this.file = path.join(instance.dir, 'saved-state.json');
  }

  get available() {
    try {
      return (
        !!this.storage?.isEncryptionAvailable() &&
        this.storage.getSelectedStorageBackend?.() !== 'basic_text'
      );
    } catch {
      return false;
    }
  }

  clear() {
    fs.rmSync(this.file, { force: true });
    fs.rmSync(this.file + '.tmp', { force: true });
  }

  consume(signature) {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        !this.available ||
        state.schema !== SCHEMA ||
        state.signature !== signature ||
        JSON.stringify(state.disk) !== JSON.stringify(fileIdentity(this.instance.overlayPath))
      )
        return null;
      const privateKey = this.storage.decryptString(Buffer.from(state.key, 'base64'));
      if (
        !privateKey.includes('PRIVATE KEY') ||
        !Number.isInteger(state.seedPort) ||
        state.seedPort < 1 ||
        state.seedPort > 65535
      )
        return null;
      if (
        state.kind === 'hibernate' &&
        (!/^\/dev\/[a-zA-Z0-9/_-]+$/.test(state.device) ||
          !Number.isSafeInteger(state.offset) ||
          state.offset < 1 ||
          !/^[a-f0-9-]{36}$/.test(state.bootId))
      )
        return null;
      if (state.kind !== 'hibernate' && state.kind !== 'qmp') return null;
      return { ...state, privateKey };
    } catch (error) {
      if (error.code !== 'ENOENT')
        this.instance.emit('serial', '[host] Saved VM state is unavailable; using a cold boot');
      return null;
    } finally {
      // Single use. A crash, disk mutation or failed load must never replay old RAM/disk state.
      this.clear();
    }
  }

  sealKey(privateKey) {
    if (!this.available) throw new Error('OS-protected storage is unavailable for the resume key');
    return this.storage.encryptString(privateKey).toString('base64');
  }

  publish(signature, key, seedPort, resume = { kind: 'qmp' }) {
    const state = {
      ...resume,
      schema: SCHEMA,
      signature,
      key,
      seedPort,
      savedAt: Date.now(),
      disk: fileIdentity(this.instance.overlayPath),
    };
    const fd = fs.openSync(this.file + '.tmp', 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

/** Only use qemu-img after the VM process has exited and released the disk. */
async function discardSnapshot(qemu, overlay) {
  const info = await new Promise((resolve, reject) => {
    execFile(
      qemu.img,
      ['info', '--output=json', overlay],
      { windowsHide: true, timeout: 15000 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      },
    );
  });
  if (!info.snapshots?.some((snapshot) => snapshot.name === TAG)) return;
  await new Promise((resolve, reject) => {
    execFile(
      qemu.img,
      ['snapshot', '-d', TAG, overlay],
      { windowsHide: true, timeout: 30000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

module.exports = { VmSavedState, compatibility, discardSnapshot, TAG };
