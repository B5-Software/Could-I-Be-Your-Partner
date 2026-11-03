/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { registerHooks, createRequire } = require('node:module');
const { flattenModules, verifyProductionDependencies } = require('./lib/runtime-dependencies.cjs');

function canonical(value) {
  const resolved = fs.realpathSync(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function smoke(manifestFile) {
  const config = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const allowed = new Set(config.directories.map(canonical));
  const identities = new Map(
    config.directories.map((directory) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      return [pkg.name + '@' + pkg.version, canonical(directory)];
    }),
  );
  const cache = new Map();
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!result.url.startsWith('file:')) return result;
      const file = fileURLToPath(result.url);
      if (!file.split(path.sep).includes('node_modules')) return result;
      let directory = path.dirname(file),
        owner = cache.get(directory);
      if (!owner) {
        const original = directory;
        for (;;) {
          if (fs.existsSync(path.join(directory, 'package.json'))) {
            const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
            if (pkg.name && pkg.version) {
              owner = canonical(directory);
              break;
            }
          }
          const parent = path.dirname(directory);
          if (parent === directory)
            throw new Error('Cannot identify packaged module: ' + specifier);
          directory = parent;
        }
        cache.set(original, owner);
      }
      if (!allowed.has(owner)) {
        const pkg = JSON.parse(fs.readFileSync(path.join(owner, 'package.json'), 'utf8'));
        const equivalent = identities.get(pkg.name + '@' + pkg.version);
        // The builder hoists one identical package version from potentially many
        // npm locations. Redirect to that collected copy; never accept another version.
        if (equivalent) {
          const target = path.join(equivalent, path.relative(owner, file));
          if (fs.existsSync(target)) return { ...result, url: pathToFileURL(target).href };
        }
        throw new Error(
          'PACKAGED_DEPENDENCY_ESCAPE: ' +
            specifier +
            ' resolved outside electron-builder production modules (' +
            owner +
            ')',
        );
      }
      return result;
    },
  });
  try {
    const requireApp = createRequire(path.join(config.root, 'package.json'));
    const catalog = requireApp('./src/main/ds-compat/sdk-catalog.js');
    requireApp('./src/main/ds-compat/plugin-host.js');
    requireApp('./src/main/ds-compat/plugin-manager.js');
    requireApp('@anthropic-ai/claude-agent-sdk');
    console.log(
      '[runtime-deps] Clean production resolution: ' +
        Object.keys(catalog).length +
        ' SDKs, plugin host/manager and Claude subscription SDK',
    );
  } finally {
    hook.deregister();
  }
}
async function main(root = path.resolve(__dirname, '..')) {
  const modules = await verifyProductionDependencies(root);
  const file = path.join(
    os.tmpdir(),
    'cibyp-production-smoke-' + require('node:crypto').randomUUID() + '.json',
  );
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ root, directories: flattenModules(modules).map((item) => item.dir) }),
      { mode: 0o600, flag: 'wx' },
    );
    const output = execFileSync(process.execPath, [__filename, '--smoke', file], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    });
    process.stdout.write(output);
    console.log(
      '[runtime-deps] ' +
        flattenModules(modules).length +
        ' production packages verified; peer dependencies included',
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
}
if (require.main === module) {
  if (process.argv[2] === '--smoke') smoke(process.argv[3]);
  else
    main().catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
module.exports = { main, smoke };
