/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const crypto = require('node:crypto');
const { parseDocument, DomUtils } = require('htmlparser2');
const { shellQuote } = require('../vm/vm-paths');

// Network response limits protect the process, not the model's reading window.
// Retain complete extracted documents; callers can page through every character.
async function requestText(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > (options.maxBytes || 20 * 1024 * 1024)) {
      throw new Error(
        'Response exceeds the network size limit; increase maxBytes or use downloadFile',
      );
    }
    chunks.push(chunk);
  }
  return {
    text: new TextDecoder().decode(Buffer.concat(chunks)),
    url: response.url,
    contentType: response.headers.get('content-type') || '',
  };
}

function extractHtml(html, format = 'text') {
  const dom = parseDocument(html);
  const title = DomUtils.findOne((n) => n.name === 'title', dom.children);
  const walk = (node) => {
    if (node.type === 'text') return node.data;
    if (
      ['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'iframe'].includes(
        node.name,
      )
    )
      return '';
    const body = (node.children || []).map(walk).join('');
    if (node.name === 'a' && format === 'markdown' && node.attribs?.href)
      return `[${body.trim()}](${node.attribs.href})`;
    if (node.name === 'br') return '\n';
    if (/^h[1-6]$/.test(node.name || ''))
      return (
        '\n\n' +
        (format === 'markdown' ? '#'.repeat(Number(node.name[1])) + ' ' : '') +
        body.trim() +
        '\n\n'
      );
    if (
      ['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'pre', 'table', 'tr'].includes(
        node.name,
      )
    )
      return '\n' + body + '\n';
    if (node.name === 'li') return '\n- ' + body;
    if (node.name === 'td' || node.name === 'th') return body + ' | ';
    return body;
  };
  const article = DomUtils.findOne((n) => n.name === 'main' || n.name === 'article', dom.children);
  return {
    title: title ? DomUtils.textContent(title).trim() : '',
    content: walk(article || dom)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  };
}

function parseMcp(body) {
  const payloads = body.trim().startsWith('{')
    ? [body]
    : body
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
  for (const payload of payloads) {
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }
    if (data.error) throw new Error(data.error.message || 'MCP search failed');
    if (!data.result) continue;
    if (data.result.isError)
      throw new Error((data.result.content || []).map((c) => c.text || '').join('\n'));
    const structured = data.result.structuredContent;
    const text = (data.result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (structured) return structured;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  throw new Error('Search provider returned no MCP result');
}

function canonicalUrl(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    // Bing tracking links carry a base64-encoded original address.
    const encoded = u.hostname.endsWith('bing.com') && u.searchParams.get('u');
    if (typeof encoded === 'string' && encoded.startsWith('a1'))
      return canonicalUrl(Buffer.from(encoded.slice(2), 'base64').toString());
    u.hash = '';
    for (const key of [...u.searchParams.keys()])
      if (/^(utm_|gclid|fbclid)/i.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeResults(payload, engine) {
  const rows = Array.isArray(payload)
    ? payload
    : payload?.results || payload?.data || payload?.search_results;
  if (Array.isArray(rows))
    return rows
      .map((row) => ({
        title: String(row.title || row.name || ''),
        url: canonicalUrl(row.url || row.link),
        snippet: String(
          row.snippet || row.description || row.text || (row.excerpts || []).join('\n') || '',
        ),
        engines: [engine],
      }))
      .filter((row) => row.url);
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const blocks = text.split(/(?=^Title:|^\s*\d+\.\s|^#{1,3} )/m);
  const result = [];
  for (const block of blocks) {
    const match = block.match(/(?:URL:\s*|\]\()(https?:\/\/[^\s)]+)|\b(https?:\/\/[^\s<>)]+)/i);
    const url = canonicalUrl(match?.[1] || match?.[2]);
    if (!url) continue;
    const title =
      block.match(/^Title:\s*(.+)/m)?.[1] ||
      block.match(/\[([^\]]+)\]\(https?:/)?.[1] ||
      block.split('\n').find(Boolean) ||
      url;
    result.push({
      title,
      url,
      snippet: block.replace(/^Title:.*\n?|^URL:.*\n?/gm, '').trim(),
      engines: [engine],
    });
  }
  // Unknown provider formats remain readable rather than disappearing.
  return result.length ? result : [{ title: engine, url: null, snippet: text, engines: [engine] }];
}

function fuseResults(query, groups) {
  const tokens = [
    ...new Set(
      (query.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]+/g) || []).flatMap((token) =>
        /[\u3400-\u9fff]/.test(token) && token.length > 2
          ? [token, ...Array.from({ length: token.length - 1 }, (_, i) => token.slice(i, i + 2))]
          : [token],
      ),
    ),
  ];
  const merged = new Map();
  groups.forEach((rows) =>
    rows.forEach((row, rank) => {
      const key = row.url || crypto.createHash('sha256').update(row.snippet).digest('hex');
      const existing = merged.get(key);
      const text = (row.title + ' ' + row.snippet).toLowerCase();
      const relevance =
        tokens.filter((token) => text.includes(token)).length / Math.max(1, tokens.length);
      const score = 1 / (40 + rank) + relevance * 0.12;
      if (existing) {
        existing.score += 1 / (40 + rank);
        existing.engines = [...new Set([...existing.engines, ...row.engines])];
        if (row.snippet.length > existing.snippet.length) existing.snippet = row.snippet;
      } else merged.set(key, { ...row, score, relevance });
    }),
  );
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...row }) => row);
}

class WebResearch {
  constructor({
    getSettings = () => ({}),
    vmService,
    vmActive = () => false,
    bingSearch,
    transport,
  } = {}) {
    Object.assign(this, { getSettings, vmService, vmActive, bingSearch, transport });
    this.cache = new Map();
  }

  async request(url, options = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP and HTTPS URLs are supported');
    if (this.transport) return this.transport(url, options);
    if (!this.vmActive()) return requestText(url, options);
    if (this.vmService.instance?.state !== 'ready') await this.vmService.start();
    const script = `(${requestText.toString()})(${JSON.stringify(url)},${JSON.stringify(options)}).then(v=>process.stdout.write(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1})`;
    const result = await this.vmService.instance.exec('node -e ' + shellQuote(script), {
      timeoutMs: (options.timeoutMs || 30000) + 3000,
      maxBuffer: Math.min(
        256 * 1024 * 1024,
        (options.maxBytes || 20 * 1024 * 1024) * 6 + 1024 * 1024,
      ),
    });
    if (!result.ok) throw new Error(result.stderr || 'VM web request failed');
    return JSON.parse(result.stdout);
  }

  store(value, key) {
    const id = crypto.randomUUID();
    const now = Date.now();
    for (const [ref, entry] of this.cache) if (now - entry.at > 30 * 60000) this.cache.delete(ref);
    // Bounded cache with explicit expiry; retained snapshots are never silently shortened.
    let bytes = [...this.cache.values()].reduce((n, v) => n + v.bytes, 0);
    const size = Buffer.byteLength(JSON.stringify(value));
    while (this.cache.size && (this.cache.size >= 80 || bytes + size > 64 * 1024 * 1024)) {
      const first = this.cache.keys().next().value;
      bytes -= this.cache.get(first).bytes;
      this.cache.delete(first);
    }
    this.cache.set(id, { value, at: now, bytes: size, key });
    return id;
  }

  page(ref, options = {}) {
    const entry = this.cache.get(ref);
    if (!entry || Date.now() - entry.at > 30 * 60000)
      throw new Error('Snapshot expired; repeat the original search or URL fetch');
    const value = entry.value;
    const content = value.content || '';
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const maxChars =
      options.maxChars === 0
        ? content.length
        : Math.max(1, Math.min(1000000, Math.floor(Number(options.maxChars) || 6000)));
    const nextOffset = Math.min(content.length, offset + maxChars);
    const out = {
      ...value,
      ref,
      content: content.slice(offset, nextOffset),
      offset,
      totalChars: content.length,
      nextOffset: nextOffset < content.length ? nextOffset : null,
      truncated: nextOffset < content.length,
      expiresInSeconds: Math.max(0, Math.floor((entry.at + 30 * 60000 - Date.now()) / 1000)),
    };
    if (value.results) {
      const start = Math.max(0, Math.floor(Number(options.resultOffset) || 0));
      const count = Math.max(1, Math.min(100, Math.floor(Number(options.numResults) || 8)));
      const snippetChars =
        options.snippetChars === 0 ? Infinity : Math.max(0, Number(options.snippetChars) || 500);
      out.totalResults = value.results.length;
      out.nextResultOffset = start + count < value.results.length ? start + count : null;
      out.results = value.results.slice(start, start + count).map((row) => ({
        ...row,
        snippet: row.snippet.slice(0, snippetChars),
        snippetChars: row.snippet.length,
        snippetTruncated: row.snippet.length > snippetChars,
      }));
      // The full indexed source text is retrieved only on explicit request.
      if (!options.includeContent && !Object.hasOwn(options, 'offset')) delete out.content;
    }
    return out;
  }

  async provider(engine, query, options) {
    const config = this.getSettings().webResearch?.providers?.[engine] || {};
    const protocol = config.provider || engine;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'CIBYP/' + require('../../../package.json').version,
    };
    const key = config.apiKey || '';
    let url, body;
    if (protocol === 'bing') return this.bingSearch(query, options);
    if (
      protocol === 'mcp' ||
      (!config.endpoint && !key && ['exa', 'parallel', 'tinyfish'].includes(protocol))
    ) {
      url =
        config.endpoint ||
        (engine === 'tinyfish'
          ? 'https://agent.tinyfish.ai/mcp'
          : engine === 'exa'
            ? 'https://mcp.exa.ai/mcp'
            : 'https://search.parallel.ai/mcp');
      if (engine === 'tinyfish') {
        if (key) headers['X-API-Key'] = key;
        else headers['X-TinyFish-Access-Mode'] = 'keyless';
      } else if (key && engine === 'exa' && !config.endpoint) {
        const target = new URL(url);
        target.searchParams.set('exaApiKey', key);
        url = target.toString();
      } else if (key) headers.Authorization = 'Bearer ' + key;
      const parallel = engine === 'parallel';
      body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name:
            config.tool ||
            (engine === 'tinyfish' ? 'search' : parallel ? 'web_search' : 'web_search_exa'),
          arguments:
            engine === 'tinyfish'
              ? { query }
              : parallel
                ? { objective: query, search_queries: [query] }
                : {
                    query,
                    numResults: options.numResults || 12,
                    type: options.type || 'auto',
                    livecrawl: 'fallback',
                    contextMaxCharacters: options.providerMaxChars || 50000,
                  },
        },
      };
      return normalizeResults(
        parseMcp(
          (
            await this.request(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              timeoutMs: 25000,
            })
          ).text,
        ),
        engine,
      );
    }
    if (protocol === 'tinyfish') {
      url = new URL(config.endpoint || 'https://api.search.tinyfish.ai');
      url.searchParams.set('query', query);
      headers['X-API-Key'] = key;
      return normalizeResults(
        JSON.parse((await this.request(url.toString(), { headers })).text),
        engine,
      );
    }
    if (protocol === 'exa') {
      url = config.endpoint || 'https://api.exa.ai/search';
      headers['x-api-key'] = key;
      body = {
        query,
        numResults: options.numResults || 12,
        type: options.type || 'auto',
        contents: { text: true },
      };
    } else if (protocol === 'parallel') {
      url = config.endpoint || 'https://api.parallel.ai/v1beta/search';
      headers['x-api-key'] = key;
      body = { objective: query, search_queries: [query], max_results: options.numResults || 12 };
    } else if (protocol === 'tavily') {
      url = config.endpoint || 'https://api.tavily.com/search';
      body = { api_key: key, query, max_results: options.numResults || 12 };
    } else if (protocol === 'brave') {
      url = new URL(config.endpoint || 'https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      headers['X-Subscription-Token'] = key;
      const data = JSON.parse((await this.request(url.toString(), { headers })).text);
      return normalizeResults(data.web?.results || [], engine);
    } else if (protocol === 'searxng') {
      url = new URL(config.endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      if (key) headers.Authorization = 'Bearer ' + key;
      return normalizeResults(
        JSON.parse((await this.request(url.toString(), { headers })).text),
        engine,
      );
    } else throw new Error('Unsupported search provider: ' + protocol);
    return normalizeResults(
      JSON.parse(
        (await this.request(url, { method: 'POST', headers, body: JSON.stringify(body) })).text,
      ),
      engine,
    );
  }

  async search(input) {
    const options = typeof input === 'string' ? { query: input } : input || {};
    if (options.ref) return this.page(options.ref, options);
    const query = String(options.query || '').trim();
    if (!query) throw new Error('query is required');
    const engine = String(
      options.engine || this.getSettings().webResearch?.engine || 'fusion',
    ).toLowerCase();
    if (!['bing', 'exa', 'parallel', 'tinyfish', 'fusion'].includes(engine))
      throw new Error('engine must be bing, exa, parallel, tinyfish, or fusion');
    const engines = engine === 'fusion' ? ['bing', 'exa', 'parallel', 'tinyfish'] : [engine];
    const responses = await Promise.allSettled(
      engines.map((e) => this.provider(e, query, options)),
    );
    const errors = [],
      groups = [];
    responses.forEach((response, i) =>
      response.status === 'fulfilled'
        ? groups.push(response.value)
        : errors.push({ engine: engines[i], error: response.reason.message }),
    );
    if (!groups.length) return { ok: false, query, engine, errors };
    const results = fuseResults(query, groups);
    const content = results
      .map((row, i) => `[${i + 1}] ${row.title}\n${row.url || ''}\n${row.snippet}`)
      .join('\n\n');
    const warnings = results.some((row) => row.relevance > 0)
      ? []
      : [
          'Results may not match the query. Try a more specific query or a different engine; do not treat unrelated results as evidence.',
        ];
    const ref = this.store({
      ok: results.length > 0,
      query,
      engine,
      results,
      content,
      errors,
      warnings,
      location: this.vmActive() ? 'vm' : 'host',
    });
    return this.page(ref, options);
  }

  async read(input) {
    const options = typeof input === 'string' ? { url: input } : input || {};
    if (options.ref) return this.page(options.ref, options);
    const format = options.format || 'markdown';
    if (!['markdown', 'text', 'html'].includes(format))
      throw new Error('format must be markdown, text, or html');
    const key = JSON.stringify([this.vmActive(), options.url, format]);
    if (!options.refresh) {
      for (const [ref, entry] of this.cache)
        if (entry.key === key && Date.now() - entry.at < 5 * 60000)
          return { ...this.page(ref, options), cached: true };
    }
    const response = await this.request(options.url, {
      timeoutMs: Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 30000)),
      maxBytes: Math.min(
        100 * 1024 * 1024,
        Math.max(1024, Number(options.maxBytes) || 20 * 1024 * 1024),
      ),
      headers: {
        Accept: 'text/markdown, text/plain, text/html;q=0.9',
        'User-Agent': 'CIBYP/' + require('../../../package.json').version,
      },
    });
    const extracted =
      /html/i.test(response.contentType) && format !== 'html'
        ? extractHtml(response.text, format)
        : { content: response.text, title: '' };
    const ref = this.store(
      {
        ok: true,
        ...extracted,
        url: response.url || options.url,
        format,
        location: this.vmActive() ? 'vm' : 'host',
      },
      key,
    );
    return this.page(ref, options);
  }
}

module.exports = {
  WebResearch,
  requestText,
  extractHtml,
  parseMcp,
  normalizeResults,
  fuseResults,
  canonicalUrl,
};
