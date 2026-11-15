/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { SOURCE } = require('./base-history');
const { CHAINS, INTERVALS } = require('./market-data');

const SERIES_SOURCE = 'base-finalized-uniswap-v3-series';
const MAX_SEGMENTS = 512;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_WINDOWS = 10000;

function sameBlock(a, b) {
  return a && b && a.number === b.number && a.hash === b.hash && a.time === b.time;
}

function validSegment(data) {
  const { amm, market } = data;
  if (
    data.source !== SOURCE ||
    !amm ||
    !INTERVALS.includes(amm.interval) ||
    market.interval !== amm.interval ||
    CHAINS[market.venue]?.id !== amm.chainId
  )
    throw Error('BASE_SERIES_REQUIRES_SEGMENT');
  if (
    !Number.isSafeInteger(amm.startTime) ||
    !Number.isSafeInteger(amm.endTime) ||
    amm.startTime < 0 ||
    amm.endTime <= amm.startTime ||
    amm.startTime % amm.interval ||
    amm.endTime % amm.interval ||
    !amm.boundary ||
    amm.boundary.time < amm.endTime
  )
    throw Error('BASE_SERIES_INVALID_WINDOW');
  return amm;
}

function checkJoin(earlier, later) {
  if (
    earlier.chainId !== later.chainId ||
    earlier.pool !== later.pool ||
    earlier.fee !== later.fee ||
    earlier.interval !== later.interval
  )
    throw Error('BASE_SERIES_SOURCE_CHANGED');
  const nextBlock = earlier.boundary.time < later.endTime ? later.firstBlock : later.boundary;
  if (earlier.endTime !== later.startTime || !sameBlock(earlier.boundary, nextBlock))
    throw Error('BASE_SERIES_DISCONTINUITY');
}

async function buildSeries(anchorId, windows, load) {
  const segments = [],
    candlePages = [],
    seen = new Set();
  let id = anchorId,
    newer,
    requestedStart,
    latest,
    market,
    bytes = 0;
  while (id !== null) {
    if (seen.has(id)) throw Error('BASE_SERIES_DISCONTINUITY');
    if (seen.size >= MAX_SEGMENTS || bytes >= MAX_BYTES) throw Error('BASE_SERIES_READ_LIMIT');
    seen.add(id);
    const loaded = await load(id, MAX_BYTES - bytes);
    bytes += loaded.bytes;
    const { data } = loaded;
    const amm = validSegment(data);
    if (newer) {
      if (data.market.venue !== market.venue || data.market.product !== market.product)
        throw Error('BASE_SERIES_SOURCE_CHANGED');
      checkJoin(amm, newer);
    } else {
      latest = amm;
      market = data.market;
      const count = windows ?? Math.ceil(86400 / amm.interval);
      if (!Number.isSafeInteger(count) || count < 1 || count > MAX_WINDOWS)
        throw Error('BASE_SERIES_WINDOW');
      requestedStart = Math.max(0, amm.endTime - count * amm.interval);
    }
    const start = Math.max(amm.startTime, requestedStart);
    if (
      data.candles.some(
        (bar) => bar.time < amm.startTime || bar.time >= amm.endTime || bar.time % amm.interval,
      )
    )
      throw Error('BASE_SERIES_INVALID_WINDOW');
    segments.push({ id, startTime: start, endTime: amm.endTime });
    candlePages.push(data.candles.filter((bar) => bar.time >= start));
    if (start === requestedStart) break;
    id = amm.previousDatasetId;
    newer = amm;
  }
  const candles = candlePages.reverse().flat();
  segments.reverse();
  const startTime = segments[0].startTime;
  const slots = (latest.endTime - startTime) / latest.interval;
  const emptyRanges = [];
  let cursor = startTime;
  for (const bar of candles) {
    if (bar.time > cursor) emptyRanges.push({ startTime: cursor, endTime: bar.time });
    cursor = bar.time + latest.interval;
  }
  if (cursor < latest.endTime) emptyRanges.push({ startTime: cursor, endTime: latest.endTime });
  return {
    market,
    candles,
    series: {
      chainId: latest.chainId,
      pool: latest.pool,
      fee: latest.fee,
      interval: latest.interval,
      requestedStart,
      startTime,
      endTime: latest.endTime,
      slots,
      gaps: slots - candles.length,
      emptyRanges,
      segments,
    },
  };
}

module.exports = { SERIES_SOURCE, MAX_BYTES, buildSeries, validSegment, checkJoin };
