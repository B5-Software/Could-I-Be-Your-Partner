/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const lock = require('../integrations/quant/anvil-test-lock.json');
const root = path.resolve(__dirname, '..');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function prepare() {
  if (process.env.CIBYP_TEST_ANVIL) return path.resolve(process.env.CIBYP_TEST_ANVIL);
  const target = lock.targets[process.platform + '-' + process.arch];
  if (!target)
    throw Error('No official Anvil test binary for this target; set CIBYP_TEST_ANVIL explicitly');
  const directory = path.join(
    root,
    '.cache/quant-tools',
    lock.version,
    process.platform + '-' + process.arch,
  );
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  const marker = path.join(directory, 'verified.json');
  try {
    const verified = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (verified.archive === target.sha256 && sha(binary) === verified.binary) return binary;
  } catch {}
  const archive = path.join(directory, target.file);
  const url = `https://github.com/${lock.repository}/releases/download/v${lock.version}/${target.file}`;
  if (
    !fs.existsSync(archive) ||
    fs.statSync(archive).size !== target.size ||
    sha(archive) !== target.sha256
  ) {
    await require('../packages/npm/lib/download.cjs').downloadVerified(
      { ...target, url },
      archive,
      { concurrency: 4, candidates: [url] },
    );
  }
  if (sha(archive) !== target.sha256) throw Error('Anvil test archive checksum mismatch');
  if (process.platform === 'win32') {
    const entry = new (require('adm-zip'))(archive).getEntry('anvil.exe');
    if (!entry || entry.isDirectory) throw Error('Anvil binary missing');
    fs.writeFileSync(binary, entry.getData(), { mode: 0o700 });
  } else {
    await require('tar').x({
      file: archive,
      cwd: directory,
      filter: (name, entry) => ['anvil', './anvil'].includes(name) && entry.type === 'File',
    });
    if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink())
      throw Error('Anvil binary is not a regular file');
    fs.chmodSync(binary, 0o700);
  }
  fs.writeFileSync(marker, JSON.stringify({ archive: target.sha256, binary: sha(binary) }));
  return binary;
}
async function main() {
  const binary = await prepare();
  const bundled = process.argv.includes('--bundled');
  const core = path.join(root, 'dist/node-core/core.cjs');
  if (bundled && !fs.existsSync(core))
    throw Error('Build Node core before the bundled integration test');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(
          root,
          process.argv.includes('--execution')
            ? 'tests/integration/quant-live-execution.cjs'
            : 'tests/integration/quant-local-chain.cjs',
        ),
      ],
      {
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          CIBYP_TEST_ANVIL: binary,
          ...(bundled ? { CIBYP_TEST_NODE_BACKEND: core } : {}),
        },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  if (result) process.exitCode = result;
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { prepare };
