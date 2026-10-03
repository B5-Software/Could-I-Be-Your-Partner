/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { spawn } = require('node:child_process');

// Copying frontend text targets the terminal user's clipboard, independently
// of the Agent's VM clipboard tool. Pass text via stdin, never a shell command.
async function copyText(
  text,
  { platform = process.platform, env = process.env, spawnProcess = spawn } = {},
) {
  const commands =
    platform === 'win32'
      ? [
          [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-WindowStyle',
              'Hidden',
              '-Command',
              '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())',
            ],
          ],
        ]
      : platform === 'darwin'
        ? [['pbcopy', []]]
        : env.WAYLAND_DISPLAY
          ? [
              ['wl-copy', []],
              ['xclip', ['-selection', 'clipboard']],
            ]
          : [
              ['xclip', ['-selection', 'clipboard']],
              ['xsel', ['--clipboard', '--input']],
            ];
  for (const [command, args] of commands) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawnProcess(command, args, {
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Clipboard copy timed out'));
        }, 5000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error('Clipboard unavailable'));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(text, 'utf8');
      });
      return;
    } catch {
      /* Try the next clipboard provider installed on this desktop. */
    }
  }
  throw new Error('Clipboard unavailable; hold Shift to use terminal selection');
}

module.exports = { copyText };
