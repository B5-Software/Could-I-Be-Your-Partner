/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { updateGuestTrust } = require('../../src/main/vm/vm-security');
const { VmInstance } = require('../../src/main/vm/vm-instance');

test('VM tools remain gated until trust maintenance completes, including restored VMs', async () => {
  const instance = new VmInstance();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  instance.ssh = {
    connected: true,
    async exec() {
      calls++;
      await gate;
      return {
        ok: true,
        stdout:
          'CIBYP_SECURITY:{"caVersion":"20250419+deb13u1","updated":true,"distrusted":true}\n',
      };
    },
  };
  const states = [];
  instance.on('state', (status) => states.push(status.state));
  const first = instance._markReady('cold');
  assert.equal(instance.state, 'preparing');
  assert.equal(states.includes('ready'), false);
  release();
  await first;
  instance._restored = true;
  await instance._markReady('restored');
  assert.equal(calls, 2);
  assert.deepEqual(states, ['preparing', 'ready', 'preparing', 'ready']);
  assert.equal(instance.status().security.distrusted, true);
});

test('verified offline distrust keeps the VM usable and exposes pending package update', async () => {
  const instance = new VmInstance();
  instance.ssh = {
    async exec() {
      return { ok: true, stdout: 'CIBYP_SECURITY:{"updated":false,"distrusted":true}\n' };
    },
  };
  await instance._markReady('ready');
  assert.equal(instance.state, 'ready');
  assert.equal(instance.status().security.updated, false);
  assert.match(instance.stateDetail, /更新待重试/);
});

test('failed certificate verification never exposes a ready VM', async () => {
  const instance = new VmInstance();
  instance.ssh = {
    async exec() {
      return { ok: false, stderr: 'distrusted CA remains' };
    },
  };
  await assert.rejects(instance._markReady('ready'), /distrusted CA/);
  assert.notEqual(instance.state, 'ready');
  await assert.rejects(
    updateGuestTrust({
      exec: async () => ({ ok: true, stdout: 'CIBYP_SECURITY:{"distrusted":false}' }),
    }),
    /not verified/,
  );
  await assert.rejects(
    updateGuestTrust({ exec: async () => ({ ok: true, stdout: 'no result' }) }),
    /missing verification result/,
  );
});
