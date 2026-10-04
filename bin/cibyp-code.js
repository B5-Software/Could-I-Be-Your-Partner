#!/usr/bin/env node
/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
require('../src/tui/launcher').launch('code', process.argv.slice(2)).catch((error) => {
  console.error('[cibyp-code] Startup failed:', error.message);
  process.exitCode = 1;
});
