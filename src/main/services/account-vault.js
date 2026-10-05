/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Windows DPAPI works in both Electron and the Node TUI, under the current user.
// Credentials travel over stdin/stdout, never process arguments or shell commands.
function dpapi(value, decrypt = false) {
  return new Promise((resolve, reject) => {
    const command = `Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $result = [Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
    const ps = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Credential protection timed out'));
    }, 15000);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot start Windows credential protection'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && /^[\w+/=\s]+$/.test(output)) resolve(Buffer.from(output.trim(), 'base64'));
      else reject(new Error('Windows credential protection failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(value).toString('base64'));
  });
}

class AccountVault {
  constructor(file, codec) {
    this.file = file;
    this.codec = codec;
  }
  async load() {
    try {
      const stat = await fs.lstat(this.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && stat.uid !== process.getuid())
      )
        throw new Error('Unsafe credential file');
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.protection === 'dpapi')
        return JSON.parse((await dpapi(Buffer.from(saved.data, 'base64'), true)).toString('utf8'));
      if (this.codec) return this.codec.decode(saved);
      if (saved.protection !== 'owner-only' || process.platform === 'win32')
        throw new Error('Invalid credential vault');
      await fs.chmod(this.file, 0o600);
      return saved.data;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(
        'Cannot read protected ChatGPT accounts; restore the credential file or remove it and sign in again',
      );
    }
  }
  async save(data) {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const saved = this.codec
      ? await this.codec.encode(data)
      : process.platform === 'win32'
        ? {
            protection: 'dpapi',
            data: (await dpapi(Buffer.from(JSON.stringify(data)))).toString('base64'),
          }
        : { protection: 'owner-only', data };
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
module.exports = { AccountVault, dpapi };
