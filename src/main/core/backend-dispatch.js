/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createIpcDispatch } = require('./ipc-dispatch');

// The preload is the single capability declaration for every frontend. Never
// expose arbitrary properties of the runtime, Electron, or the IPC registry.
function createBackendDispatch({ runtime, ipcMain, eventBus, desktop, shutdown, bootState }) {
  const source = fs
    .readdirSync(path.join(__dirname, '../../preload'))
    .filter((file) => file === 'preload.js' || file.endsWith('-preload.js'))
    .map((file) => fs.readFileSync(path.join(__dirname, '../../preload', file), 'utf8'))
    .join('\n');
  const channels = new Set(
    [...source.matchAll(/ipcRenderer\.(?:invoke|send)\(['"]([^'"]+)['"]/g)].map((m) => m[1]),
  );
  const ipc = createIpcDispatch({
    ipcMain,
    publishEvent: (c, p) => eventBus.publish(c, p),
    subscribe: (c, f) => eventBus.subscribe(c, f),
  });
  const methods = new Set([
    'getSettings',
    'saveSettings',
    'getSystemTheme',
    'getLanguage',
    'setLanguage',
    'listSessions',
    'getSession',
    'getSessionDetails',
    'getStats',
    'getSubscriptionUsage',
    'getTodos',
    'toggleTodo',
    'openCurrentDirectory',
    'openVmDesktop',
    'setTitle',
    'sendMessage',
    'submitMessage',
    'inject',
    'stop',
    'undo',
    'deleteTurn',
    'close',
    'respond',
    'answerQuestions',
    'setMinimalMode',
    'setWorkspace',
    'syncWorkspace',
    'listLocalWorkspaceDirectories',
    'listHistory',
    'getHistory',
    'deleteHistory',
    'renameHistory',
    'openHistory',
    'getView',
    'initialize',
    'agentAction',
    'configureSession',
    'prepareWorkspace',
    'uploadAttachment',
  ]);
  return async function dispatch({ method, args = [] } = {}) {
    if (!Array.isArray(args) || args.length > 30) throw new Error('Invalid arguments');
    if (method === 'snapshot')
      return {
        sessions: runtime.listSessions(),
        views: Object.fromEntries(
          runtime.listSessions().map((s) => [s.key, runtime.getView(s.key)]),
        ),
        boot: bootState?.() || { ready: true },
        platform: process.platform,
        pid: process.pid,
      };
    if (method === 'settings:catalog')
      return require('./settings-catalog').settingsCatalog(await runtime.getSettings());
    if (method === 'chat:appearance') {
      const settings = await runtime.getSettings();
      const encode = async (profile = {}) => {
        const avatar = profile.avatar
          ? (await ipc.invoke('avatar:encodeFile', profile.avatar))?.dataUrl || ''
          : '';
        const frame =
          profile.avatarFrame && /^[\w-]+$/.test(profile.avatarFrame)
            ? (await ipc.invoke('avatar-frames:get', profile.avatarFrame))?.content || ''
            : '';
        return { name: profile.name || '', avatar, frame };
      };
      const [user, ai, babe] = await Promise.all([
        encode(settings.userProfile),
        encode(settings.aiPersona),
        encode(settings.babe),
      ]);
      return { user, ai, babe, theme: settings.theme, animations: settings.animations !== false };
    }
    if (method === 'boot:state') return bootState?.() || { ready: true };
    if (method === 'desktop:open')
      return desktop ? desktop() : { ok: false, error: 'No graphical environment available' };
    if (method === 'backend:shutdown') return shutdown?.() || { ok: false };
    if (method === 'createSession') {
      const session = runtime.createSession(args[0]);
      return runtime.getSession(session.key);
    }
    if (method === 'ipc:invoke' || method === 'ipc:send') {
      const [channel, ...values] = args;
      if (!channels.has(channel) || channel === 'backend:request')
        throw new Error('Unknown capability');
      if (/^backend:remote/.test(channel))
        throw new Error('Remote connections belong to the client');
      // Browser window chrome belongs to the client, not to the server's GUI.
      if (
        /^(window:|tray:|app:renderer-(?:ready|failed)|app:startup-(?:retry|close)|webControl:push|webControl:mirror)/.test(
          channel,
        )
      )
        return null;
      return method === 'ipc:invoke'
        ? ipc.invoke(channel, ...values)
        : ipc.send(channel, ...values);
    }
    if (!methods.has(method) || typeof runtime[method] !== 'function')
      throw new Error('Unknown backend method');
    return runtime[method](...args);
  };
}

module.exports = { createBackendDispatch };
