const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const yaml = require('js-yaml');

test('release tag survives advancing main, accepts reruns and rejects a reused version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-release-tag-'));
  const remote = path.join(root, 'origin.git');
  const checkout = path.join(root, 'checkout');
  const git = (args, cwd = checkout) =>
    cp
      .execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      .trim();
  try {
    fs.mkdirSync(checkout);
    git(['init', '--bare', remote]);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Release fixture']);
    git(['config', 'user.email', 'release-fixture@example.invalid']);
    git(['remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(checkout, 'app.txt'), 'first build');
    git(['add', '.']);
    git(['commit', '-m', 'first']);
    git(['push', 'origin', 'main']);
    const first = git(['rev-parse', 'HEAD']);
    const workflow = yaml.load(
      fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8'),
    );
    const script = workflow.jobs.detect.steps.find(
      (step) => step.name === 'Pin version tag before building',
    ).run;
    const bash =
      process.platform === 'win32'
        ? path.resolve(git(['--exec-path']), '../../../bin/bash.exe')
        : '/bin/bash';
    // Model the GitHub refs endpoint with a real bare Git repository.
    const api = `gh() {
      local tag_ref tag_sha
      for argument in "$@"; do
        case "$argument" in ref=*) tag_ref="\${argument#ref=}";; sha=*) tag_sha="\${argument#sha=}";; esac
      done
      git --git-dir="$RELEASE_TAG_TEST_REMOTE" update-ref "$tag_ref" "$tag_sha"
    }
    `;
    const pin = (sha) =>
      cp.spawnSync(bash, ['--noprofile', '--norc', '-e'], {
        cwd: checkout,
        input: api + script,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          VERSION: '9.9.9-alpha.1',
          GITHUB_SHA: sha,
          GITHUB_REPOSITORY: 'fixture/release',
          RELEASE_TAG_TEST_REMOTE: remote,
        },
      });
    const created = pin(first);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'v9.9.9-alpha.1']), first);
    fs.writeFileSync(path.join(checkout, 'app.txt'), 'followup while builders run');
    git(['commit', '-am', 'followup']);
    git(['push', 'origin', 'main']);
    const next = git(['rev-parse', 'HEAD']);
    const rerun = pin(first);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'v9.9.9-alpha.1']), first);
    const conflict = pin(next);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stdout, /already tagged at another commit/);
    assert.equal(
      git(['--git-dir', remote, 'rev-parse', 'v9.9.9-alpha.1']),
      first,
      'a version tag must never be overwritten',
    );
    const verifyScript = workflow.jobs.release.steps.find(
      (step) => step.name === 'Verify artifact revision',
    ).run;
    const verify = (sha, run = '1234') =>
      cp.spawnSync(bash, ['--noprofile', '--norc', '-e'], {
        cwd: checkout,
        input: 'gh() { echo "$RELEASE_TAG_TEST_BUILD_SHA"; }\n' + verifyScript,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          VERSION: '9.9.9-alpha.1',
          BUILD_RUN_ID: run,
          GITHUB_REPOSITORY: 'fixture/release',
          RELEASE_TAG_TEST_BUILD_SHA: sha,
        },
      });
    assert.equal(verify(first).status, 0);
    const wrongBuild = verify(next);
    assert.equal(wrongBuild.status, 1);
    assert.match(wrongBuild.stdout, /different commits/);
    assert.equal(verify(first, '1234; echo injected').status, 1);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('cibyp-release-tag-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
