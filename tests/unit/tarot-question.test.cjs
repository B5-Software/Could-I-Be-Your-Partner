/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  { createHash } = require('node:crypto');
function browser({ fixed = false } = {}) {
  let counter = 0;
  const context = vm.createContext({
    TextEncoder,
    Uint8Array,
    Uint32Array,
    DataView,
    crypto: {
      getRandomValues(bytes) {
        bytes.fill(fixed ? 7 : ++counter);
        return bytes;
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve('IoT-Firmware/CIBYP-TRNG/web/question-seed.js'), 'utf8'),
    context,
  );
  return context.CibypTarotQuestionDigest;
}
test('offline question hash works without secure-context subtle, includes a fresh blinding nonce and matches independent SHA-256', () => {
  const digest = browser(),
    question = '问题：明天的计划';
  const expected = createHash('sha256')
    .update('CIBYP-TAROT/2/browser-question\n')
    .update(Buffer.alloc(32, 1))
    .update(question.normalize('NFC'))
    .digest('hex');
  assert.equal(digest(question), expected);
  assert.notEqual(digest(question), expected);
  assert.equal(browser({ fixed: true })('é'), browser({ fixed: true })('e\u0301'));
  for (const value of ['', '  ', 'x'.repeat(201), null]) assert.throws(() => digest(value));
});
