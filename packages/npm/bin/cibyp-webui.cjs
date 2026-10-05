#!/usr/bin/env node
/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
require('../lib/runtime.cjs')
  .main('webui')
  .catch((error) => {
    console.error('[cibyp]', error.message);
    process.exitCode = 1;
  });
