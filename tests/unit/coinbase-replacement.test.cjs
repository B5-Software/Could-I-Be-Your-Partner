/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { ExchangeOrders } = require('../../src/main/services/quant/exchange-orders');
const { writeAtomic } = require('../../src/main/services/quant');

async function fixture(t, { env = 'sandbox' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-ex-replace-'));
  const account = { profileId: randomUUID(), credentialId: randomUUID() };
  const workspace = { id: 'quant-fixture', market: { venue: 'coinbase', product: 'ETH-USD' } };
  const updates = [];
  const remote = new Map();
  const controls = { available: '1000', fee: '0.006', stopped: false };
  const service = {
    directory,
    workspace: () => workspace,
    publish() {},
    getWallet: () => ({
      emergency: {
        assert: () => {
          if (controls.stopped) throw Error('WALLET_EMERGENCY_STOPPED');
          return '1';
        },
      },
    }),
  };
  const disk = () => JSON.parse(fs.readFileSync(path.join(directory, 'coinbase-orders.json')));
  const api = {
    product: async () => ({
      id: 'ETH-USD',
      base_currency: 'ETH',
      quote_currency: 'USD',
      status: 'online',
      cancel_only: false,
      quote_increment: '0.01',
      base_increment: '0.00000001',
      min_market_funds: '10',
    }),
    accounts: async () => [
      {
        currency: 'USD',
        profile_id: account.profileId,
        trading_enabled: true,
        available: controls.available,
      },
    ],
    fees: async () => ({ maker_fee_rate: '0.004', taker_fee_rate: controls.fee }),
    lookup: async (_env, _account, order) => {
      const row = remote.get(order.clientId);
      if (!row || controls.hiddenId === order.clientId)
        throw Object.assign(Error('EXCHANGE_HTTP'), { httpStatus: 404 });
      return structuredClone(row);
    },
    cancel: async (_env, _account, order, guard) => {
      guard();
      const saved = disk().orders.find((row) => row.clientId === order.clientId);
      assert.equal(saved.status, 'canceling');
      assert.equal(saved.replacement.filledSize, '0.02');
      const original = remote.get(order.clientId);
      assert.equal(original.id, order.venueId);
      updates.push('cancel');
      Object.assign(original, { status: 'done', done_reason: 'canceled', settled: true });
      await controls.onCancel?.(original);
      return order.venueId;
    },
    submit: async (_env, _account, body, guard) => {
      guard();
      const journal = disk();
      const row = journal.orders.find((order) => order.clientId === body.client_oid);
      assert.equal(row.status, 'submitting');
      if (row.replaces) {
        const original = journal.orders.find((value) => value.clientId === row.replaces);
        assert.equal(original.status, 'canceled');
        assert.equal(original.replacement.clientId, row.clientId);
        assert.equal(original.replacement.filledSize, original.filledSize);
      }
      updates.push('submit');
      if (controls.rejectSubmit)
        throw Object.assign(Error('EXCHANGE_RATE_LIMIT'), { httpStatus: 429 });
      const acknowledged = {
        ...body,
        profile_id: account.profileId,
        id: randomUUID(),
        status: 'open',
        filled_size: '0',
        executed_value: '0',
        fill_fees: '0',
        settled: false,
      };
      remote.set(body.client_oid, acknowledged);
      if (controls.dropSubmit) throw Error('fixture lost response');
      return acknowledged;
    },
  };
  let exchange;
  const restart = () => {
    exchange?.dispose();
    exchange = new ExchangeOrders(service, writeAtomic, {
      api,
      vault: () => ({ load: async () => account }),
    });
  };
  restart();
  t.after(() => {
    exchange.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (action, params = {}, context) =>
    exchange.request(action, { id: workspace.id, env, ...params }, context);
  const price = '2000';
  const review = await request('preview', {
    price,
    size: '0.1',
    side: 'buy',
    postOnly: true,
    operationId: 'old',
  });
  const original = await request('confirm', {
    reviewId: review.reviewId,
    specHash: review.specHash,
    ack: 'PLACE ORDER',
  });
  const orderId = original.clientId;
  Object.assign(remote.get(orderId), {
    filled_size: '0.02',
    executed_value: '40',
    fill_fees: '0.16',
  });
  updates.length = 0;
  const preview = () => request('previewReplacement', { orderId, price: '2010', size: '0.07' });
  const confirm = (draft, extra = {}) =>
    request('confirmReplacement', {
      orderId,
      reviewId: draft.reviewId,
      specHash: draft.specHash,
      ack: 'REPLACE ORDER',
      ...extra,
    });
  const getOld = async () => (await request('list')).items.find((row) => row.clientId === orderId);
  return { orderId, request, controls, updates, preview, confirm, restart, getOld, remote };
}

test('replacement uses signed-off terms, releases the old hold before funding checks and survives replay', async (t) => {
  const f = await fixture(t);
  f.controls.available = '10';
  f.controls.onCancel = () => {
    f.controls.available = '900';
  };
  const review = await f.preview();
  assert.equal(review.filledSize, '0.02');
  assert.equal(review.estimatedFee, '0.8442');
  assert.deepEqual(f.updates, []);
  await assert.rejects(f.confirm(review, { ack: 'PLACE ORDER' }), /EXCHANGE_REVIEW_CHANGED/);
  await assert.rejects(f.confirm(review, { specHash: 'other' }), /EXCHANGE_REVIEW_CHANGED/);
  await assert.rejects(
    f.request('confirmReplacement', {}, { agentContext: { workspaceId: 'quant-fixture' } }),
    /EXCHANGE_HUMAN_REQUIRED/,
  );
  assert.deepEqual(f.updates, []);
  const placed = await f.confirm(review);
  assert.equal(placed.clientId, review.reviewId);
  assert.equal(placed.replaces, f.orderId);
  assert.equal(placed.price, '2010');
  assert.equal(placed.size, '0.07');
  assert.equal(placed.postOnly, true);
  assert.equal((await f.getOld()).filledSize, '0.02');
  assert.deepEqual(f.updates, ['cancel', 'submit']);
  f.restart();
  assert.equal((await f.confirm(review)).clientId, placed.clientId);
  await assert.rejects(f.preview(), /EXCHANGE_REPLACE_UNAVAILABLE/);
  assert.deepEqual(f.updates, ['cancel', 'submit']);
});

test('stale fill evidence and changed fees stop the replacement before any cancellation', async (t) => {
  const f = await fixture(t);
  const review = await f.preview();
  f.controls.fee = '0.008';
  await assert.rejects(f.confirm(review), /EXCHANGE_REVIEW_CHANGED/);
  f.controls.fee = '0.006';
  f.remote.get(f.orderId).filled_size = '0.03';
  await assert.rejects(f.confirm(review), /EXCHANGE_REPLACE_CHANGED/);
  assert.deepEqual(f.updates, []);
});

test('missing original evidence pauses after cancellation and restarts only with fresh consent', async (t) => {
  const f = await fixture(t);
  f.controls.onCancel = () => {
    f.controls.hiddenId = f.orderId;
  };
  const draft = await f.preview();
  await assert.rejects(f.confirm(draft), /EXCHANGE_REPLACE_UNVERIFIED/);
  assert.deepEqual(f.updates, ['cancel']);
  f.restart();
  const awaiting = await f.getOld();
  assert.equal(awaiting.replacement.error, 'EXCHANGE_REPLACE_UNVERIFIED');
  assert.equal((await f.confirm(draft)).clientId, f.orderId);
  await assert.rejects(f.preview(), /EXCHANGE_REPLACE_UNAVAILABLE/);
  delete f.controls.hiddenId;
  await f.request('reconcile', { orderId: f.orderId });
  const fresh = await f.preview();
  assert.notEqual(fresh.reviewId, draft.reviewId);
  assert.equal(fresh.originalStatus, 'canceled');
  f.controls.dropSubmit = true;
  const unknown = await f.confirm(fresh);
  assert.equal(unknown.status, 'submit-unknown');
  f.restart();
  assert.equal((await f.confirm(fresh)).status, 'submit-unknown');
  assert.equal(
    (await f.request('reconcile', { orderId: unknown.clientId })).clientId,
    unknown.clientId,
  );
  await assert.rejects(f.preview(), /EXCHANGE_REPLACE_UNAVAILABLE/);
  assert.deepEqual(f.updates, ['cancel', 'submit']);
});

test('a late fill requires a fresh review of the new size', async (t) => {
  const f = await fixture(t, { env: 'live' });
  f.controls.onCancel = (order) => {
    order.filled_size = '0.03';
    order.executed_value = '60';
  };
  await assert.rejects(f.confirm(await f.preview()), /EXCHANGE_REPLACE_CHANGED/);
  assert.equal((await f.getOld()).filledSize, '0.03');
  assert.equal((await f.preview()).filledSize, '0.03');
  assert.deepEqual(f.updates, ['cancel']);
});

test('a live emergency halt between cancellation and submission fences the replacement', async (t) => {
  const f = await fixture(t, { env: 'live' });
  f.controls.onCancel = () => {
    f.controls.stopped = true;
  };
  await assert.rejects(f.confirm(await f.preview()), /WALLET_EMERGENCY_STOPPED/);
  assert.equal((await f.getOld()).status, 'canceled');
  assert.deepEqual(f.updates, ['cancel']);
});

test('a definite rejection permits a new review while preserving the rejected order', async (t) => {
  const f = await fixture(t);
  f.controls.rejectSubmit = true;
  const failed = await f.confirm(await f.preview());
  assert.equal(failed.status, 'rejected');
  f.restart();
  assert.equal((await f.getOld()).replacementAvailable, true);
  f.controls.rejectSubmit = false;
  const next = await f.confirm(await f.preview());
  assert.notEqual(next.clientId, failed.clientId);
  assert.equal(next.replaces, f.orderId);
  const history = await f.request('list');
  assert.equal(history.items.find((row) => row.clientId === failed.clientId).status, 'rejected');
  assert.deepEqual(f.updates, ['cancel', 'submit', 'submit']);
});
