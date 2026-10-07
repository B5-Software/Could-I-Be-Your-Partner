/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// Node 24's bundled Undici 7 can crash on socket close while a large download is
// paused (nodejs/undici#5360). Use the fixed HTTP implementation in the isolated
// electron-builder process, including dependency downloaders and beforePack hooks.
require('build-undici').install();
