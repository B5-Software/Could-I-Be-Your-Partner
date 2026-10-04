/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { ensureRuntime } = require('./runtime.cjs');
const { registerDesktop } = require('./desktop.cjs');

async function install() {
  // A sudo global installation must create the invoking user's launcher/cache.
  if (
    process.platform !== 'win32' &&
    process.getuid?.() === 0 &&
    /^[1-9]\d*$/.test(process.env.SUDO_UID || '') &&
    /^\d+$/.test(process.env.SUDO_GID || '')
  ) {
    process.setgid(Number(process.env.SUDO_GID));
    process.setuid(Number(process.env.SUDO_UID));
    const home = require('node:os').userInfo().homedir;
    const path = require('node:path');
    process.env.CIBYP_CACHE_DIR = path.join(
      home,
      process.platform === 'darwin' ? 'Library/Caches/cibyp/npm' : '.cache/cibyp/npm',
    );
    process.env.XDG_DATA_HOME = path.join(home, '.local/share');
  }
  const manifest = require('../runtime.json');
  if (manifest.version !== require('../package.json').version)
    throw new Error('Mismatched npm/runtime version');
  const runtime = await ensureRuntime(manifest);
  try {
    const shortcut = await registerDesktop(runtime, {
      home: require('node:os').userInfo().homedir,
    });
    console.error('[cibyp] GUI launcher registered: ' + shortcut);
  } catch (error) {
    // CLI/TUI and the complete runtime remain usable on headless/read-only desktops.
    console.error(
      '[cibyp] Desktop registration failed: ' +
        error.message +
        '. Retry with cibyp --install-only.',
    );
  }
}

if (require.main === module)
  install().catch((error) => {
    console.error('[cibyp] Installation failed:', error.message);
    process.exitCode = 1;
  });
module.exports = { install };
