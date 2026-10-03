/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// Electron loads its entry module without guaranteeing require.main === module.
// Use an explicit entrypoint, just as the packaged App's private host does.
require('./vm-desktop-entry').startDesktopHost();
