/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const execution = new AsyncLocalStorage();
async function bounded(task, parentSignal, label = 'Plugin hook', timeoutMs = 30000) {
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        Object.assign(new Error(label + ' cancelled or timed out', { cause: signal.reason }), {
          code: 'PLUGIN_HOOK_CANCELLED',
        }),
      );
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
module.exports = { execution, currentExecution: () => execution.getStore() || {}, bounded };
