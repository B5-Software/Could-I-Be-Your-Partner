/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveWorkspaceTarget } = require('../../src/main/services/workspace-target');
const register = require('../../src/main/ipc/workspaces');

test('TUI and Code-OSS use the same external VM project identity and preserve the local path', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-workspace-target-'));
  try {
    const mounts = new Map();
    const vm = {
      runtime: { location: 'vm', workspaceMode: 'shared', vm: { workspaceMount: '/workspace' } },
      instance: { state: 'ready' },
      _externMounts: mounts,
      mountExternalDir: async (host, options) => {
        assert.equal(options.preserveGit, true);
        mounts.set(host, '/workspace/_external/project-identity');
        return { ok: true, vmRoot: mounts.get(host) };
      },
      toHostPath: (value) => (value === '/workspace/_external/project-identity' ? directory : null),
    };
    const tui = await resolveWorkspaceTarget(vm, directory, { local: true });
    const gui = await resolveWorkspaceTarget(vm, directory);
    assert.equal(tui.path, '/workspace/_external/project-identity');
    assert.equal(tui.hostPath, directory);
    assert.equal(gui.path, tui.path);
    assert.equal(gui.uri, tui.uri);
    assert.ok(!tui.path.includes(':'));
    vm.emergencyHost = true;
    assert.equal((await resolveWorkspaceTarget(vm, directory)).path, directory);
    const file = path.join(directory, 'file');
    fs.writeFileSync(file, 'content');
    await assert.rejects(resolveWorkspaceTarget(vm, file), /directory/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workspace IPC creates fresh hash directories, browses host folders and exports through the VM mapping', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-workspace-ipc-'));
  const handlers = new Map();
  const calls = [];
  const vm = {
    runtime: { location: 'host', workspaceMode: 'shared', vm: { workspaceMount: '/workspace' } },
    instance: { state: 'ready' },
    _externMounts: new Map(),
    externalPair: () =>
      vm._externMounts.size ? { vmMount: '/workspace/_external/project-identity' } : null,
    mountExternalDir: async (host) => {
      vm._externMounts.set(host, '/workspace/_external/project-identity');
      return { ok: true, vmRoot: '/workspace/_external/project-identity' };
    },
    toHostPath: () => directory,
    prepareTerminalDirectory: async (selected) => calls.push(['prepare', selected]),
    pullExternalDir: async (selected) => (calls.push(['pull', selected]), { ok: true, pulled: 1 }),
  };
  register({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    vmService: vm,
    path,
    fs,
    app: { getPath: () => directory },
    workspacesBaseDir: directory,
    getSettings: () => ({ runtime: vm.runtime }),
  });
  try {
    const one = await handlers.get('workspace:resolve')({}, null);
    const two = await handlers.get('workspace:resolve')({}, null);
    assert.equal(one.ok, true);
    assert.equal(one.hostPath, one.path);
    assert.match(path.basename(one.path), /^[a-f0-9]{16}$/);
    assert.notEqual(one.path, two.path);
    assert.ok(fs.statSync(one.path).isDirectory());
    fs.mkdirSync(path.join(directory, '项目'));
    fs.writeFileSync(path.join(directory, 'file.txt'), 'not a directory');
    const browse = await handlers.get('workspace:listLocalDirectories')({}, directory);
    assert.equal(browse.ok, true);
    assert.ok(browse.directories.some((entry) => entry.name === '项目'));
    assert.ok(!browse.directories.some((entry) => entry.name === 'file.txt'));
    assert.equal(
      (await handlers.get('workspace:listLocalDirectories')({}, path.join(directory, 'missing')))
        .ok,
      false,
    );
    vm.runtime.location = 'vm';
    const target = await handlers.get('workspace:resolve')({}, directory, { local: true });
    assert.equal(target.path, '/workspace/_external/project-identity');
    assert.deepEqual(calls.at(-1), ['prepare', directory]);
    const exported = await handlers.get('workspace:sync')({}, target.path, target.hostPath);
    assert.equal(exported.pulled, 1);
    assert.deepEqual(calls.at(-1), ['pull', target.path]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
