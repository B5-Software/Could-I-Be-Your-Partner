/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { shellQuote } = require('../vm/vm-paths');

function shellConfiguration(settings, location) {
  const terminal = settings?.terminal || {};
  const config = location === 'vm' ? terminal.vm || {} : terminal;
  const args = config.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new Error('Shell arguments must be a JSON array of up to 32 strings');
  return {
    shell: config.shell || 'auto',
    customShellPath: String(config.customShellPath || '').trim(),
    args: [...args],
  };
}

function hostExecutable(raw, platform = process.platform, env = process.env) {
  let value = String(raw || '')
    .trim()
    .replace(/^"(.*)"$/, '$1');
  if (!value || value.includes('\0')) return null;
  value = value.replace(/^~(?=$|[/\\])/, env.HOME || env.USERPROFILE || os.homedir());
  if (platform === 'win32') value = value.replace(/%([^%]+)%/g, (match, key) => env[key] || match);
  const windows = platform === 'win32';
  const paths = (env.PATH || env.Path || '')
    .split(windows ? ';' : ':')
    .map((item) => item.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const names = windows && !path.win32.extname(value) ? [value + '.exe', value] : [value];
  const candidates = /[/\\]/.test(value)
    ? names
    : paths.flatMap((directory) => names.map((name) => path.join(directory, name)));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
      if (windows && !/\.exe$/i.test(candidate)) continue;
      return path.resolve(candidate);
    } catch {
      /* Try the next executable. */
    }
  }
  return null;
}

function resolveHostShell(settings, { platform = process.platform, env = process.env } = {}) {
  const config = shellConfiguration(settings, 'host');
  const windows = platform === 'win32';
  const ps5 = path.join(
    env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const pwsh = [
    'pwsh',
    path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell/7/pwsh.exe'),
  ];
  const candidates = windows
    ? {
        auto: [...pwsh, ps5, env.ComSpec || 'cmd.exe'],
        pwsh,
        powershell: [ps5, 'powershell'],
        cmd: [env.ComSpec || 'cmd.exe'],
        bash: ['bash', path.join(env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe')],
        zsh: ['zsh'],
      }
    : {
        auto: [env.SHELL, platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/sh'].filter(
          Boolean,
        ),
        bash: ['bash', '/bin/bash', '/usr/bin/bash'],
        zsh: ['zsh', '/bin/zsh', '/usr/bin/zsh'],
        pwsh: ['pwsh'],
      };
  const choices = config.shell === 'custom' ? [config.customShellPath] : candidates[config.shell];
  if (!choices) throw new Error(`Shell ${config.shell} is not supported on ${platform}`);
  const file = choices.map((value) => hostExecutable(value, platform, env)).find(Boolean);
  if (!file)
    throw new Error(
      `Host Shell executable is unavailable: ${config.shell === 'custom' ? config.customShellPath || '(empty path)' : config.shell}`,
    );
  return { file, args: config.args, location: 'host' };
}

async function resolveVmShell(settings, service) {
  const config = shellConfiguration(settings, 'vm');
  if (['cmd', 'powershell'].includes(config.shell))
    throw new Error(`Windows Shell ${config.shell} cannot run in the Linux VM`);
  const requested =
    config.shell === 'custom'
      ? config.customShellPath
      : config.shell === 'auto'
        ? 'bash'
        : config.shell;
  if (!requested || requested.includes('\0') || /^[a-z]:[/\\]|^\\\\/i.test(requested))
    throw new Error('VM Shell requires an executable path inside the Linux VM');
  if (!service) throw new Error('Virtual machine service is unavailable');
  if (!service.instance || service.instance.state !== 'ready') await service.start();
  if (!service.instance || service.instance.state !== 'ready')
    throw new Error('Virtual machine is not ready for Shell detection');
  const candidates = config.shell === 'auto' ? ['bash', 'sh'] : [requested];
  const script = `for candidate in ${candidates.map(shellQuote).join(' ')}; do
    case "$candidate" in */*) resolved="$candidate";; *) resolved=$(command -v -- "$candidate" 2>/dev/null);; esac
    if [ -f "$resolved" ] && [ -x "$resolved" ]; then printf '%s\\n' "$resolved"; exit 0; fi
  done
  exit 1`;
  const result = await service.instance.exec(script, { timeoutMs: 15000 });
  const file = String(result.stdout || '')
    .trim()
    .split(/\r?\n/)[0];
  if (!result.ok || !file?.startsWith('/'))
    throw new Error(`VM Shell executable is unavailable: ${requested}`);
  return {
    file,
    args: config.shell === 'auto' && !config.args.length ? ['-l'] : config.args,
    location: 'vm',
  };
}

function resolveTerminalShell(settings, location, service) {
  if (location === 'host') return Promise.resolve(resolveHostShell(settings));
  if (location === 'vm') return resolveVmShell(settings, service);
  throw new Error('Shell location must be host or vm');
}

module.exports = {
  shellConfiguration,
  hostExecutable,
  resolveHostShell,
  resolveVmShell,
  resolveTerminalShell,
};
