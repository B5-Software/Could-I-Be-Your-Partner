/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { performance } = require('node:perf_hooks');
// One small outbound budget for every public market stream in this backend.
class SubscriptionPacer {
  constructor({
    now = () => performance.now(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.now = now;
    this.wait = wait;
    this.chain = Promise.resolve();
    this.last = -Infinity;
    this.pending = 0;
  }
  run(send) {
    if (this.pending >= 64) return Promise.reject(Error('SOURCE_SUBSCRIBE_QUEUE_FULL'));
    this.pending++;
    const task = this.chain.then(async () => {
      const delay = this.last + 250 - this.now();
      if (delay > 0) await this.wait(delay);
      if (send() !== false) this.last = this.now();
    });
    this.chain = task.catch(() => {});
    return task.finally(() => this.pending--);
  }
}
module.exports = { SubscriptionPacer };
