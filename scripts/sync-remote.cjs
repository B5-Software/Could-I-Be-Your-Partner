/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'packages/remote');
const source = path.resolve(process.env.CIBYP_REMOTE_SOURCE || path.join(root, '../CIBYP-Remote'));
if (process.argv.includes('--check')) {
  const lock = JSON.parse(fs.readFileSync(path.join(destination, 'SOURCE.json'), 'utf8'));
  for (const [name, sha] of Object.entries(lock.files))
    if (
      createHash('sha256')
        .update(fs.readFileSync(path.join(destination, name)))
        .digest('hex') !== sha
    )
      throw new Error('Remote dependency integrity failed: ' + name);
  console.log('Remote dependency integrity verified');
} else {
  const files = [
    'package.json',
    'LICENSE',
    ...fs
      .readdirSync(path.join(source, 'src'))
      .filter((v) => /\.(?:js|ts)$/.test(v))
      .map((v) => 'src/' + v),
    ...fs
      .readdirSync(path.join(source, 'schema'))
      .filter((v) => v.endsWith('.json'))
      .map((v) => 'schema/' + v),
  ];
  const lock = {
    repository: 'https://github.com/B5-Software/CIBYP-Remote',
    version: JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version,
    files: {},
  };
  for (const name of files) {
    const data = fs.readFileSync(path.join(source, name));
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    lock.files[name] = createHash('sha256').update(data).digest('hex');
  }
  fs.writeFileSync(path.join(destination, 'SOURCE.json'), JSON.stringify(lock, null, 2) + '\n');
}
