/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const nodePath = require('node:path');
const { VmFs } = require('./vm-fs');

function createToolFiles({ fs, getVmService, recoveryDirectory }) {
  const service = () => (typeof getVmService === 'function' ? getVmService() : null);
  const active = () => require('./tool-location').isVmOperation(service);
  const guest = () => new VmFs({ vmService: service() });
  const resolve = (raw) => {
    if (!active()) return String(raw);
    const value = String(raw).replace(/\\/g, '/');
    const target = guest().resolveVmPath(value);
    if (!target.ok) throw new Error(target.error);
    return target.vm;
  };
  return {
    active,
    resolve,
    recovery: () => (active() ? `${guest().mountRoot()}/.cibyp-recovery` : recoveryDirectory),
    exists: async (raw) => (active() ? guest().exists(resolve(raw)) : fs.existsSync(raw)),
    stat: async (raw) => {
      if (!active()) return fs.promises.stat(raw);
      const info = await guest().stat(resolve(raw));
      if (!info) throw new Error('VM 文件不存在: ' + raw);
      return { ...info, isFile: () => !info.isDirectory };
    },
    read: async (raw, encoding) => {
      const buffer = active()
        ? await guest().readBuffer(resolve(raw))
        : await fs.promises.readFile(raw);
      return encoding ? buffer.toString(encoding) : buffer;
    },
    write: async (raw, content, encoding) => {
      if (active())
        return guest().writeBuffer(
          resolve(raw),
          Buffer.isBuffer(content) ? content : Buffer.from(String(content), encoding || 'utf8'),
        );
      return fs.promises.writeFile(raw, content, encoding);
    },
    mkdir: async (raw) => {
      if (!active()) return fs.promises.mkdir(raw, { recursive: true });
      const result = await guest().makeDirectory(resolve(raw));
      if (!result.ok) throw new Error(result.error);
    },
    join: (...parts) =>
      active()
        ? nodePath.posix.join(...parts.map((part) => String(part).replace(/\\/g, '/')))
        : nodePath.join(...parts),
    dirname: (raw) => (active() ? nodePath.posix.dirname(resolve(raw)) : nodePath.dirname(raw)),
  };
}
module.exports = { createToolFiles };
