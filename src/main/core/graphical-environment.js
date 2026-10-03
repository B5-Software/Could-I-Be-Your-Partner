/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

function canConnect(address) {
  return new Promise((resolve) => {
    const socket = net.connect(address);
    const finish = (available) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(800, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}

async function hasGraphicalEnvironment({
  platform = process.platform,
  env = process.env,
  connect = canConnect,
  run = execute,
  uid = () => process.getuid(),
} = {}) {
  if (env.CIBYP_NO_GUI === '1') return false;
  try {
    if (platform === 'win32') {
      if (env.SSH_CONNECTION || env.SSH_TTY || env.SESSIONNAME === 'Services') return false;
      // Windows services and disconnected desktops can have USERPROFILE and
      // SESSIONNAME but cannot show a window. Probe the current input desktop.
      const powershell = path.join(
        env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CibypDesktop { [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access); [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop); }'; $desktop = [CibypDesktop]::OpenInputDesktop(0, $false, 1); if ($desktop -eq [IntPtr]::Zero) { exit 1 }; [void][CibypDesktop]::CloseDesktop($desktop)`;
      await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 5000,
        windowsHide: true,
      });
      return true;
    }
    if (platform === 'darwin') {
      // A GUI launchd domain exists only for a logged-in graphical session.
      await run('/bin/launchctl', ['print', `gui/${uid()}`], {
        timeout: 2000,
        maxBuffer: 1024 * 1024,
      });
      return true;
    }
    if (platform !== 'linux') return false;
    if (env.WAYLAND_DISPLAY) {
      const socket = path.isAbsolute(env.WAYLAND_DISPLAY)
        ? env.WAYLAND_DISPLAY
        : env.XDG_RUNTIME_DIR && path.join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY);
      if (socket && fs.existsSync(socket) && (await connect(socket))) return true;
    }
    const display = /^(.*):(\d+)(?:\.\d+)?$/.exec(env.DISPLAY || '');
    if (!display) return false;
    const host = display[1].replace(/^\[(.*)\]$/, '$1');
    const address =
      !host || host === 'unix' || host.endsWith('/unix')
        ? `/tmp/.X11-unix/X${Number(display[2])}`
        : { host, port: 6000 + Number(display[2]) };
    if (!(await connect(address))) return false;
    // When present, also check authentication. Do not mistake a stale DISPLAY
    // or an inaccessible X server for a usable graphical environment.
    try {
      await run('xdpyinfo', ['-display', env.DISPLAY], { timeout: 2000 });
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { hasGraphicalEnvironment };
