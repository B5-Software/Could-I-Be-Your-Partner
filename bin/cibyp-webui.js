#!/usr/bin/env node
/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
require('../src/tui/launcher').launch('webui', process.argv.slice(2)).catch(error => { console.error('[cibyp-webui]', error.message); process.exitCode = 1; });
