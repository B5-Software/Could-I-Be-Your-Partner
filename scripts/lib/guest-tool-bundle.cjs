/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// ESM SDKs read their own package metadata with createRequire(import.meta.url).
// A deployed worker has no node_modules or package.json beside it. Preserve
// each SDK's metadata at build time rather than resolving relative to the worker.
function sdkMetadataPlugin() {
  return {
    name: 'guest-sdk-metadata',
    setup(build) {
      build.onLoad({ filter: /[\\/]@deepseek-ai[\\/].*\.[cm]?js$/ }, async (args) => {
        let source = await fs.readFile(args.path, 'utf8');
        const pattern =
          /createRequire\(import\.meta\.url\)\(\s*(["'])(\.\.?\/[^"']+\.json)\1\s*\)/g;
        const matches = [...source.matchAll(pattern)];
        for (const match of matches) {
          const metadata = JSON.parse(
            await fs.readFile(path.resolve(path.dirname(args.path), match[2]), 'utf8'),
          );
          source = source.replace(match[0], '(' + JSON.stringify(metadata) + ')');
        }
        return { contents: source, loader: 'js' };
      });
    },
  };
}

async function buildGuestToolWorker(root) {
  return require('esbuild').build({
    entryPoints: [path.join(root, 'src/main/vm/guest-tool-worker.js')],
    outfile: path.join(root, 'src/main/vm/generated/guest-tool-worker.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20.19',
    plugins: [sdkMetadataPlugin()],
    // Other ESM dependencies may need a require rooted in the deployed worker.
    define: { 'import.meta.url': '__cibypGuestModuleUrl' },
    banner: {
      js: 'const __cibypGuestModuleUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    external: [
      'pdf-parse',
      'pdfjs-dist/*',
      'tesseract.js',
      'puppeteer',
      '@napi-rs/canvas',
      'ffmpeg-static',
      'ffprobe-static',
      'electron',
      'eslint',
      'eslint/*',
    ],
    logLevel: 'warning',
  });
}
module.exports = { buildGuestToolWorker };
