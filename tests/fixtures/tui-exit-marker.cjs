/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Test-only instrumentation, loaded by NODE_OPTIONS in the real TUI process.
const marker = process.env.CIBYP_TEST_EXIT_MARKER;
if (marker)
  process.on('exit', (code) => {
    require('node:fs').writeSync(1, '\r\n' + marker + code + '\r\n');
  });
