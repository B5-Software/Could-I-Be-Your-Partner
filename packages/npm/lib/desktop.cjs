/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inside, cacheDirectory } = require('./runtime.cjs');
const crypto = require('node:crypto');
const execute = promisify(execFile);
const productName = 'Could I Be Your Partner';

function desktopQuote(value) {
  return '"' + value.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%') + '"';
}
function powershellQuote(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}
function shellQuote(value) {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
async function desktopLauncher(env, platform) {
  const pkg = require('../package.json');
  const base = cacheDirectory(env, platform);
  const directory = inside(base, 'launcher-' + pkg.version);
  try {
    const existing = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    if (existing.version === pkg.version) return inside(directory, 'bin/cibyp.cjs');
  } catch {
    /* Create the stable copy below; npx may remove its original package. */
  }
  const staging = inside(base, 'launcher-staging-' + crypto.randomUUID());
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const name of ['bin', 'lib', 'package.json'])
      await fs.cp(path.join(__dirname, '..', name), path.join(staging, name), { recursive: true });
    await fs.rename(staging, directory).catch(async (error) => {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      const current = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (current.version !== pkg.version) throw error;
    });
    return inside(directory, 'bin/cibyp.cjs');
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function registerDesktop(
  runtime,
  { platform = process.platform, env = process.env, home = os.homedir(), run = execute } = {},
) {
  const executable = inside(runtime.directory, runtime.asset.executable);
  const launcher = await desktopLauncher(env, platform);
  const node = inside(runtime.directory, runtime.asset.node);
  if (platform === 'win32') {
    const programs = path.resolve(
      env.CIBYP_DESKTOP_DIR || env.APPDATA || path.join(home, 'AppData/Roaming'),
      'Microsoft/Windows/Start Menu/Programs',
    );
    await fs.mkdir(programs, { recursive: true });
    const shortcut = path.join(programs, productName + '.lnk');
    // Encode values as data; never interpolate paths into PowerShell code.
    const values = Buffer.from(
      JSON.stringify({
        shortcut,
        legacyShortcut: path.join(programs, 'CIBYP.lnk'),
        cache: cacheDirectory(env, platform),
        executable,
        directory: runtime.directory,
        arguments:
          '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' +
          Buffer.from(
            '& ' + powershellQuote(node) + ' ' + powershellQuote(launcher) + ' --desktop',
            'utf16le',
          ).toString('base64'),
      }),
    ).toString('base64');
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
          values +
          "'))|ConvertFrom-Json; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($v.shortcut); $link.TargetPath=$PSHOME+'\\powershell.exe'; $link.Arguments=$v.arguments; $link.WorkingDirectory=$v.directory; $link.IconLocation=$v.executable+',0'; $link.Description='Could I Be Your Partner'; $link.Save(); if(Test-Path -LiteralPath $v.legacyShortcut){$old=$shell.CreateShortcut($v.legacyShortcut); $base=[IO.Path]::GetFullPath($v.cache).TrimEnd('\\')+'\\'; if($old.Description -eq 'Could I Be Your Partner' -and $old.WorkingDirectory.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -and $old.IconLocation.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -and $old.TargetPath.EndsWith('\\powershell.exe',[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $v.legacyShortcut}}",
      ],
      { windowsHide: true, timeout: 15000 },
    );
    return shortcut;
  }
  if (platform === 'darwin') {
    const applications = env.CIBYP_DESKTOP_DIR || path.join(home, 'Applications');
    await fs.mkdir(applications, { recursive: true });
    const shortcut = path.join(applications, productName + '.app');
    const legacy = path.join(applications, 'CIBYP.app');
    if (!runtime.asset.executable.includes('.app/'))
      throw new Error('Missing macOS application bundle');
    const existing = await fs.lstat(shortcut).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) {
      if (
        !existing.isDirectory() ||
        (await fs.readFile(path.join(shortcut, '.cibyp-managed'), 'utf8').catch(() => '')) !== 'npm'
      )
        throw new Error('An existing ' + shortcut + ' is not managed by npm');
    }
    const temporary = shortcut + '.tmp-' + process.pid;
    try {
      await fs.mkdir(path.join(temporary, 'Contents/MacOS'), { recursive: true });
      await fs.mkdir(path.join(temporary, 'Contents/Resources'), { recursive: true });
      await fs.writeFile(path.join(temporary, '.cibyp-managed'), 'npm');
      await fs.writeFile(
        path.join(temporary, 'Contents/MacOS/CIBYP'),
        '#!/bin/sh\nexec ' + shellQuote(node) + ' ' + shellQuote(launcher) + ' --desktop\n',
        { mode: 0o755 },
      );
      const resourceDirectory = inside(runtime.directory, runtime.asset.resources);
      const icon = (await fs.readdir(resourceDirectory).catch(() => [])).find((name) =>
        name.endsWith('.icns'),
      );
      if (icon)
        await fs.copyFile(
          path.join(resourceDirectory, icon),
          path.join(temporary, 'Contents/Resources/icon.icns'),
        );
      await fs.writeFile(
        path.join(temporary, 'Contents/Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.b5-software.cibyp.launcher</string><key>CFBundleName</key><string>Could I Be Your Partner</string><key>CFBundleDisplayName</key><string>Could I Be Your Partner</string><key>CFBundleExecutable</key><string>CIBYP</string><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
      );
      const previous = shortcut + '.previous-' + process.pid;
      if (existing) await fs.rename(shortcut, previous);
      try {
        await fs.rename(temporary, shortcut);
      } catch (error) {
        if (existing) await fs.rename(previous, shortcut);
        throw error;
      }
      if (existing) await fs.rm(previous, { recursive: true, force: true });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
    await run(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', shortcut],
      { timeout: 15000 },
    ).catch(() => {});
    const old = await fs.lstat(legacy).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (
      old?.isDirectory() &&
      !old.isSymbolicLink() &&
      (await fs.readFile(path.join(legacy, '.cibyp-managed'), 'utf8').catch(() => '')) === 'npm'
    ) {
      await run(
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
        ['-u', legacy],
        { timeout: 15000 },
      ).catch(() => {});
      await fs.rm(legacy, { recursive: true, force: true });
    }
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
    const entry = `[Desktop Entry]\nType=Application\nName=${productName}\nComment=Could I Be Your Partner\nExec=${desktopQuote(node)} ${desktopQuote(launcher)} --desktop %U\nIcon=${icon}\nTerminal=false\nCategories=Utility;Development;\nStartupWMClass=could-i-be-your-partner\nX-CIBYP-Managed=npm\n`;
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
