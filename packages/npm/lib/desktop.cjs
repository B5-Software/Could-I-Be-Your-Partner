/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inside, cacheDirectory } = require('./runtime.cjs');
const execute = promisify(execFile);

function desktopQuote(value) {
  return '"' + value.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%') + '"';
}

async function registerDesktop(
  runtime,
  { platform = process.platform, env = process.env, home = os.homedir(), run = execute } = {},
) {
  const executable = inside(runtime.directory, runtime.asset.executable);
  if (platform === 'win32') {
    const programs = path.resolve(
      env.CIBYP_DESKTOP_DIR || env.APPDATA || path.join(home, 'AppData/Roaming'),
      'Microsoft/Windows/Start Menu/Programs',
    );
    await fs.mkdir(programs, { recursive: true });
    const shortcut = path.join(programs, 'CIBYP.lnk');
    // Encode values as data; never interpolate paths into PowerShell code.
    const values = Buffer.from(
      JSON.stringify({ shortcut, executable, directory: runtime.directory }),
    ).toString('base64');
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
          values +
          "'))|ConvertFrom-Json; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($v.shortcut); $link.TargetPath=$v.executable; $link.WorkingDirectory=$v.directory; $link.IconLocation=$v.executable+',0'; $link.Description='Could I Be Your Partner'; $link.Save()",
      ],
      { windowsHide: true, timeout: 15000 },
    );
    return shortcut;
  }
  if (platform === 'darwin') {
    const applications = env.CIBYP_DESKTOP_DIR || path.join(home, 'Applications');
    await fs.mkdir(applications, { recursive: true });
    const shortcut = path.join(applications, 'CIBYP.app');
    const bundle = executable.slice(0, executable.lastIndexOf('.app/')) + '.app';
    if (!executable.includes('.app/')) throw new Error('Missing macOS application bundle');
    const existing = await fs.lstat(shortcut).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) {
      if (!existing.isSymbolicLink())
        throw new Error('An existing ~/Applications/CIBYP.app is not managed by npm');
      const previous = await fs.readlink(shortcut);
      const relative = path.relative(
        cacheDirectory(env, platform),
        path.resolve(applications, previous),
      );
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('An existing CIBYP.app points outside the npm cache');
    }
    const temporary = shortcut + '.tmp-' + process.pid;
    try {
      await fs.symlink(bundle, temporary);
      await fs.rename(temporary, shortcut);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    await run(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', shortcut],
      { timeout: 15000 },
    ).catch(() => {});
    return shortcut;
  }
  if (platform === 'linux') {
    const applications = path.resolve(
      env.CIBYP_DESKTOP_DIR || env.XDG_DATA_HOME || path.join(home, '.local/share'),
      'applications',
    );
    await fs.mkdir(applications, { recursive: true });
    const shortcut = path.join(applications, 'cibyp.desktop');
    const previous = await fs.readFile(shortcut, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (previous && !previous.includes('X-CIBYP-Managed=npm'))
      throw new Error('An existing cibyp.desktop is not managed by npm');
    const pkg = inside(runtime.directory, runtime.asset.resources + '/app.asar.unpacked');
    const icon = path.join(pkg, 'assets/icons/icons/256x256.png');
    const entry = `[Desktop Entry]\nType=Application\nName=CIBYP\nComment=Could I Be Your Partner\nExec=${desktopQuote(inside(runtime.directory, runtime.asset.node))} ${desktopQuote(inside(runtime.directory, runtime.asset.entry))} gui %U\nIcon=${icon}\nTerminal=false\nCategories=Utility;Development;\nStartupWMClass=could-i-be-your-partner\nX-CIBYP-Managed=npm\n`;
    const temporary = shortcut + '.tmp-' + process.pid;
    try {
      await fs.writeFile(temporary, entry, { mode: 0o755 });
      await fs.rename(temporary, shortcut);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    await run('update-desktop-database', [applications], { timeout: 15000 }).catch(() => {});
    return shortcut;
  }
  throw new Error('Unsupported desktop platform: ' + platform);
}

module.exports = { registerDesktop, desktopQuote };
