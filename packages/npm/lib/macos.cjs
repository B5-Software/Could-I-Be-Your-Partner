/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const policy = 1;

async function machO(file) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(8);
    if ((await handle.read(bytes, 0, bytes.length, 0)).bytesRead < 8) return false;
    const magic = bytes.readUInt32BE(0);
    if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) return true;
    if ([0xcafebabe, 0xcafebabf].includes(magic)) {
      const count = bytes.readUInt32BE(4);
      return count > 0 && count <= 16;
    }
    if ([0xbebafeca, 0xbfbafeca].includes(magic)) {
      const count = bytes.readUInt32LE(4);
      return count > 0 && count <= 16;
    }
    return false;
  } finally {
    await handle.close();
  }
}

async function signingTargets(app) {
  const binaries = [];
  const bundles = [];
  async function visit(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      // Framework aliases point to the real Versions tree. Never follow links
      // into a user's other files, or sign the same framework twice.
      if (item.isSymbolicLink() || item.name === '_CodeSignature') continue;
      if (item.isDirectory()) {
        await visit(file);
        if (/\.(app|framework|xpc|bundle)$/.test(item.name)) {
          for (const metadata of ['Contents/Info.plist', 'Resources/Info.plist']) {
            if (
              await fs.stat(path.join(file, metadata)).then(
                (value) => value.isFile(),
                () => false,
              )
            ) {
              bundles.push(file);
              break;
            }
          }
        }
      } else if (item.isFile() && (await machO(file))) binaries.push(file);
    }
  }
  await visit(app);
  bundles.push(app);
  return { binaries, bundles };
}

async function prepareMacRuntime(
  directory,
  asset,
  { run = execute, signal, log = (message) => console.error(message) } = {},
) {
  const { inside } = require('./runtime.cjs');
  const match = asset.executable.match(/^(.+\.app)\/Contents\/MacOS\/[^/]+$/);
  if (!match) throw new Error('Missing macOS runtime application bundle');
  const app = inside(directory, match[1]);
  const actualRoot = await fs.realpath(directory);
  const actualApp = await fs.realpath(app);
  const relative = path.relative(actualRoot, actualApp);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('macOS application bundle is outside the verified runtime');
  const options = { timeout: 120000, signal, windowsHide: true, maxBuffer: 1024 * 1024 };
  const verify = () => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], options);
  try {
    await verify();
    log('[cibyp] Existing macOS code signature verified; preserving it.');
    return;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new Error('macOS codesign is unavailable');
  }
  log('[cibyp] Applying a local macOS signature to the verified App...');
  const temporary = await fs.mkdtemp(path.join(directory, '.cibyp-signing-'));
  try {
    const { binaries, bundles } = await signingTargets(app);
    if (!binaries.length) throw new Error('The macOS runtime contains no Mach-O binaries');
    const fallback = path.join(temporary, 'electron.plist');
    const keys = [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ];
    await fs.writeFile(
      fallback,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
        keys.map((key) => `<key>${key}</key><true/>`).join('') +
        '<key>com.apple.security.device.audio-input</key><true/>' +
        '<key>com.apple.security.automation.apple-events</key><true/>' +
        '</dict></plist>',
      { mode: 0o600 },
    );
    // Sign leaves first, then enclosing bundles. --deep signing would replace
    // helper entitlements and can miss native modules in Contents/Resources.
    const targets = [...binaries, ...bundles];
    let completed = 0;
    for (const target of targets) {
      signal?.throwIfAborted();
      let entitlements = fallback;
      const previous = await run(
        '/usr/bin/codesign',
        ['--display', '--entitlements', ':-', target],
        options,
      ).catch(() => null);
      const xml = previous?.stdout?.match(/<\?xml[\s\S]*?<\/plist>/)?.[0];
      if (xml) {
        entitlements = path.join(temporary, 'preserved.plist');
        await fs.writeFile(entitlements, xml, { mode: 0o600 });
        for (const key of keys) {
          await run(
            '/usr/libexec/PlistBuddy',
            ['-c', `Set :${key} true`, entitlements],
            options,
          ).catch(() =>
            run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} bool true`, entitlements], options),
          );
        }
      }
      await run(
        '/usr/bin/codesign',
        [
          '--force',
          '--sign',
          '-',
          '--timestamp=none',
          '--options',
          'runtime',
          '--entitlements',
          entitlements,
          target,
        ],
        options,
      );
      completed++;
      if (completed % 20 === 0 || completed === targets.length)
        log(`[cibyp] Local signing: ${completed}/${targets.length} components`);
    }
    await verify();
    log(
      '[cibyp] Local macOS signature verified. Gatekeeper may still require Open Anyway in System Settings > Privacy & Security.',
    );
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error('macOS local signing failed: ' + (error.stderr?.trim() || error.message), {
      cause: error,
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { prepareMacRuntime, signingTargets, machO, policy };
