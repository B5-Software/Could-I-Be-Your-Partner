/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebControlService } = require('../../src/main/backend-webui');
const { createEventBus } = require('../../src/main/core/event-bus');

test('public WebUI waits for VM readiness before opening its listener', async (t) => {
  const service = new WebControlService();
  let ready,
    starting = 0;
  service.attach(() => ({}), createEventBus(), null, {
    onStarting: () => starting++,
    bootState: () => ({ required: true, ready: false, progress: 45 }),
    waitUntilReady: () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  });
  service.configure({ password: 'test-only-password' });
  service.hashPassword = async () => 'test-hash';
  const result = service.start();
  t.after(() => service.stop());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starting, 1);
  assert.equal(service.status().starting, true);
  assert.equal(service.status().boot.progress, 45);
  assert.equal(service.backend, undefined);
  // Use an ephemeral port for this isolated listener.
  service.config.port = 0;
  ready();
  assert.equal((await result).running, true);
});

test('stopping during password hashing cancels startup instead of opening WebUI later', async () => {
  const service = new WebControlService();
  let finishHash,
    waited = 0;
  service.attach(() => ({}), createEventBus(), null, { waitUntilReady: () => waited++ });
  service.configure({ password: 'test-only-password' });
  service.hashPassword = () =>
    new Promise((resolve) => {
      finishHash = resolve;
    });
  const pending = service.start();
  const rejected = assert.rejects(pending, /abort/i);
  const stopped = service.stop();
  finishHash('test-hash');
  await rejected;
  await stopped;
  assert.equal(waited, 0);
  assert.equal(service.status().running, false);
  assert.equal(service.status().starting, false);
});
