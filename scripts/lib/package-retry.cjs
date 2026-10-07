/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isTransientDiskImageError(output) {
  return /hdiutil:\s*(?:create|attach|detach|convert) failed\s*-\s*Resource busy\b/i.test(output);
}

function prepackagedMacArgs(args, projectRoot, pkg) {
  if (!args.includes('--mac') || args.some((arg) => /^--(?:win|linux|universal)/.test(arg))) {
    return null;
  }
  // Only retry a single, known architecture with the app produced by this invocation.
  const architectures = ['x64', 'arm64'].filter((arch) => args.includes(`--${arch}`));
  if (
    architectures.length !== 1 ||
    args.some((arg) => /prepackaged|directories\.output/.test(arg))
  ) {
    return null;
  }
  const arch = architectures[0];
  const output = pkg.build?.directories?.output || 'dist';
  const appDir = path.resolve(projectRoot, output, arch === 'x64' ? 'mac' : 'mac-arm64');
  const productName = pkg.build?.productName || pkg.productName || pkg.name;
  const appPath = path.join(appDir, `${productName}.app`);
  if (!fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))) {
    return null;
  }
  // Preserve targets, architecture and build metadata. Recreate all requested installers
  // so an interrupted concurrent ZIP/PKG build cannot be mistaken for a completed one.
  return [...args, '--prepackaged', appPath];
}

async function packageWithRetry({
  args,
  projectRoot,
  pkg,
  run,
  platform = process.platform,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.warn,
}) {
  let currentArgs = args;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await run(currentArgs);
    if (result.code === 0 || result.signal || attempt === 2) return result.code;
    if (platform !== 'darwin' || !isTransientDiskImageError(result.output)) return result.code;
    const retryArgs = prepackagedMacArgs(args, projectRoot, pkg);
    if (!retryArgs) return result.code;
    const delay = (attempt + 1) * 10000;
    log(
      `[package] hdiutil is busy; retrying installers from the packaged app in ${delay / 1000}s (${attempt + 2}/3)`,
    );
    await sleep(delay);
    currentArgs = retryArgs;
  }
  return 1;
}

module.exports = { isTransientDiskImageError, prepackagedMacArgs, packageWithRetry };
