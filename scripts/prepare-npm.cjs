/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const { archiveRuntime, preparePackage } = require('./lib/npm-distribution.cjs');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const task = args.includes('--archive')
  ? archiveRuntime({
      dist: option('--dist') && path.resolve(option('--dist')),
      platform: option('--platform'),
      arch: option('--arch'),
    })
  : preparePackage({
      assets: option('--assets') && path.resolve(option('--assets')),
      output: option('--output') && path.resolve(option('--output')),
    });
task
  .then((result) =>
    console.log(
      `[npm] Prepared ${result.version}${result.platform ? ` (${result.platform}-${result.arch})` : ' package'}`,
    ),
  )
  .catch((error) => {
    console.error('[npm]', error.message);
    process.exitCode = 1;
  });
