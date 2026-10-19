/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { torSources } = require('../../scripts/lib/tor-runtime.cjs');
const lock = require('../../integrations/tor/runtime-lock.json');

test('pinned Tor bundles retain an official archive fallback after dist rotates releases', () => {
  for (const asset of Object.values(lock.targets)) {
    const sources = torSources(asset);
    assert.equal(sources[0], asset.url);
    assert.equal(new URL(sources[1]).origin, 'https://archive.torproject.org');
    assert.equal(
      new URL(sources[1]).pathname,
      '/tor-package-archive' + new URL(asset.url).pathname,
    );
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.size > 0);
  }
  for (const url of [
    'https://example.invalid/torbrowser/15/bundle.tar.gz',
    'https://user:secret@dist.torproject.org/torbrowser/15/tor-expert-bundle-test.tar.gz',
    'https://dist.torproject.org/torbrowser/15/tor-expert-bundle-test.tar.gz?other=1',
    'http://dist.torproject.org/torbrowser/15/tor-expert-bundle-test.tar.gz',
  ])
    assert.throws(() => torSources({ url }), /Invalid official/);
});
