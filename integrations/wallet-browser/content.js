/* SPDX-License-Identifier: GPL-3.0-or-later */
const api = globalThis.browser || chrome;
if (window.top === window) {
  let port;
  const pending = new Set();
  const response = (id, value) => {
    pending.delete(id);
    window.postMessage(
      { channel: 'cibyp-wallet-v1', direction: 'response', id, value },
      location.origin,
    );
  };
  const connect = () => {
    if (port) return port;
    const next = api.runtime.connect({ name: 'cibyp-wallet-document-v1' });
    port = next;
    next.onMessage.addListener((d) => {
      if (port === next && typeof d.id === 'string' && pending.has(d.id)) response(d.id, d.value);
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      for (const id of [...pending])
        response(id, {
          ok: false,
          error: {
            code: 4900,
            message: 'Wallet connection ended; inspect the wallet before retrying',
          },
        });
    });
    return next;
  };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (
      e.source !== window ||
      e.origin !== location.origin ||
      d?.channel !== 'cibyp-wallet-v1' ||
      d.direction !== 'request' ||
      typeof d.id !== 'string' ||
      !/^[\da-f-]{36}$/.test(d.id) ||
      pending.has(d.id)
    )
      return;
    try {
      if (pending.size >= 8) throw Error('Too many requests');
      if (new TextEncoder().encode(JSON.stringify(d.input)).length > 65536)
        throw Error('Request too large');
      pending.add(d.id);
      connect().postMessage({ id: d.id, input: d.input });
    } catch {
      response(d.id, {
        ok: false,
        error: { code: -32602, message: 'Invalid or excessive wallet request' },
      });
    }
  });
}
