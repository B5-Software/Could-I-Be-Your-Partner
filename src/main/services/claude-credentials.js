/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { AccountVault } = require('./account-vault');

/** The official CLI needs a credential file while running. Keep its idle copy
 * encrypted, and materialize one private file only for the duration of a lease.
 * Reference counts include login, status checks, SDK streams and token refreshes.
 */
class ClaudeCredentials {
  constructor(root, vaultFactory = (file) => new AccountVault(file)) {
    this.root = root;
    this.vaultFactory = vaultFactory;
    this.profiles = new Map();
  }
  profile(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid Claude credential profile');
    if (!this.profiles.has(id)) {
      const directory = path.join(this.root, id);
      this.profiles.set(id, {
        directory,
        plain: path.join(directory, '.credentials.json'),
        vault: this.vaultFactory(path.join(directory, 'credentials.vault')),
        count: 0,
        queue: Promise.resolve(),
      });
    }
    return this.profiles.get(id);
  }
  serial(profile, fn) {
    const task = profile.queue.catch(() => {}).then(fn);
    profile.queue = task;
    return task;
  }
  async readPlain(profile) {
    try {
      const stat = await fs.lstat(profile.plain);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && stat.uid !== process.getuid())
      )
        throw new Error('Unsafe Claude credential file');
      try {
        return JSON.parse(await fs.readFile(profile.plain, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('Invalid Claude credential file');
        throw error;
      }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async protect(profile) {
    const value = await this.readPlain(profile);
    if (!value) return;
    // Encrypt before removing the original; a failed write never loses a login.
    await profile.vault.save(value);
    await fs.rm(profile.plain, { force: true });
  }
  async migrate(id) {
    const profile = this.profile(id);
    await this.serial(profile, () => (profile.count ? undefined : this.protect(profile)));
  }
  async acquire(id) {
    const profile = this.profile(id);
    await this.serial(profile, async () => {
      await fs.mkdir(profile.directory, { recursive: true, mode: 0o700 });
      if (!profile.count) {
        // A crash may have left newer refreshed tokens than the encrypted copy.
        await this.protect(profile);
        const value = await profile.vault.load();
        if (value) {
          await fs.writeFile(profile.plain, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        } else {
          // Verify encryption works before launching a process that can mint tokens.
          await profile.vault.save(null);
        }
      }
      profile.count++;
    });
    let released = false;
    return () => {
      if (released) return profile.queue;
      released = true;
      return this.serial(profile, async () => {
        profile.count--;
        if (!profile.count) await this.protect(profile);
      });
    };
  }
  async settle(id) {
    const profiles = id ? [this.profile(id)] : [...this.profiles.values()];
    const deadline = Date.now() + 10000;
    // An acquire may be queued for encryption while count is still zero.
    // Drain that queue before deciding the profile is idle, then allow its
    // cancelled owner to release the lease before checking again.
    for (;;) {
      await Promise.all(profiles.map((profile) => profile.queue));
      if (!profiles.some((profile) => profile.count)) break;
      if (Date.now() >= deadline) throw new Error('Claude is still using its credential profile');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const profile of profiles) {
      await profile.queue;
      if (profile.count) throw new Error('Claude is still using its credential profile');
      await this.protect(profile);
    }
  }
}
module.exports = { ClaudeCredentials };
