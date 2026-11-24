/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseUnits, formatUnits } = require('ethers');
const { AccountVault } = require('../account-vault');
const { CoinbaseExchange, environment, credentials, id } = require('./coinbase-exchange');
const { ExchangeEmergencyCancellation, isOpenOrder } = require('./exchange-emergency');
const { ExchangeOrderWatch } = require('./exchange-order-watch');
const { ExchangeFixSessions } = require('./exchange-fix-sessions');
const { executionStatus } = require('./coinbase-fix-session');

const SCALE = 10n ** 18n;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw Error(code);
};
const amount = (value, code = 'EXCHANGE_DECIMAL') => {
  if (typeof value !== 'string' || !/^\d{1,18}(?:\.\d{1,18})?$/.test(value)) fail(code);
  return parseUnits(value, 18);
};
const shown = (value) => formatUnits(value, 18).replace(/\.0$/, '');
const ceil = (num, den) => (num + den - 1n) / den;
const active = new Set(['open', 'pending', 'active', 'received', 'partially-filled']);
const terminal = new Set(['filled', 'canceled', 'rejected']);
const unknown = new Set([
  'submitting',
  'submit-unknown',
  'canceling',
  'cancel-unknown',
  'status-unknown',
  'amending',
  'amend-unknown',
]);
const stages = new Set([...active, ...terminal, ...unknown]);
const reviewActions = new Set(['list', 'preview', 'reconcile']);
const authorizedActions = new Set(['submitAuthorized', 'amendAuthorized', 'cancelAuthorized']);
const configured = (c) => c && id.test(c.profileId);
const isRoot = (context) =>
  context?.nodes?.length === 1 && context.nodes[0]?.subject === 'quant:' + context.workspaceId;
const binding = (account) => account?.credentialId || account?.profileId;
const sameScope = (left, right) => left.workspaceId === right.workspaceId && left.env === right.env;
const decimal = /^\d{1,18}(?:\.\d{1,18})?$/;
const directions = ['up', 'down'];
const triggerState = (order) => order.stopState || 'unverified';
const changedTerms = (left, right) =>
  left.price !== right.price ||
  left.size !== right.size ||
  left.stopPrice !== right.stopPrice ||
  left.stopLimitPrice !== right.stopLimitPrice;
const maxPrice = (order) => {
  const first = amount(order.price);
  const second = order.stopLimitPrice ? amount(order.stopLimitPrice) : first;
  return first > second ? first : second;
};
const allowsCondition = (grant, order) =>
  order.stopLimitPrice
    ? grant.allowTpsl === true
    : !order.stopPrice || grant.allowStopLimit === true;
const canAmend = (order) =>
  order.fix &&
  !order.fix.pending &&
  active.has(order.status) &&
  (!order.stopPrice || triggerState(order) !== 'triggered');
const amendments = (order) => [
  ...(order.fix?.amendments || []),
  ...(order.fix?.pending ? [order.fix.pending] : []),
];
const cancellations = (order) => order.cancellations || [];
const pendingCancellation = (order) => {
  const latest = cancellations(order).at(-1);
  return latest && !latest.outcome ? latest : null;
};
const finishCancellation = (order, outcome) => ({
  ...order,
  cancellations: [
    ...cancellations(order).slice(0, -1),
    { ...pendingCancellation(order), outcome, completedAt: Date.now() },
  ],
});
const ownsOrder = (grant, order) =>
  order.grantId === grant.grantId &&
  (order.fix
    ? grant.transport === 'fix' && order.fix.currentGrantId === grant.grantId
    : grant.transport !== 'fix');
const humanCanCancel = (order) =>
  Boolean(
    order.venueId &&
    !terminal.has(order.status) &&
    (active.has(order.status) || order.fix?.pending || pendingCancellation(order)),
  );
const cancellationOutcomes = new Set(['canceled', 'closed', 'rejected', 'skipped']);
function validCancellationRecord(order) {
  if (order.cancellations === undefined) return true;
  return (
    Array.isArray(order.cancellations) &&
    order.cancellations.length <= 8000 &&
    order.cancellations.every(
      (row, index, entries) =>
        row &&
        id.test(row.clientId) &&
        id.test(row.grantId) &&
        row.grantId === order.grantId &&
        row.transport === (order.fix ? 'fix' : 'rest') &&
        /^[\w:-]{1,128}$/.test(row.operationId || '') &&
        /^[0-9a-f]{64}$/.test(row.specHash || '') &&
        (cancellationOutcomes.has(row.outcome) ||
          (row.outcome === undefined &&
            index === entries.length - 1 &&
            ['canceling', 'cancel-unknown'].includes(order.status))),
    )
  );
}

function amendmentDebit(current, spec, rate) {
  const filled = amount(current.filledSize);
  const oldRemaining = amount(current.size) - filled;
  const newRemaining = amount(spec.size) - filled;
  const added = newRemaining > oldRemaining ? newRemaining - oldRemaining : 0n;
  if (current.side === 'sell') return added;
  const newPrice = maxPrice(spec);
  const newFeeRate = amount(rate);
  const oldUnit = maxPrice(current) * (SCALE + amount(current.feeRate, 'EXCHANGE_STORE'));
  const newUnit = newPrice * (SCALE + newFeeRate);
  const common = newRemaining - added;
  const newNotional = ceil(newPrice * added, SCALE);
  // Extra size and higher unit cost are independent upper bounds. A lower price
  // never subsidizes extra size while the previous order can still fill in flight.
  const repriced =
    newUnit > oldUnit
      ? ceil((newUnit - oldUnit) * common, SCALE * SCALE) + 2n // upper bound for quote/fee rounding
      : 0n;
  return newNotional + ceil(newNotional * newFeeRate, SCALE) + repriced;
}

function operationsOf(order, grantId) {
  return [order, ...amendments(order)].filter(
    (row) => row.grantId === grantId && !row.dispatchSkipped && row.outcome !== 'skipped',
  );
}

function grantLimits(input) {
  const transport = input.transport ?? 'rest';
  const maxCancels = input.maxCancels ?? 0;
  const perOrder = amount(input.perOrder, 'EXCHANGE_AUTHORITY_LIMITS');
  const total = amount(input.total, 'EXCHANGE_AUTHORITY_LIMITS');
  if (
    !['buy', 'sell'].includes(input.side) ||
    typeof input.postOnly !== 'boolean' ||
    !perOrder ||
    perOrder > total ||
    !Number.isSafeInteger(input.maxOrders) ||
    input.maxOrders < 1 ||
    input.maxOrders > 8000 ||
    !Number.isSafeInteger(maxCancels) ||
    maxCancels < 0 ||
    maxCancels > 8000 ||
    !['rest', 'fix'].includes(transport) ||
    (input.allowAmend !== undefined && typeof input.allowAmend !== 'boolean') ||
    (input.allowAmend === true && transport !== 'fix') ||
    (input.allowStopLimit !== undefined && typeof input.allowStopLimit !== 'boolean') ||
    (input.allowStopLimit === true && transport !== 'fix') ||
    (input.allowTpsl !== undefined && typeof input.allowTpsl !== 'boolean') ||
    (input.allowTpsl === true && (transport !== 'fix' || input.postOnly)) ||
    !Number.isSafeInteger(input.minutes) ||
    input.minutes < 1 ||
    input.minutes > 43200
  )
    fail('EXCHANGE_AUTHORITY_LIMITS');
  return {
    ...(transport === 'fix' && { transport, allowAmend: input.allowAmend === true }),
    ...(input.allowStopLimit === true && { allowStopLimit: true }),
    ...(input.allowTpsl === true && { allowTpsl: true }),
    side: input.side,
    postOnly: input.postOnly,
    perOrder: shown(perOrder),
    total: shown(total),
    maxOrders: input.maxOrders,
    ...(maxCancels && { maxCancels }),
    minutes: input.minutes,
  };
}

function stopTerms(input, existing) {
  const tpsl = input.stopLimitPrice !== undefined;
  if (existing && tpsl !== Boolean(existing.stopLimitPrice)) fail('EXCHANGE_TPSL_TERMS');
  if (tpsl) {
    const stop = amount(input.stopPrice, 'EXCHANGE_TPSL_TERMS');
    const execution = amount(input.stopLimitPrice, 'EXCHANGE_TPSL_TERMS');
    const profit = amount(input.price, 'EXCHANGE_TPSL_TERMS');
    const ordered =
      input.side === 'buy' ? profit < stop && stop < execution : profit > stop && stop > execution;
    if (
      !profit ||
      !stop ||
      !execution ||
      !ordered ||
      input.postOnly ||
      input.triggerDirection !== undefined
    )
      fail('EXCHANGE_TPSL_TERMS');
    return { stopPrice: shown(stop), stopLimitPrice: shown(execution) };
  }
  if (!existing && input.stopPrice === undefined && input.triggerDirection === undefined) return {};
  if (existing && !existing.stopPrice) {
    if (input.stopPrice !== undefined || input.triggerDirection !== undefined)
      fail('EXCHANGE_STOP_TERMS');
    return {};
  }
  const direction = input.triggerDirection ?? existing?.triggerDirection;
  if (
    !directions.includes(direction) ||
    (existing && existing.triggerDirection !== direction) ||
    !amount(input.stopPrice, 'EXCHANGE_STOP_TERMS')
  )
    fail('EXCHANGE_STOP_TERMS');
  return { stopPrice: shown(amount(input.stopPrice)), triggerDirection: direction };
}

function validStop(row) {
  if (row.stopLimitPrice !== undefined) {
    try {
      stopTerms(row);
      return (
        ['buy', 'sell'].includes(row.side) &&
        row.postOnly === false &&
        row.triggerDirection === undefined
      );
    } catch {
      return false;
    }
  }
  if (row.stopPrice === undefined) return row.triggerDirection === undefined;
  return (
    directions.includes(row.triggerDirection) &&
    typeof row.stopPrice === 'string' &&
    decimal.test(row.stopPrice) &&
    amount(row.stopPrice) > 0n
  );
}

function matchesPrice(value, expected) {
  return (
    typeof value === 'string' &&
    decimal.test(value) &&
    expected !== undefined &&
    amount(value) === amount(expected)
  );
}

function restTpslMatches(payload, order) {
  return (
    matchesPrice(payload.stop_price, order.stopPrice) &&
    matchesPrice(payload.stop_limit_price, order.stopLimitPrice)
  );
}

function tpslRevisionObserved(payload, previous, next) {
  if (payload.client_oid === next.fix.clientId) return true;
  if (restTpslMatches(payload, next) && !restTpslMatches(payload, previous)) return true;
  if (matchesPrice(payload.size, next.size) && !matchesPrice(payload.size, previous.size))
    return true;
  return (
    (matchesPrice(payload.price, next.price) || matchesPrice(payload.price, next.stopLimitPrice)) &&
    !matchesPrice(payload.price, previous.price) &&
    !matchesPrice(payload.price, previous.stopLimitPrice)
  );
}

function restStopMatches(payload, order) {
  return (
    typeof payload.stop_price === 'string' &&
    decimal.test(payload.stop_price) &&
    amount(payload.stop_price) === amount(order.stopPrice) &&
    payload.stop === (order.triggerDirection === 'up' ? 'entry' : 'loss')
  );
}

function restOrderTypeMatches(payload, order) {
  const reportedStop =
    payload.stop_price != null && amount(payload.stop_price, 'EXCHANGE_RESPONSE') > 0n;
  const reportedStopLimit =
    payload.stop_limit_price != null && amount(payload.stop_limit_price, 'EXCHANGE_RESPONSE') > 0n;
  if (order.stopLimitPrice)
    return (
      ['limit', 'stop'].includes(payload.type) &&
      (!reportedStop || matchesPrice(payload.stop_price, order.stopPrice)) &&
      (!reportedStopLimit || matchesPrice(payload.stop_limit_price, order.stopLimitPrice)) &&
      (order.venueId || payload.client_oid === order.clientId || restTpslMatches(payload, order))
    );
  if (reportedStopLimit) return false;
  if (!order.stopPrice) return payload.type === 'limit' && !reportedStop;
  if (reportedStop || payload.type === 'stop')
    return restStopMatches(payload, order) && ['stop', 'limit'].includes(payload.type);
  // After triggering, an authentic limit record may omit the stop terms.
  return payload.type === 'limit' && (order.venueId || payload.client_oid === order.clientId);
}

function tpslEvidence(order, observedPrice, filled, armed, errorCode) {
  if (
    observedPrice !== null &&
    !matchesPrice(observedPrice, order.price) &&
    !matchesPrice(observedPrice, order.stopLimitPrice)
  )
    fail(errorCode);
  const leg = matchesPrice(observedPrice, order.stopLimitPrice)
    ? 'stop-loss'
    : filled > 0n && matchesPrice(observedPrice, order.price)
      ? 'take-profit'
      : null;
  if (
    order.activeLeg &&
    ((leg && leg !== order.activeLeg) ||
      (order.activeLeg === 'stop-loss' && matchesPrice(observedPrice, order.price)))
  )
    fail(errorCode);
  return {
    stopState:
      order.stopState === 'triggered' || leg || filled > 0n
        ? 'triggered'
        : armed
          ? 'waiting'
          : 'unverified',
    ...(leg && { activeLeg: leg }),
    ...(observedPrice !== null && { activePrice: shown(amount(observedPrice, errorCode)) }),
  };
}

function bindAccounts(rows) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 1000 ||
    rows.some((row) => !row || !id.test(row.profile_id))
  )
    fail('EXCHANGE_PROFILE');
  const profileId = rows[0].profile_id;
  if (rows.some((row) => row.profile_id !== profileId)) fail('EXCHANGE_PROFILE');
  return profileId;
}

function toOrder(payload, previous) {
  const broken = 'EXCHANGE_RESPONSE';
  if (
    !payload ||
    !id.test(payload.id) ||
    (previous.venueId && previous.venueId !== payload.id) ||
    (payload.client_oid != null &&
      payload.client_oid !== previous.clientId &&
      (!previous.venueId || payload.client_oid !== previous.fix?.clientId)) ||
    payload.profile_id !== previous.profileId ||
    payload.product_id !== previous.product ||
    payload.side !== previous.side ||
    !restOrderTypeMatches(payload, previous) ||
    payload.post_only !== previous.postOnly ||
    (payload.time_in_force != null && payload.time_in_force !== 'GTC') ||
    (payload.market_type != null && payload.market_type !== 'spot') ||
    (!previous.stopLimitPrice && !matchesPrice(payload.price, previous.price)) ||
    amount(payload.size, broken) !== amount(previous.size)
  )
    fail(broken);
  const filled = amount(payload.filled_size, broken);
  const funds = amount(payload.executed_value, broken);
  const fees = amount(payload.fill_fees, broken);
  if (
    filled > amount(previous.size) ||
    (previous.filledSize && filled < amount(previous.filledSize)) ||
    (previous.executedValue && funds < amount(previous.executedValue))
  )
    fail(broken);
  let status = payload.status;
  if (status === 'done') {
    if (payload.done_reason === 'canceled') status = 'canceled';
    else if (payload.done_reason === 'rejected') status = 'rejected';
    else if (filled === amount(previous.size)) status = 'filled';
    else fail(broken);
  }
  if (
    (!active.has(status) && !terminal.has(status)) ||
    (terminal.has(previous.status) && !terminal.has(status)) ||
    (previous.settled && payload.settled !== true) ||
    (status === 'filled' && filled !== amount(previous.size)) ||
    (status === 'rejected' && filled !== 0n)
  )
    fail(broken);
  if (active.has(status) && filled > 0n) status = 'partially-filled';
  const tpsl =
    previous.stopLimitPrice &&
    tpslEvidence(
      previous,
      payload.price,
      filled,
      active.has(status) && restTpslMatches(payload, previous),
      broken,
    );
  const stopState =
    previous.stopPrice &&
    (triggerState(previous) === 'triggered' ||
    payload.type === 'limit' ||
    filled > 0n ||
    status === 'open'
      ? 'triggered'
      : active.has(status)
        ? 'waiting'
        : triggerState(previous));
  return {
    ...previous,
    venueId: payload.id,
    status,
    filledSize: shown(filled),
    executedValue: shown(funds),
    fillFees: shown(fees),
    settled: payload.settled === true,
    checkedAt: Date.now(),
    error: null,
    ...(tpsl || (stopState && { stopState })),
  };
}

function present(order) {
  const status =
    order.status === 'submitting'
      ? 'submit-unknown'
      : order.status === 'canceling'
        ? 'cancel-unknown'
        : order.status === 'amending'
          ? 'amend-unknown'
          : order.status;
  return { ...order, status };
}

function applyFixExecution(order, report) {
  const broken = 'EXCHANGE_FIX_REPORT';
  const size = amount(order.size);
  const filled = amount(report.filledSize ?? (report.executionType === '0' ? '0' : ''), broken);
  const remaining = report.remainingSize === null ? null : amount(report.remainingSize, broken);
  if (
    !id.test(report.venueId) ||
    (order.venueId && order.venueId !== report.venueId) ||
    (order.filledSize && filled < amount(order.filledSize)) ||
    filled > size ||
    (!order.stopLimitPrice && report.price !== null && !matchesPrice(report.price, order.price)) ||
    (report.size !== null && amount(report.size, broken) !== size) ||
    (report.status === 'filled' && filled !== size) ||
    (active.has(report.status) && remaining !== null && filled + remaining !== size)
  )
    fail(broken);
  return {
    ...order,
    venueId: report.venueId,
    status: active.has(report.status) && filled > 0n ? 'partially-filled' : report.status,
    filledSize: shown(filled),
    checkedAt: report.checkedAt,
    settled: false,
    error: null,
    ...(order.stopLimitPrice
      ? tpslEvidence(
          order,
          report.price,
          filled,
          report.executionType === '0' || report.executionType === '5',
          broken,
        )
      : order.stopPrice && {
          stopState:
            triggerState(order) === 'triggered' || report.triggered === true || filled > 0n
              ? 'triggered'
              : report.status === 'pending'
                ? 'waiting'
                : triggerState(order),
        }),
    fix: { ...order.fix, executionId: report.executionId },
  };
}

function finishAmend(order, outcome) {
  const { pending, ...fix } = order.fix;
  return {
    ...order,
    ...(outcome === 'applied' && {
      price: pending.price,
      size: pending.size,
      notional: pending.notional,
      estimatedFee: pending.estimatedFee,
      feeRate: pending.feeRate,
      ...(pending.stopPrice && { stopPrice: pending.stopPrice }),
      ...(pending.stopLimitPrice && { stopLimitPrice: pending.stopLimitPrice, activePrice: null }),
    }),
    fix: {
      ...fix,
      clientId: outcome === 'applied' ? pending.clientId : fix.clientId,
      ...(outcome === 'applied' && { currentGrantId: pending.grantId || null }),
      amendments: [...(fix.amendments || []), { ...pending, outcome, completedAt: Date.now() }],
    },
  };
}

class ExchangeOrders {
  constructor(
    service,
    write,
    { api = new CoinbaseExchange(service.market.fetch), vault, watch, fix } = {},
  ) {
    this.service = service;
    this.write = write;
    this.api = api;
    this.vault =
      vault ||
      ((env) => new AccountVault(path.join(service.directory, 'coinbase-' + env + '.vault.json')));
    this.file = path.join(service.directory, 'coinbase-orders.json');
    this.queue = Promise.resolve();
    this.reviews = new Map();
    this.replacementReviews = new Map();
    this.amendReviews = new Map();
    this.grantReviews = new Map();
    this.accounts = new Map();
    this.fencedGrants = new Set();
    this.grants = [];
    this.orders = [];
    this.activeWrites = new Set();
    this.cancelBatch = null;
    this.emergencyCancellation = new ExchangeEmergencyCancellation(this);
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
        fail('EXCHANGE_STORE');
      const { version, orders, grants, cancelBatch, sha256 } = JSON.parse(
        fs.readFileSync(this.file, 'utf8'),
      );
      if (
        ![1, 2, 3].includes(version) ||
        !Array.isArray(orders) ||
        orders.length > 8000 ||
        orders.some(
          (o) =>
            !id.test(o?.clientId) ||
            !stages.has(o.status) ||
            !validStop(o) ||
            (o.stopPrice && !o.fix) ||
            !validCancellationRecord(o),
        ) ||
        new Set(orders.map((o) => o.clientId)).size !== orders.length ||
        (version >= 2 &&
          (!Array.isArray(grants) ||
            grants.length > 8000 ||
            grants.some((grant) => !id.test(grant?.grantId)) ||
            new Set(grants.map((grant) => grant.grantId)).size !== grants.length ||
            orders.some(
              (order) => order.grantId && !grants.some((g) => g.grantId === order.grantId),
            ))) ||
        (version === 3 && !ExchangeEmergencyCancellation.valid(cancelBatch, orders)) ||
        sha256 !==
          digest(
            version === 1
              ? orders
              : version === 2
                ? { orders, grants }
                : { orders, grants, cancelBatch },
          )
      )
        fail('EXCHANGE_STORE');
      this.orders = orders;
      if (version >= 2) this.grants = grants;
      if (version === 3) this.cancelBatch = cancelBatch;
    } catch (error) {
      if (error.code !== 'ENOENT') fail('EXCHANGE_STORE');
    }
    this.watch = new ExchangeOrderWatch(this, watch);
    this.fix = new ExchangeFixSessions(this, fix);
    void this.watch.resume();
  }
  request(action, input, context) {
    if (action === 'revokeAuthority') return this.revokeAuthority(input, context);
    // Observing a submission or opening its revocation controls must not wait for the venue.
    if (['list', 'fixConnect', 'fixDisconnect', 'fixQuery'].includes(action))
      return this.execute(action, input, context);
    const pending = this.queue.then(() => this.execute(action, input, context));
    this.queue = pending.catch(() => {});
    return pending;
  }
  record(order) {
    if (terminal.has(order.status) && pendingCancellation(order))
      order = finishCancellation(order, 'closed');
    const next = [...this.orders.filter((row) => row.clientId !== order.clientId), order];
    this.persist(next, this.grants);
    this.watch.ordersChanged(order.env);
    return present(order);
  }
  persist(orders, grants, cancelBatch = this.cancelBatch) {
    if (this.closed) fail('QUANT_STOPPED');
    if (orders.length > 8000 || grants.length > 8000) fail('EXCHANGE_STORE_LIMIT');
    const data = { orders, grants, cancelBatch };
    try {
      this.write(this.file, { version: 3, ...data, sha256: digest(data) });
    } catch {
      fail('EXCHANGE_STORE');
    }
    this.orders = orders;
    this.grants = grants;
    this.cancelBatch = cancelBatch;
  }
  async account(env, required = true) {
    if (!this.accounts.has(env)) {
      try {
        const value = await this.vault(env).load();
        if (!this.accounts.has(env)) this.accounts.set(env, value);
      } catch {
        fail('EXCHANGE_CREDENTIAL_STORAGE');
      }
    }
    const saved = this.accounts.get(env);
    if (required && !configured(saved)) fail('EXCHANGE_NOT_CONNECTED');
    return saved;
  }
  async saveAccount(env, value) {
    if (this.closed) fail('QUANT_STOPPED');
    try {
      await this.vault(env).save(value);
    } catch {
      fail('EXCHANGE_CREDENTIAL_STORAGE');
    }
    this.accounts.set(env, value);
    this.fix.drop(env);
    this.watch.accountChanged(env, value);
    for (const [key, draft] of this.reviews) {
      if (draft.env === env) this.reviews.delete(key);
    }
    for (const [key, draft] of this.replacementReviews) {
      if (draft.env === env) this.replacementReviews.delete(key);
    }
    for (const [key, draft] of this.amendReviews) {
      if (draft.env === env) this.amendReviews.delete(key);
    }
    for (const [key, draft] of this.grantReviews) {
      if (draft.env === env) this.grantReviews.delete(key);
    }
  }
  async inspectOrder(env, spec, account, signal, { deferFunds = false, filledSize = '0' } = {}) {
    const [product, rows, fees] = await Promise.all([
      this.api.product(env, spec.product, signal),
      this.api.accounts(env, account, signal),
      this.api.fees(env, account, signal),
    ]);
    const [base, quote] = spec.product.split('-');
    const rate = [
      amount(fees?.maker_fee_rate, 'EXCHANGE_RESPONSE'),
      amount(fees?.taker_fee_rate, 'EXCHANGE_RESPONSE'),
    ].reduce((highest, value) => (value > highest ? value : highest), 0n);
    const price = amount(spec.price);
    const size = amount(spec.size);
    const stopLimit = spec.stopLimitPrice ? amount(spec.stopLimitPrice) : price;
    if (
      !product ||
      product.id !== spec.product ||
      product.base_currency !== base ||
      product.quote_currency !== quote ||
      product.status !== 'online' ||
      product.trading_disabled === true ||
      product.cancel_only !== false ||
      product.auction_mode === true ||
      (product.post_only === true && !spec.postOnly)
    )
      fail('EXCHANGE_PRODUCT_UNAVAILABLE');
    const tick = amount(product.quote_increment, 'EXCHANGE_RESPONSE');
    const step = amount(product.base_increment, 'EXCHANGE_RESPONSE');
    const min = amount(product.min_market_funds, 'EXCHANGE_RESPONSE');
    if (
      !tick ||
      !step ||
      !price ||
      !size ||
      price % tick ||
      (spec.stopPrice && amount(spec.stopPrice) % tick) ||
      stopLimit % tick ||
      size % step ||
      price * size < min * SCALE ||
      stopLimit * size < min * SCALE ||
      (product.base_min_size && size < amount(product.base_min_size, 'EXCHANGE_RESPONSE')) ||
      (!spec.postOnly &&
        product.base_max_size &&
        size > amount(product.base_max_size, 'EXCHANGE_RESPONSE'))
    )
      fail('EXCHANGE_ORDER_INCREMENT');
    if (rate > SCALE || bindAccounts(rows) !== account.profileId) fail('EXCHANGE_PROFILE');
    const remaining = size - amount(filledSize);
    if (remaining <= 0n) fail('EXCHANGE_FIX_AMEND_TERMS');
    const notional = ceil((price > stopLimit ? price : stopLimit) * remaining, SCALE);
    if (notional >= SCALE * SCALE) fail('EXCHANGE_DECIMAL');
    const fee = ceil(notional * rate, SCALE);
    const asset = spec.side === 'buy' ? quote : base;
    const funds = rows.filter((row) => row.currency === asset);
    if (funds.length !== 1 || funds[0].trading_enabled !== true) fail('EXCHANGE_FUNDS');
    const available = amount(funds[0].available, 'EXCHANGE_RESPONSE');
    if (!deferFunds && available < (spec.side === 'buy' ? notional + fee : remaining))
      fail('EXCHANGE_FUNDS');
    return {
      notional: shown(notional),
      estimatedFee: shown(fee),
      feeRate: shown(rate),
      asset,
      available: funds[0].available,
    };
  }
  grantUsage(grant) {
    let spent = 0n;
    let orders = 0;
    let cancels = 0;
    for (const row of this.orders) {
      for (const operation of operationsOf(row, grant.grantId)) {
        spent += amount(operation.authorizedDebit, 'EXCHANGE_STORE');
        orders++;
      }
      cancels += cancellations(row).filter(
        (attempt) => attempt.grantId === grant.grantId && attempt.outcome !== 'skipped',
      ).length;
    }
    return { spent, orders, cancels };
  }
  grantStatus(grant, workspace, account, now = Date.now()) {
    if (grant.revokedAt) return 'authorityRevoked';
    if (this.fencedGrants.has(grant.grantId)) return 'authorityRevocationPending';
    if (now < grant.issuedAt || now >= grant.expiresAt) return 'authorityExpired';
    if (
      !configured(account) ||
      account.profileId !== grant.profileId ||
      binding(account) !== grant.credentialId ||
      workspace.market.venue !== 'coinbase' ||
      workspace.market.product !== grant.product
    )
      return 'authorityScopeChanged';
    if (grant.env === 'live') {
      const emergency = this.service.getWallet().emergency;
      if (emergency.halted || emergency.storageError || emergency.generation !== grant.generation)
        return 'authorityStopped';
    }
    return 'authorityActive';
  }
  presentGrant(grant, workspace, account) {
    const { credentialId: _credential, generation: _generation, ...view } = grant;
    const { spent, orders, cancels } = this.grantUsage(grant);
    const remaining = amount(grant.total) - spent;
    const cancelsRemaining = (grant.maxCancels || 0) - cancels;
    const status = this.grantStatus(grant, workspace, account);
    return {
      ...view,
      status:
        status === 'authorityActive' &&
        ((!remaining && !grant.allowAmend) || orders >= grant.maxOrders) &&
        !cancelsRemaining
          ? 'authorityExhausted'
          : status,
      remaining: shown(remaining),
      ordersRemaining: grant.maxOrders - orders,
      cancelsRemaining,
      transport: grant.transport || 'rest',
      allowAmend: grant.allowAmend === true,
      ...(grant.transport === 'fix' && { fixReady: Boolean(this.fix.connectionId(grant.env)) }),
    };
  }
  revokeAuthority(input, context) {
    if (context?.agentContext) fail('EXCHANGE_HUMAN_REQUIRED');
    if (this.closed) fail('QUANT_STOPPED');
    const scope = { workspaceId: this.service.workspace(input.id).id, env: environment(input.env) };
    const grant = this.grants.find((row) => row.grantId === input.grantId && sameScope(row, scope));
    if (!grant) fail('EXCHANGE_AUTHORITY_REQUIRED');
    if (grant.revokedAt) return { ok: true };
    this.fencedGrants.add(grant.grantId);
    if (this.sending?.grantId === grant.grantId)
      this.sending.controller.abort(Error('EXCHANGE_AUTHORITY_INACTIVE'));
    try {
      this.persist(
        this.orders,
        this.grants.map((row) => (row === grant ? { ...row, revokedAt: Date.now() } : row)),
      );
    } catch {
      this.watch.emit(scope.env);
      fail('EXCHANGE_AUTHORITY_STORAGE');
    }
    this.fencedGrants.delete(grant.grantId);
    this.watch.emit(scope.env);
    return { ok: true };
  }
  grantAction(action, input, workspace, env, account) {
    const scope = { workspaceId: workspace.id, env };
    if (workspace.market.venue !== 'coinbase') fail('EXCHANGE_AUTHORITY_REQUIRED');
    const now = Date.now();
    if (action === 'prepareAuthority') {
      const terms = grantLimits(input);
      if (this.grantReviews.size >= 32) fail('EXCHANGE_REVIEW_LIMIT');
      const generation = env === 'live' ? this.service.getWallet().emergency.assert() : null;
      const grant = {
        ...scope,
        ...terms,
        product: workspace.market.product,
        profileId: account.profileId,
        credentialId: binding(account),
        generation,
        grantId: randomUUID(),
      };
      const review = { ...grant, specHash: digest(grant), reviewExpiresAt: now + 90000 };
      this.grantReviews.set(grant.grantId, review);
      const { credentialId: _credential, generation: _generation, ...view } = review;
      return view;
    }
    const review = this.grantReviews.get(input.grantId);
    if (
      !review ||
      !sameScope(review, scope) ||
      review.reviewExpiresAt <= now ||
      input.ack !== 'ALLOW EXCHANGE AGENT' ||
      input.specHash !== review.specHash ||
      review.product !== workspace.market.product ||
      review.profileId !== account.profileId ||
      review.credentialId !== binding(account)
    )
      fail('EXCHANGE_AUTHORITY_REVIEW');
    if (env === 'live') this.service.getWallet().emergency.assert(review.generation);
    if (
      this.grants.some(
        (grant) =>
          sameScope(grant, scope) &&
          grant.side === review.side &&
          this.grantStatus(grant, workspace, account, now) === 'authorityActive',
      )
    )
      fail('EXCHANGE_AUTHORITY_EXISTS');
    const { reviewExpiresAt: _expires, specHash: _hash, ...terms } = review;
    const grant = {
      ...terms,
      issuedAt: now,
      expiresAt: now + terms.minutes * 60000,
      revokedAt: null,
    };
    this.persist(this.orders, [...this.grants, grant]);
    this.grantReviews.delete(grant.grantId);
    this.watch.emit(env);
    return this.presentGrant(grant, workspace, account);
  }
  orderSpec(input, workspace, env, account, existing) {
    if (
      workspace.market.venue !== 'coinbase' ||
      !['buy', 'sell'].includes(input.side) ||
      typeof input.postOnly !== 'boolean' ||
      typeof input.operationId !== 'string' ||
      !/^[\w:-]{1,128}$/.test(input.operationId)
    )
      fail('EXCHANGE_ORDER_INVALID');
    return {
      workspaceId: workspace.id,
      env,
      profileId: account.profileId,
      operationId: input.operationId,
      product: workspace.market.product,
      side: input.side,
      price: shown(amount(input.price)),
      size: shown(amount(input.size)),
      postOnly: input.postOnly,
      ...stopTerms(input, existing),
    };
  }
  requireReconciled(env, account) {
    if (
      this.orders.some(
        (o) => o.env === env && o.profileId === account.profileId && unknown.has(o.status),
      )
    )
      fail('EXCHANGE_RECONCILE_FIRST');
  }
  async previewAmend(input, workspace, env, account, signal) {
    if (this.amendReviews.size >= 32) fail('EXCHANGE_REVIEW_LIMIT');
    const order = this.replacementSource(workspace, env, account, input.orderId);
    if (!canAmend(order)) fail('EXCHANGE_FIX_AMEND_UNAVAILABLE');
    const { connectionId } = this.fix.writer(env, account, order.fix.connectionId);
    const emergency = this.service.getWallet().emergency;
    const generation = env === 'live' ? emergency.assert() : null;
    const current = await this.reconcileOrder(account, order, signal);
    const reviewId = randomUUID();
    const spec = this.orderSpec(
      {
        side: order.side,
        postOnly: order.postOnly,
        price: input.price,
        size: input.size,
        operationId: 'amend:' + reviewId,
        stopPrice: input.stopPrice,
        stopLimitPrice: input.stopLimitPrice,
        triggerDirection: input.triggerDirection,
      },
      workspace,
      env,
      account,
      order,
    );
    if (
      current.error ||
      !canAmend(current) ||
      (current.stopPrice && current.stopState !== 'waiting') ||
      amount(spec.size) <= amount(current.filledSize) ||
      !changedTerms(spec, current)
    )
      fail('EXCHANGE_FIX_AMEND_TERMS');
    const terms = await this.inspectOrder(env, spec, account, signal, {
      deferFunds: true,
      filledSize: current.filledSize,
    });
    this.fix.writer(env, account, connectionId);
    const draft = {
      ...spec,
      ...terms,
      reviewId,
      generation,
      connectionId,
      credentialId: binding(account),
      orderId: order.clientId,
      origClientId: current.fix.clientId,
      originalPrice: current.price,
      originalSize: current.size,
      ...(current.stopPrice && { originalStopPrice: current.stopPrice }),
      ...(current.stopLimitPrice && { originalStopLimitPrice: current.stopLimitPrice }),
      filledSize: current.filledSize,
      remainingSize: shown(amount(spec.size) - amount(current.filledSize)),
      keepsPriority: spec.price === current.price && amount(spec.size) < amount(current.size),
      ...(current.stopPrice && { keepsTriggerPriority: spec.stopPrice === current.stopPrice }),
      expiresAt: Date.now() + 90000,
    };
    draft.specHash = digest(draft);
    this.amendReviews.set(reviewId, draft);
    return draft;
  }
  async confirmAmend(input, workspace, env, account, callerSignal) {
    const order = this.replacementSource(workspace, env, account, input.orderId);
    if (input.ack !== 'AMEND ORDER') fail('EXCHANGE_REVIEW_CHANGED');
    const existing = [order.fix?.pending, ...(order.fix?.amendments || [])].find(
      (row) => row && row.clientId === input.reviewId && row.specHash === input.specHash,
    );
    if (existing) return present(order);
    const draft = this.amendReviews.get(input.reviewId);
    if (
      !draft ||
      !order.fix ||
      draft.orderId !== order.clientId ||
      !sameScope(order, draft) ||
      draft.specHash !== input.specHash ||
      draft.credentialId !== binding(account)
    )
      fail('EXCHANGE_REVIEW_CHANGED');
    this.requireReconciled(env, account);
    const emergency = this.service.getWallet().emergency;
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const guard = () => {
      signal.throwIfAborted();
      if (this.closed) fail('QUANT_STOPPED');
      const market = this.service.workspace(workspace.id).market;
      if (
        Date.now() >= draft.expiresAt ||
        market.venue !== 'coinbase' ||
        market.product !== draft.product
      )
        fail('EXCHANGE_REVIEW_CHANGED');
      if (env === 'live') emergency.assert(draft.generation);
      return this.fix.writer(env, account, draft.connectionId);
    };
    guard();
    const terms = await this.inspectOrder(env, draft, account, signal, {
      deferFunds: true,
      filledSize: draft.filledSize,
    });
    if (amount(terms.estimatedFee) > amount(draft.estimatedFee)) fail('EXCHANGE_REVIEW_CHANGED');
    const current = await this.reconcileOrder(account, order, signal);
    if (
      current.error ||
      !canAmend(current) ||
      (current.stopPrice && current.stopState !== 'waiting') ||
      current.fix.clientId !== draft.origClientId ||
      current.filledSize !== draft.filledSize ||
      current.price !== draft.originalPrice ||
      current.size !== draft.originalSize ||
      current.stopPrice !== draft.originalStopPrice ||
      current.stopLimitPrice !== draft.originalStopLimitPrice
    )
      fail('EXCHANGE_FIX_AMEND_TERMS');
    const pending = {
      clientId: draft.reviewId,
      specHash: draft.specHash,
      origClientId: draft.origClientId,
      price: draft.price,
      size: draft.size,
      notional: terms.notional,
      estimatedFee: terms.estimatedFee,
      feeRate: terms.feeRate,
      originalPrice: current.price,
      originalSize: current.size,
      ...(draft.stopPrice && { stopPrice: draft.stopPrice, originalStopPrice: current.stopPrice }),
      ...(draft.stopLimitPrice && {
        stopLimitPrice: draft.stopLimitPrice,
        originalStopLimitPrice: current.stopLimitPrice,
      }),
      filledSize: current.filledSize,
      approvedAt: Date.now(),
    };
    return this.dispatchAmend(current, pending, guard, controller, signal);
  }
  async dispatchAmend(current, pending, guard, controller, signal) {
    const { session, connectionId } = guard();
    const sending = { ...current, status: 'amending', fix: { ...current.fix, pending } };
    this.record(sending);
    this.amendReviews.delete(pending.clientId);
    this.activeWrites.add(current.clientId);
    this.sending = { env: current.env, grantId: pending.grantId, controller };
    let started = false;
    let result;
    try {
      const report = await session.amend(
        { ...current, ...pending },
        connectionId,
        () => {
          guard();
          started = true;
        },
        signal,
      );
      result = applyFixExecution(finishAmend(sending, 'applied'), report);
    } catch (error) {
      const reason = safeError(signal.reason || error);
      result =
        !started || error.fixRejected
          ? {
              ...finishAmend(sending, started ? 'rejected' : 'skipped'),
              status: current.status,
              error: reason,
            }
          : { ...sending, status: 'amend-unknown', error: reason };
    } finally {
      this.sending = null;
      this.activeWrites.delete(current.clientId);
    }
    return this.record(result);
  }
  requireActiveGrant(selected, workspace, account, spec, signal) {
    signal?.throwIfAborted();
    if (this.closed) fail('QUANT_STOPPED');
    const grant = this.grants.find((row) => row.grantId === selected.grantId);
    if (grant.env === 'live') this.service.getWallet().emergency.assert(grant.generation);
    if (
      this.grantStatus(grant, this.service.workspace(workspace.id), account) !== 'authorityActive'
    )
      fail('EXCHANGE_AUTHORITY_INACTIVE');
    if (
      spec.side !== grant.side ||
      (grant.postOnly && !spec.postOnly) ||
      !allowsCondition(grant, spec)
    )
      fail('EXCHANGE_AUTHORITY_SCOPE');
  }
  checkAuthorityBudget(grant, debit, alreadyUsed = 0n) {
    const { orders, spent } = this.grantUsage(grant);
    if (
      orders >= grant.maxOrders ||
      alreadyUsed + debit > amount(grant.perOrder) ||
      spent + debit > amount(grant.total)
    )
      fail('EXCHANGE_AUTHORITY_BUDGET');
  }
  async amendAuthorized(input, workspace, env, account, callerSignal) {
    if (input.transport != null && input.transport !== 'fix') fail('EXCHANGE_AUTHORITY_SCOPE');
    const order = this.replacementSource(workspace, env, account, input.orderId);
    const spec = this.orderSpec(
      { ...input, side: order.side, postOnly: order.postOnly },
      workspace,
      env,
      account,
      order,
    );
    const specHash = digest({ ...spec, orderId: order.clientId, grantId: input.grantId });
    const report = (row, action) => ({
      ...present(row),
      amendment: { ...action, outcome: action.outcome || 'unknown' },
    });
    for (const row of this.orders) {
      if (!sameScope(row, spec)) continue;
      if (
        row.operationId === spec.operationId ||
        cancellations(row).some((action) => action.operationId === spec.operationId)
      )
        fail('EXCHANGE_REVIEW_CHANGED');
      const previous = amendments(row).find((action) => action.operationId === spec.operationId);
      if (!previous) continue;
      if (previous.specHash !== specHash) fail('EXCHANGE_REVIEW_CHANGED');
      return report(row, previous);
    }
    const selected = this.grants.find(
      (grant) => grant.grantId === input.grantId && sameScope(grant, spec),
    );
    if (!selected) fail('EXCHANGE_AUTHORITY_REQUIRED');
    if (
      selected.transport !== 'fix' ||
      selected.allowAmend !== true ||
      order.grantId !== selected.grantId ||
      order.fix?.currentGrantId !== selected.grantId
    )
      fail('EXCHANGE_AUTHORITY_SCOPE');
    if (!canAmend(order)) fail('EXCHANGE_FIX_AMEND_UNAVAILABLE');
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const guard = () => {
      this.requireActiveGrant(selected, workspace, account, spec, signal);
      return this.fix.writer(env, account, order.fix.connectionId);
    };
    guard();
    this.requireReconciled(env, account);
    const current = await this.reconcileOrder(account, order, signal);
    if (
      current.error ||
      !canAmend(current) ||
      (current.stopPrice && current.stopState !== 'waiting') ||
      amount(spec.size) <= amount(current.filledSize) ||
      !changedTerms(spec, current)
    )
      fail('EXCHANGE_FIX_AMEND_TERMS');
    const terms = await this.inspectOrder(env, spec, account, signal, {
      deferFunds: true,
      filledSize: current.filledSize,
    });
    const debit = amendmentDebit(current, spec, terms.feeRate);
    const used = operationsOf(current, selected.grantId).reduce(
      (sum, row) => sum + amount(row.authorizedDebit, 'EXCHANGE_STORE'),
      0n,
    );
    this.checkAuthorityBudget(selected, debit, used);
    // A watcher can learn about fills during the terms check. Keep its newer evidence.
    const latest = this.orders.find((row) => row.clientId === current.clientId);
    if (
      latest.status !== current.status ||
      latest.filledSize !== current.filledSize ||
      latest.stopState !== current.stopState ||
      latest.error
    )
      fail('EXCHANGE_FIX_AMEND_TERMS');
    const pending = {
      clientId: randomUUID(),
      operationId: spec.operationId,
      specHash,
      origClientId: latest.fix.clientId,
      price: spec.price,
      size: spec.size,
      notional: terms.notional,
      estimatedFee: terms.estimatedFee,
      feeRate: terms.feeRate,
      originalPrice: latest.price,
      originalSize: latest.size,
      ...(spec.stopPrice && { stopPrice: spec.stopPrice, originalStopPrice: latest.stopPrice }),
      ...(spec.stopLimitPrice && {
        stopLimitPrice: spec.stopLimitPrice,
        originalStopLimitPrice: latest.stopLimitPrice,
      }),
      filledSize: latest.filledSize,
      grantId: selected.grantId,
      authorizedDebit: shown(debit),
      approvedAt: Date.now(),
    };
    const result = await this.dispatchAmend(latest, pending, guard, controller, signal);
    return report(
      result,
      amendments(result).find((row) => row.clientId === pending.clientId),
    );
  }
  async cancelAuthorized(input, workspace, env, account, callerSignal) {
    const order = this.replacementSource(workspace, env, account, input.orderId);
    const { operationId, grantId } = input;
    if (typeof operationId !== 'string' || !/^[\w:-]{1,128}$/.test(operationId))
      fail('EXCHANGE_ORDER_INVALID');
    const specHash = digest({ orderId: order.clientId, operationId, grantId });
    if (
      [...this.reviews.values()].some(
        (draft) => sameScope(draft, order) && draft.operationId === operationId,
      )
    )
      fail('EXCHANGE_REVIEW_CHANGED');
    const report = (row, attempt) => ({
      ...present(row),
      cancellation: { ...attempt, outcome: attempt.outcome || 'unknown' },
    });
    for (const row of this.orders) {
      if (!sameScope(row, order)) continue;
      if (
        row.operationId === operationId ||
        amendments(row).some((action) => action.operationId === operationId)
      )
        fail('EXCHANGE_REVIEW_CHANGED');
      const previous = cancellations(row).find((action) => action.operationId === operationId);
      if (!previous) continue;
      if (previous.specHash !== specHash) fail('EXCHANGE_REVIEW_CHANGED');
      return report(row, previous);
    }
    const selected = this.grants.find(
      (grant) => grant.grantId === grantId && sameScope(grant, order),
    );
    if (!selected) fail('EXCHANGE_AUTHORITY_REQUIRED');
    if (!selected.maxCancels || !ownsOrder(selected, order)) fail('EXCHANGE_AUTHORITY_SCOPE');
    if (this.grantUsage(selected).cancels >= selected.maxCancels) fail('EXCHANGE_CANCEL_BUDGET');
    if (!active.has(order.status) || order.fix?.pending || pendingCancellation(order))
      fail('EXCHANGE_CANCEL_UNAVAILABLE');
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const guard = () => this.requireActiveGrant(selected, workspace, account, order, signal);
    guard();
    this.sending = { env, grantId, controller };
    try {
      let fix;
      if (order.fix) {
        await this.fix.session(env, account).waitUntilReady(signal);
        fix = this.fix.writer(env, account);
      }
      guard();
      const latest = this.orders.find((row) => row.clientId === order.clientId);
      if (!active.has(latest.status) || latest.fix?.pending || pendingCancellation(latest))
        fail('EXCHANGE_CANCEL_UNAVAILABLE');
      const attempt = {
        clientId: randomUUID(),
        operationId,
        specHash,
        grantId,
        transport: order.fix ? 'fix' : 'rest',
        requestedAt: Date.now(),
      };
      const result = await this.cancelRecordedOrder(account, latest, guard, signal, {
        attempt,
        fix,
      });
      return report(result, cancellations(result).at(-1));
    } finally {
      this.sending = null;
    }
  }
  replacementSource(workspace, env, account, clientId) {
    const order = this.orders.find((row) => row.clientId === clientId);
    if (
      !order ||
      !order.venueId ||
      !sameScope(order, { workspaceId: workspace.id, env }) ||
      order.profileId !== account.profileId ||
      workspace.market.venue !== 'coinbase' ||
      order.product !== workspace.market.product
    )
      fail('EXCHANGE_ORDER_ID');
    return order;
  }
  canReplace(order) {
    if (order.stopPrice) return false;
    if (!active.has(order.status) && !(order.status === 'canceled' && order.replacement))
      return false;
    const previous = this.orders.find((row) => row.clientId === order.replacement?.clientId);
    return !previous || previous.status === 'rejected';
  }
  async previewReplacement(input, workspace, env, account, signal) {
    if (this.replacementReviews.size >= 32) fail('EXCHANGE_REVIEW_LIMIT');
    const order = this.replacementSource(workspace, env, account, input.orderId);
    if (!this.canReplace(order)) fail('EXCHANGE_REPLACE_UNAVAILABLE');
    const reviewId = randomUUID();
    const spec = this.orderSpec(
      {
        side: order.side,
        postOnly: order.postOnly,
        price: input.price,
        size: input.size,
        operationId: 'replace:' + reviewId,
      },
      workspace,
      env,
      account,
    );
    const emergency = this.service.getWallet().emergency;
    const generation = env === 'live' ? emergency.assert() : null;
    const current = await this.reconcileOrder(account, order, signal);
    if (current.error || !this.canReplace(current)) fail('EXCHANGE_REPLACE_UNAVAILABLE');
    const terms = await this.inspectOrder(env, spec, account, signal, {
      // The old order may still be holding the balance needed for the replacement.
      deferFunds: active.has(current.status),
    });
    const draft = {
      ...spec,
      ...terms,
      reviewId,
      generation,
      replaces: current.clientId,
      credentialId: binding(account),
      previous: current.replacement?.clientId ?? null,
      originalPrice: current.price,
      originalSize: current.size,
      originalStatus: current.status,
      filledSize: current.filledSize,
      expiresAt: Date.now() + 90000,
    };
    draft.specHash = digest(draft);
    this.replacementReviews.set(reviewId, draft);
    return draft;
  }
  async confirmReplacement(input, workspace, env, account, signal) {
    const initial = this.replacementSource(workspace, env, account, input.orderId);
    if (input.ack !== 'REPLACE ORDER') fail('EXCHANGE_REVIEW_CHANGED');
    if (
      initial.replacement &&
      initial.replacement.clientId === input.reviewId &&
      initial.replacement.specHash === input.specHash
    ) {
      const result = this.orders.find((row) => row.clientId === input.reviewId);
      return result ? present(result) : present(initial);
    }
    const draft = this.replacementReviews.get(input.reviewId);
    const emergency = this.service.getWallet().emergency;
    const guard = () => {
      if (this.closed) fail('QUANT_STOPPED');
      signal?.throwIfAborted();
      const market = this.service.workspace(workspace.id).market;
      if (
        !draft ||
        draft.replaces !== initial.clientId ||
        !sameScope(draft, initial) ||
        draft.credentialId !== binding(account) ||
        input.specHash !== draft.specHash ||
        Date.now() >= draft.expiresAt ||
        market.venue !== 'coinbase' ||
        market.product !== draft.product
      )
        fail('EXCHANGE_REVIEW_CHANGED');
      if (env === 'live') emergency.assert(draft.generation);
    };
    guard();
    if (this.orders.length >= 8000) fail('EXCHANGE_STORE_LIMIT');
    const verifyTerms = async (deferFunds = false) => {
      const latest = await this.inspectOrder(env, draft, account, signal, { deferFunds });
      if (amount(latest.estimatedFee) > amount(draft.estimatedFee)) fail('EXCHANGE_REVIEW_CHANGED');
      guard();
    };
    this.requireReconciled(env, account);
    await verifyTerms(draft.originalStatus !== 'canceled');
    const current = await this.reconcileOrder(account, initial, signal);
    if (
      current.error ||
      !this.canReplace(current) ||
      (current.replacement?.clientId ?? null) !== draft.previous ||
      active.has(current.status) !== active.has(draft.originalStatus) ||
      current.filledSize !== draft.filledSize ||
      current.price !== draft.originalPrice ||
      current.size !== draft.originalSize
    )
      fail('EXCHANGE_REPLACE_CHANGED');
    guard();
    const replacement = {
      clientId: draft.reviewId,
      specHash: draft.specHash,
      price: draft.price,
      size: draft.size,
      filledSize: draft.filledSize,
      approvedAt: Date.now(),
      error: null,
    };
    let original = this.record({ ...current, replacement });
    this.replacementReviews.delete(draft.reviewId);
    try {
      if (active.has(original.status)) {
        original = await this.cancelRecordedOrder(account, original, guard, signal);
        original = await this.reconcileOrder(account, original, signal);
      }
      if (original.error || original.status !== 'canceled') fail('EXCHANGE_REPLACE_UNVERIFIED');
      if (original.filledSize !== draft.filledSize) fail('EXCHANGE_REPLACE_CHANGED');
      await verifyTerms();
      this.requireReconciled(env, account);
      const latest = this.orders.find((row) => row.clientId === original.clientId);
      if (latest.error || latest.status !== 'canceled' || latest.filledSize !== draft.filledSize)
        fail('EXCHANGE_REPLACE_CHANGED');
      const spec = this.orderSpec(draft, workspace, env, account);
      return await this.placeOrder(
        account,
        { ...spec, clientId: draft.reviewId, replaces: original.clientId },
        guard,
        signal,
      );
    } catch (error) {
      const latest = this.orders.find((row) => row.clientId === original.clientId);
      if (!this.closed && !this.orders.some((row) => row.clientId === draft.reviewId))
        this.record({
          ...latest,
          replacement: { ...replacement, error: safeError(signal?.reason || error) },
        });
      throw error;
    }
  }
  async submitAuthorized(input, workspace, env, account, signal) {
    const spec = this.orderSpec(input, workspace, env, account);
    const specHash = digest(spec);
    const sameOperation = (row) => sameScope(row, spec) && row.operationId === spec.operationId;
    const previous = this.orders.find(sameOperation);
    if (previous) {
      if (previous.specHash !== specHash || previous.grantId !== input.grantId)
        fail('EXCHANGE_REVIEW_CHANGED');
      return present(previous);
    }
    if (
      this.orders.some(
        (row) =>
          sameScope(row, spec) &&
          [...amendments(row), ...cancellations(row)].some(
            (action) => action.operationId === spec.operationId,
          ),
      )
    )
      fail('EXCHANGE_REVIEW_CHANGED');
    const draft = [...this.reviews.values()].find(sameOperation);
    if (draft && draft.specHash !== specHash) fail('EXCHANGE_REVIEW_CHANGED');
    const selected = this.grants.find(
      (grant) => grant.grantId === input.grantId && sameScope(grant, spec),
    );
    if (!selected) fail('EXCHANGE_AUTHORITY_REQUIRED');
    const transport = selected.transport || 'rest';
    if (input.transport != null && input.transport !== transport) fail('EXCHANGE_AUTHORITY_SCOPE');
    if (draft && Boolean(draft.fixConnectionId) !== (transport === 'fix'))
      fail('EXCHANGE_REVIEW_CHANGED');
    const guard = () => this.requireActiveGrant(selected, workspace, account, spec, signal);
    guard();
    this.requireReconciled(env, account);
    const { available: _available, ...estimate } = await this.inspectOrder(
      env,
      spec,
      account,
      signal,
    );
    guard();
    const debit =
      spec.side === 'buy'
        ? amount(estimate.notional) + amount(estimate.estimatedFee)
        : amount(spec.size);
    this.checkAuthorityBudget(selected, debit);
    if (transport === 'fix') {
      // Connection recovery can wait for multiple FIX pages. Revocation and the
      // emergency latch must be able to release the shared execution queue here.
      const controller = new AbortController();
      this.sending = { env, grantId: selected.grantId, controller };
      try {
        const readySignal = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
        guard();
        await this.fix.session(env, account).waitUntilReady(readySignal);
        spec.fixConnectionId = this.fix.writer(env, account, draft?.fixConnectionId).connectionId;
      } finally {
        this.sending = null;
      }
      guard();
    }
    return this.placeOrder(
      account,
      {
        ...spec,
        ...estimate,
        specHash,
        grantId: selected.grantId,
        authorizedDebit: shown(debit),
        clientId: draft?.reviewId || randomUUID(),
      },
      guard,
      signal,
    );
  }
  async execute(action, input, context = {}) {
    if (this.closed) fail('QUANT_STOPPED');
    if (
      context.agentContext &&
      (context.agentContext.workspaceId !== input.id ||
        (!reviewActions.has(action) &&
          !(authorizedActions.has(action) && isRoot(context.agentContext))))
    )
      fail('EXCHANGE_HUMAN_REQUIRED');
    const workspace = this.service.workspace(input.id);
    const env = environment(input.env);
    const scoped = (order) => order.workspaceId === workspace.id && order.env === env;
    const now = Date.now();
    for (const [key, draft] of this.reviews) {
      if (draft.expiresAt <= now) this.reviews.delete(key);
    }
    for (const [key, draft] of this.replacementReviews) {
      if (draft.expiresAt <= now) this.replacementReviews.delete(key);
    }
    for (const [key, draft] of this.amendReviews) {
      if (draft.expiresAt <= now) this.amendReviews.delete(key);
    }
    for (const [key, draft] of this.grantReviews) {
      if (draft.reviewExpiresAt <= now) this.grantReviews.delete(key);
    }
    if (action === 'list') {
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) fail('EXCHANGE_PAGE');
      const items = this.orders.filter(scoped).sort((a, b) => b.createdAt - a.createdAt);
      const grants = ['buy', 'sell']
        .map((side) => this.grants.findLast((grant) => scoped(grant) && grant.side === side))
        .filter(Boolean);
      let account = null;
      let accountError;
      if (!context.agentContext || (grants.length && isRoot(context.agentContext))) {
        try {
          account = await this.account(env, false);
        } catch {
          accountError = 'EXCHANGE_CREDENTIAL_STORAGE';
        }
      }
      const visibleGrants =
        !context.agentContext || isRoot(context.agentContext)
          ? grants.map((grant) => this.presentGrant(grant, workspace, account))
          : [];
      const fixConnection = this.fix.connectionId(env);
      return {
        configured: context.agentContext ? undefined : Boolean(configured(account)),
        ...(accountError && { accountError }),
        product: workspace.market.product,
        next: offset + 20 < items.length ? offset + 20 : null,
        items: items.slice(offset, offset + 20).map((order) => ({
          ...present(order),
          replacementAvailable: Boolean(
            !context.agentContext &&
            order.venueId &&
            configured(account) &&
            account.profileId === order.profileId &&
            workspace.market.venue === 'coinbase' &&
            workspace.market.product === order.product &&
            this.canReplace(order),
          ),
          amendmentAvailable: Boolean(
            canAmend(order) &&
            order.venueId &&
            configured(account) &&
            order.profileId === account.profileId &&
            workspace.market.venue === 'coinbase' &&
            workspace.market.product === order.product &&
            order.fix.connectionId === fixConnection &&
            (!context.agentContext ||
              visibleGrants.some(
                (grant) =>
                  grant.grantId === order.fix.currentGrantId &&
                  grant.allowAmend &&
                  allowsCondition(grant, order) &&
                  grant.ordersRemaining > 0 &&
                  grant.status === 'authorityActive',
              )),
          ),
          cancelAvailable: context.agentContext
            ? Boolean(
                order.venueId &&
                active.has(order.status) &&
                !order.fix?.pending &&
                !pendingCancellation(order) &&
                visibleGrants.some(
                  (grant) =>
                    ownsOrder(grant, order) &&
                    grant.status === 'authorityActive' &&
                    grant.cancelsRemaining > 0,
                ),
              )
            : Boolean(
                configured(account) &&
                order.profileId === account.profileId &&
                humanCanCancel(order),
              ),
        })),
        drafts: [...this.reviews.values()].filter(scoped),
        watch: this.watch.status(env),
        fix: context.agentContext ? undefined : this.fix.status(env),
        grants: visibleGrants,
      };
    }
    if (action === 'connect') {
      const auth = credentials(input);
      const profileId = bindAccounts(await this.api.accounts(env, auth, context.signal));
      if (
        this.orders.some(
          (order) =>
            order.env === env && order.profileId !== profileId && !terminal.has(order.status),
        )
      )
        fail('EXCHANGE_PROFILE_UNRESOLVED');
      await this.saveAccount(env, { ...auth, profileId, credentialId: randomUUID() });
      return { configured: true };
    }
    if (action === 'disconnect') {
      await this.saveAccount(env, null);
      return { configured: false };
    }
    if (action === 'discard') {
      const draft = this.reviews.get(input.reviewId);
      if (draft && scoped(draft)) this.reviews.delete(input.reviewId);
      return { ok: true };
    }
    if (action === 'discardAuthority') {
      const draft = this.grantReviews.get(input.grantId);
      if (draft && scoped(draft)) this.grantReviews.delete(input.grantId);
      return { ok: true };
    }
    if (action === 'discardReplacement') {
      const draft = this.replacementReviews.get(input.reviewId);
      if (draft && scoped(draft)) this.replacementReviews.delete(input.reviewId);
      return { ok: true };
    }
    if (action === 'discardAmend') {
      const draft = this.amendReviews.get(input.reviewId);
      if (draft && scoped(draft)) this.amendReviews.delete(input.reviewId);
      return { ok: true };
    }
    if (authorizedActions.has(action) && !isRoot(context.agentContext))
      fail('EXCHANGE_AGENT_REQUIRED');
    if (action === 'fixDisconnect') return this.fix.drop(env);
    const account = await this.account(env);
    if (action === 'fixConnect') {
      await this.fix.session(env, account).ensure();
      return this.fix.status(env);
    }
    if (action === 'fixQuery') {
      const order = this.orders.find((row) => scoped(row) && row.clientId === input.orderId);
      if (!order || order.profileId !== account.profileId || !order.venueId)
        fail('EXCHANGE_ORDER_ID');
      return this.fix.session(env, account).query(
        {
          ...order,
          ...(order.fix?.pending?.stopPrice && { stopPrice: order.fix.pending.stopPrice }),
          ...(order.fix?.pending?.stopLimitPrice && {
            stopLimitPrice: order.fix.pending.stopLimitPrice,
            price: order.fix.pending.price,
          }),
          clientId: order.fix?.pending?.clientId || order.fix?.clientId || order.clientId,
        },
        context.signal,
      );
    }
    if (action === 'watch') return this.watch.setEnabled(env, account, input.enabled);
    if (['prepareAuthority', 'confirmAuthority'].includes(action))
      return this.grantAction(action, input, workspace, env, account);
    if (action === 'submitAuthorized')
      return this.submitAuthorized(input, workspace, env, account, context.signal);
    if (action === 'amendAuthorized')
      return this.amendAuthorized(input, workspace, env, account, context.signal);
    if (action === 'cancelAuthorized')
      return this.cancelAuthorized(input, workspace, env, account, context.signal);
    if (action === 'previewReplacement')
      return this.previewReplacement(input, workspace, env, account, context.signal);
    if (action === 'confirmReplacement')
      return this.confirmReplacement(input, workspace, env, account, context.signal);
    if (action === 'previewAmend')
      return this.previewAmend(input, workspace, env, account, context.signal);
    if (action === 'confirmAmend')
      return this.confirmAmend(input, workspace, env, account, context.signal);
    if (action === 'preview') {
      const spec = this.orderSpec(input, workspace, env, account);
      if (input.transport != null && !['rest', 'fix'].includes(input.transport))
        fail('EXCHANGE_ORDER_INVALID');
      if (input.transport === 'fix') {
        spec.fixConnectionId = this.fix.writer(env, account).connectionId;
      }
      if (spec.stopPrice && input.transport !== 'fix') fail('EXCHANGE_STOP_REQUIRES_FIX');
      if (
        this.orders.some(
          (o) =>
            scoped(o) &&
            (o.operationId === spec.operationId ||
              [...amendments(o), ...cancellations(o)].some(
                (action) => action.operationId === spec.operationId,
              )),
        )
      )
        fail('EXCHANGE_ORDER_ALREADY_RECORDED');
      const old = [...this.reviews.values()].find(
        (draft) => scoped(draft) && draft.operationId === spec.operationId,
      );
      if (old) {
        if (old.specHash !== digest(spec)) fail('EXCHANGE_REVIEW_CHANGED');
        return old;
      }
      if (this.reviews.size >= 32) fail('EXCHANGE_REVIEW_LIMIT');
      const emergency = this.service.getWallet().emergency;
      const generation = env === 'live' ? emergency.assert() : null;
      const preview = await this.inspectOrder(env, spec, account, context.signal);
      const reviewId = randomUUID();
      const draft = {
        ...spec,
        ...preview,
        reviewId,
        specHash: digest(spec),
        generation,
        expiresAt: Date.now() + 90000,
      };
      this.reviews.set(reviewId, draft);
      return draft;
    }
    if (action === 'confirm') {
      const previous = this.orders.find(
        (entry) => scoped(entry) && entry.clientId === input.reviewId,
      );
      if (previous) return present(previous);
      const draft = this.reviews.get(input.reviewId);
      if (
        !draft ||
        !scoped(draft) ||
        draft.profileId !== account.profileId ||
        input.specHash !== draft.specHash ||
        input.ack !== 'PLACE ORDER' ||
        workspace.market.venue !== 'coinbase' ||
        workspace.market.product !== draft.product
      )
        fail('EXCHANGE_REVIEW_CHANGED');
      this.requireReconciled(env, account);
      const emergency = this.service.getWallet().emergency;
      const guard = () => {
        if (this.closed) fail('QUANT_STOPPED');
        if (Date.now() >= draft.expiresAt) fail('EXCHANGE_REVIEW_CHANGED');
        const current = this.service.workspace(input.id);
        if (current.market.venue !== 'coinbase' || current.market.product !== draft.product)
          fail('EXCHANGE_REVIEW_CHANGED');
        if (env === 'live') emergency.assert(draft.generation);
        if (draft.fixConnectionId) this.fix.writer(env, account, draft.fixConnectionId);
      };
      guard();
      const refreshed = await this.inspectOrder(env, draft, account, context.signal);
      if (amount(refreshed.estimatedFee) > amount(draft.estimatedFee))
        fail('EXCHANGE_REVIEW_CHANGED');
      guard();
      const { reviewId, expiresAt, generation, available, ...spec } = draft;
      return this.placeOrder(account, { ...spec, clientId: reviewId }, guard, context.signal);
    }
    if (!['reconcile', 'cancel'].includes(action)) fail('EXCHANGE_ACTION');
    const order = this.orders.find((entry) => scoped(entry) && entry.clientId === input.orderId);
    if (!order || order.profileId !== account.profileId) fail('EXCHANGE_ORDER_ID');
    if (action === 'reconcile') return this.reconcileOrder(account, order, context.signal);
    if (input.ack !== 'CANCEL ORDER' || !humanCanCancel(order)) fail('EXCHANGE_CANCEL_REVIEW');
    return this.cancelRecordedOrder(account, order, () => {
      if (this.closed) fail('QUANT_STOPPED');
    });
  }
  shouldWatch(order, now = Date.now()) {
    if (active.has(order.status) || unknown.has(order.status)) return true;
    return (
      ['canceled', 'filled'].includes(order.status) &&
      !order.settled &&
      now - (order.canceledAt || order.checkedAt || order.createdAt) < 20 * 60000
    );
  }
  async lookupOrder(account, order, signal) {
    if (order.fix?.pending) return this.lookupAmend(account, order, signal);
    try {
      const result = toOrder(await this.api.lookup(order.env, account, order, signal), order);
      return pendingCancellation(order) && active.has(result.status)
        ? { ...result, status: 'cancel-unknown', error: 'EXCHANGE_CANCEL_PENDING' }
        : result;
    } catch (error) {
      if (error.httpStatus !== 404) throw error;
      return {
        ...order,
        status: active.has(order.status) ? 'status-unknown' : order.status,
        error: 'EXCHANGE_ORDER_NOT_FOUND',
        checkedAt: Date.now(),
      };
    }
  }
  async lookupAmend(account, order, signal) {
    const attempt = order.fix.pending;
    const expected = finishAmend(order, 'applied');
    try {
      const report = await this.api.lookup(
        order.env,
        account,
        { ...order, clientId: attempt.clientId, venueId: undefined },
        signal,
      );
      if (
        attempt.stopPrice &&
        report.client_oid !== attempt.clientId &&
        !(attempt.stopLimitPrice
          ? tpslRevisionObserved(report, order, expected)
          : restStopMatches(report, expected))
      )
        fail('EXCHANGE_RESPONSE');
      return toOrder(report, expected);
    } catch (error) {
      if (error.httpStatus !== 404 && error.message !== 'EXCHANGE_RESPONSE') throw error;
    }
    try {
      const report = await this.api.lookup(order.env, account, order, signal);
      // The immutable venue ID, scoped profile and distinct approved terms identify the amended order.
      if (
        attempt.stopLimitPrice
          ? tpslRevisionObserved(report, order, expected)
          : amount(report.price, 'EXCHANGE_RESPONSE') === amount(attempt.price) &&
            amount(report.size, 'EXCHANGE_RESPONSE') === amount(attempt.size) &&
            (!attempt.stopPrice ||
              (attempt.stopPrice === order.stopPrice && changedTerms(attempt, order)) ||
              report.client_oid === attempt.clientId ||
              restStopMatches(report, expected))
      )
        return toOrder(report, expected);
      // A triggered limit with the old client ID and missing trigger terms cannot prove that a
      // trigger-only amendment was applied. Keep the pending revision unless the order is terminal.
      const original = toOrder(report, order);
      if (terminal.has(original.status)) return finishAmend(original, 'closed');
      return { ...original, status: 'amend-unknown', error: 'EXCHANGE_FIX_AMEND_PENDING' };
    } catch (error) {
      if (error.httpStatus !== 404) throw error;
      return { ...order, error: 'EXCHANGE_FIX_AMEND_PENDING' };
    }
  }
  async reconcileOrder(account, order, signal) {
    const latest = this.orders.find((row) => row.clientId === order.clientId);
    this.activeWrites.add(order.clientId);
    try {
      return this.record(await this.lookupOrder(account, latest, signal));
    } finally {
      this.activeWrites.delete(order.clientId);
    }
  }
  async verifyWatchedOrder(account, order, signal) {
    const next = await this.lookupOrder(account, order, signal);
    if (
      this.closed ||
      signal.aborted ||
      this.activeWrites.has(order.clientId) ||
      (order.env === 'live' && this.emergencyCancellation.running) ||
      this.accounts.get(order.env) !== account ||
      this.orders.find((entry) => entry.clientId === order.clientId) !== order
    )
      return false;
    if (
      next.fix?.pending !== order.fix?.pending ||
      [
        'status',
        'venueId',
        'filledSize',
        'executedValue',
        'fillFees',
        'settled',
        'stopState',
        'activePrice',
        'activeLeg',
        'error',
      ].some((key) => next[key] !== order[key])
    )
      this.record(next);
    if (next.error) fail(next.error);
    return true;
  }
  applyTpslUpdate(env, account, fields) {
    if (
      this.closed ||
      this.accounts.get(env) !== account ||
      (env === 'live' && this.emergencyCancellation.running)
    )
      return;
    const order = this.orders.find(
      (row) =>
        row.env === env &&
        row.profileId === account.profileId &&
        row.stopLimitPrice &&
        active.has(row.status) &&
        row.venueId === fields.get(37) &&
        row.fix?.clientId === fields.get(11),
    );
    if (!order || this.activeWrites.has(order.clientId)) return;
    let next;
    try {
      const report = executionStatus(fields, { ...order, clientId: order.fix.clientId }, false);
      if (report.executionType === 'D') {
        if (!matchesPrice(report.price, order.stopLimitPrice)) return;
        report.filledSize ??= order.filledSize;
      }
      next = applyFixExecution(order, report);
    } catch (error) {
      if (error.message === 'EXCHANGE_FIX_REPORT') return;
      throw error;
    }
    this.record(next);
  }
  async cancelRecordedOrder(account, order, guard, signal, { attempt, fix } = {}) {
    const canceling = {
      ...order,
      status: 'canceling',
      ...(attempt && { cancellations: [...cancellations(order), attempt] }),
    };
    this.record(canceling);
    this.activeWrites.add(order.clientId);
    let started = false;
    let result;
    try {
      const beforeSend = () => {
        guard();
        started = true;
      };
      let confirmed = canceling;
      if (fix) {
        const report = await fix.session.cancel(
          { ...order, clientId: attempt.clientId, origClientId: order.fix.clientId },
          fix.connectionId,
          beforeSend,
          signal,
        );
        confirmed = applyFixExecution(canceling, {
          ...report,
          filledSize: report.filledSize ?? order.filledSize,
        });
      } else {
        const acknowledged = await this.api.cancel(order.env, account, order, beforeSend, signal);
        if (acknowledged !== (order.venueId || order.clientId)) fail('EXCHANGE_RESPONSE');
      }
      result = {
        ...confirmed,
        status: 'canceled',
        settled: false,
        canceledAt: Date.now(),
        error: null,
      };
      if (attempt) result = finishCancellation(result, 'canceled');
    } catch (error) {
      const unresolved = started && (!attempt || !error.fixRejected);
      result = {
        ...canceling,
        status: unresolved ? 'cancel-unknown' : order.status,
        error: safeError(signal?.reason || error),
      };
      if (attempt && !unresolved)
        result = finishCancellation(result, started ? 'rejected' : 'skipped');
    } finally {
      this.activeWrites.delete(order.clientId);
    }
    return this.record(result);
  }
  async cancelForEmergency(account, initial, guard, signal) {
    const verify = async (order) => {
      guard();
      if (order.fix?.pending) return this.record(await this.lookupAmend(account, order, signal));
      try {
        return this.record(
          toOrder(await this.api.lookup(order.env, account, order, signal), order),
        );
      } catch (error) {
        if (error.httpStatus !== 404) throw error;
        return order;
      }
    };
    // A restarted or lost acknowledgement needs an exact read before any reattempt.
    // A native amendment retains the same venue ID. Cancel that exact ID even when its terms are unresolved.
    const order =
      unknown.has(initial.status) && !initial.fix?.pending ? await verify(initial) : initial;
    if (!isOpenOrder(order)) return;
    guard();
    const result = await this.cancelRecordedOrder(account, order, guard, signal);
    if (['EXCHANGE_AUTH', 'EXCHANGE_RATE_LIMIT'].includes(result.error)) fail(result.error);
    if (isOpenOrder(result) && !signal.aborted && isOpenOrder(await verify(result)))
      fail(result.error || 'EXCHANGE_EMERGENCY_UNRESOLVED');
  }
  async placeOrder(account, spec, guard, callerSignal) {
    const { fixConnectionId, ...terms } = spec;
    if (terms.stopPrice && !fixConnectionId) fail('EXCHANGE_STOP_REQUIRES_FIX');
    const order = {
      ...terms,
      ...(terms.stopPrice && { stopState: 'unverified' }),
      createdAt: Date.now(),
      status: 'submitting',
      ...(fixConnectionId && {
        fix: {
          clientId: terms.clientId,
          connectionId: fixConnectionId,
          currentGrantId: terms.grantId || null,
          amendments: [],
        },
      }),
    };
    const { env, grantId } = order;
    this.record(order);
    this.activeWrites.add(order.clientId);
    this.reviews.delete(order.clientId);
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    this.sending = { env, grantId, controller };
    let started = false;
    let result;
    try {
      const beforeSend = () => {
        guard();
        started = true;
      };
      if (fixConnectionId) {
        const { session } = this.fix.writer(env, account, fixConnectionId);
        result = applyFixExecution(
          order,
          await session.submit(order, fixConnectionId, beforeSend, signal),
        );
      } else
        result = toOrder(
          await this.api.submit(
            env,
            account,
            {
              type: 'limit',
              time_in_force: 'GTC',
              product_id: order.product,
              side: order.side,
              price: order.price,
              size: order.size,
              post_only: order.postOnly,
              client_oid: order.clientId,
            },
            beforeSend,
            signal,
          ),
          order,
        );
    } catch (error) {
      const rejected =
        !started || error.fixRejected || [400, 401, 403, 422, 429].includes(error.httpStatus);
      result = {
        ...order,
        status: rejected ? 'rejected' : 'submit-unknown',
        error: safeError(signal.reason || error),
        ...(!started && { dispatchSkipped: true }),
      };
    } finally {
      this.sending = null;
      this.activeWrites.delete(order.clientId);
    }
    return this.record(result);
  }
  emergencyHalt() {
    if (this.sending?.env === 'live')
      this.sending.controller.abort(Error('WALLET_EMERGENCY_STOPPED'));
  }
  dispose() {
    this.closed = true;
    this.fix.dispose();
    this.watch.dispose();
    this.sending?.controller.abort(Error('QUANT_STOPPED'));
    this.emergencyCancellation.dispose();
    this.accounts.clear();
    this.reviews.clear();
    this.replacementReviews.clear();
    this.amendReviews.clear();
    this.grantReviews.clear();
  }
}

function safeError(error) {
  return /^EXCHANGE_[A-Z_]+$|^WALLET_EMERGENCY_[A-Z_]+$/.test(error?.message || '')
    ? error.message
    : 'EXCHANGE_NETWORK';
}

module.exports = { ExchangeOrders };
