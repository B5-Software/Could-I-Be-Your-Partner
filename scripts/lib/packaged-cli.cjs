/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

function patchPtyHelperPaths(source) {
  for (const name of ['app', 'node_modules']) {
    const original = `helperPath.replace('${name}.asar', '${name}.asar.unpacked')`;
    const replacement = `helperPath.replace(/${name}\\.asar(?!\\.unpacked)/g, '${name}.asar.unpacked')`;
    if (source.includes(original)) source = source.replace(original, replacement);
    else if (!source.includes(replacement))
      throw new Error('Unsupported node-pty helper path resolver');
  }
  return source;
}

async function preparePackagedCLI(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const platform = context.electronPlatformName;
  const directory = path.join(resources, 'cli');
  const cliRoot = path.join(resources, 'app.asar.unpacked');
  const arch = require('builder-util').Arch[context.arch];
  let name =
    platform === 'linux'
      ? context.packager.executableName
      : context.packager.appInfo.productFilename;
  if (platform === 'win32') name += '.exe';
  let executable = platform === 'darwin' ? path.join('../MacOS', name) : path.join('..', name);
  if (platform === 'linux') {
    // AppImage's AppRun and the desktop file call this wrapper too, so a
    // headless launch reaches Node directly rather than Electron's fake TTY.
    const entry = path.join(context.appOutDir, name);
    const gui = entry + '-gui';
    await fs.promises.rename(entry, gui);
    executable += '-gui';
    await fs.promises.writeFile(
      entry,
      `#!/bin/sh\nentry=$(readlink -f -- "$0") || exit 1\ndirectory=$(dirname -- "$entry")\nexec "$directory/resources/cli/cibyp" "$@"\n`,
      { mode: 0o755 },
    );
  }
  const marker = JSON.parse(fs.readFileSync(path.join(resources, 'node/runtime.json'), 'utf8'));
  if (marker.platform !== platform || marker.arch !== arch)
    throw new Error('CLI runtime target does not match the App');
  await fs.promises.writeFile(
    path.join(directory, 'runtime.json'),
    JSON.stringify({ executable, version: marker.version, platform, arch }, null, 2) + '\n',
  );
  for (const file of [
    'bin/cibyp-tui.js',
    'bin/cibyp.js',
    'src/main/main.js',
    'src/tui/launcher.js',
    'package.json',
    'node_modules/node-pty/package.json',
    'node_modules/express/package.json',
  ]) {
    if (!fs.existsSync(path.join(cliRoot, file)))
      throw new Error(`Unpacked CLI runtime missing: ${file}`);
  }
  if (platform !== 'win32') {
    for (const name of ['cibyp', 'cibyp-tui'])
      await fs.promises.chmod(path.join(directory, name), 0o755);
    // node-pty assumes an Electron virtual ASAR path. Pure Node resolves the
    // physical directory, which must not become app.asar.unpacked.unpacked.
    const moduleFile = path.join(cliRoot, 'node_modules/node-pty/lib/unixTerminal.js');
    await fs.promises.writeFile(
      moduleFile,
      patchPtyHelperPaths(await fs.promises.readFile(moduleFile, 'utf8')),
    );
    if (platform === 'darwin') {
      for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`]) {
        const helper = path.join(cliRoot, 'node_modules/node-pty', directory, 'spawn-helper');
        if (fs.existsSync(helper)) await fs.promises.chmod(helper, 0o755);
      }
    }
  }
  // Run the installed entry point with its own Node binary. This catches ASAR
  // resolution, missing CLI files and runtime/architecture errors in every CI build.
  if (platform === process.platform && arch === process.arch) {
    const node = path.join(resources, 'node', platform === 'win32' ? 'node.exe' : 'node');
    const result = spawnSync(node, [path.join(directory, 'launch.cjs'), 'tui', '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    const version = require(path.join(cliRoot, 'package.json')).version.split('+')[0];
    if (result.error || result.status !== 0 || result.stdout.trim() !== version)
      throw new Error(
        `Packaged TUI version probe failed: ${result.stderr || result.error || result.stdout}`,
      );
    const pty = spawnSync(
      node,
      [
        '-e',
        `const p=require(${JSON.stringify(path.join(cliRoot, 'node_modules/node-pty'))});const t=p.spawn(process.execPath,['--version'],{env:process.env});let o='';t.onData(x=>o+=x);t.onExit(x=>process.exit(x.exitCode!==0||!o.includes('v${marker.version}')?1:0));`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    if (pty.error || pty.status !== 0)
      throw new Error(`Packaged Node PTY probe failed: ${pty.stderr || pty.error}`);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-packaged-check-'));
    if (
      path.dirname(profile) !== path.resolve(os.tmpdir()) ||
      !path.basename(profile).startsWith('cibyp-packaged-check-')
    )
      throw new Error('Unsafe package check profile');
    try {
      fs.mkdirSync(path.join(profile, 'data'));
      fs.writeFileSync(
        path.join(profile, 'data/settings.json'),
        JSON.stringify({
          onboardingCompleted: true,
          runtime: { location: 'host' },
          notifications: { enabled: false },
          updates: { autoCheckEnabled: false },
          voice: { wakeEnabled: false },
          closeToTray: 'never',
          trayEnabled: false,
          automation: { http: { port: 0 } },
        }),
      );
      const runtime = spawnSync(node, [path.join(directory, 'self-check.cjs')], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 45000,
        env: {
          ...process.env,
          CIBYP_USER_DATA: profile,
          CIBYP_DOCUMENTS: path.join(profile, 'documents'),
        },
      });
      if (
        runtime.error ||
        runtime.status !== 0 ||
        !runtime.stdout.includes('PACKAGED_RUNTIME_READY')
      )
        throw new Error(
          `Packaged Agent bootstrap failed: ${runtime.stderr || runtime.error || runtime.stdout}`,
        );
      const tty = spawnSync(
        process.execPath,
        [
          '--test',
          '--test-force-exit',
          path.resolve(__dirname, '../../tests/integration/tui-tty.test.cjs'),
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 75000,
          env: {
            ...process.env,
            CIBYP_TEST_PACKAGED_RESOURCES: resources,
            CIBYP_TEST_COMMAND: 'gui',
            CIBYP_NO_GUI: '1',
          },
        },
      );
      if (tty.error || tty.status !== 0)
        throw new Error(
          `Packaged terminal interaction failed: ${tty.stdout}\n${tty.stderr || tty.error}`,
        );
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
  console.log(
    `[after-pack] GUI/TUI commands and Node.js ${marker.version} verified (${platform}-${arch})`,
  );
}

module.exports = { preparePackagedCLI, patchPtyHelperPaths };
