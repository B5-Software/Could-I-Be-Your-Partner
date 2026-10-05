/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VmFs } = require('./vm-fs');
const { shellQuote } = require('./vm-paths');
const deployed = new WeakMap();
const pluginDeployed = new WeakMap();

async function deploy(instance) {
  const identity = instance.ciServer?.instanceId;
  if (deployed.get(instance)?.identity !== identity || !deployed.has(instance)) {
    const pending = (async () => {
      const bundle = fs.readFileSync(path.join(__dirname, 'generated/guest-tool-worker.cjs'));
      const digest = crypto.createHash('sha256').update(bundle).digest('hex');
      const root = `/tmp/cibyp-tool-runtime-${digest}`;
      const checked = await instance.exec(
        `mkdir -p ${shellQuote(root)} && chmod 700 ${shellQuote(root)}`,
      );
      if (!checked.ok) throw new Error(checked.stderr || 'Cannot prepare guest tool runtime');
      const remote = `${root}/worker.cjs`;
      const sftp = await instance.sftp();
      await sftp.writeFile(remote, bundle);
      return { root, remote };
    })();
    deployed.set(instance, { identity, pending });
    pending.catch(() => deployed.delete(instance));
  }
  return deployed.get(instance).pending;
}

async function runGuestTool(service, channel, args, route) {
  if (!service.instance || service.instance.state !== 'ready') await service.start();
  const instance = service.instance;
  if (!instance || instance.state !== 'ready') throw new Error('虚拟机未就绪，工具不会回退到宿主');
  const io = new VmFs({ vmService: service });
  const vmArgs = [...args];
  for (const index of [
    ...(route.read || []),
    ...(route.writeFile || []),
    ...(route.writeDir || []),
  ]) {
    const raw = vmArgs[index] || ((route.writeDir || []).includes(index) && io.mountRoot());
    if (!raw) continue;
    const target = io.resolveVmPath(raw, { forWrite: (route.writeFile || []).includes(index) });
    if (!target.ok) throw new Error(target.error);
    vmArgs[index] = target.vm;
    if ((route.writeDir || []).includes(index)) {
      const result = await io.makeDirectory(target.vm);
      if (!result.ok) throw new Error(result.error);
    }
    if ((route.writeFile || []).includes(index)) {
      const result = await io.makeDirectory(path.posix.dirname(target.vm));
      if (!result.ok) throw new Error(result.error);
    }
  }
  const translate = (value, key = '') => {
    if (
      typeof value === 'string' &&
      (!route.pathKeys || route.pathKeys.includes(key)) &&
      (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'))
    ) {
      const target = io.resolveVmPath(value);
      if (!target.ok) throw new Error(target.error);
      return target.vm;
    }
    if (Array.isArray(value)) return value.map((item) => translate(item, key));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, translate(item, key)]),
      );
    return value;
  };
  for (const index of route.deep || []) vmArgs[index] = translate(vmArgs[index]);
  const { root, remote } = await deploy(instance);
  if (channel === 'eslint:lint' || channel === 'eslint:lintFile') {
    const version = require('eslint/package.json').version;
    const prepared = await instance.exec(
      `test -f ${shellQuote(root + '/node_modules/eslint/package.json')} || npm install --prefix ${shellQuote(root)} --ignore-scripts --no-audit --no-fund ${shellQuote('eslint@' + version)}`,
      { timeoutMs: 300000 },
    );
    if (!prepared.ok) throw new Error('VM ESLint 不可用: ' + prepared.stderr);
  }
  const id = crypto.randomUUID();
  const input = `${root}/${id}.json`;
  const output = `${root}/${id}-result.json`;
  const sftp = await instance.sftp();
  try {
    await sftp.writeFile(
      input,
      JSON.stringify({
        channel,
        args: vmArgs,
        settings: { theme: service.getSettings().theme },
        nativeDark: service.appearanceSync?.getSystemDark(),
      }),
    );
    const result = await instance.exec(
      `LANG=C.UTF-8 LC_ALL=C.UTF-8 node ${shellQuote(remote)} ${shellQuote(input)} ${shellQuote(output)}`,
      { timeoutMs: 300000 },
    );
    if (!result.ok) throw new Error(result.stderr || result.stdout || 'VM tool process failed');
    const response = JSON.parse((await sftp.readFile(output)).toString('utf8'));
    if (service.runtime.workspaceMode === 'shared' && response.ok !== false) {
      for (const raw of args.filter((value) => typeof value === 'string'))
        await service.pullExternalDir(raw);
      await service.syncWorkspace({ direction: 'pull', reason: 'guest-tool' });
    }
    return response;
  } finally {
    await instance.exec(`rm -f -- ${shellQuote(input)} ${shellQuote(output)}`).catch(() => {});
  }
}

async function runGuestPlugin(service, record, name, args, context) {
  const working = await service.prepareTerminalDirectory(context.cwd || '/workspace');
  const { root, remote } = await deploy(service.instance);
  const io = new VmFs({ vmService: service });
  const pluginRoot = `${root}/plugins/${crypto.createHash('sha256').update(record.id).digest('hex')}`;
  if (!pluginDeployed.has(service.instance)) pluginDeployed.set(service.instance, new Map());
  const cache = pluginDeployed.get(service.instance);
  const key = [
    service.instance.ciServer.instanceId,
    record.id,
    record.version,
    fs.statSync(record.entry).mtimeMs,
  ].join(':');
  if (!cache.has(key)) {
    const transferring = (async () => {
      await io.makeDirectory(pluginRoot);
      const { stream, done } = await service.instance.ssh.execStream(
        `tar -xf - -C ${shellQuote(pluginRoot)}`,
      );
      const source = require('tar').c({ cwd: record.installDir, follow: false }, ['.']);
      source.on('error', (error) => stream.destroy(error));
      stream.resume();
      source.pipe(stream);
      let timer;
      const result = await Promise.race([
        done,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            source.destroy();
            stream.close();
            reject(new Error('Plugin transfer timed out'));
          }, 60000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.code !== 0) throw new Error(result.stderr || 'Plugin transfer failed');
    })();
    cache.set(key, transferring);
    transferring.catch(() => cache.delete(key));
  }
  await cache.get(key);
  const shims = {
    cordis: ['vmShimCordis', require('@deepseek-ai/cordis')],
    'dsh-tools': ['vmShimTools', require('../ds-compat/shims/dsh-tools')],
    schemastery: ['vmShimSchema', require('@deepseek-ai/schemastery')],
    'dsh-llm': ['vmShimLlm', require('@deepseek-ai/dsh-llm')],
    'dsh-util-values': ['vmShimValues', require('@deepseek-ai/dsh-util-values')],
    'dsh-brand': ['vmShimBrand', require('@deepseek-ai/dsh-brand')],
    'dsh-scope': ['vmShimScope', require('@deepseek-ai/dsh-scope')],
  };
  for (const [moduleName, [exportName, exports]] of Object.entries(shims)) {
    const directory = `${pluginRoot}/node_modules/@deepseek-ai/${moduleName}`;
    await io.makeDirectory(directory);
    await io.writeBuffer(
      `${directory}/package.json`,
      Buffer.from(
        JSON.stringify({
          name: '@deepseek-ai/' + moduleName,
          main: 'index.js',
          type: 'commonjs',
          ...(moduleName === 'dsh-tools'
            ? {
                exports: {
                  '.': './index.js',
                  './schema': './index.js',
                  './json-schema': './index.js',
                  './testing': './index.js',
                  './types': './types.js',
                  './presentation': './types.js',
                  './src/schema.ts': './index.js',
                  './src/json-schema.ts': './index.js',
                  './src/ts-types.ts': './index.js',
                  './src/py-types.ts': './index.js',
                  './src/types.ts': './types.js',
                  './src/presentation.ts': './types.js',
                  './package.json': './package.json',
                },
              }
            : {}),
        }),
      ),
    );
    const bridge =
      `const shim=require(${JSON.stringify(remote)})[${JSON.stringify(exportName)}];module.exports=shim;\n` +
      Object.keys(exports)
        .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key))
        .map((key) => `exports.${key}=shim.${key};`)
        .join('\n');
    await io.writeBuffer(`${directory}/index.js`, Buffer.from(bridge));
    if (moduleName === 'dsh-tools')
      await io.writeBuffer(`${directory}/types.js`, Buffer.from('module.exports = {};\n'));
  }
  const entryRelative = path.relative(record.installDir, record.entry);
  if (entryRelative.startsWith('..') || path.isAbsolute(entryRelative))
    throw new Error('插件入口不在安装目录内');
  return runGuestTool(
    service,
    'ds:toolCall',
    [
      {
        id: record.id,
        name: record.name,
        config: record.config,
        entry: `${pluginRoot}/${entryRelative.split(path.sep).join('/')}`,
      },
      name,
      args,
      { ...context, cwd: working },
    ],
    { deep: [2] },
  );
}
module.exports = { runGuestTool, runGuestPlugin };
