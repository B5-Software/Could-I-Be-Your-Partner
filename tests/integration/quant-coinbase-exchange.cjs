/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Shared backend and OS vault with isolated, signed HTTP fixtures. No real credentials or orders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createHmac } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-coinbase-fixture-'));
const entry = process.argv.includes('--bundled')
  ? path.resolve('dist/node-core/core.cjs')
  : require.resolve('../../src/agent/node-host');
const profiles = {
  sandbox: '11111111-2222-3333-4444-555555555555',
  live: '22222222-2222-3333-4444-555555555555',
};
const secret = Buffer.alloc(64, 17).toString('base64');
const auth = (env) => ({ key: 'fixture-' + env, secret, passphrase: 'test-passphrase-' + env });
const respond = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const venueId = '44111111-2222-3333-4444-555555555555';
let host,
  savedOrder,
  remote404 = true,
  submits = 0,
  cancels = 0,
  estimated = '0.006',
  sandboxTransport,
  sandboxAccepted = false,
  sandboxAborted = false,
  liveTransport,
  liveAborted = false,
  liveReceipts = 0,
  lateClientId,
  waitForSecondCancel;
const liveOrders = new Map();
const liveCancellations = [];
const liveLookups = [];
const secondVenueId = '20000000-1111-2222-3333-444444444444';
const fixtureFetch = async (input, options = {}) => {
  const target = new URL(input);
  const env = {
    'api-public.sandbox.exchange.coinbase.com': 'sandbox',
    'api.exchange.coinbase.com': 'live',
  }[target.hostname];
  assert.ok(env, 'Only fixture hosts are permitted');
  const method = options.method,
    route = target.pathname,
    payload = options.body || '';
  assert.equal(options.redirect, 'error');
  if (route.startsWith('/products/')) {
    assert.equal(options.headers['CB-ACCESS-KEY'], undefined);
    return respond({
      id: 'ETH-USD',
      base_currency: 'ETH',
      quote_currency: 'USD',
      status: 'online',
      cancel_only: false,
      auction_mode: false,
      quote_increment: '0.01',
      base_increment: '0.00000001',
      min_market_funds: '10',
    });
  }
  assert.equal(options.headers['CB-ACCESS-KEY'], auth(env).key);
  assert.equal(options.headers['CB-ACCESS-PASSPHRASE'], auth(env).passphrase);
  const timestamp = options.headers['CB-ACCESS-TIMESTAMP'];
  assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 30);
  assert.equal(
    options.headers['CB-ACCESS-SIGN'],
    createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(timestamp + method + route + payload)
      .digest('base64'),
  );
  if (route === '/accounts')
    return respond(
      ['USD', 'ETH'].map((currency) => ({
        currency,
        available: currency === 'USD' ? '1000' : '0.5',
        trading_enabled: true,
        profile_id: profiles[env],
      })),
    );
  if (route === '/fees') return respond({ maker_fee_rate: '0.004', taker_fee_rate: estimated });
  if (method === 'POST' && route === '/orders') {
    if (env === 'live') {
      const request = JSON.parse(payload);
      if (liveReceipts > 0) {
        const venue = liveReceipts === 1 ? secondVenueId : '10000000-1111-2222-3333-444444444444';
        liveReceipts--;
        const order = {
          ...request,
          id: venue,
          profile_id: profiles.live,
          status: 'open',
          filled_size: '0.025',
          executed_value: '50',
          fill_fees: '0.2',
          settled: false,
        };
        liveOrders.set(venue, order);
        return respond(order);
      }
      assert.ok(liveTransport, 'Production submission must remain blocked');
      lateClientId = request.client_oid;
      return new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            liveAborted = true;
            reject(options.signal.reason);
          },
          { once: true },
        );
        liveTransport();
      });
    }
    submits++;
    const request = JSON.parse(payload);
    const durable = host.runtime.quantService.exchangeOrders.orders.find(
      (entry) => entry.clientId === request.client_oid,
    );
    assert.equal(durable.status, 'submitting');
    assert.deepEqual(request, {
      type: 'limit',
      time_in_force: 'GTC',
      product_id: 'ETH-USD',
      side: durable.side,
      size: durable.size,
      price: durable.price,
      post_only: durable.postOnly,
      client_oid: durable.clientId,
    });
    assert.ok(
      fs
        .readFileSync(host.runtime.quantService.exchangeOrders.file, 'utf8')
        .includes(request.client_oid),
    );
    savedOrder = {
      ...request,
      id: venueId,
      profile_id: profiles.sandbox,
      status: 'open',
      filled_size: '0.025',
      executed_value: '50',
      fill_fees: '0.2',
      settled: false,
    };
    if (sandboxTransport)
      return new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            sandboxAborted = true;
            reject(options.signal.reason);
          },
          { once: true },
        );
        sandboxTransport();
      });
    if (sandboxAccepted) return respond(savedOrder);
    throw new Error('fixture dropped an accepted response');
  }
  if (env === 'live' && route.startsWith('/orders/')) {
    const reference = route.slice('/orders/'.length);
    if (method === 'GET') {
      liveLookups.push(reference);
      const known = liveOrders.get(reference);
      return known ? respond(known) : respond({}, 404);
    }
    assert.equal(method, 'DELETE');
    assert.equal(target.searchParams.get('product_id'), 'ETH-USD');
    const inFlightTarget = reference === 'client:' + lateClientId;
    const saved = liveOrders.get(reference);
    assert.ok(inFlightTarget || saved, 'Only exact tracked order identifiers can be canceled');
    const journal = JSON.parse(
      fs.readFileSync(host.runtime.quantService.exchangeOrders.file, 'utf8'),
    );
    const clientId = saved?.client_oid || lateClientId;
    assert.ok(journal.cancelBatch.targets.includes(clientId));
    assert.equal(journal.orders.find((order) => order.clientId === clientId).status, 'canceling');
    liveCancellations.push(reference);
    if (reference === secondVenueId) {
      if (waitForSecondCancel)
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
          waitForSecondCancel();
        });
      return respond({}, 503);
    }
    if (saved) Object.assign(saved, { status: 'done', done_reason: 'canceled' });
    return respond(saved ? reference : lateClientId);
  }
  assert.equal(env, 'sandbox');
  if (method === 'GET' && route === '/orders/client:' + savedOrder?.client_oid)
    return remote404 ? respond({}, 404) : respond(savedOrder);
  if (method === 'GET' && route === '/orders/' + venueId) return respond(savedOrder);
  if (method === 'DELETE' && route === '/orders/' + venueId) {
    assert.equal(target.searchParams.get('product_id'), 'ETH-USD');
    cancels++;
    if (cancels === 2) {
      const { orders } = JSON.parse(fs.readFileSync(host.runtime.quantService.exchangeOrders.file));
      const row = orders.find((entry) => entry.clientId === savedOrder.client_oid);
      assert.equal(row.status, 'canceling');
      assert.equal(row.cancellations[0].transport, 'rest');
      assert.equal(row.cancellations[0].outcome, undefined);
      Object.assign(savedOrder, { status: 'done', done_reason: 'canceled' });
    }
    return respond(venueId);
  }
  throw Error('Unexpected fixture route ' + method + ' ' + route);
};
globalThis.fetch = fixtureFetch;
require('undici').fetch = fixtureFetch;

const rpc = (action, input = {}) =>
  host.dispatch({ method: 'quant:request', args: [action, input] });
const open = async () => {
  host = await require(entry).createNodeRuntime({
    dataDir: directory,
    workspaceRoot: path.join(directory, 'workspaces'),
    settings: {
      onboardingCompleted: true,
      language: 'en',
      runtime: { location: 'host' },
      automaticMemory: { enabled: false },
    },
  });
  // The bundled host has its own Undici copy and installs a proxy wrapper at boot.
  globalThis.fetch = fixtureFetch;
};
async function main() {
  await open();
  const project = await rpc('workspace.create', {
    venue: 'coinbase',
    product: 'ETH-USD',
    name: 'Exchange protocol fixture',
  });
  const context = require('../../src/main/services/wallet/agent-scopes').rootContext(project.id);
  const exchange = (action, input = {}, env = 'sandbox') =>
    rpc('exchange.' + action, { id: project.id, env, ...input });
  assert.equal((await exchange('list')).configured, false);
  assert.deepEqual(await exchange('connect', auth('sandbox')), { configured: true });
  assert.deepEqual(await exchange('connect', auth('live'), 'live'), { configured: true });
  const file = path.join(host.runtime.quantService.directory, 'coinbase-sandbox.vault.json');
  const vault = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(vault).protection, 'dpapi');
  assert.ok(!vault.includes(secret) && !vault.includes(auth('sandbox').passphrase));
  await assert.rejects(
    host.runtime.quantService.request(
      'exchange.connect',
      { id: project.id, env: 'sandbox', ...auth('sandbox') },
      { agentContext: context },
    ),
    /EXCHANGE_HUMAN_REQUIRED/,
  );
  const order = { price: '2000', size: '0.1', side: 'buy', postOnly: true };
  await assert.rejects(
    exchange('preview', { ...order, price: '2000.001', operationId: 'bad-price' }),
    /EXCHANGE_ORDER_INCREMENT/,
  );
  const draft = await exchange('preview', { ...order, operationId: 'first' });
  assert.equal(draft.notional, '200');
  assert.equal(draft.estimatedFee, '1.2');
  assert.equal((await exchange('list')).drafts[0].reviewId, draft.reviewId);
  const confirmation = { reviewId: draft.reviewId, specHash: draft.specHash, ack: 'PLACE ORDER' };
  await assert.rejects(
    exchange('confirm', { ...confirmation, ack: 'yes' }),
    /EXCHANGE_REVIEW_CHANGED/,
  );
  estimated = '0.007';
  await assert.rejects(exchange('confirm', confirmation), /EXCHANGE_REVIEW_CHANGED/);
  assert.equal(submits, 0);
  estimated = '0.006';
  const result = await exchange('confirm', confirmation);
  assert.equal(result.status, 'submit-unknown');
  assert.equal((await exchange('confirm', confirmation)).clientId, result.clientId);
  assert.equal(submits, 1);
  const ledger = host.runtime.quantService.exchangeOrders.file;
  await host.close();
  const { orders } = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  fs.writeFileSync(
    ledger,
    JSON.stringify({
      version: 1,
      orders,
      sha256: createHash('sha256').update(JSON.stringify(orders)).digest('hex'),
    }),
  );
  await open();
  assert.equal((await exchange('list')).items[0].status, 'submit-unknown');
  const next = await exchange('preview', { ...order, operationId: 'second' });
  await assert.rejects(
    exchange('confirm', { reviewId: next.reviewId, specHash: next.specHash, ack: 'PLACE ORDER' }),
    /EXCHANGE_RECONCILE_FIRST/,
  );
  assert.equal(
    (await exchange('reconcile', { orderId: result.clientId })).status,
    'submit-unknown',
  );
  remote404 = false;
  const verified = await exchange('reconcile', { orderId: result.clientId });
  assert.equal(verified.status, 'partially-filled');
  assert.equal(verified.filledSize, '0.025');
  assert.equal(verified.venueId, venueId);
  await assert.rejects(
    exchange('cancel', { orderId: result.clientId, ack: 'no' }),
    /EXCHANGE_CANCEL_REVIEW/,
  );
  const canceled = await exchange('cancel', { orderId: result.clientId, ack: 'CANCEL ORDER' });
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.filledSize, '0.025');
  await assert.rejects(exchange('reconcile', { orderId: result.clientId }), /EXCHANGE_RESPONSE/);
  assert.equal((await exchange('list')).items[0].status, 'canceled');
  assert.equal(submits, 1);
  assert.equal(cancels, 1);

  const callAs = (action, input, agentContext = context, env = 'sandbox') =>
    host.runtime.quantService.request(
      'exchange.' + action,
      { id: project.id, env, ...input },
      { agentContext },
    );
  const grantTerms = {
    side: 'buy',
    postOnly: true,
    perOrder: '202',
    total: '402',
    maxOrders: 3,
    minutes: 60,
  };
  const grantAck = 'ALLOW EXCHANGE AGENT';
  await assert.rejects(
    exchange('prepareAuthority', { ...grantTerms, allowStopLimit: true }),
    /EXCHANGE_AUTHORITY_LIMITS/,
  );
  const requestOrder = { ...order, operationId: 'auto-1', grantId: 'no-grant' };
  await assert.rejects(callAs('submitAuthorized', requestOrder), /EXCHANGE_AUTHORITY_REQUIRED/);
  await assert.rejects(exchange('submitAuthorized', requestOrder), /EXCHANGE_AGENT_REQUIRED/);
  await assert.rejects(callAs('prepareAuthority', grantTerms), /EXCHANGE_HUMAN_REQUIRED/);
  const openGrant = async (terms, env = 'sandbox') => {
    const review = await exchange('prepareAuthority', terms, env);
    assert.equal(Object.hasOwn(review, 'credentialId'), false);
    const confirmation = { grantId: review.grantId, specHash: review.specHash, ack: grantAck };
    await assert.rejects(
      exchange('confirmAuthority', { ...confirmation, ack: 'yes' }, env),
      /EXCHANGE_AUTHORITY_REVIEW/,
    );
    await assert.rejects(
      exchange('confirmAuthority', { ...confirmation, specHash: 'wrong' }, env),
      /EXCHANGE_AUTHORITY_REVIEW/,
    );
    return exchange('confirmAuthority', confirmation, env);
  };
  const grant = await openGrant({ ...grantTerms, maxCancels: 1 });
  requestOrder.grantId = grant.grantId;
  const child = require('../../src/main/services/wallet/agent-scopes').deriveChild(
    context,
    'subagent:fixture',
  );
  await assert.rejects(callAs('submitAuthorized', requestOrder, child), /EXCHANGE_HUMAN_REQUIRED/);
  await assert.rejects(
    callAs('revokeAuthority', { grantId: grant.grantId }),
    /EXCHANGE_HUMAN_REQUIRED/,
  );
  await assert.rejects(
    callAs('submitAuthorized', requestOrder, context, 'live'),
    /EXCHANGE_AUTHORITY_REQUIRED/,
  );
  await assert.rejects(
    callAs('submitAuthorized', { ...requestOrder, postOnly: false }),
    /EXCHANGE_AUTHORITY_SCOPE/,
  );
  await assert.rejects(
    callAs('submitAuthorized', { ...requestOrder, price: '2020' }),
    /EXCHANGE_AUTHORITY_BUDGET/,
  );
  assert.equal(submits, 1);

  sandboxAccepted = true;
  const researchSession = (await rpc('chat.open', { id: project.id })).session.key;
  host.runtime.sessions
    .get(researchSession)
    .agent.contextManager.addUserMessage('Place the planned sandbox order.');
  const agentOrder = () =>
    host.runtime.sessions
      .get(researchSession)
      .agent.executeTool(
        'quant_exchange',
        { ...requestOrder, env: 'sandbox', action: 'submit_authorized' },
        { callId: 'fixture-auto' },
      );
  const auto = await agentOrder();
  assert.equal(auto.status, 'partially-filled');
  assert.equal(auto.grantId, grant.grantId);
  assert.equal(auto.authorizedDebit, '201.2');
  assert.equal((await agentOrder()).clientId, auto.clientId);
  assert.equal(submits, 2);
  const unapprovedStop = await host.runtime.sessions.get(researchSession).agent.executeTool(
    'quant_exchange',
    {
      ...requestOrder,
      operationId: 'fixture-stop-forbidden',
      env: 'sandbox',
      action: 'submit_authorized',
      stopPrice: '1900',
      triggerDirection: 'down',
    },
    { callId: 'fixture-stop' },
  );
  assert.equal(unapprovedStop.error, 'EXCHANGE_AUTHORITY_SCOPE');
  assert.equal(submits, 2);
  const amendThroughAgent = (extra) =>
    host.runtime.sessions.get(researchSession).agent.executeTool(
      'quant_exchange',
      {
        action: 'amend_authorized',
        env: 'sandbox',
        orderId: auto.clientId,
        grantId: grant.grantId,
        price: '2000',
        size: '0.11',
        ...extra,
      },
      { callId: 'fixture-amend' },
    );
  assert.equal((await amendThroughAgent({})).error, 'LIVE_OPERATION_ID_REQUIRED');
  assert.equal(
    (await amendThroughAgent({ operationId: 'fixture-native-amend' })).error,
    'EXCHANGE_AUTHORITY_SCOPE',
  );
  const capacity = () => exchange('list').then((r) => r.grants.find((g) => g.side === 'buy'));
  assert.equal((await capacity()).remaining, '200.8');
  await host.close();
  await open();
  assert.equal((await capacity()).ordersRemaining, 2);
  assert.equal((await capacity()).remaining, '200.8');
  await rpc('chat.open', { id: project.id });
  assert.equal((await agentOrder()).clientId, auto.clientId);
  await rpc('workspace.update', { id: project.id, market: { interval: 900 } });
  assert.equal((await capacity()).status, 'authorityActive');
  await assert.rejects(callAs('submitAuthorized', requestOrder), /EXCHANGE_AUTHORITY_BUDGET/);
  assert.equal(submits, 2);
  const cancelThroughAgent = (orderId = auto.clientId) =>
    host.runtime.sessions.get(researchSession).agent.executeTool(
      'quant_exchange',
      {
        action: 'cancel_authorized',
        env: 'sandbox',
        orderId,
        grantId: grant.grantId,
        operationId: 'cancel-fixture',
      },
      { callId: 'fixture-cancel' },
    );
  assert.equal((await cancelThroughAgent(result.clientId)).error, 'EXCHANGE_AUTHORITY_SCOPE');
  const autoCanceled = await cancelThroughAgent();
  assert.equal(autoCanceled.cancellation.outcome, 'canceled');
  assert.equal(autoCanceled.filledSize, '0.025');
  assert.equal((await capacity()).cancelsRemaining, 0);
  assert.equal((await capacity()).remaining, '200.8');
  await exchange('revokeAuthority', { grantId: grant.grantId });
  assert.equal((await capacity()).status, 'authorityRevoked');
  await assert.rejects(callAs('submitAuthorized', requestOrder), /EXCHANGE_AUTHORITY_INACTIVE/);
  await host.close();
  await open();
  await rpc('chat.open', { id: project.id });
  assert.equal(
    (await cancelThroughAgent()).cancellation.clientId,
    autoCanceled.cancellation.clientId,
  );
  assert.equal(cancels, 2);

  const sell = await openGrant({
    ...grantTerms,
    side: 'sell',
    perOrder: '0.1',
    total: '0.4',
    maxOrders: 1,
  });
  const sellOrder = { ...requestOrder, side: 'sell', grantId: sell.grantId, operationId: 'sell' };
  await assert.rejects(
    callAs('submitAuthorized', { ...sellOrder, size: '0.2' }),
    /EXCHANGE_AUTHORITY_BUDGET/,
  );
  const openedSell = await callAs('submitAuthorized', sellOrder);
  assert.equal(openedSell.authorizedDebit, '0.1');
  await assert.rejects(
    callAs('cancelAuthorized', {
      orderId: openedSell.clientId,
      grantId: sell.grantId,
      operationId: 'legacy-cancel',
    }),
    /EXCHANGE_AUTHORITY_SCOPE/,
  );
  await assert.rejects(
    callAs('submitAuthorized', { ...sellOrder, operationId: 'count' }),
    /EXCHANGE_AUTHORITY_BUDGET/,
  );

  const newGrant = await openGrant(grantTerms);
  const realNow = Date.now;
  try {
    Date.now = () => newGrant.expiresAt;
    await assert.rejects(
      callAs('submitAuthorized', { ...requestOrder, grantId: newGrant.grantId }),
      /EXCHANGE_AUTHORITY_INACTIVE/,
    );
  } finally {
    Date.now = realNow;
  }
  await exchange('connect', auth('sandbox'));
  assert.equal((await capacity()).status, 'authorityScopeChanged');
  const replacing = await openGrant(grantTerms);
  const enteredSandbox = Promise.withResolvers();
  sandboxTransport = enteredSandbox.resolve;
  const hanging = callAs('submitAuthorized', { ...requestOrder, grantId: replacing.grantId });
  await enteredSandbox.promise;
  assert.equal((await capacity()).remaining, '200.8');
  await exchange('revokeAuthority', { grantId: replacing.grantId });
  assert.equal(sandboxAborted, true);
  const unknownAuto = await hanging;
  assert.equal(unknownAuto.status, 'submit-unknown');
  assert.equal(unknownAuto.error, 'EXCHANGE_AUTHORITY_INACTIVE');
  assert.equal((await capacity()).remaining, '200.8');
  await host.close();
  await open();
  const recovered = await exchange('list');
  assert.equal(
    recovered.items.find((row) => row.clientId === unknownAuto.clientId).status,
    'submit-unknown',
  );
  assert.equal((await capacity()).status, 'authorityRevoked');
  assert.equal((await capacity()).remaining, '200.8');
  const newer = await openGrant(grantTerms);
  await assert.rejects(
    callAs('submitAuthorized', {
      ...requestOrder,
      operationId: 'replacement',
      grantId: newer.grantId,
    }),
    /EXCHANGE_RECONCILE_FIRST/,
  );
  const controller = host.runtime.quantService.exchangeOrders;
  const writer = controller.write;
  try {
    controller.write = () => {
      throw Error('fixture storage failure');
    };
    await assert.rejects(
      exchange('revokeAuthority', { grantId: newer.grantId }),
      /EXCHANGE_AUTHORITY_STORAGE/,
    );
    assert.equal((await capacity()).status, 'authorityRevocationPending');
    await assert.rejects(
      callAs('submitAuthorized', {
        ...requestOrder,
        operationId: 'blocked-by-fence',
        grantId: newer.grantId,
      }),
      /EXCHANGE_AUTHORITY_INACTIVE/,
    );
  } finally {
    controller.write = writer;
  }
  await exchange('revokeAuthority', { grantId: newer.grantId });
  assert.equal((await capacity()).status, 'authorityRevoked');

  const live = await exchange('preview', { ...order, operationId: 'live-gated' }, 'live');
  const liveGrant = await openGrant(grantTerms, 'live');
  const emergency = host.runtime.walletService.emergency.status();
  await host.dispatch({
    method: 'wallet:request',
    args: ['emergency.halt', { expectedGeneration: emergency.generation }],
  });
  await assert.rejects(
    exchange(
      'confirm',
      { reviewId: live.reviewId, specHash: live.specHash, ack: 'PLACE ORDER' },
      'live',
    ),
    /WALLET_EMERGENCY_STOPPED/,
  );
  assert.equal((await exchange('list', {}, 'live')).items.length, 0);
  await assert.rejects(
    callAs('submitAuthorized', { ...requestOrder, grantId: liveGrant.grantId }, context, 'live'),
    /WALLET_EMERGENCY_STOPPED/,
  );
  const reset = await host.dispatch({ method: 'wallet:request', args: ['emergency.challenge'] });
  await host.dispatch({
    method: 'wallet:request',
    args: ['emergency.reset', { challengeId: reset.id, ack: 'RESET LIVE', confirmed: true }],
  });
  await assert.rejects(
    callAs('submitAuthorized', { ...requestOrder, grantId: liveGrant.grantId }, context, 'live'),
    /WALLET_EMERGENCY_CHANGED/,
  );
  liveReceipts = 2;
  const existingLive = [];
  for (const operationId of ['open-live-one', 'open-live-two']) {
    const preview = await exchange('preview', { ...order, operationId }, 'live');
    const submitted = await exchange(
      'confirm',
      { reviewId: preview.reviewId, specHash: preview.specHash, ack: 'PLACE ORDER' },
      'live',
    );
    assert.equal(submitted.status, 'partially-filled');
    existingLive.push(submitted);
  }
  const inFlight = await exchange('preview', { ...order, operationId: 'live-transport' }, 'live');
  const entered = new Promise((resolve) => {
    liveTransport = resolve;
  });
  const pending = exchange(
    'confirm',
    { reviewId: inFlight.reviewId, specHash: inFlight.specHash, ack: 'PLACE ORDER' },
    'live',
  );
  let timer;
  try {
    await Promise.race([
      entered,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Live fixture did not reach transport')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const stop = await host.dispatch({
    method: 'wallet:request',
    args: [
      'emergency.halt',
      {
        expectedGeneration: host.runtime.walletService.emergency.generation,
        cancelExchangeOrders: true,
      },
    ],
  });
  assert.equal(stop.exchangeCancel.phase, 'running');
  assert.equal(stop.exchangeCancel.targeted, 3);
  assert.equal(liveAborted, true);
  const held = await pending;
  assert.equal(held.status, 'submit-unknown');
  assert.equal(held.error, 'WALLET_EMERGENCY_STOPPED');
  const wallet = (action, input) =>
    host.dispatch({ method: 'wallet:request', args: [action, input] });
  const waitForPhase = async (phase) => {
    for (let i = 0; i < 200; i++) {
      const current = (await wallet('emergency.status')).exchangeCancel;
      if (current?.phase === phase) return current;
      await require('node:timers/promises').setTimeout(25);
    }
    throw Error('Timed out waiting for cancellation phase ' + phase);
  };
  const partial = await waitForPhase('attention');
  assert.deepEqual(partial, {
    phase: 'attention',
    targeted: 3,
    canceled: 2,
    remaining: 1,
    error: 'EXCHANGE_HTTP',
  });
  assert.ok(liveCancellations.includes('client:' + held.clientId));
  assert.equal(cancels, 2, 'Emergency stop must leave the sandbox untouched');
  assert.equal(
    (await exchange('list', {}, 'live')).items.find(
      (row) => row.clientId === existingLive[0].clientId,
    ).filledSize,
    '0.025',
  );
  assert.equal(
    (
      await wallet('emergency.halt', {
        expectedGeneration: stop.generation,
        cancelExchangeOrders: true,
      })
    ).exchangeCancel.phase,
    'attention',
  );
  assert.equal(liveCancellations.length, 3);

  const secondCancel = Promise.withResolvers();
  waitForSecondCancel = secondCancel.resolve;
  const retry = await wallet('emergency.cancelExchange', { expectedGeneration: stop.generation });
  assert.equal(retry.exchangeCancel.phase, 'running');
  await assert.rejects(wallet('emergency.challenge'), /EXCHANGE_EMERGENCY_RUNNING/);
  await secondCancel.promise;
  await host.close();
  const alreadySent = liveCancellations.length;
  const firstLookups = liveLookups.length;
  const filledByVenue = liveOrders.get(secondVenueId);
  Object.assign(filledByVenue, {
    status: 'done',
    done_reason: 'filled',
    filled_size: '0.1',
    executed_value: '200',
    fill_fees: '0.8',
    settled: true,
  });
  await open();
  const final = await waitForPhase('complete');
  assert.deepEqual(final, {
    phase: 'complete',
    targeted: 3,
    canceled: 2,
    remaining: 0,
    error: null,
  });
  assert.deepEqual(liveLookups.slice(firstLookups), [secondVenueId]);
  assert.equal(
    liveCancellations.length,
    alreadySent,
    'Recovery reads final fills instead of re-canceling',
  );
  assert.equal(
    (await exchange('list', {}, 'live')).items.find((row) => row.venueId === secondVenueId).status,
    'filled',
  );
  assert.equal((await wallet('emergency.status')).generation, stop.generation);
  console.log(
    '[exchange] PASS: authenticated orders, durable Agent authority, global stop, partial live cancellation, and interrupted batch recovery',
  );
}
if (process.platform === 'win32') {
  main()
    .catch((error) => {
      console.error(error.stack);
      process.exitCode = 1;
    })
    .finally(async () => {
      await host?.close();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('cibyp-coinbase-fixture-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
} else {
  fs.rmdirSync(directory);
  console.log('[exchange] SKIP: this fixture uses Windows DPAPI');
}
