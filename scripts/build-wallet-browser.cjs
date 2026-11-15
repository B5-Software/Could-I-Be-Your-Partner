/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'),
  source = path.join(root, 'integrations/wallet-browser');
async function build(output = path.join(root, 'dist/wallet-browser')) {
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: true });
  const assets = ['manifest.json', 'popup.html', 'popup.css'];
  const entries = ['background', 'content', 'provider', 'popup'];
  for (const file of assets) fs.copyFileSync(path.join(source, file), path.join(output, file));
  for (const name of entries)
    await require('esbuild').build({
      entryPoints: [path.join(source, name + '.js')],
      outfile: path.join(output, name + '.js'),
      bundle: true,
      platform: 'browser',
      target: ['chrome121', 'firefox128'],
      format: 'iife',
      legalComments: 'eof',
    });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  const files = [...assets, ...entries.map((n) => n + '.js'), 'LICENSE'];
  const hashes = Object.fromEntries(
    files.sort().map((f) => [
      f,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(output, f)))
        .digest('hex'),
    ]),
  );
  fs.writeFileSync(
    path.join(output, 'build.json'),
    JSON.stringify({ schemaVersion: 1, protocol: 1, files: hashes }, null, 2) + '\n',
  );
  return output;
}
if (require.main === module)
  build(process.argv[2]).then(
    (p) => console.log('Built wallet browser extension: ' + p),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
module.exports = { build };
