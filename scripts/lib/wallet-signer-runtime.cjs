/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process'),
  { gzipSync } = require('node:zlib');
const runtime = require('../../src/main/services/wallet/native-binary');
const { lock, target, sha256, readRegular, executable, decode, MAX_BINARY } = runtime;
const root = path.resolve(__dirname, '../..'),
  preparing = new Map();
function sourceHash(project = root) {
  const inputs = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'];
  const visit = (folder) => {
    for (const item of fs.readdirSync(path.join(project, 'native/wallet-signer', folder), {
      withFileTypes: true,
    })) {
      if (item.isSymbolicLink()) throw Error('NATIVE_SOURCE_SYMLINK');
      const relative = folder + '/' + item.name;
      if (item.isDirectory()) visit(relative);
      else if (item.isFile() && item.name.endsWith('.rs')) inputs.push(relative);
    }
  };
  visit('src');
  if (fs.existsSync(path.join(project, 'native/wallet-signer/build.rs'))) inputs.push('build.rs');
  if (fs.existsSync(path.join(project, 'native/wallet-signer/.cargo/config.toml')))
    inputs.push('.cargo/config.toml');
  const files = inputs
    .sort()
    .map((file) => [
      file,
      fs
        .readFileSync(path.join(project, 'native/wallet-signer', file), 'utf8')
        .replace(/\r\n/g, '\n'),
    ]);
  files.push([
    'runtime-lock.json',
    fs
      .readFileSync(path.join(project, 'integrations/wallet/runtime-lock.json'), 'utf8')
      .replace(/\r\n/g, '\n'),
  ]);
  for (const file of [
    'scripts/lib/wallet-signer-runtime.cjs',
    'src/main/services/wallet/native-binary.js',
    'src/main/services/native-resource.js',
    'native/wallet-signer/licenses/CC0-1.0.txt',
    'native/wallet-signer/licenses/Apache-2.0.txt',
    'native/wallet-signer/licenses/ruint-MIT.txt',
    'native/wallet-signer/licenses/ruint-macro-MIT.txt',
    'native/wallet-signer/licenses/sha3-asm-BSD.txt',
    'native/wallet-signer/licenses/valuable-MIT.txt',
    'LICENSE',
  ])
    files.push([file, fs.readFileSync(path.join(project, file), 'utf8').replace(/\r\n/g, '\n')]);
  return sha256(Buffer.from(JSON.stringify(files)));
}
function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    windowsHide: true,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw Error(
      'Native quant build failed: ' + program + ' ' + (result.error?.message || result.status),
    );
  return result;
}
function stage(
  binary,
  destination,
  platform = process.platform,
  arch = process.arch,
  metadata = {},
) {
  const spec = target(platform, arch),
    bytes = readRegular(binary, MAX_BINARY);
  executable(bytes, platform, arch);
  const compressed = gzipSync(bytes, { level: 9 });
  const value = {
    schemaVersion: 1,
    format: lock.format,
    protocol: lock.protocol,
    engineVersion: lock.engineVersion,
    toolchain: lock.toolchain,
    target: spec.key,
    rustTarget: spec.rust,
    binary: spec.binary,
    archive: 'engine.gz',
    size: bytes.length,
    archiveSize: compressed.length,
    sha256: sha256(bytes),
    archiveSha256: sha256(compressed),
    sourceHash: metadata.sourceHash || sourceHash(),
    signing: metadata.signing || 'none',
  };
  runtime.manifest(value, platform, arch);
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.join(destination, 'engine.gz'),
    manifest = path.join(destination, 'manifest.json');
  fs.writeFileSync(archive + '.tmp', compressed);
  fs.renameSync(archive + '.tmp', archive);
  fs.writeFileSync(manifest + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(manifest + '.tmp', manifest);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
  if (metadata.notices)
    fs.writeFileSync(path.join(destination, 'THIRD-PARTY.txt'), metadata.notices);
  return { directory: destination, manifest: value };
}
function thirdPartyNotices(rustTarget) {
  const result = spawnSync(
    'cargo',
    [
      '+' + lock.toolchain,
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--filter-platform',
      rustTarget,
    ],
    {
      cwd: path.join(root, 'native/wallet-signer'),
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) throw Error('Wallet dependency license metadata unavailable');
  const metadata = JSON.parse(result.stdout),
    nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n])),
    active = new Set();
  const visit = (id) => {
    if (active.has(id)) return;
    active.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) visit(dependency.pkg);
  };
  visit(metadata.resolve.root);
  const packages = metadata.packages
    .filter((p) => p.source && active.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    packages
      .map((p) => {
        const folder = path.dirname(p.manifest_path),
          texts = [];
        for (const file of fs
          .readdirSync(folder)
          .filter((name) => /^(LICENSE|COPYING)(?:[-_.]|$)/i.test(name))
          .sort()) {
          const target = path.join(folder, file),
            stat = fs.lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
            throw Error('Wallet dependency license is invalid');
          texts.push(file + '\n' + fs.readFileSync(target, 'utf8'));
        }
        const bundledLicense = {
          'ruint@1.17.2': ['MIT', 'ruint-MIT'],
          'ruint-macro@1.2.1': ['MIT', 'ruint-macro-MIT'],
          'valuable@0.1.1': ['MIT', 'valuable-MIT'],
          'sha3-asm@0.1.9': ['BSD-3-Clause', 'sha3-asm-BSD'],
        }[p.name + '@' + p.version];
        const fallback =
          p.license === 'CC0-1.0'
            ? 'CC0-1.0'
            : ['Apache-2.0', 'MIT OR Apache-2.0', 'Apache-2.0/MIT'].includes(p.license)
              ? 'Apache-2.0'
              : bundledLicense?.[0] === p.license
                ? bundledLicense[1]
                : null;
        if (!texts.length && fallback)
          texts.push(
            fs.readFileSync(
              path.join(root, 'native/wallet-signer/licenses', fallback + '.txt'),
              'utf8',
            ),
          );
        if (!texts.length) throw Error('Missing wallet dependency license: ' + p.name);
        return (
          p.name +
          ' ' +
          p.version +
          ' · ' +
          p.license +
          '\n' +
          (p.authors || []).join(', ') +
          '\n' +
          (p.repository || '') +
          '\n' +
          texts.join('\n')
        );
      })
      .join('\n\n============================================================\n\n') + '\n'
  );
}
async function prepareWalletSigner(platform = process.platform, arch = process.arch, options = {}) {
  const spec = target(platform, arch),
    directory = options.destination || path.join(root, 'assets/wallet-signer', spec.asset),
    fingerprint = sourceHash();
  const expectedSigning =
    platform === 'darwin'
      ? process.env.CIBYP_WALLET_SIGN_IDENTITY
        ? 'identity:' + sha256(Buffer.from(process.env.CIBYP_WALLET_SIGN_IDENTITY))
        : 'adhoc'
      : 'none';
  const key = directory + ':' + fingerprint + ':' + expectedSigning;
  if (preparing.has(key)) return preparing.get(key);
  const task = Promise.resolve()
    .then(() => {
      try {
        const value = decode(directory, platform, arch).manifest;
        if (value.sourceHash === fingerprint && value.signing === expectedSigning)
          return { directory, manifest: value };
      } catch {}
      if (platform !== process.platform || arch !== process.arch)
        throw Error(
          'Native quant engine must be built on its target host or supplied as a verified prepared asset: ' +
            spec.key,
        );
      const crate = path.join(root, 'native/wallet-signer');
      if (
        fs
          .readFileSync(path.join(crate, 'Cargo.toml'), 'utf8')
          .match(/^version\s*=\s*"([^"]+)"/m)?.[1] !== lock.engineVersion ||
        fs
          .readFileSync(path.join(crate, 'rust-toolchain.toml'), 'utf8')
          .match(/^channel\s*=\s*"([^"]+)"/m)?.[1] !== lock.toolchain
      )
        throw Error('Native engine version/toolchain differs from its runtime lock');
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (
          /RUSTFLAGS$/.test(key) ||
          ['RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTC'].includes(key)
        )
          delete env[key];
      env.CARGO_TARGET_DIR = path.join(crate, 'target');
      env.CARGO_INCREMENTAL = '0';
      if (spec.staticCrt) env.RUSTFLAGS = '-C target-feature=+crt-static';
      if (platform === 'linux')
        env['CARGO_TARGET_' + spec.rust.toUpperCase().replace(/-/g, '_') + '_LINKER'] = 'musl-gcc';
      execute(
        'cargo',
        ['+' + lock.toolchain, 'build', '--release', '--locked', '--target', spec.rust],
        { cwd: crate, env },
      );
      const binary = path.join(crate, 'target', spec.rust, 'release', spec.binary);
      let signing = 'none';
      if (platform === 'darwin') {
        const identity = process.env.CIBYP_WALLET_SIGN_IDENTITY || '-';
        execute('/usr/bin/codesign', [
          '--force',
          '--sign',
          identity,
          ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp']),
          '--options',
          'runtime',
          binary,
        ]);
        execute('/usr/bin/codesign', ['--verify', '--strict', binary]);
        signing = expectedSigning;
      }
      if (sourceHash() !== fingerprint)
        throw Error('Native sources changed during compilation; rebuild the runtime');
      const result = stage(binary, directory, platform, arch, {
        sourceHash: fingerprint,
        signing,
        notices: thirdPartyNotices(spec.rust),
      });
      console.log(
        '[wallet-signer] Prepared verified native resource ' +
          spec.key +
          ' ' +
          result.manifest.sha256,
      );
      return result;
    })
    .finally(() => preparing.delete(key));
  preparing.set(key, task);
  return task;
}
module.exports = { prepareWalletSigner, sourceHash, stage };
if (require.main === module) {
  const args = process.argv.slice(2),
    value = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
  if (args.includes('--install-toolchain')) {
    const spec = target(value('--platform'), value('--arch'));
    execute('rustup', ['toolchain', 'install', lock.toolchain, '--profile', 'minimal']);
    execute('rustup', ['target', 'add', '--toolchain', lock.toolchain, spec.rust]);
  } else
    prepareWalletSigner(value('--platform'), value('--arch')).catch((error) => {
      console.error('[wallet-signer]', error.message);
      process.exitCode = 1;
    });
}
