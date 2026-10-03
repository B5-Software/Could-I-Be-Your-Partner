/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Build-time smoke test: a private profile and host runtime, no user App or VM.
const path = require('node:path');
const resources = path.resolve(__dirname, '..');
process.env.CIBYP_PACKAGED_RESOURCES = resources;
process.resourcesPath = resources;
const { bootNodeRuntime, waitForRuntime } = require(path.join(resources, 'app.asar.unpacked/src/tui/node-entry.js'));
const main = bootNodeRuntime(['--headless']);
waitForRuntime(main, 30000).then((runtime) => {
  if (!Array.isArray(runtime.listSessions())) throw new Error('Agent runtime unavailable');
  console.log('PACKAGED_RUNTIME_READY');
  process.exit(0);
}).catch((error) => { console.error(error); process.exit(1); });
