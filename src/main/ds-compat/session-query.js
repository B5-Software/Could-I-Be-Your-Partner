/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHash } = require('node:crypto');
const { SessionQueryEngine } = require('@deepseek-ai/dsh-session-query');
function page(items, request) {
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1))
    throw new TypeError('Invalid search page size');
  const size = Math.min(100, Math.max(1, request.limit ?? 20));
  const generation = createHash('sha256')
    .update(JSON.stringify({ ...request, cursor: undefined, items }))
    .digest('hex');
  let offset = 0;
  if (request.cursor) {
    const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString());
    if (
      cursor.generation !== generation ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw Object.assign(new Error('Search results changed; start a new search'), {
        code: 'SESSION_QUERY_STALE_CURSOR',
      });
    offset = cursor.offset;
  }
  return {
    items: items.slice(offset, offset + size),
    ...(offset + size < items.length
      ? {
          nextCursor: Buffer.from(JSON.stringify({ generation, offset: offset + size })).toString(
            'base64url',
          ),
        }
      : {}),
  };
}
class CibypSessionQuery extends SessionQueryEngine {
  async hits(id, query, filters, signal) {
    signal?.throwIfAborted();
    const documents = await this.filterEvents(id, [
      ...(filters || []),
      { kind: 'text', text: String(query || '') },
    ]);
    return documents.map(({ text, ...record }) => {
      const at = text.toLocaleLowerCase().indexOf(String(query).toLocaleLowerCase());
      return { ...record, snippet: text.slice(Math.max(0, at - 80), Math.max(0, at - 80) + 320) };
    });
  }
  async searchEvents(request, exec = {}) {
    const hits = await this.hits(request.sessionId, request.query, request.filters, exec.signal);
    const observation = await this.observeSession(request.sessionId, { signal: exec.signal });
    try {
      return { ...page(hits, request), session: structuredClone(observation.header) };
    } finally {
      observation[Symbol.dispose]();
    }
  }
  async searchSessions(request, exec = {}) {
    const sessions = await this.filterSessions(request.sessionFilters || [], exec.signal),
      items = [];
    for (const record of sessions) {
      exec.signal?.throwIfAborted();
      const hits = await this.hits(
        record.id || record.header?.id || record.sessionId,
        request.query,
        request.eventFilters,
        exec.signal,
      );
      if (hits.length) items.push({ ...record, bestMatch: hits[0] });
    }
    return page(items, request);
  }
}
module.exports = { CibypSessionQuery };
