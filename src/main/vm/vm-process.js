/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const { EventEmitter } = require('node:events');
const { VmFs } = require('./vm-fs');
const { shellQuote } = require('./vm-paths');

async function spawnVmProcess(service, { command, args = [], cwd, env = {} }) {
  const working = await service.prepareTerminalDirectory(cwd || '/workspace');
  const io = new VmFs({ vmService: service });
  const translate = (arg) => {
    if (typeof arg !== 'string') throw new Error('VM 命令参数必须是字符串');
    if (/^[A-Za-z]:[\\/]|^\\\\/.test(arg)) {
      const target = io.resolveVmPath(arg);
      if (!target.ok) throw new Error(target.error);
      return target.vm;
    }
    return arg;
  };
  command = translate(command);
  if (/\.(exe|cmd|bat)$/i.test(command))
    throw new Error(
      'VM 工具需要 Linux 命令，请在 MCP 配置中使用 node、npx、python3 或 VM 内可执行文件',
    );
  const variables = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid VM environment variable');
    return `${key}=${shellQuote(String(value))}`;
  });
  const { stream } = await service.instance.ssh.execStream(
    `cd ${shellQuote(working)} && exec env ${variables.join(' ')} ${[command, ...args.map(translate)].map(shellQuote).join(' ')}`,
  );
  const child = new EventEmitter();
  child.stdin = stream;
  child.stdout = stream;
  child.stderr = stream.stderr;
  child.killed = false;
  child.exitCode = null;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    stream.signal(signal.replace(/^SIG/, ''));
    if (signal === 'SIGKILL') stream.close();
    return true;
  };
  stream.on('error', (error) => child.emit('error', error));
  stream.on('close', (code) => {
    child.exitCode = code;
    child.emit('close', code);
  });
  return child;
}
module.exports = { spawnVmProcess };
