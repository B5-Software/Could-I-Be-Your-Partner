/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";

function aliasName(value) {
  const name = String(value || '').toLowerCase();
  if (
    !/^[a-z][a-z0-9_-]{0,39}$/.test(name) ||
    /(?:-code|-tui|-webui)$/.test(name) ||
    /^(?:cibyp|con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)
  )
    throw new Error(
      'Use a name starting with a letter (letters, digits, - and _). Do not use cibyp, reserved device names, -code or -tui suffixes.',
    );
  return name;
}

function aliasDirectory({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  return path.resolve(
    env.CIBYP_ALIAS_DIR ||
      (platform === 'win32'
        ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'CIBYP/bin')
        : path.join(home, '.local/bin')),
  );
}

async function readManifest(directory) {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(directory, '.cibyp-aliases.json'), 'utf8'),
    );
    if (value.owner !== 'cibyp' || value.version !== 1)
      throw new Error('Invalid CIBYP alias registry');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { owner: 'cibyp', version: 1, aliases: {} };
    throw error;
  }
}

async function saveManifest(directory, manifest) {
  const temp = path.join(directory, '.cibyp-aliases-' + crypto.randomUUID() + '.tmp');
  try {
    await fs.writeFile(temp, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, path.join(directory, '.cibyp-aliases.json'));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (!stat) continue;
      const owner = await fs
        .readFile(lock, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      let stale = !owner?.pid && Date.now() - stat.mtimeMs > 30000;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (failure) {
          stale = failure.code === 'ESRCH';
        }
      }
      if (!stale) throw new Error('Another alias operation is running. Retry after it finishes.');
      const latest = await fs.stat(lock).catch(() => null);
      if (latest?.ino === stat.ino && latest?.mtimeMs === stat.mtimeMs)
        await fs.rm(lock, { force: true });
    }
  }
  throw new Error('Could not acquire the alias registry lock. Retry.');
}

async function registerPath(
  directory,
  { platform = process.platform, env = process.env, home = os.homedir(), execute = run } = {},
) {
  const separator = platform === 'win32' ? ';' : ':';
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!(env.PATH || '').split(separator).some((item) => same(item, directory)))
    env.PATH = directory + separator + (env.PATH || '');
  if (platform === 'win32') {
    // User scope only: no elevation, no modification of the system PATH.
    const encoded = Buffer.from(directory, 'utf8').toString('base64');
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
          encoded +
          "')); $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not (@($p -split ';') -contains $d)){[Environment]::SetEnvironmentVariable('Path',($d+';'+$p),'User'); Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CibypEnvironment { [DllImport(\"user32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); }'; $r=[UIntPtr]::Zero; [void][CibypEnvironment]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,2000,[ref]$r)}",
      ],
      { windowsHide: true, timeout: 15000 },
    );
  } else {
    const line = '\n# CIBYP command aliases\nexport PATH=' + quote(directory) + ':"$PATH"\n';
    for (const file of [
      '.profile',
      ...(platform === 'darwin' ? ['.zprofile', '.zshrc'] : ['.bashrc', '.zshrc']),
    ]) {
      const target = path.join(home, file);
      const content = await fs.readFile(target, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      });
      if (!content.includes('export PATH=' + quote(directory) + ':'))
        await fs.appendFile(target, line, { mode: 0o600 });
    }
  }
}

function aliasFiles(name, target, platform) {
  const files = {};
  for (const [suffix, mode] of [
    ['', 'gui'],
    ['-code', 'code'],
    ['-tui', 'tui'],
    ['-webui', 'webui'],
  ]) {
    const command = name + suffix;
    const entry = target.entries[mode] || target.entries.tui;
    const args = [
      ...(target.arguments?.[mode] || []),
      ...(mode === 'webui' && !target.entries.webui ? ['--headless', '--web'] : []),
    ];
    const js = `#!/usr/bin/env node\n/* CIBYP managed alias: ${name} */\n'use strict';\nconst {spawn}=require('node:child_process');\nconst child=spawn(${JSON.stringify(target.node)},[${JSON.stringify(entry)},...${JSON.stringify(args)},...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});\nchild.on('error',e=>{console.error('[cibyp]',e.message);process.exitCode=1});\nchild.on('exit',(code,signal)=>{process.exitCode=code??1;if(signal)process.kill(process.pid,signal)});\n`;
    files[command + '.cjs'] = js;
    if (platform === 'win32') {
      if (/[\r\n"%]/.test(target.node))
        throw new Error(
          'Node executable path cannot be represented safely in a Windows command alias',
        );
      files[command + '.cmd'] =
        `@echo off\r\nrem CIBYP managed alias: ${name}\r\n"${target.node}" "%~dp0${command}.cjs" %*\r\nexit /b %errorlevel%\r\n`;
      files[command + '.ps1'] =
        `# CIBYP managed alias: ${name}\n& '${target.node.replace(/'/g, "''")}' (Join-Path $PSScriptRoot '${command}.cjs') @args\nexit $LASTEXITCODE\n`;
    } else {
      files[command] =
        `#!/bin/sh\n# CIBYP managed alias: ${name}\nexec ${quote(target.node)} ${quote(path.join(target.directory, command + '.cjs'))} "$@"\n`;
    }
  }
  return files;
}

async function manageAliases(args, target, options = {}) {
  const [action, rawName, ...extra] = args;
  if (extra.length || !['add', 'create', 'remove', 'delete', 'list'].includes(action))
    throw new Error('Usage: cibyp alias add <name> | remove <name> | list');
  const directory = aliasDirectory(options);
  await fs.mkdir(directory, { recursive: true });
  // Avoid overlapping add/remove operations corrupting the registry.
  const lock = path.join(directory, '.cibyp-aliases.lock');
  const handle = await acquireLock(lock);
  try {
    const manifest = await readManifest(directory);
    if (action === 'list') return { directory, names: Object.keys(manifest.aliases).sort() };
    const name = aliasName(rawName);
    const existing = manifest.aliases[name];
    if (action === 'remove' || action === 'delete') {
      if (!existing) throw new Error('Alias not found: ' + name);
      for (const [file, hash] of Object.entries(existing.files)) {
        if (path.basename(file) !== file) throw new Error('Invalid alias file');
        const data = await fs.readFile(path.join(directory, file)).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
        if (data && digest(data) !== hash)
          throw new Error('Alias file was changed; keeping it: ' + file);
      }
      for (const file of Object.keys(existing.files))
        await fs.rm(path.join(directory, file), { force: true });
      delete manifest.aliases[name];
      await saveManifest(directory, manifest);
      return { name, directory, removed: true };
    }
    if (existing) throw new Error('Alias already exists: ' + name);
    const files = aliasFiles(name, { ...target, directory }, options.platform || process.platform);
    // Preflight every file before writing any member of the alias family.
    for (const file of Object.keys(files)) {
      try {
        await fs.lstat(path.join(directory, file));
        throw new Error('Refusing to overwrite: ' + file);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    const created = [];
    try {
      for (const [file, data] of Object.entries(files)) {
        await fs.writeFile(path.join(directory, file), data, { flag: 'wx', mode: 0o755 });
        created.push(file);
      }
      if (options.persistPath !== false) await registerPath(directory, options);
      manifest.aliases[name] = {
        files: Object.fromEntries(
          Object.entries(files).map(([file, data]) => [file, digest(data)]),
        ),
      };
      await saveManifest(directory, manifest);
    } catch (error) {
      for (const file of created) await fs.rm(path.join(directory, file), { force: true });
      throw error;
    }
    return { name, directory, commands: [name, name + '-code', name + '-tui', name + '-webui'] };
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

async function aliasCommand(args, target, options) {
  const result = await manageAliases(args, target, options);
  console.log(
    result.names
      ? result.names.join('\n') || 'No CIBYP aliases.'
      : result.removed
        ? 'Removed ' + result.name + ', ' + result.name + '-code, ' + result.name + '-tui'
        : 'Created ' +
          result.commands.join(', ') +
          '\nLocation: ' +
          result.directory +
          '\nOpen a new terminal to use the commands.',
  );
  return result;
}

module.exports = {
  aliasName,
  aliasDirectory,
  aliasFiles,
  manageAliases,
  aliasCommand,
  registerPath,
};
