/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { addAbortListener } = require('node:events');
const { performance } = require('node:perf_hooks');
const { connectFix } = require('./coinbase-fix-network');
const { id, products } = require('./coinbase-exchange');
const { onPolicyChange } = require('../../net-proxy');
const {
  FixFramer,
  encode,
  timestamp,
  logonFields,
  numberField,
  MAX_SEQUENCE,
} = require('./coinbase-fix-wire');

const phaseErrors = /^EXCHANGE_FIX_[A-Z_]+$/;
const statusCodes = {
  0: 'open',
  1: 'partially-filled',
  2: 'filled',
  4: 'canceled',
  8: 'rejected',
  A: 'pending',
  C: 'canceled',
};
const nextError = (error, fallback) =>
  phaseErrors.test(error?.message || '') ? error : Error(fallback);
const quoteTicks = (price) => {
  if (typeof price !== 'string' || !/^\d{1,18}(?:\.\d{1,18})?$/.test(price))
    throw Error('EXCHANGE_FIX_REPORT');
  const [whole, fraction = ''] = price.split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
};
const orderType = (order) => (order.stopLimitPrice ? 'O' : order.stopPrice ? '4' : '2');
const triggerFields = (order, submitting) => {
  if (!order.stopPrice) return [];
  return [
    [99, order.stopPrice],
    ...(order.stopLimitPrice
      ? [[3040, order.stopLimitPrice]]
      : submitting
        ? [[1109, order.triggerDirection === 'up' ? 'U' : 'D']]
        : []),
  ];
};

function withAbort(operation, signal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  let abort;
  const canceled = new Promise((_, reject) => {
    abort = addAbortListener(signal, () => reject(signal.reason));
  });
  return Promise.race([operation, canceled]).finally(() => abort[Symbol.dispose]());
}

function orderStatus(fields, order) {
  const status = fields.get(39);
  if (status === '8' && fields.get(103) === '5') throw Error('EXCHANGE_FIX_NOT_FOUND');
  if (
    !Object.hasOwn(statusCodes, status) ||
    fields.get(55) !== order.product ||
    !id.test(fields.get(37)) ||
    (order.venueId && fields.get(37) !== order.venueId) ||
    (fields.has(54) && fields.get(54) !== (order.side === 'buy' ? '1' : '2')) ||
    (fields.has(40) &&
      fields.get(40) !== orderType(order) &&
      !(order.stopPrice && fields.get(40) === '2')) ||
    (fields.has(99) &&
      (!order.stopPrice || quoteTicks(fields.get(99)) !== quoteTicks(order.stopPrice))) ||
    (fields.has(1109) &&
      (!order.triggerDirection ||
        fields.get(1109) !== (order.triggerDirection === 'up' ? 'U' : 'D'))) ||
    (fields.has(3040) &&
      (!order.stopLimitPrice || quoteTicks(fields.get(3040)) !== quoteTicks(order.stopLimitPrice)))
  )
    throw Error('EXCHANGE_FIX_REPORT');
  const quantity = (tag) => {
    const value = fields.get(tag);
    if (value !== undefined && !/^\d{1,18}(?:\.\d{1,18})?$/.test(value))
      throw Error('EXCHANGE_FIX_REPORT');
    return value ?? null;
  };
  const price = quantity(44);
  const filledSize = quantity(14);
  const stopLoss =
    order.stopLimitPrice && price && quoteTicks(price) === quoteTicks(order.stopLimitPrice);
  if (order.stopLimitPrice && price && !stopLoss && quoteTicks(price) !== quoteTicks(order.price))
    throw Error('EXCHANGE_FIX_REPORT');
  return {
    status: statusCodes[status],
    venueId: fields.get(37),
    clientId: order.clientId,
    filledSize,
    remainingSize: quantity(151),
    price,
    size: quantity(38),
    averagePrice: quantity(6),
    ...(order.stopPrice && {
      triggered: Boolean(
        stopLoss ||
        (order.stopLimitPrice
          ? filledSize && quoteTicks(filledSize) > 0n
          : fields.get(40) === '2') ||
        ['1', '2'].includes(status),
      ),
    }),
    checkedAt: Date.now(),
  };
}

function executionStatus(fields, order, replace) {
  const type = fields.get(150);
  if (
    !id.test(fields.get(17)) ||
    (replace && fields.get(41) !== order.origClientId) ||
    (fields.has(55) && fields.get(55) !== order.product) ||
    (fields.has(37) && order.venueId && fields.get(37) !== order.venueId) ||
    (fields.has(40) &&
      fields.get(40) !== orderType(order) &&
      !(order.stopPrice && fields.get(40) === '2' && ['4', 'F'].includes(type))) ||
    (fields.has(59) && fields.get(59) !== '1') ||
    (fields.has(18) && fields.get(18) !== (order.postOnly ? 'A' : undefined))
  )
    throw Error('EXCHANGE_FIX_REPORT');
  if (type === '8' && fields.get(39) === '8') throw rejected(false);
  if (type === '8' || fields.get(39) === '8') throw Error('EXCHANGE_FIX_REPORT');
  const accepted = new Map(fields);
  if (type === '5' && fields.get(39) === '5') {
    const remaining = fields.get(151);
    const filled = fields.get(14);
    if (remaining === undefined || filled === undefined) throw Error('EXCHANGE_FIX_REPORT');
    accepted.set(
      39,
      /^0+(?:\.0+)?$/.test(remaining) ? '2' : /^0+(?:\.0+)?$/.test(filled) ? '0' : '1',
    );
  }
  return { ...orderStatus(accepted, order), executionId: fields.get(17), executionType: type };
}

const rejected = (query) =>
  Object.assign(Error(query ? 'EXCHANGE_FIX_QUERY_REJECTED' : 'EXCHANGE_FIX_TRADE_REJECTED'), {
    fixRejected: !query,
  });

class CoinbaseFixSession {
  constructor({
    env,
    account,
    cursor = 2,
    previousSession = cursor > 2,
    connect = connectFix,
    subscribePolicy = onPolicyChange,
    change = () => {},
    venueUpdate = () => {},
    checkpoint = () => {},
    heartbeatSeconds = 10,
    timeout = 10000,
  }) {
    Object.assign(this, {
      env,
      account,
      cursor,
      previousSession,
      connect,
      change,
      venueUpdate,
      checkpoint,
      heartbeatSeconds,
      timeout,
    });
    this.phase = 'idle';
    this.unsubscribe = subscribePolicy(() => this.disconnect('EXCHANGE_FIX_POLICY'));
  }

  status() {
    return { phase: this.phase, lastSequence: this.cursor - 1, error: this.error ?? null };
  }

  setPhase(phase, error) {
    this.phase = phase;
    this.error = error;
    this.change();
  }

  ensure() {
    if (this.closed) throw Error('EXCHANGE_FIX_CLOSED');
    if (this.current) return this.current.ready.promise;
    const ready = Promise.withResolvers();
    ready.promise.catch(() => {});
    const channel = {
      id: randomUUID(),
      controller: new AbortController(),
      ready,
      framer: new FixFramer(),
      nextOut: 1,
      expected: this.cursor,
      buffer: new Map(),
      lastRx: performance.now(),
      resume: this.previousSession,
    };
    this.current = channel;
    this.setPhase('connecting');
    this.deadline(channel);
    void this.open(channel);
    return ready.promise;
  }

  async open(channel) {
    try {
      const socket = await this.connect(this.env, channel.controller.signal);
      if (this.current !== channel) {
        socket.destroy();
        return;
      }
      channel.socket = socket;
      socket.on('error', () => this.fail(channel, 'EXCHANGE_FIX_NETWORK'));
      socket.once('close', () => this.fail(channel, 'EXCHANGE_FIX_NETWORK'));
      socket.on('data', (chunk) => {
        if (this.current !== channel) return;
        try {
          channel.framer.push(chunk, (fields) => {
            if (this.current === channel) this.receive(channel, fields);
          });
        } catch (error) {
          this.fail(channel, nextError(error, 'EXCHANGE_FIX_FRAME').message);
        }
      });
      const time = timestamp();
      this.send(
        channel,
        'A',
        logonFields(this.account, time, this.heartbeatSeconds, channel.resume),
        time,
      );
    } catch (error) {
      this.fail(channel, nextError(error, 'EXCHANGE_FIX_NETWORK').message);
    }
  }

  send(channel, type, fields, time, beforeWrite) {
    if (this.current !== channel || !channel.socket?.writable) throw Error('EXCHANGE_FIX_NETWORK');
    const sequence = channel.nextOut;
    const packet = encode({ type, sequence, from: this.account.key, to: 'Coinbase', time }, fields);
    beforeWrite?.(sequence);
    channel.nextOut++;
    channel.lastTx = performance.now();
    channel.socket.write(packet);
  }

  deadline(channel) {
    clearTimeout(channel.deadline);
    channel.deadline = setTimeout(() => this.fail(channel, 'EXCHANGE_FIX_TIMEOUT'), this.timeout);
    channel.deadline.unref();
  }

  receive(channel, fields) {
    if (
      fields.get(49) !== 'Coinbase' ||
      fields.get(56) !== this.account.key ||
      !/^\d{8}-\d{2}:\d{2}:\d{2}(?:\.\d{3,9})?$/.test(fields.get(52) || '')
    )
      throw Error('EXCHANGE_FIX_FRAME');
    const type = fields.get(35);
    const seq = numberField(fields.get(34));
    channel.lastRx = performance.now();
    if (!channel.loggedOn) {
      if (type === '3' || type === '5') throw Error('EXCHANGE_FIX_AUTH');
      if (type !== 'A' || seq !== 1 || fields.get(43) === 'Y') throw Error('EXCHANGE_FIX_FRAME');
      channel.loggedOn = true;
      channel.waitingReset = channel.resume && fields.get(141) !== 'Y';
      channel.initialReset = true;
      channel.heartbeat = fields.has(108)
        ? numberField(fields.get(108), 30)
        : this.heartbeatSeconds;
      channel.interval = setInterval(
        () => this.heartbeat(channel),
        Math.min(1000, channel.heartbeat * 250),
      );
      channel.interval.unref();
      if (!channel.waitingReset) {
        this.advance(channel, 2);
        this.ready(channel);
      }
      return;
    }
    if (channel.initialReset && type === '4' && fields.get(43) !== 'Y') {
      const end = this.gapEnd(fields);
      channel.initialReset = false;
      channel.waitingReset = false;
      if (end < channel.expected) {
        if (end !== 2) throw Error('EXCHANGE_FIX_SEQUENCE');
        this.advance(channel, 2);
      }
      channel.resumeEnd = end;
      this.pump(channel);
      return;
    }
    channel.initialReset = false;
    if (channel.waitingReset) throw Error('EXCHANGE_FIX_SEQUENCE');
    if (seq < channel.expected) {
      if (fields.get(43) === 'Y') return;
      throw Error('EXCHANGE_FIX_SEQUENCE');
    }
    if (seq > channel.expected) {
      if (channel.buffer.size >= 256 || channel.buffer.has(seq))
        throw Error('EXCHANGE_FIX_SEQUENCE');
      channel.buffer.set(seq, fields);
    } else this.accept(channel, fields, seq);
    this.pump(channel);
  }

  gapEnd(fields) {
    if (fields.get(123) !== 'Y') throw Error('EXCHANGE_FIX_SEQUENCE');
    return numberField(fields.get(36));
  }

  advance(channel, next) {
    if (next >= MAX_SEQUENCE) throw Error('EXCHANGE_FIX_SEQUENCE');
    channel.expected = next;
    this.cursor = next;
  }

  accept(channel, fields, seq) {
    const type = fields.get(35);
    if (type === '4') {
      const end = this.gapEnd(fields);
      if (fields.get(43) !== 'Y' || end <= seq || [...channel.buffer.keys()].some((n) => n < end))
        throw Error('EXCHANGE_FIX_SEQUENCE');
      this.advance(channel, end);
      return;
    }
    if (type === 'A' || type === '2') throw Error('EXCHANGE_FIX_SEQUENCE');
    this.advance(channel, seq + 1);
    if (type === '5') {
      this.send(channel, '5', []);
      this.fail(channel, 'EXCHANGE_FIX_LOGOUT', true);
      return;
    }
    if (type === '1') {
      const request = fields.get(112);
      if (!request) throw Error('EXCHANGE_FIX_FRAME');
      this.send(channel, '0', [[112, request]]);
    }
    if (type === '0' && fields.get(112) === channel.challenge?.id) channel.challenge = null;
    const pending = channel.pending;
    if (
      type === '8' &&
      fields.get(40) === 'O' &&
      ((fields.get(150) === 'D' && fields.get(378) === '3') ||
        (fields.get(150) === 'F' && fields.get(11) !== pending?.order.clientId))
    )
      this.venueUpdate(fields);
    if (!pending || seq < pending.firstSequence) return;
    const query = pending.type === 'H';
    const replace = pending.type === 'G';
    const cancel = pending.type === 'F';
    if (
      (type === '3' && fields.get(45) === String(pending.sequence)) ||
      (type === 'j' &&
        fields.get(372) === pending.type &&
        (fields.get(45) === String(pending.sequence) || fields.get(379) === pending.order.clientId))
    ) {
      this.settle(channel, rejected(query));
      return;
    }
    if (fields.get(11) !== pending.order.clientId) return;
    if (
      (replace || cancel) &&
      type === '9' &&
      fields.get(434) === (cancel ? '1' : '2') &&
      (!cancel || fields.get(39) === '8') &&
      fields.get(41) === pending.order.origClientId &&
      (!fields.has(37) || fields.get(37) === pending.order.venueId)
    ) {
      this.settle(channel, rejected(false));
      return;
    }
    if (type !== '8') return;
    const exec = fields.get(150);
    const admitted = query
      ? exec === 'I'
      : replace
        ? exec === '5' || exec === '8'
        : cancel
          ? exec === '4'
          : ['0', 'F', '4', '8'].includes(exec);
    if (!admitted) return;
    try {
      if (
        cancel &&
        (fields.get(39) !== '4' ||
          (fields.has(41) && fields.get(41) !== pending.order.origClientId) ||
          (fields.has(151) && !/^0+(?:\.0+)?$/.test(fields.get(151))))
      )
        throw Error('EXCHANGE_FIX_REPORT');
      this.settle(
        channel,
        null,
        query
          ? orderStatus(fields, pending.order)
          : executionStatus(fields, pending.order, replace),
      );
    } catch (error) {
      this.settle(channel, error);
    }
  }

  pump(channel) {
    while (this.current === channel && channel.buffer.has(channel.expected)) {
      const seq = channel.expected;
      const fields = channel.buffer.get(seq);
      channel.buffer.delete(seq);
      this.accept(channel, fields, seq);
    }
    if (this.current !== channel) return;
    if (channel.pageEnd && channel.expected <= channel.pageEnd) return;
    if (channel.pageEnd) this.checkpoint(this.cursor);
    channel.pageEnd = null;
    const next = Math.min(
      channel.resumeEnd > channel.expected ? channel.resumeEnd : Infinity,
      ...channel.buffer.keys(),
    );
    if (next !== Infinity) {
      channel.pageEnd = Math.min(next - 1, channel.expected + 999);
      if (this.phase === 'ready') {
        channel.ready = Promise.withResolvers();
        // Gaps can arrive while there is no caller waiting for the session.
        channel.ready.promise.catch(() => {});
      }
      if (this.phase !== 'recovering') this.setPhase('recovering');
      this.deadline(channel);
      this.send(channel, '2', [
        [7, channel.expected],
        [16, channel.pageEnd],
      ]);
      return;
    }
    this.ready(channel);
  }

  ready(channel) {
    clearTimeout(channel.deadline);
    if (this.phase === 'ready') return;
    this.checkpoint(this.cursor);
    this.previousSession = true;
    this.setPhase('ready');
    channel.ready.resolve(channel);
  }

  heartbeat(channel) {
    if (this.current !== channel) return;
    const now = performance.now();
    const interval = channel.heartbeat * 1000;
    try {
      if (channel.challenge && now - channel.challenge.at >= interval)
        this.fail(channel, 'EXCHANGE_FIX_TIMEOUT');
      else if (!channel.challenge && now - channel.lastRx >= 1.5 * interval) {
        channel.challenge = { id: randomUUID(), at: now };
        this.send(channel, '1', [[112, channel.challenge.id]]);
      } else if (now - channel.lastTx >= interval) this.send(channel, '0', []);
    } catch (error) {
      this.fail(channel, nextError(error, 'EXCHANGE_FIX_NETWORK').message);
    }
  }

  connectionId() {
    return this.phase === 'ready' ? this.current?.id : undefined;
  }

  waitUntilReady(signal) {
    signal?.throwIfAborted();
    return withAbort(this.ensure(), signal);
  }

  query(order, signal) {
    return this.request(
      'H',
      order,
      [
        [11, order.clientId],
        [55, order.product],
      ],
      signal,
    );
  }

  submit(order, connectionId, guard, signal) {
    return this.request(
      'D',
      order,
      [
        [11, order.clientId],
        ...(order.postOnly ? [[18, 'A']] : []),
        [38, order.size],
        [40, orderType(order)],
        [44, order.price],
        [54, order.side === 'buy' ? '1' : '2'],
        [55, order.product],
        [59, '1'],
        ...triggerFields(order, true),
      ],
      signal,
      connectionId,
      guard,
    );
  }

  amend(order, connectionId, guard, signal) {
    if (!id.test(order.origClientId) || !id.test(order.venueId)) throw Error('EXCHANGE_FIX_REPORT');
    return this.request(
      'G',
      order,
      [
        [11, order.clientId],
        [37, order.venueId],
        [41, order.origClientId],
        [38, order.size],
        [44, order.price],
        [55, order.product],
        [40, orderType(order)],
        ...triggerFields(order, false),
      ],
      signal,
      connectionId,
      guard,
    );
  }

  cancel(order, connectionId, guard, signal) {
    if (!id.test(order.origClientId) || !id.test(order.venueId)) throw Error('EXCHANGE_FIX_REPORT');
    return this.request(
      'F',
      order,
      [
        [11, order.clientId],
        [37, order.venueId],
        [41, order.origClientId],
        [55, order.product],
      ],
      signal,
      connectionId,
      guard,
    );
  }

  async request(type, order, fields, signal, connectionId, guard) {
    if (
      !id.test(order.clientId) ||
      (order.venueId && !id.test(order.venueId)) ||
      !products.includes(order.product)
    )
      throw Error('EXCHANGE_FIX_REPORT');
    signal?.throwIfAborted();
    const channel = type === 'H' ? await this.waitUntilReady(signal) : this.current;
    signal?.throwIfAborted();
    if (type !== 'H' && (!connectionId || this.connectionId() !== connectionId))
      throw Error('EXCHANGE_FIX_SAME_CONNECTION');
    if (this.phase !== 'ready' || this.current !== channel || channel.pending)
      throw Error('EXCHANGE_FIX_BUSY');
    const pending = { ...Promise.withResolvers(), type, order, firstSequence: channel.expected };
    channel.pending = pending;
    pending.deadline = setTimeout(() => this.fail(channel, 'EXCHANGE_FIX_TIMEOUT'), this.timeout);
    pending.deadline.unref();
    if (signal)
      pending.abort = addAbortListener(signal, () =>
        this.fail(channel, 'EXCHANGE_FIX_INTERRUPTED'),
      );
    try {
      this.send(channel, type, fields, undefined, (seq) => {
        guard?.();
        pending.sequence = seq;
      });
    } catch (error) {
      if (pending.sequence) this.fail(channel, nextError(error, 'EXCHANGE_FIX_NETWORK').message);
      else this.settle(channel, error);
    }
    return pending.promise;
  }

  settle(channel, error, value) {
    const pending = channel.pending;
    if (!pending) return;
    channel.pending = null;
    pending.abort?.[Symbol.dispose]();
    clearTimeout(pending.deadline);
    if (!error) {
      try {
        this.checkpoint(this.cursor);
      } catch (failure) {
        error = failure;
      }
    }
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  fail(channel, code, graceful = false) {
    if (this.current !== channel) return;
    this.current = null;
    clearTimeout(channel.deadline);
    clearInterval(channel.interval);
    const error = Error(code);
    this.settle(channel, error);
    channel.ready.reject(error);
    if (graceful) channel.socket?.end();
    else channel.socket?.destroy();
    channel.controller.abort(error);
    this.setPhase('disconnected', code);
  }

  disconnect(code = 'EXCHANGE_FIX_CLOSED') {
    if (this.current) this.fail(this.current, code);
  }

  close() {
    this.closed = true;
    this.unsubscribe();
    this.disconnect();
  }
}

module.exports = { CoinbaseFixSession, executionStatus };
