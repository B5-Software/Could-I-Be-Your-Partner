/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('immediate history edits commit atomically, cancel stale writes and keep the old pending snapshot on failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-history-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let rejectWrites = false;
  const io = {
    ...fs,
    writeFileSync: (...args) => {
      if (rejectWrites && String(args[0]).endsWith('.tmp')) throw new Error('disk full');
      return fs.writeFileSync(...args);
    },
  };
  const history = require('../../src/main/services/history')({
    path,
    imagesDir: root,
    dataDir: root,
    historyDir: root,
    babeHistoryDir: root,
    fs: io,
    getSettings: () => ({ llm: {} }),
    loadJSON: () => null,
    saveJSON: (file, data) => fs.writeFileSync(file, JSON.stringify(data)),
    ipcMain: { handle: () => {} },
  });
  const file = path.join(root, 'chat.json');
  history.queueHistorySave('chat', file, { text: 'old' });
  history.queueHistorySave('chat', file, { text: 'deleted' }, { immediate: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, 'deleted');
  history.flushPendingHistorySaves();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, 'deleted');
  history.queueHistorySave('chat', file, { text: 'restore pending' });
  rejectWrites = true;
  assert.throws(
    () => history.queueHistorySave('chat', file, { text: 'must not commit' }, { immediate: true }),
    /disk full/,
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, 'deleted');
  rejectWrites = false;
  history.flushPendingHistorySaves();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, 'restore pending');
  assert.deepEqual(fs.readdirSync(root), ['chat.json']);
});
