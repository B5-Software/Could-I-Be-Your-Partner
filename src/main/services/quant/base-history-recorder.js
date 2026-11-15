/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CHAINS } = require('./market-data');
const { captureWindow } = require('./base-history');

const POLL_MS = 60000;
const CATCH_UP_MS = 5000;
const MAX_RETRY_MS = 600000;
const REVIEW_ERRORS = new Set([
  'BASE_HISTORY_SOURCE_CHANGED',
  'BASE_HISTORY_VENUE',
  'BASE_POOL_NOT_FOUND',
  'BASE_POOL_NOT_CANONICAL',
  'CHAIN_ID_MISMATCH',
  'DATASET_NOT_IN_WORKSPACE',
  'DATASET_HASH_MISMATCH',
  'EXECUTION_PROFILE_CHANGED',
  'INVALID_DATASET',
  'QUANT_STORAGE_LIMIT',
]);

class BaseHistoryRecorder {
  static shouldStart(directory) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
      return state.version === 1 && state.workspaces.some((w) => w.baseRecorder?.enabled === true);
    } catch {
      return false;
    }
  }

  constructor(service, event) {
    this.service = service;
    this.event = event;
    this.unsaved = new Map();
  }

  status(w) {
    const record = w.baseRecorder;
    if (!record) return { phase: 'idle' };
    const { id, enabled, marketRevision, ...status } = record;
    const unsaved = this.unsaved.get(id);
    return {
      ...status,
      canResume: !enabled && marketRevision === w.marketRevision,
      phase: !enabled
        ? 'paused'
        : this.active?.id === id
          ? 'capturing'
          : unsaved || record.lastError
            ? 'retrying'
            : 'waiting',
      ...(unsaved && { lastError: 'BASE_HISTORY_SAVE_FAILED', nextAt: unsaved }),
    };
  }

  start(input) {
    return this.service.mutate((state) => {
      const w = this.service.workspace(input.id, state);
      if (!CHAINS[w.market.venue]) throw Error('BASE_HISTORY_VENUE');
      const window = captureWindow(w.market.interval);
      const previous = w.baseRecorder;
      if (previous?.enabled) return this.status(w);
      if (
        input.resume === true &&
        (input.afterDatasetId !== undefined || previous?.marketRevision !== w.marketRevision)
      )
        throw Error('BASE_HISTORY_SOURCE_CHANGED');
      const count = input.count ?? (input.resume === true ? previous.count : window.defaultCount);
      if (!Number.isSafeInteger(count) || count < 1 || count > window.maxCount)
        throw Error('BASE_HISTORY_RANGE');
      const datasetId = input.resume === true ? previous.datasetId : (input.afterDatasetId ?? null);
      const checkpoint =
        datasetId !== null ? this.service.workspaceDataset(w, datasetId).amm : null;
      if (
        datasetId !== null &&
        (!checkpoint ||
          checkpoint.chainId !== CHAINS[w.market.venue].id ||
          checkpoint.interval !== w.market.interval ||
          checkpoint.fee !== w.market.poolFee ||
          (w.market.pool && w.market.pool.toLowerCase() !== checkpoint.pool))
      )
        throw Error('BASE_HISTORY_SOURCE_CHANGED');
      const now = Date.now();
      w.baseRecorder = {
        id: randomUUID(),
        enabled: true,
        marketRevision: w.marketRevision,
        startedAt: input.resume === true ? (previous.startedAt ?? now) : now,
        count,
        datasetId,
        startTime: input.resume === true ? previous.startTime : (checkpoint?.startTime ?? null),
        endTime: checkpoint?.endTime ?? null,
        batches: input.resume === true ? previous.batches : 0,
        lastSuccess: input.resume === true ? previous.lastSuccess : null,
        nextAt: now,
        failures: 0,
        lastError: null,
        pauseReason: null,
      };
      this.event(w, 'base-history-recording-started', {
        datasetId,
        resumed: input.resume === true,
      });
      return this.status(w);
    });
  }

  stop(id) {
    return this.service.mutate((state) => {
      const w = this.service.workspace(id, state);
      this.pause(w, 'manual');
      return this.status(w);
    });
  }

  pause(w, reason) {
    if (w.baseRecorder?.enabled) {
      Object.assign(w.baseRecorder, { enabled: false, nextAt: null, pauseReason: reason });
      this.event(w, 'base-history-recording-paused', {
        reason,
        datasetId: w.baseRecorder.datasetId,
      });
    }
  }

  check(w, capture) {
    const record = w.baseRecorder;
    if (
      !record?.enabled ||
      record.id !== capture.id ||
      record.datasetId !== capture.datasetId ||
      record.marketRevision !== w.marketRevision
    )
      throw Error('BASE_HISTORY_RECORDING_CHANGED');
    return record;
  }

  advance(record, meta) {
    const now = Date.now();
    record.datasetId = meta.id;
    record.startTime ??= meta.start;
    record.endTime = meta.end;
    record.batches++;
    record.lastSuccess = now;
    record.nextAt = now + CATCH_UP_MS;
    record.failures = 0;
    record.lastError = null;
  }

  arm() {
    clearTimeout(this.timer);
    if (this.service.disposed) return;
    const enabled = this.service.state.workspaces.filter((w) => w.baseRecorder?.enabled);
    for (const id of this.unsaved.keys())
      if (!enabled.some((w) => w.baseRecorder.id === id)) this.unsaved.delete(id);
    if (this.active) {
      const w = this.service.workspace(this.active.workspaceId);
      if (!w.baseRecorder?.enabled || w.baseRecorder.id !== this.active.id)
        this.active.controller.abort();
      return;
    }
    const dueAt = (w) => this.unsaved.get(w.baseRecorder.id) ?? w.baseRecorder.nextAt;
    const [w] = enabled.sort((a, b) => dueAt(a) - dueAt(b));
    if (!w) return;
    this.timer = setTimeout(() => void this.capture(w.id), Math.max(0, dueAt(w) - Date.now()));
    this.timer.unref?.();
  }

  async capture(workspaceId) {
    const w = this.service.workspace(workspaceId),
      record = w.baseRecorder;
    if (this.service.disposed || this.active || !record?.enabled) return;
    const controller = new AbortController();
    const capture = {
      id: record.id,
      datasetId: record.datasetId,
      startedAt: record.startedAt,
      workspaceId,
      controller,
    };
    this.active = capture;
    this.unsaved.delete(capture.id);
    try {
      await this.service.captureBaseHistory(
        {
          id: workspaceId,
          count: record.count,
          afterDatasetId: record.datasetId ?? undefined,
        },
        controller.signal,
        capture,
      );
    } catch (error) {
      if (controller.signal.aborted || this.service.disposed) return;
      try {
        await this.service.mutate((state) => {
          const current = this.service.workspace(workspaceId, state);
          const entry = this.check(current, capture);
          const code =
            error.code === 'ENOENT'
              ? 'BASE_HISTORY_ARCHIVE_MISSING'
              : /^[A-Z][A-Z_\d-]{1,100}$/.test(error.message)
                ? error.message
                : 'MARKET_CONNECTION_FAILED';
          const idle = code === 'BASE_HISTORY_UP_TO_DATE';
          const busy = code === 'BASE_HISTORY_BUSY';
          const canShrink =
            entry.count > 1 && ['EXECUTION_PROFILE_LIMIT', 'BASE_HISTORY_TIMEOUT'].includes(code);
          if (canShrink) entry.count = Math.floor(entry.count / 2);
          entry.failures = idle ? 0 : busy ? entry.failures : Math.min(10, entry.failures + 1);
          entry.lastError = idle || busy ? null : code;
          const wait = idle
            ? Math.min(300000, Math.max(POLL_MS, entry.count * current.market.interval * 250))
            : Math.min(MAX_RETRY_MS, POLL_MS * 2 ** Math.max(0, entry.failures - 1));
          entry.nextAt = Date.now() + (busy ? CATCH_UP_MS : wait);
          if (
            REVIEW_ERRORS.has(code) ||
            error.code === 'ENOENT' ||
            (code === 'EXECUTION_PROFILE_LIMIT' && !canShrink)
          )
            this.pause(current, 'review');
        });
      } catch {
        if (!controller.signal.aborted && !this.service.disposed)
          this.unsaved.set(capture.id, Date.now() + POLL_MS);
      }
    } finally {
      this.active = undefined;
      this.arm();
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.active?.controller.abort();
  }
}

module.exports = { BaseHistoryRecorder };
