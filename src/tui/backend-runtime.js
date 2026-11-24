/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { loadPreloadApi } = require('../agent/preload-api');
const { loadI18n } = require('../agent/i18n-loader');
const i18n = loadI18n();
require('./text').setGlobalTranslator((...args) => {
  i18n.i18nSetLanguage(require('./text').getLanguage());
  return i18n.t(...args);
});

async function createBackendRuntime(client) {
  const snapshot = await client.connect();
  let sessions = new Map(snapshot.sessions.map((session) => [session.key, session]));
  let views = new Map(Object.entries(snapshot.views));
  let snapshotSequence = snapshot.sequence;
  const listeners = new Set();
  const channels = new Map();
  const api = loadPreloadApi({
    invoke: (channel, ...args) =>
      client.request(
        channel === 'backend:request' ? args.shift() : 'ipc:invoke',
        ...(channel === 'backend:request' ? args : [channel, ...args]),
      ),
    send: (channel, ...args) => client.request('ipc:send', channel, ...args).catch(client.onError),
    on: (channel, listener) => {
      if (!channels.has(channel)) channels.set(channel, new Set());
      channels.get(channel).add(listener);
    },
    off: (channel, listener) => channels.get(channel)?.delete(listener),
  });
  let refreshing;
  const applySessionEvent = (event) => {
    const session = sessions.get(event.key);
    if (event.type === 'session-created') sessions.set(event.key, { ...event.session });
    else if (event.type === 'session-closed') {
      sessions.delete(event.key);
      views.delete(event.key);
    } else if (event.type === 'status' && session) {
      session.status = event.status;
      session.busy = event.status === 'running' || event.status === 'working';
    } else if (event.type === 'title' && session) session.title = event.title;
  };
  const setSnapshot = (value) => {
    runtime.boot = value.boot;
    snapshotSequence = value.sequence;
    sessions = new Map(value.sessions.map((s) => [s.key, s]));
    views = new Map(Object.entries(value.views));
  };
  const refresh = () => {
    if (refreshing) return refreshing.promise;
    const flight = { events: [] };
    refreshing = flight;
    flight.promise = client
      .request('snapshot')
      .then((value) => {
        if (refreshing !== flight) return;
        const previous = sessions;
        setSnapshot(value);
        // The snapshot could have been collected before a terminal event arrived.
        for (const event of flight.events) {
          if (event.sequence > snapshotSequence) applySessionEvent(event.payload);
        }
        // HTTP can see the end of a run before the event socket catches up.
        for (const session of sessions.values()) {
          const before = previous.get(session.key);
          if (before?.status === session.status) continue;
          const status = {
            type: 'status',
            key: session.key,
            status: session.status,
          };
          for (const fn of listeners) fn(status);
        }
      })
      .finally(() => {
        if (refreshing === flight) refreshing = null;
      });
    return flight.promise;
  };
  const runtime = {
    api,
    boot: snapshot.boot,
    getSettingsCatalog: () => client.request('settings:catalog'),
    onEvent(fn) {
      listeners.add(fn);
      api
        .updatesStatus()
        .then((state) => {
          if (listeners.has(fn) && state?.phase === 'ready') fn({ type: 'update', state });
        })
        .catch(client.onError);
      return () => listeners.delete(fn);
    },
    listSessions: () => [...sessions.values()],
    refresh,
    getSession: (key) => sessions.get(key),
    getStats: (key) => views.get(key)?.stats,
    getSessionDetails: (key) => {
      const view = views.get(key);
      return view
        ? {
            messages: view.displayMessages || view.messages || [],
            pendingInteraction: view.pendingInteraction,
            compaction: view.stats?.compaction || null,
          }
        : null;
    },
    async createSession(options) {
      const session = await client.request('createSession', options);
      sessions.set(session.key, session);
      await refresh();
      return session;
    },
    dispose: () => {
      clearInterval(bootTimer);
      client.close();
    },
  };
  for (const method of [
    'getSettings',
    'goalCommand',
    'saveSettings',
    'getSystemTheme',
    'getLanguage',
    'setLanguage',
    'getTodos',
    'toggleTodo',
    'openCurrentDirectory',
    'openVmDesktop',
    'getSubscriptionUsage',
    'setTitle',
    'sendMessage',
    'agentAction',
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
    'prepareWorkspace',
    'syncWorkspace',
    'listLocalWorkspaceDirectories',
    'listHistory',
    'getHistory',
    'deleteHistory',
    'renameHistory',
    'openHistory',
  ])
    runtime[method] = async (...args) => {
      const value = await client.request(method, ...args);
      if (
        !['getSettings', 'getSystemTheme', 'setLanguage', 'listHistory', 'getHistory'].includes(
          method,
        )
      )
        await refresh();
      return value;
    };
  const bootTimer = setInterval(() => {
    if (runtime.boot?.ready) {
      clearInterval(bootTimer);
      return;
    }
    client
      .request('boot:state')
      .then((value) => {
        runtime.boot = value;
      })
      .catch(client.onError);
  }, 400);
  bootTimer.unref();
  client.onEvent(async (event) => {
    if (event.type === 'snapshot') {
      refreshing = null;
      setSnapshot(event.snapshot);
      for (const fn of listeners) fn({ type: 'reconnected' });
      return;
    }
    for (const listener of channels.get(event.channel) || []) listener({}, event.payload);
    if (event.channel === 'updates:state') {
      for (const listener of listeners) listener({ type: 'update', state: event.payload });
      return;
    }
    if (event.channel !== 'agent:session-event') return;
    const data = event.payload;
    if (['session-created', 'session-closed', 'status', 'title'].includes(data.type)) {
      const coveredBySnapshot = event.sequence <= snapshotSequence;
      if (!coveredBySnapshot) {
        applySessionEvent(data);
        refreshing?.events.push(event);
      } else if (data.type === 'status') return;
    }
    if (data.type === 'messages-deleted') {
      try {
        await refresh();
      } catch (error) {
        client.onError(error);
      }
    }
    if (['usage', 'view-changed', 'stream-end'].includes(data.type))
      refresh().catch(client.onError);
    for (const listener of listeners) listener(data);
  });
  return runtime;
}
module.exports = { createBackendRuntime };
