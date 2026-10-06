/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, DEFAULT_MEEK, TRANSPORTS } = require('../../src/shared/tor-bridges');
const { bridgeLines } = require('../../src/main/services/tor-remote');

test('meek aliases use the actual Lyrebird transport and retain fronting parameters', () => {
  assert.ok(TRANSPORTS.includes('meek_lite'));
  const input = 'Bridge ' + DEFAULT_MEEK.replace('meek_lite', 'meek');
  assert.deepEqual(parse(input), [{ transport: 'meek_lite', line: DEFAULT_MEEK }]);
  assert.deepEqual(bridgeLines(input), ['Bridge ' + DEFAULT_MEEK]);
});
test('official meek syntax accepts optional fingerprint and multiple targets', () => {
  const multi =
    'meek_lite [2001:db8::1]:443 targets=https://bridge.example.org|front.example.org+front2.example.org,https://backup.example.org|backup-front.example.org utls=HelloRandomizedALPN';
  assert.equal(parse(multi)[0].line, multi);
  assert.equal(parse('snowflake 192.0.2.3:80')[0].transport, 'snowflake');
  assert.equal(
    parse('obfs4 127.0.0.1:443 ' + 'A'.repeat(40) + ' cert=example iat-mode=0')[0].transport,
    'obfs4',
  );
});
test('reject invalid meek parameters and torrc injection before starting Tor', () => {
  for (const line of [
    'meek 192.0.2.20:80',
    'meek 192.0.2.20:80 url=file:///tmp/meek',
    'meek 192.0.2.20:80 targets=https://example.org',
    'meek 256.1.1.1:80 url=https://example.org',
    'meek 192.0.2.20:70000 url=https://example.org',
    DEFAULT_MEEK + '\u0000',
    DEFAULT_MEEK + '\nControlPort 1234',
  ])
    assert.throws(() => parse(line));
  assert.throws(() => parse(Array(33).fill(DEFAULT_MEEK).join('\n')));
  assert.throws(() => parse(''));
  assert.deepEqual(parse('', true), []);
});
