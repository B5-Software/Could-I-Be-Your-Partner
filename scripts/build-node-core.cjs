/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  out = path.resolve(process.argv[2] || path.join(root, 'dist/node-core'));
const sources = Object.fromEntries(
  ['i18n.js', 'i18n/en.js', 'i18n/de.js'].map((name) => [
    path.basename(name),
    fs.readFileSync(path.join(root, 'src/renderer/js', name), 'utf8'),
  ]),
);
const framesDir = path.join(root, 'src/renderer/assets/avatar-frames');
const frames = Object.fromEntries(
  fs
    .readdirSync(framesDir)
    .filter((name) => name.endsWith('.svg'))
    .map((name) => [
      path.basename(name, '.svg'),
      fs.readFileSync(path.join(framesDir, name), 'utf8'),
    ]),
);
require('esbuild')
  .build({
    entryPoints: [path.join(root, 'src/agent/node-host.js')],
    outfile: path.join(out, 'core.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: [
      'express',
      'express-ws',
      'ws',
      'bcryptjs',
      'otpauth',
      'node-pty',
      '@anthropic-ai/claude-agent-sdk',
      'zod',
    ],
    plugins: [require('./lib/guest-tool-bundle.cjs').sdkMetadataPlugin()],
    define: {
      CIBYP_I18N_SOURCES: JSON.stringify(sources),
      CIBYP_AVATAR_FRAMES: JSON.stringify(frames),
      'import.meta.url': '__cibypNodeModuleUrl',
    },
    banner: {
      js: 'const __cibypNodeModuleUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    metafile: true,
    sourcemap: 'external',
    legalComments: 'eof',
  })
  .then((result) => {
    const forbidden = Object.keys(result.metafile.inputs).filter((name) =>
      /(?:^|\/)electron(?:\/|$)|src\/main\/main\.js|src\/renderer\/(?:pages|css)\//.test(
        name.replace(/\\/g, '/'),
      ),
    );
    if (forbidden.length)
      throw new Error('Desktop dependency leaked into Node core: ' + forbidden.join(', '));
    const sha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(out, 'core.cjs')))
      .digest('hex');
    let revision = null,
      dirty = true;
    try {
      revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      dirty = !!execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    } catch {}
    const manifest = {
      schemaVersion: 1,
      protocol: 2,
      version: require('../package.json').version,
      node: '>=24',
      sha256,
      source: {
        repository: 'https://github.com/B5-Software/Could-I-Be-Your-Partner',
        revision,
        dirty,
        sourceMap: 'core.cjs.map',
      },
      dependencies: Object.fromEntries(
        [
          'express',
          'express-ws',
          'ws',
          'bcryptjs',
          'otpauth',
          '@anthropic-ai/claude-agent-sdk',
          'zod',
        ].map((name) => [name, require('../package.json').dependencies[name]]),
      ),
    };
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
    fs.writeFileSync(path.join(out, 'i18n-sources.json'), JSON.stringify(sources));
    const notices = [];
    for (const name of Object.keys(result.metafile.inputs)) {
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(name.replace(/\\/g, '/'));
      if (!match || notices.some((v) => v.name === match[1])) continue;
      const directory = path.join(root, 'node_modules', match[1]);
      const license = fs.readdirSync(directory).find((v) => /^licen[sc]e(?:\.|$)/i.test(v));
      notices.push({
        name: match[1],
        license: license
          ? fs.readFileSync(path.join(directory, license), 'utf8')
          : 'See upstream package license',
      });
    }
    fs.writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.json'), JSON.stringify(notices, null, 2));
    console.log(
      'Node core: ' + out + ' (' + fs.statSync(path.join(out, 'core.cjs')).size + ' bytes)',
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
