/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { publicSettings, messageView } = require('./remote-projection');
const {
  RemoteService,
  ToolRegistry,
  DeviceGateway,
  Credentials,
  RemoteError,
  publicValue,
  atomic,
  read,
  identifier,
} = require('../../../packages/remote');
function createRemoteControl({
  runtime,
  eventBus,
  bootState = () => ({ ready: true }),
  storageDir,
  product = { name: 'Could I Be Your Partner', version: require('../../../package.json').version },
  capabilities = [],
}) {
  const file = (name) => (storageDir ? path.join(storageDir, 'remote', name + '.json') : undefined);
  const service = new RemoteService({
    identityFile: file('identity'),
    operationsFile: file('operations'),
    product,
    capabilities: [
      'session.chat',
      'session.code',
      'session.babe',
      'settings',
      'tools',
      'devices',
      ...capabilities,
    ],
  });
  service.tools = new ToolRegistry({ events: service.events });
  service.tools.attach(service);
  runtime.setExternalToolService?.(service);
  service.devices = new DeviceGateway({
    file: file('devices'),
    tools: service.tools,
    events: service.events,
    bootId: service.bootId,
    instanceId: service.instanceId,
  });
  service.devices.attach(service);
  service.credentials = new Credentials(file('clients'));
  service.credentials.attach(service);
  const attachments = read(file('attachments'), {});
  const attachmentView = ({ path: _path, ...value }) => value;
  service.capabilities.push('attachment.transfer');
  service.blobs = {
    async upload(p, principal, bytes) {
      identifier(p.operationId, 'operationId');
      key(p);
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length > 8 * 1024 * 1024 ||
        typeof p.name !== 'string' ||
        p.name.length > 240
      )
        throw new RemoteError('INVALID_PARAMS');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (p.sha256 !== sha256)
        throw new RemoteError('INVALID_PARAMS', 'Attachment SHA-256 mismatch');
      return service.operations.run(
        principal.id,
        p.operationId,
        'attachment.upload',
        { ...p, sha256 },
        async () => {
          const value = await runtime.uploadAttachment(p.sessionId, {
            name: p.name,
            type: p.type || '',
            data: bytes.toString('base64'),
          });
          const attachmentId = crypto.randomUUID();
          const saved = {
            ...value,
            attachmentId,
            sessionId: p.sessionId,
            sha256,
            createdAt: Date.now(),
          };
          attachments[attachmentId] = saved;
          atomic(file('attachments'), attachments);
          return attachmentView(saved);
        },
      );
    },
    async download(p) {
      const value = attachments[identifier(p.attachmentId)];
      if (!value) throw new RemoteError('INVALID_PARAMS', 'Unknown attachment');
      const result = checked(await runtime.downloadAttachment(value.path));
      const bytes = Buffer.from(result.bytes);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== value.sha256)
        throw new RemoteError('REVISION_CONFLICT', 'Attachment was changed');
      return { name: value.name, bytes, sha256: value.sha256 };
    },
  };
  service.register('attachment.list', 'files.read', (p) =>
    page(
      Object.values(attachments)
        .filter((a) => a.sessionId === key(p))
        .map(attachmentView),
      p,
    ),
  );
  service.register('attachment.get', 'files.read', (p) => {
    const value = attachments[identifier(p.attachmentId)];
    if (!value) throw new RemoteError('INVALID_PARAMS');
    return attachmentView(value);
  });
  let revision = read(file('settings-revision'), 0);
  const key = (p) => identifier(p.sessionId, 'sessionId');
  const checked = (value) => {
    if (value?.ok === false)
      throw new RemoteError(
        'OPERATION_FAILED',
        String(value.error || 'Operation failed').slice(0, 300),
      );
    return value;
  };
  function page(items, p) {
    const offset = p.offset ?? 0,
      limit = p.limit ?? 50;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new RemoteError('INVALID_PARAMS');
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null,
    };
  }
  service.register('system.health', 'system.read', () => ({
    boot: bootState(),
    pid: process.pid,
    platform: process.platform,
  }));
  service.register('session.list', 'sessions.read', (p) => ({
    ...page(
      runtime.listSessions().filter((s) => !['subagent', 'settings-assistant'].includes(s.profile)),
      p,
    ),
    cursor: service.events.cursor(),
  }));
  service.register('session.get', 'sessions.read', (p) => {
    const session = runtime.getSession(key(p));
    if (!session) throw new RemoteError('INVALID_PARAMS', 'Unknown session');
    return {
      session,
      stats: runtime.getStats(p.sessionId),
      interaction: runtime.getSessionDetails(p.sessionId)?.pendingInteraction,
      cursor: service.events.cursor(),
    };
  });
  service.register('session.messages', 'sessions.read', (p) => ({
    ...page((runtime.getSessionDetails(key(p))?.messages || []).map(messageView), {
      ...p,
      limit: Math.min(p.limit ?? 10, 10),
    }),
    cursor: service.events.cursor(),
  }));
  service.register('session.message', 'sessions.read', (p) => {
    const messages = runtime.getSessionDetails(key(p))?.messages || [];
    if (!Number.isSafeInteger(p.messageIndex) || !messages[p.messageIndex])
      throw new RemoteError('INVALID_PARAMS');
    const json = JSON.stringify(publicValue(messages[p.messageIndex])),
      sha256 = crypto.createHash('sha256').update(json).digest('hex');
    if (p.sha256 && p.sha256 !== sha256)
      throw new RemoteError('REVISION_CONFLICT', 'Message changed; restart reading');
    const offset = p.offset ?? 0,
      limit = p.limit ?? 16384;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > json.length ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 16384
    )
      throw new RemoteError('INVALID_PARAMS');
    return {
      encoding: 'json',
      sha256,
      totalChars: json.length,
      offset,
      text: json.slice(offset, offset + limit),
      nextOffset: offset + limit < json.length ? offset + limit : null,
    };
  });
  service.register(
    'session.create',
    'sessions.write',
    (p) =>
      runtime.getSession(
        runtime.createSession({
          mode: p.mode,
          workspacePath: p.workspacePath,
          key: p.sessionId == null ? undefined : identifier(p.sessionId),
          minimalMode: p.minimalMode,
        }).key,
      ),
    { write: true },
  );
  service.register(
    'session.initialize',
    'sessions.write',
    async (p) => {
      await runtime.initialize({ key: key(p) });
      return runtime.getSession(p.sessionId);
    },
    { write: true },
  );
  service.register(
    'session.submit',
    'sessions.write',
    async (p) => {
      if (
        typeof p.text !== 'string' ||
        p.text.length > 131072 ||
        !Array.isArray(p.attachments || []) ||
        (p.attachments || []).length > 16
      )
        throw new RemoteError('INVALID_PARAMS');
      const files = (p.attachments || []).map((id) => {
        const value = attachments[identifier(id)];
        if (!value || value.sessionId !== key(p))
          throw new RemoteError('FORBIDDEN', 'Attachment belongs to a different session');
        return value;
      });
      return checked(await runtime.submitMessage(key(p), p.text, files));
    },
    { write: true },
  );
  for (const method of ['stop', 'undo', 'close'])
    service.register('session.' + method, 'sessions.write', (p) => runtime[method](key(p)), {
      write: true,
    });
  service.register(
    'session.title',
    'sessions.write',
    (p) => runtime.setTitle(key(p), String(p.title || '').slice(0, 500)),
    { write: true },
  );
  service.register(
    'workspace.bind',
    'workspace.write',
    async (p) => checked(await runtime.setWorkspace(key(p), p.path, { create: !p.path })),
    { write: true },
  );
  service.register('workspace.list', 'workspace.read', (p) =>
    runtime.listLocalWorkspaceDirectories(p.path),
  );
  service.register('history.list', 'sessions.read', async (p) =>
    page(await runtime.listHistory(p.mode, p.workspacePath), p),
  );
  service.register(
    'history.open',
    'sessions.write',
    async (p) => checked(await runtime.openHistory(key(p), identifier(p.historyId))),
    { write: true },
  );
  service.register(
    'history.delete',
    'sessions.write',
    (p) => runtime.deleteHistory(p.mode, identifier(p.historyId), p.workspacePath),
    { write: true },
  );
  service.register(
    'interaction.answer',
    'interactions.answer',
    (p) => {
      const interaction = runtime.getSessionDetails(key(p))?.pendingInteraction;
      if (!interaction || interaction.id !== p.interactionId || interaction.revision !== p.revision)
        throw new RemoteError('REVISION_CONFLICT', 'Interaction is no longer pending');
      if (interaction.kind === 'questions' && p.response !== false && !Array.isArray(p.answers))
        throw new RemoteError('INVALID_PARAMS', 'Question answers are required');
      return runtime.respond(
        p.sessionId,
        interaction.kind === 'questions' && p.response !== false
          ? { answers: p.answers }
          : p.response,
      );
    },
    { write: true },
  );
  service.register('settings.catalog', 'settings.read', () => runtime.getSettingsCatalog());
  service.register('settings.get', 'settings.read', async () => ({
    revision,
    values: publicSettings(await runtime.getSettings()),
  }));
  let changing = false;
  async function saveSettings(p, privateWrite) {
    if (changing || p.expectedRevision !== revision) throw new RemoteError('REVISION_CONFLICT');
    if (!p.changes || typeof p.changes !== 'object' || Array.isArray(p.changes))
      throw new RemoteError('INVALID_PARAMS');
    if (!privateWrite && JSON.stringify(publicSettings(p.changes)) !== JSON.stringify(p.changes))
      throw new RemoteError('FORBIDDEN', 'Use the private settings interface for secrets');
    changing = true;
    try {
      checked(await runtime.saveSettings(p.changes));
      revision++;
      atomic(file('settings-revision'), revision);
      return { revision };
    } finally {
      changing = false;
    }
  }
  service.register('settings.patch', 'settings.write', (p) => saveSettings(p, false), {
    write: true,
  });
  service.register('settings.privatePatch', 'secrets.write', (p) => saveSettings(p, true), {
    write: true,
  });
  for (const [method, action] of [
    ['status', 'updatesStatus'],
    ['check', 'updatesCheck'],
    ['download', 'updatesStart'],
    ['install', 'updatesInstall'],
  ]) {
    service.register(
      'update.' + method,
      method === 'status' ? 'system.read' : 'updates.manage',
      async (p) => {
        if (action === 'updatesInstall' && p.confirm !== true)
          throw new RemoteError('FORBIDDEN', 'Explicit installation confirmation required');
        const result = await runtime.api?.[action]?.();
        if (result === undefined)
          throw new RemoteError('CAPABILITY_UNAVAILABLE', 'This host does not expose updates');
        return checked(result);
      },
      { write: method !== 'status' },
    );
  }
  service.register('todo.get', 'sessions.read', () => runtime.getTodos());
  service.register('todo.toggle', 'sessions.write', (p) => runtime.toggleTodo(p.id), {
    write: true,
  });
  service.dispose = eventBus.addSink((channel, payload) => {
    if (channel === 'settings:changed' && !changing) {
      revision++;
      atomic(file('settings-revision'), revision);
    }
    if (/^(?:agent:session-event|settings:changed|todo:state|updates:state)$/.test(channel))
      service.events.publish(
        channel,
        channel === 'settings:changed' ? { revision, values: publicSettings(payload) } : payload,
      );
  });
  service.close = () => {
    service.dispose();
    service.devices.close();
  };
  return service;
}
module.exports = { createRemoteControl };
