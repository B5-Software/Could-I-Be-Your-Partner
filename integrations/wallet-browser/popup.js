/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../src/shared/wallet-browser-labels.json';
const api = globalThis.browser || chrome,
  language = navigator.language;
const t = labels[language.startsWith('zh') ? 'zh-CN' : language.startsWith('de') ? 'de' : 'en'];
document.documentElement.lang = language;
document
  .querySelectorAll('[data-text]')
  .forEach((n) => (n.textContent = t[n.dataset.text] || n.dataset.text));
const status = document.getElementById('status');
const notice = (text) => {
  status.hidden = false;
  status.textContent = text;
};
async function command(message) {
  const result = await api.runtime.sendMessage(message);
  if (!result?.ok) throw Error(result?.error || t.wbError);
  return result;
}
async function render() {
  const { connection, pending, available } = await command({ action: 'status' });
  document.getElementById('connection').hidden = !connection;
  document.getElementById('pair-form').hidden = !!connection;
  if (connection) {
    document.getElementById('connection-badge').textContent = available ? t.wbPaired : t.wbOffline;
    const bytes = new TextEncoder().encode(JSON.stringify(connection.publicKey));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    document.getElementById('fingerprint').textContent = Array.from(new Uint8Array(digest), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('');
  }
  if (pending) {
    await showIdentity();
    notice(t.wbPairing);
  }
}
async function showIdentity() {
  const { fingerprint } = await command({ action: 'identity' });
  document.getElementById('client-fingerprint').textContent = fingerprint;
  document.getElementById('browser-identity').hidden = false;
}
document.getElementById('pair-form').onsubmit = async (e) => {
  e.preventDefault();
  const button = document.getElementById('pair');
  if (button.disabled) return;
  button.disabled = true;
  notice(t.wbPairing);
  try {
    await showIdentity();
    await command({
      action: 'pair',
      uri: document.getElementById('pair-uri').value.trim(),
      name: document.getElementById('browser-name').value,
    });
    document.getElementById('pair-uri').value = '';
    status.hidden = true;
    await render();
  } catch (error) {
    notice(t.wbError + ' ' + error.message);
  } finally {
    button.disabled = false;
  }
};
document.getElementById('forget').onclick = async () => {
  try {
    await command({ action: 'forget' });
    status.hidden = true;
    await render();
  } catch (e) {
    notice(t.wbError + ' ' + e.message);
  }
};
render().catch(() => notice(t.wbError));
