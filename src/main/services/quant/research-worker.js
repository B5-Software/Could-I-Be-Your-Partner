/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
try {
  parentPort.postMessage({
    result: require('./backtest').runBacktest(workerData.candles, workerData.config),
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
