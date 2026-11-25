/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileSearchService } = require('../../src/main/services/file-search-service');

test('file search processes nested files outside the UI process and rejects broad path aliases', async (t) => {
  const temp = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temp, 'cibyp-file-search-'));
  const service = new FileSearchService();
  t.after(async () => {
    service.dispose();
    assert.equal(path.dirname(path.resolve(directory)), temp);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, 'subfolder'));
  const expected = path.join(directory, 'subfolder', 'notes.txt');
  await fs.writeFile(expected, 'First line\nLocated an answer\n');
  const alias = path.join(directory, 'home-alias');
  await fs.symlink(os.homedir(), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const [names, contents, blocked] = await Promise.all([
    service.localSearch(directory, '*.txt', { fileOnly: true }),
    service.searchInFiles([directory], 'answer'),
    service.localSearch(alias, '*'),
  ]);
  assert.deepEqual(names.results, [expected]);
  assert.equal(contents.matches[0].file, expected);
  assert.equal(blocked.blocked, true);
});
