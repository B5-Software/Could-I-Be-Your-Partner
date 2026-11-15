/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
/* global window, document, CustomEvent */
// This function is serialized by Playwright and executes before site scripts.
function installProvider(injectedTransport) {
  if (window.top !== window) return;
  const transport =
    typeof injectedTransport === 'function' ? injectedTransport : window.__cibypWalletProviderV1;
  if (typeof transport !== 'function') return;
  const listeners = new Map();
  let accounts = [],
    chainId = null,
    connected = false,
    syncing = false;
  const emit = (name, value) => {
    for (const listener of [...(listeners.get(name) || [])])
      try {
        listener(value);
      } catch {
        /* Site handlers cannot affect wallet state. */
      }
  };
  const sync = (snapshot) => {
    if (!snapshot) return;
    const previous = connected;
    connected = true;
    if (!previous) emit('connect', { chainId: snapshot.chainId });
    if (chainId !== snapshot.chainId) {
      chainId = snapshot.chainId;
      emit('chainChanged', chainId);
    }
    if (JSON.stringify(accounts) !== JSON.stringify(snapshot.accounts)) {
      accounts = snapshot.accounts.slice();
      emit('accountsChanged', accounts.slice());
    }
  };
  const provider = Object.freeze({
    isCibyp: true,
    isConnected: () => connected,
    async request(input) {
      if (!input || typeof input.method !== 'string')
        throw Object.assign(Error('Invalid request'), { code: -32602 });
      const response = await transport({
        id: crypto.randomUUID(),
        method: input.method,
        params: input.params ?? [],
      });
      sync(response.snapshot);
      if (!response.ok)
        throw Object.assign(Error(response.error.message), { code: response.error.code });
      return response.value;
    },
    on(event, listener) {
      if (typeof listener !== 'function') throw TypeError('Expected an event listener');
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return provider;
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  });
  const info = Object.freeze({
    uuid: crypto.randomUUID(),
    name: 'Could I Be Your Partner',
    rdns: 'software.b5.cibyp',
    icon:
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#222633"/><path d="M65 30a25 25 0 1 0 0 36" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/></svg>',
      ),
  });
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  if (!window.ethereum)
    Object.defineProperty(window, 'ethereum', {
      value: provider,
      configurable: false,
      writable: false,
    });
  announce();
  setInterval(async () => {
    if (document.hidden || syncing || (!connected && !listeners.size)) return;
    syncing = true;
    try {
      const response = await transport({ method: '__cibyp_snapshot', params: [] });
      if (response.ok) sync(response.snapshot);
      else if (connected) {
        connected = false;
        accounts = [];
        emit('accountsChanged', []);
        emit(
          'disconnect',
          Object.assign(Error(response.error.message), { code: response.error.code }),
        );
      }
    } catch {
      /* Reconnection is checked by the next explicit request. */
    } finally {
      syncing = false;
    }
  }, 2000);
}
async function attachWalletProvider(context, { getWallet, enabled }) {
  const pages = new WeakMap();
  await context.exposeBinding('__cibypWalletProviderV1', async (source, input) => {
    let activeState, activeSession;
    try {
      if (!enabled() || source.frame !== source.page.mainFrame())
        throw Object.assign(Error('Host wallet is unavailable for this frame'), { code: 4100 });
      let state = pages.get(source.page);
      if (!state) {
        state = { epoch: 0, session: null, opening: null };
        pages.set(source.page, state);
        const close = () => {
          state.epoch++;
          state.session?.close();
          state.session = null;
          state.opening = null;
        };
        source.page.on('close', close);
        source.page.on('framenavigated', (frame) => {
          if (frame === source.page.mainFrame()) close();
        });
      }
      activeState = state;
      if (!state.session) {
        const epoch = state.epoch,
          url = source.frame.url();
        state.opening ||= (async () => {
          const wallet = await getWallet();
          if (state.epoch !== epoch || source.page.isClosed() || source.frame.url() !== url)
            throw Object.assign(Error('Requesting document changed'), { code: 4900 });
          return wallet.apps.createSession({
            url,
            valid: () =>
              enabled() &&
              state.epoch === epoch &&
              !source.page.isClosed() &&
              source.frame.url() === url,
          });
        })();
        const opening = state.opening;
        try {
          const session = await opening;
          if (state.epoch !== epoch || source.page.isClosed()) {
            session.close();
            throw Object.assign(Error('Requesting document changed'), { code: 4900 });
          }
          state.session = session;
        } finally {
          if (state.opening === opening) state.opening = null;
        }
      }
      activeSession = state.session;
      const value =
        input?.method === '__cibyp_snapshot' ? null : await activeSession.request(input);
      return { ok: true, value, snapshot: activeSession.snapshot() };
    } catch (error) {
      if (error.code === 4900 && activeSession) {
        activeSession.close();
        if (activeState.session === activeSession) activeState.session = null;
      }
      return {
        ok: false,
        error: {
          code: Number.isInteger(error.code) ? error.code : -32000,
          message: Number.isInteger(error.code)
            ? error.message
            : 'Wallet request failed; inspect the wallet for details',
        },
      };
    }
  });
  await context.addInitScript(installProvider);
}
module.exports = { installProvider, attachWalletProvider };
