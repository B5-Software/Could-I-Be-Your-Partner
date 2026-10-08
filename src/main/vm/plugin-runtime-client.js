/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { RpcPeer } = require('../ds-compat/rpc-peer');
const { shellQuote } = require('./vm-paths');
const residents = new WeakMap();
function guestSettings(settings = {}) {
  // Models/authentication remain on the host. Only public route metadata crosses SSH.
  const route = (llm) =>
    Object.fromEntries(
      Object.entries(llm || {}).filter(([key]) =>
        [
          'id',
          'name',
          'model',
          'provider',
          'enabled',
          'contextLength',
          'maxResponseTokens',
          'reasoningEffort',
        ].includes(key),
      ),
    );
  return {
    sandbox: settings.sandbox,
    theme: settings.theme,
    terminal: settings.terminal?.vm || {},
    llm: { ...route(settings.llm), pool: (settings.llm?.pool || []).map(route) },
  };
}
function agents(options, service) {
  const io = service && new (require('./vm-fs').VmFs)({ vmService: service });
  return [...(options.agentsService?.metadata.values() || [])].map((entry) => {
    if (!entry.cwd || !io) return entry;
    const result = io.resolveVmPath(entry.cwd);
    return { ...entry, cwd: result.ok ? result.vm : undefined };
  });
}
async function connect(service, remote, options) {
  const instance = service.instance,
    identity = instance.ciServer?.instanceId;
  let slot = residents.get(instance);
  if (slot && (slot.identity !== identity || slot.remote !== remote || slot.closed)) {
    await slot.pending.then((r) => r.dispose()).catch(() => {});
    residents.delete(instance);
    slot = null;
  }
  if (slot) return slot.pending;
  slot = { identity, remote, closed: false };
  residents.set(instance, slot);
  slot.pending = (async () => {
    const { stream, done } = await instance.ssh.execStream(
      `LANG=C.UTF-8 LC_ALL=C.UTF-8 node ${shellQuote(remote)} --plugin-daemon`,
      { maxStderrBytes: 65536 },
    );
    const unsub = [];
    const peer = new RpcPeer(stream, stream, {
      async request(method, args, signal) {
        if (method === 'invoke') {
          if (
            !['llm:chat', 'llm:chatStream', 'web:search', 'web:fetch', 'codeoss:language'].includes(
              args[0],
            )
          )
            throw new Error('Unsupported host plugin capability: ' + args[0]);
          const abort = () => {
            if (args[2]?.requestId) options.cancelRequest?.({ requestId: args[2].requestId });
          };
          if (args[0].startsWith('llm:')) args[2] = { ...args[2], signal };
          signal.addEventListener('abort', abort, { once: true });
          try {
            signal.throwIfAborted();
            return await options.invoke(...args);
          } finally {
            signal.removeEventListener('abort', abort);
          }
        }
        if (method === 'cancelRequest' && args?.requestId) return options.cancelRequest?.(args);
        if (
          method.startsWith('backend:') &&
          !options.transport?.handles?.(args.channel) &&
          ![
            'ds:agentCreate',
            'ds:agentResume',
            'ds:pluginAgentMessage',
            'ds:approvalRequest',
            'ds:questionsRequest',
            'ds:agentClose',
            'ds:compact',
          ].includes(args.channel)
        )
          throw new Error('Unsupported Agent capability');
        if (method === 'backend:request')
          return options.transport.request(args.channel, args.payload, undefined, signal);
        if (method === 'backend:send') return options.transport.send(args.channel, args.payload);
        if (method === 'skills:list') return options.skills?.().list(args) || [];
        if (method === 'skills:get') return options.skills?.().get(args.name, args.options);
        if (method === 'plugin:config') return options.setPluginConfig(args.id, args.value);
        throw new Error('Unsupported host plugin method: ' + method);
      },
      close: () => {
        slot.closed = true;
        for (const stop of unsub) stop();
        try {
          stream.close();
        } catch {}
      },
    });
    for (const name of ['llm:stream-chunk', 'llm:retry'])
      if (options.subscribe)
        unsub.push(
          options.subscribe(name, (value) => {
            if (!peer.closed) peer.emit(name, value);
          }),
        );
    done
      .then((result) =>
        peer.close(new Error(result.stderr?.slice(-1000) || 'VM plugin runtime exited')),
      )
      .catch((error) => peer.close(error));
    try {
      await peer.ask(
        'init',
        {
          dataDir:
            '/home/cibyp/.local/share/cibyp/plugin-runtime/' +
            require('node:crypto')
              .createHash('sha256')
              .update(options.dataDir || 'default')
              .digest('hex')
              .slice(0, 24),
          settings: guestSettings(await options.getSettings?.()),
          agents: agents(options, service),
        },
        { timeoutMs: 30000 },
      );
    } catch (error) {
      peer.close(error);
      throw error;
    }
    return {
      peer,
      async dispose() {
        if (!peer.closed) await peer.ask('dispose', null, { timeoutMs: 5000 }).catch(() => {});
        peer.close();
      },
      closed: () => peer.closed,
    };
  })();
  slot.pending.catch(() => {
    slot.closed = true;
    if (residents.get(instance) === slot) residents.delete(instance);
  });
  return slot.pending;
}
async function existing(service) {
  const slot = residents.get(service?.instance);
  return slot && !slot.closed ? slot.pending : null;
}
async function notify(service, name, value) {
  const runtime = await existing(service);
  if (runtime && !runtime.peer.closed) runtime.peer.emit(name, value);
}
async function unload(service, id) {
  const runtime = await existing(service);
  if (runtime) await runtime.peer.ask('unload', id);
}
async function augment(service, messages, options) {
  const runtime = await existing(service);
  if (!runtime) return { messages, options };
  const result = await runtime.peer.ask(
    'augment',
    { messages, options: { ...options, signal: undefined } },
    { signal: options.signal },
  );
  return { ...result, options: { ...result.options, signal: options.signal } };
}
async function surfaceTool(service, wire, sessionKey) {
  const runtime = await existing(service);
  return runtime ? runtime.peer.ask('surface-tool', { wire, sessionKey }) : null;
}
function translatePaths(io, value, key = '') {
  // Translate declared path-bearing fields, never commands or message bodies.
  if (
    typeof value === 'string' &&
    /^(?:paths?|file_path|filename|cwd|workdir|repoDir|workspaceRoot|directory|dir)$/i.test(key) &&
    (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'))
  ) {
    const target = io.resolveVmPath(value);
    if (!target.ok) throw new Error(target.error);
    return target.vm;
  }
  if (Array.isArray(value)) return value.map((item) => translatePaths(io, item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, translatePaths(io, item, name)]),
    );
  return value;
}
async function busy(service, id) {
  const runtime = await existing(service);
  return runtime ? runtime.peer.ask('plugin-busy', id) : false;
}
async function turnStopping(service, id) {
  const runtime = await existing(service);
  return runtime ? runtime.peer.ask('turn-stopping', id) : { contexts: [] };
}
async function dispose(service) {
  const slot = residents.get(service?.instance);
  if (!slot) return;
  residents.delete(service.instance);
  await slot.pending.then((r) => r.dispose()).catch(() => {});
}
module.exports = {
  connect,
  notify,
  unload,
  augment,
  turnStopping,
  surfaceTool,
  translatePaths,
  busy,
  dispose,
  guestSettings,
  agents,
};
