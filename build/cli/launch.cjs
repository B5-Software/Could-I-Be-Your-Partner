/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const resources = path.resolve(__dirname, '..');
const runtime = require('./runtime.json');
const executable = path.resolve(resources, runtime.executable);
const { launch } = require(path.join(resources, 'app.asar.unpacked/src/tui/launcher.js'));
launch(process.argv[2], process.argv.slice(3), { resources, executable }).catch((error) => {
  console.error('[cibyp] Startup failed:', error.message);
  process.exitCode = 1;
});
