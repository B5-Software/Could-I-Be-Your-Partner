/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  auditPackages,
  auditArchiveDependencies,
  collectProductionModules,
  flattenModules,
} = require('../../scripts/lib/runtime-dependencies.cjs');
const root = path.resolve(__dirname, '../..');

test('required peer dependencies cannot disappear from the production graph', () => {
  const packages = [
    { packageDirectory: '/', manifest: { name: 'app', dependencies: { sdk: '1' } } },
    {
      packageDirectory: '/node_modules/sdk',
      manifest: {
        name: 'sdk',
        peerDependencies: { 'title-runtime': '1', optional: '*' },
        peerDependenciesMeta: { optional: { optional: true } },
      },
    },
  ];
  assert.deepEqual(
    auditPackages(packages).map((item) => item.missing),
    ['title-runtime'],
  );
  packages.push({
    packageDirectory: '/node_modules/title-runtime',
    manifest: { name: 'title-runtime' },
  });
  assert.deepEqual(auditPackages(packages), []);
});
test('an unrelated nested module does not satisfy a missing peer in another package', () => {
  assert.equal(
    auditPackages([
      {
        packageDirectory: '/node_modules/sdk',
        manifest: { name: 'sdk', peerDependencies: { title: '*' } },
      },
      { packageDirectory: '/node_modules/other/node_modules/title', manifest: { name: 'title' } },
    ]).length,
    1,
  );
});
test('archive audit uses packaged files, never the developer node_modules fallback', () => {
  const manifests = new Map([
    ['/package.json', { name: 'app', dependencies: { sdk: '*' } }],
    [
      '/node_modules/sdk/package.json',
      { name: 'sdk', peerDependencies: { '@deepseek-ai/dsh-session-title': '*' } },
    ],
  ]);
  const read = (file) => JSON.stringify(manifests.get(file));
  assert.equal(
    auditArchiveDependencies(new Set(manifests.keys()), read)[0].missing,
    '@deepseek-ai/dsh-session-title',
  );
  manifests.set('/node_modules/@deepseek-ai/dsh-session-title/package.json', {
    name: '@deepseek-ai/dsh-session-title',
  });
  assert.deepEqual(auditArchiveDependencies(new Set(manifests.keys()), read), []);
});
test('published runtime prerequisites are explicit production dependencies', () => {
  const pkg = require('../../package.json');
  for (const name of [
    '@deepseek-ai/dsh-session-title',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-http-proxy',
    '@deepseek-ai/dsh-llm-retry',
    '@deepseek-ai/dsh-ptc-runtime',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
  ]) {
    assert.ok(pkg.dependencies[name], name);
    assert.ok(!pkg.devDependencies[name], name + ' cannot be development-only');
  }
});
test('actual SDK startup succeeds with the collected modules and fails when the title peer is removed', async (t) => {
  const modules = await collectProductionModules(root);
  const directories = flattenModules(modules).map((item) => item.dir);
  const file = path.join(
    os.tmpdir(),
    'cibyp-production-proof-' + require('node:crypto').randomUUID() + '.json',
  );
  t.after(() => fs.rmSync(file, { force: true }));
  const run = (allowed) => {
    fs.writeFileSync(file, JSON.stringify({ root, directories: allowed }));
    return spawnSync(
      process.execPath,
      [path.join(root, 'scripts/check-runtime-deps.cjs'), '--smoke', file],
      {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      },
    );
  };
  const good = run(directories);
  assert.equal(good.status, 0, good.stderr);
  const bad = run(
    directories.filter(
      (directory) => !directory.replace(/\\/g, '/').endsWith('/@deepseek-ai/dsh-session-title'),
    ),
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /PACKAGED_DEPENDENCY_ESCAPE.*dsh-session-title/);
});
