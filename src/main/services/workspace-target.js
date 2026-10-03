/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { VmFs } = require('../vm/vm-fs');

/** Shared Code-OSS / headless workspace mapping, including external Git projects. */
async function resolveWorkspaceTarget(vm, directory, { local = false } = {}) {
  const location = vm.runtime.location === 'vm' && !vm.emergencyHost ? 'vm' : 'host';
  if (location === 'vm') {
    if (vm.instance?.state !== 'ready') await vm.start();
    const io = new VmFs({ vmService: vm });
    let mapped = io.resolveVmPath(directory || vm.runtime.vm.workspaceMount || '/workspace');
    if (local && directory && mapped.mapped === 'vm') mapped = { ok: false };
    if (!mapped.ok && directory) {
      const mounted = await vm.mountExternalDir(directory, { preserveGit: true });
      if (!mounted.ok) throw new Error(mounted.error);
      mapped = { ok: true, vm: mounted.vmRoot };
    }
    if (!mapped.ok) throw new Error(mapped.error);
    const uri = `vscode-remote://cibyp-vm+default${mapped.vm.split('/').map(encodeURIComponent).join('/')}`;
    const hostPath = local ? path.resolve(directory) : io.toHost(mapped.vm);
    return { location, path: mapped.vm, originalPath: directory, hostPath, uri };
  }
  if (!directory) return { location, path: '', uri: '' };
  const absolute = path.resolve(directory);
  if (!fs.statSync(absolute).isDirectory()) throw new Error('Workspace must be a directory');
  return {
    location,
    path: absolute,
    originalPath: directory,
    hostPath: absolute,
    uri: pathToFileURL(absolute).href,
  };
}

module.exports = { resolveWorkspaceTarget };
