/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const { createIpcDispatch } = require('./ipc-dispatch');

// The preload is the single capability declaration for every frontend. Never
// expose arbitrary properties of the runtime, Electron, or the IPC registry.
function createBackendDispatch({
  runtime,
  ipcMain,
  bridge,
  eventBus,
  desktop,
  shutdown,
  bootState,
  storageDir,
  product,
}) {
  const channels = new Set(require('../../shared/ipc-capabilities.json'));
  const ipc =
    bridge ||
    createIpcDispatch({
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
    'goalCommand',
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
    'getMessageEditPlan',
    'editMessages',
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
    'getSessionModels',
    'selectSessionModel',
    'setSessionReasoning',
    'prepareWorkspace',
    'uploadAttachment',
  ]);
  // Lazily create ONE owner for every attached frontend, outside chat/workspace cleanup.
  const getQuant = async () => {
    if (!require('../../shared/feature-gates').quantEnabled(await runtime.getSettings()))
      throw Error('QUANT_DISABLED');
    if (!runtime.quantService) {
      if (!storageDir) throw new Error('QUANT_STORAGE_UNAVAILABLE');
      runtime.quantService = new (require('../services/quant').QuantService)({
        directory: require('node:path').join(storageDir, 'quant'),
        runtime,
        getWallet: () => getWallet(),
        publish: (event) => eventBus.publish('agent:session-event', event),
      });
    }
    return runtime.quantService;
  };
  const getWallet = () => {
    if (!runtime.walletService) {
      if (!storageDir) throw new Error('WALLET_STORAGE_UNAVAILABLE');
      runtime.walletService = new (require('../services/wallet').WalletService)({
        directory: require('node:path').join(storageDir, 'wallet'),
        publish: (event) => eventBus.publish('agent:session-event', event),
        onEmergencyHalt: () => runtime.quantService?.liveExecution?.emergencyHalt(),
      });
    }
    return runtime.walletService;
  };
  const getSuperAgent = () => {
    if (!runtime.superAgentService) {
      if (!storageDir) throw Error('SUPER_STORAGE_UNAVAILABLE');
      runtime.superAgentService = new (require('../services/super-agent').SuperAgentService)({
        directory: require('node:path').join(storageDir, 'superagent'),
        runtime,
        publish: (event) => eventBus.publish('agent:session-event', event),
      });
      const unsubscribe = eventBus.subscribe('agent:session-event', (event) => {
        try {
          runtime.superAgentService?.event(event);
        } catch (error) {
          runtime.superAgentService?.fail(error);
        }
      });
      const service = runtime.superAgentService,
        dispose = service.dispose.bind(service);
      service.dispose = async () => {
        unsubscribe();
        await dispose();
      };
    }
    return runtime.superAgentService;
  };
  if (storageDir) {
    try {
      getSuperAgent();
    } catch (error) {
      runtime.superAgentError = error.message;
    }
  }
  runtime.quantGateOff?.();
  runtime.quantGateOff = eventBus.subscribe('settings:changed', (settings) => {
    if (!require('../../shared/feature-gates').quantEnabled(settings)) {
      runtime.quantService?.dispose();
      runtime.quantService = undefined;
    }
  });
  const dispatch = async function dispatch({ method, args = [] } = {}) {
    if (!Array.isArray(args) || args.length > 30) throw new Error('Invalid arguments');
    if (method === 'firmware:request') {
      runtime.firmwareService ||= new (require('../services/firmware').FirmwareService)({
        publish: (event) => eventBus.publish('agent:session-event', event),
      });
      return runtime.firmwareService.request(args[0], args[1]);
    }
    if (method === 'superagent:request') return getSuperAgent().request(args[0], args[1]);
    if (method === 'quant:request') return (await getQuant()).request(args[0], args[1]);
    if (method === 'wallet:request') return getWallet().request(args[0], args[1]);
    if (method === 'snapshot')
      return {
        sessions: runtime.listSessions(),
        views: Object.fromEntries(
          runtime.listSessions().map((s) => [s.key, runtime.getView(s.key)]),
        ),
        boot: bootState?.() || { ready: true },
        platform: process.platform,
        pid: process.pid,
        features: {
          quant: require('../../shared/feature-gates').quantEnabled(await runtime.getSettings()),
        },
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
  dispatch.remote = require('../services/remote-control').createRemoteControl({
    runtime,
    eventBus,
    bootState,
    storageDir,
    product,
  });
  return dispatch;
}

module.exports = { createBackendDispatch };
