const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  WebResearch,
  parseMcp,
  extractHtml,
  fuseResults,
  canonicalUrl,
} = require('../../src/main/services/web-research');

test('MCP accepts JSON, SSE and structured search results while surfacing provider failures', () => {
  assert.deepEqual(
    parseMcp(
      'data: ' +
        JSON.stringify({ result: { content: [{ type: 'text', text: '{"results":[]}' }] } }) +
        '\n\n',
    ),
    { results: [] },
  );
  assert.deepEqual(parseMcp(JSON.stringify({ result: { structuredContent: { results: [1] } } })), {
    results: [1],
  });
  assert.throws(() => parseMcp('{"error":{"message":"rate limited"}}'), /rate limited/);
  assert.throws(
    () => parseMcp('{"result":{"isError":true,"content":[{"text":"provider unavailable"}]}}'),
    /provider unavailable/,
  );
});

test('Fusion deduplicates tracking URLs, favors actual query matches and reports partial provider failures', async () => {
  const service = new WebResearch({
    getSettings: () => ({
      webResearch: {
        providers: {
          tinyfish: { provider: 'mcp' },
          exa: { provider: 'mcp' },
          parallel: { provider: 'mcp' },
        },
      },
    }),
    bingSearch: async () => [
      {
        title: 'Weather',
        url: 'https://weather.example/',
        snippet: 'Weather forecast',
        engines: ['bing'],
      },
    ],
    transport: async (url, options) => {
      const request = JSON.parse(options.body);
      if (url.includes('parallel')) throw new Error('HTTP 429');
      if (url.includes('tinyfish')) {
        assert.equal(options.headers['X-TinyFish-Access-Mode'], 'keyless');
        assert.equal(request.params.name, 'search');
      }
      return {
        text: JSON.stringify({
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: [
                    {
                      title: '叫妈妈 meme',
                      url: 'https://meme.example/page?utm_source=' + request.params.name,
                      snippet: '叫妈妈 网络梗 ' + '正文'.repeat(5000),
                    },
                  ],
                }),
              },
            ],
          },
        }),
      };
    },
  });
  const result = await service.search({
    query: '叫妈妈 meme 网络梗',
    engine: 'fusion',
    snippetChars: 80,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].title, '叫妈妈 meme');
  assert.deepEqual(result.results[0].engines.sort(), ['exa', 'tinyfish']);
  assert.equal(result.results[0].snippet.length, 80);
  assert.equal(result.results[0].snippetTruncated, true);
  assert.equal(result.errors[0].engine, 'parallel');
  assert.ok(!Object.hasOwn(result, 'html'));
  let offset = 0,
    all = '';
  do {
    const page = await service.search({ ref: result.ref, offset, maxChars: 123 });
    all += page.content;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.ok(all.includes('正文'.repeat(5000)), 'all provider text is recoverable');
});

test('fetch strips navigation and scripts, preserves links, pages all content and reuses URL snapshots', async () => {
  let requests = 0;
  const service = new WebResearch({
    transport: async () => {
      requests++;
      return {
        text:
          '<html><title>Article</title><nav>weather</nav><main><h1>Title</h1><p>Hello <a href="https://example.org">link</a></p><p>' +
          'body '.repeat(5000) +
          '</p></main><script>secret</script></html>',
        contentType: 'text/html',
        url: 'https://example.org',
      };
    },
  });
  const first = await service.read({ url: 'https://example.org', maxChars: 250 });
  assert.equal(first.title, 'Article');
  assert.ok(first.content.includes('[link](https://example.org)'));
  assert.equal(first.truncated, true);
  const full = await service.read({ ref: first.ref, maxChars: 0 });
  assert.equal(full.content.length, full.totalChars);
  assert.ok(!full.content.includes('weather') && !full.content.includes('secret'));
  assert.equal(full.nextOffset, null);
  assert.equal((await service.read({ url: 'https://example.org' })).cached, true);
  assert.equal(requests, 1);
  await service.read({ url: 'https://example.org', refresh: true });
  assert.equal(requests, 2);
  assert.throws(() => service.page('expired-ref'), /expired/);
});

test('HTML extraction and Fusion never treat entire SERPs as candidate evidence', () => {
  assert.equal(extractHtml('<p>A</p><script>bad</script><p>B</p>').content, 'A\n\nB');
  assert.equal(canonicalUrl('https://example.org/?utm_source=bing#anchor'), 'https://example.org/');
  assert.equal(
    fuseResults('meme', [
      [{ title: 'Forecast', snippet: 'rain', url: 'https://example.org/', engines: ['bing'] }],
    ])[0].relevance,
    0,
  );
});
