/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
try {
  const run = workerData.walkForward
    ? require('./walk-forward').runWalkForward
    : require('./backtest').runBacktest;
  parentPort.postMessage({ result: run(workerData.candles, workerData.config) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
