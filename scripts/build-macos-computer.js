/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function buildMacComputer(arch = process.arch) {
  if (process.platform !== 'darwin') return;
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const directory = path.join(__dirname, '../src/main/native/macos-computer');
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('node-gyp/bin/node-gyp.js'),
      'rebuild',
      `--directory=${directory}`,
      `--arch=${arch}`,
    ],
    { stdio: 'inherit', shell: false },
  );
  if (result.error || result.status !== 0)
    throw result.error || new Error(`macOS Computer Use build failed (${result.status})`);
  const output = path.join(directory, 'build/Release/cibyp_computer.node');
  if (!fs.existsSync(output)) throw new Error('macOS Computer Use native module was not produced');
  fs.copyFileSync(output, path.join(directory, 'cibyp_computer.node'));
  if (arch === process.arch) {
    const result = JSON.parse(require(output).invoke('permissions', '{}'));
    if (!result.ok) throw new Error('Native permission preflight failed');
    console.log('[computer] Native module loaded; permission preflight is silent:', result);
  }
}
module.exports = { buildMacComputer };
if (require.main === module) buildMacComputer(process.argv[2] || process.arch);
