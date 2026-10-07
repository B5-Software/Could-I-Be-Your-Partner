/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  generateReleaseNotes,
  mergeReleaseNotes,
  compareVersions,
} = require('../../scripts/lib/release-notes.cjs');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-release-notes-'));
  t.after(() => {
    assert.equal(path.dirname(cwd), path.resolve(os.tmpdir()));
    assert(path.basename(cwd).startsWith('cibyp-release-notes-'));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const git = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Release test']);
  git(['config', 'user.email', 'release@example.invalid']);
  const commit = (subject, body = '') => {
    git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', subject, '-m', body]);
    return git(['rev-parse', 'HEAD']);
  };
  return {
    cwd,
    git,
    commit,
    notes: (options) => generateReleaseNotes({ cwd, repo: 'fixture/app', ...options }),
  };
}

test('notes include every commit and full bodies, use published versions, and stay pinned when HEAD advances', (t) => {
  const f = fixture(t);
  f.commit('initial');
  f.git(['tag', 'v1.0.0']);
  f.commit('fix: first change', '第一段。\n\n```text\nfull details\n```');
  f.git(['tag', 'v1.1.0-alpha.2']); // Failed/unpublished build must not hide changes.
  f.commit('feat: 新功能 [preview]');
  f.git(['tag', '-a', 'v1.1.0-alpha.10', '-m', 'published']);
  f.commit('fix: after latest preview');
  f.git(['tag', 'v1.1.0-alpha.11']);
  f.commit('chore: later work that is not released yet');
  const complete = f.notes({ version: '1.1.0-alpha.10', publishedTags: ['v1.0.0'] });
  assert.equal(complete.from, 'v1.0.0');
  assert.deepEqual(
    complete.commits.map((c) => c.subject),
    ['fix: first change', 'feat: 新功能 [preview]'],
  );
  assert.match(complete.markdown, /第一段。/);
  assert.match(complete.markdown, /````text/);
  assert.match(complete.markdown, /新功能 \\\[preview\\\]/);
  assert(!complete.markdown.includes('after latest preview'));
  assert.equal(f.notes({ version: '1.1.0-alpha.11' }).from, 'v1.1.0-alpha.10');
  assert.match(complete.markdown, /compare\/v1.0.0\.\.\.v1.1.0-alpha.10/);
});

test('notes ignore unrelated release branches and reject a supplied non-ancestor or option-like ref', (t) => {
  const f = fixture(t);
  f.commit('initial');
  f.git(['tag', 'v1.0.0']);
  f.git(['checkout', '-b', 'unrelated']);
  f.commit('feat: unrelated');
  f.git(['tag', 'v1.1.0']);
  f.git(['checkout', 'main']);
  f.commit('fix: main');
  f.git(['tag', 'v1.2.0']);
  assert.equal(f.notes({ version: '1.2.0' }).from, 'v1.0.0');
  assert.throws(() => f.notes({ version: '1.2.0', from: 'v1.1.0' }), /not an ancestor/);
  assert.throws(() => f.notes({ version: '1.2.0', to: '--all' }), /Invalid release revision/);
  assert.throws(
    () => f.notes({ version: '1.2.0', repo: 'https://invalid/' }),
    /Invalid GitHub repository/,
  );
});

test('merged branches retain both their individual commits and the merge commit', (t) => {
  const f = fixture(t);
  f.commit('initial');
  f.git(['tag', 'v1.0.0']);
  f.git(['checkout', '-b', 'feature']);
  f.commit('feat: branch change');
  f.git(['checkout', 'main']);
  f.commit('fix: main change');
  f.git(['-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'feature', '-m', 'Merge feature']);
  f.git(['tag', 'v1.1.0']);
  assert.deepEqual(
    new Set(f.notes({ version: '1.1.0' }).commits.map((c) => c.subject)),
    new Set(['feat: branch change', 'fix: main change', 'Merge feature']),
  );
});

test('first release contains full history and reruns preserve manually authored release text', (t) => {
  const f = fixture(t);
  f.commit('initial');
  f.commit(
    'docs: usage',
    'Markers quoted in commit details:\n<!-- cibyp-release-notes:start -->\n<!-- cibyp-release-notes:end -->',
  );
  f.git(['tag', 'v1.0.0']);
  const notes = f.notes({ version: '1.0.0' });
  assert.equal(notes.from, null);
  assert.equal(notes.commits.length, 2);
  const merged = mergeReleaseNotes('Manual upgrade instructions.', notes.markdown);
  assert.equal(mergeReleaseNotes(merged, notes.markdown), merged);
  assert(merged.includes('Manual upgrade instructions.'));
  assert.throws(
    () => mergeReleaseNotes('<!-- cibyp-release-notes:start -->\nbroken', notes.markdown),
    /Malformed/,
  );
  assert.throws(() => mergeReleaseNotes(merged + merged, notes.markdown), /Malformed/);
  assert.equal(
    mergeReleaseNotes(merged.replaceAll('\n', '\r\n'), notes.markdown).replaceAll('\r\n', '\n'),
    merged,
  );
  assert(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2') > 0);
  assert(compareVersions('1.0.0', '1.0.0-alpha.10') > 0);
});
