/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ArtifactLibrary } = require('../../src/main/services/artifact-library');
const {
  decodeBackup,
  encodeBackup,
  exportRows,
} = require('../../src/main/services/conversation-archive');
const { EntropyPools, normalizedPools } = require('../../src/main/services/entropy-pool');
const { validate } = require('../../src/shared/interactive-content');

test('artifact catalog keeps all occurrences and pages searchable metadata in reverse order', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-artifact-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const library = new ArtifactLibrary(path.join(dir, 'artifacts.jsonl'));
  const context = { mode: 'code', conversationId: 'abc', title: 'Regression check' };
  const [first, second] = await Promise.all([
    library.record(context, { filename: 'first.txt', title: 'Report', fullPath: 'first.txt' }),
    library.record(context, { filename: 'second.txt', title: 'Report', location: 'vm' }),
  ]);
  const page = await library.list({ query: 'REGRESSION', limit: 1 });
  assert.deepEqual(page, { items: [second], next: second.id });
  assert.deepEqual(await library.list({ query: 'report', before: page.next }), {
    items: [first],
    next: null,
  });
});

test('backup formats preserve chat data, while corrupted or wrongly decrypted data is rejected', async () => {
  const rows = [
    {
      mode: 'chat',
      data: { id: 'id-1', title: "Chinese 中文 '", messages: [{ role: 'user', content: '山海' }] },
    },
  ];
  assert.deepEqual(await decodeBackup(await encodeBackup(rows)), rows);
  const password = 'test-password';
  const encrypted = await encodeBackup(rows, password);
  assert.ok(!encrypted.includes('山海'));
  assert.deepEqual(await decodeBackup(encrypted, password), rows);
  await assert.rejects(decodeBackup(encrypted, 'wrong-password'), /ARCHIVE_AUTH/);
  const tampered = JSON.parse(encrypted);
  tampered.data = (tampered.data[0] === 'A' ? 'B' : 'A') + tampered.data.slice(1);
  await assert.rejects(decodeBackup(JSON.stringify(tampered), password), /ARCHIVE_AUTH/);
  assert.match(exportRows(rows, 'md'), /## user[\s\S]+山海/);
  assert.doesNotMatch(exportRows(rows, 'sql'), /Chinese|山海/);
});

test('entropy pool always supplies fresh system randomness when optional sources fail', async () => {
  const pool = { id: 'demo', name: 'Demo', drand: true, hardware: true, device: '/dev/hwrng' };
  const pools = new EntropyPools({
    getSettings: () => ({ entropy: { pools: [pool], activePoolId: pool.id } }),
    fetcher: async () => new Response('{}'),
    device: async () => ({ bytes: Buffer.alloc(32, 7) }),
    hardware: async () => {
      throw new Error('offline');
    },
  });
  const first = await pools.use(undefined, 'question', (getBytes) => getBytes(24));
  const second = await pools.use(undefined, 'question', (getBytes) => getBytes(24));
  assert.equal(first.result.length, 24);
  assert.notDeepEqual(first.result, second.result);
  assert.deepEqual(
    second.report.sources.map((source) => [source.kind, source.status]),
    [
      ['os', 'used'],
      ['drand', 'unavailable'],
      ['hardware', 'unavailable'],
      ['device', 'used'],
    ],
  );
  assert.deepEqual(pools.report(), second.report);
  assert.throws(() => normalizedPools([pool, pool]), /INVALID_ENTROPY_POOL/);
});

test('structured widgets accept plain text and exact bounds without accepting executable fields', () => {
  const data = {
    title: 'Summary',
    columns: ['Label', 'Value'],
    rows: [['<svg onload=alert(1)>', 7]],
    chartColumn: 1,
  };
  assert.deepEqual(validate(data), data);
  assert.throws(() => validate({ ...data, script: 'fetch()' }), /bounded table/);
  assert.throws(
    () => validate({ ...data, rows: Array.from({ length: 121 }, () => data.rows[0]) }),
    /bounded table/,
  );
  assert.throws(() => validate({ ...data, chartColumn: 0 }), /numbers or null/);
});
