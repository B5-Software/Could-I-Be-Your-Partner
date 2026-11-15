/* SPDX-License-Identifier: GPL-3.0-or-later */
import { installProvider } from '../../src/main/services/wallet/browser-provider';
if (window.top === window) {
  const pending = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (
      e.source !== window ||
      e.origin !== location.origin ||
      d?.channel !== 'cibyp-wallet-v1' ||
      d.direction !== 'response'
    )
      return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    p.resolve(d.value);
  });
  installProvider(
    (input) =>
      new Promise((resolve) => {
        if (pending.size >= 16) {
          resolve({ ok: false, error: { code: -32002, message: 'Too many wallet requests' } });
          return;
        }
        const id = crypto.randomUUID(),
          timer = setTimeout(() => {
            pending.delete(id);
            resolve({
              ok: false,
              error: {
                code: 4900,
                message: 'Wallet channel timed out; inspect the wallet before retrying',
              },
            });
          }, 610000);
        pending.set(id, { resolve, timer });
        window.postMessage(
          { channel: 'cibyp-wallet-v1', direction: 'request', id, input },
          location.origin,
        );
      }),
  );
}
