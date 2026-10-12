/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const { createApiFacade } = require('./api-facade');
const { api, dispose } = createApiFacade(ipcRenderer);
window.addEventListener('pagehide', dispose, { once: true });
contextBridge.exposeInMainWorld('api', api);
