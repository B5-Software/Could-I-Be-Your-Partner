/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { WebResearch, bingHttpSearch, publicNewsUrl } = require('../web-research');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

class QuantResearch {
  constructor(service, { getSettings, transport, bingSearch = bingHttpSearch } = {}) {
    this.service = service;
    this.getSettings = getSettings || (() => service.runtime?.getSettings?.() || {});
    this.settings = {};
    // Host-only HTTP: no VM, browser automation, wallet credentials or cookies.
    this.web = new WebResearch({ getSettings: () => this.settings, transport, bingSearch });
  }
  async request(action, input) {
    const service = this.service;
    service.workspace(input.id);
    if (
      action === 'read' &&
      ['url', 'ref', 'evidenceId'].filter((key) => Boolean(input[key])).length !== 1
    )
      throw new Error('NEWS_SOURCE_REQUIRED_OR_AMBIGUOUS');
    if (action === 'read' && input.evidenceId) return this.readEvidence(input);
    let result;
    if (action === 'search') {
      if (
        !input.ref &&
        (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 4000)
      )
        throw new Error('NEWS_QUERY_REQUIRED');
      const settings = await this.getSettings();
      this.settings = { webResearch: settings?.webResearch || {} };
      result = await this.web.search({
        ...input,
        numResults: input.numResults ?? 6,
        snippetChars: input.snippetChars ?? 400,
      });
      const rows = result.results || [];
      result.results = rows.filter((row) => {
        try {
          publicNewsUrl(row.url);
          return true;
        } catch {
          return false;
        }
      });
      result.excludedNonPublicUrls = rows.length - result.results.length;
      if (result.excludedNonPublicUrls && result.content) delete result.content;
      // A provider error can echo its authentication details. Keep credentials
      // and raw transport errors out of both the model and research history.
      result.errors = (result.errors || []).map((item) => {
        const httpStatus = Number(/^HTTP (\d{3})$/.exec(item.error || '')?.[1]) || null;
        return {
          engine: item.engine,
          httpStatus,
          error:
            httpStatus === 429
              ? 'SEARCH_RATE_LIMITED'
              : [401, 403].includes(httpStatus)
                ? 'SEARCH_AUTH_REQUIRED'
                : 'SEARCH_PROVIDER_UNAVAILABLE',
        };
      });
      if (result.ok && !result.results.length) result.ok = false;
    } else if (action === 'read') {
      if (!input.ref) publicNewsUrl(input.url);
      result = await this.web.read({
        ...input,
        format: 'markdown',
        publicOnly: true,
        maxChars: input.maxChars ?? 5000,
      });
      publicNewsUrl(result.url);
      result.publishedAtReported ??= null;
    } else throw new Error('UNKNOWN_RESEARCH_ACTION');
    result.untrusted = true;
    if (!result.ok) return result;
    const { ref: _ref, expiresInSeconds: _expiry, cached: _cached, ...snapshot } = result;
    snapshot.kind = action === 'search' ? 'search' : 'article';
    snapshot.completeDocument = action === 'read' && snapshot.offset === 0 && !snapshot.truncated;
    const evidenceId = digest(snapshot);
    const file = this.file(input.id, evidenceId);
    if (!fs.existsSync(file)) service.writeResearch(file, snapshot);
    await service.mutate((state) => {
      const workspace = service.workspace(input.id, state);
      workspace.research ||= [];
      if (!workspace.research.some((row) => row.evidenceId === evidenceId))
        workspace.research.push({
          evidenceId,
          kind: snapshot.kind,
          title: snapshot.title || snapshot.query || '',
          url: snapshot.url || null,
          retrievedAt: snapshot.retrievedAt,
          publishedAtReported: snapshot.publishedAtReported || null,
          completeDocument: snapshot.completeDocument,
          sourceOffset: snapshot.offset || 0,
        });
    });
    return { ...result, evidenceId, completeDocument: snapshot.completeDocument };
  }
  file(id, evidenceId) {
    if (typeof evidenceId !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceId))
      throw new Error('INVALID_EVIDENCE_ID');
    return path.join(this.service.directory, 'research', id, evidenceId + '.json');
  }
  readEvidence(input) {
    const workspace = this.service.workspace(input.id);
    if (!workspace.research?.some((row) => row.evidenceId === input.evidenceId))
      throw new Error('EVIDENCE_NOT_FOUND');
    const snapshot = JSON.parse(fs.readFileSync(this.file(input.id, input.evidenceId), 'utf8'));
    if (digest(snapshot) !== input.evidenceId) throw new Error('EVIDENCE_HASH_MISMATCH');
    const content = snapshot.content || '',
      offset = input.offset ?? 0,
      maxChars = input.maxChars ?? 5000;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxChars) ||
      maxChars < 0 ||
      maxChars > 1000000
    )
      throw new Error('INVALID_PAGINATION');
    const end = maxChars === 0 ? content.length : Math.min(content.length, offset + maxChars);
    return {
      ...snapshot,
      evidenceId: input.evidenceId,
      archived: true,
      archiveCompleteDocument: snapshot.completeDocument,
      completeDocument: snapshot.completeDocument && offset === 0 && end === content.length,
      sourceOffset: snapshot.offset,
      sourceTotalChars: snapshot.totalChars,
      content: content.slice(offset, end),
      offset,
      totalChars: content.length,
      nextOffset: end < content.length ? end : null,
      truncated: end < content.length,
    };
  }
}
module.exports = { QuantResearch };
