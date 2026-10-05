/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { BackendClient } = require('../shared/backend-client');
const client = new BackendClient({ url: window.location.origin, onError: error => console.error('[backend]', error) });
const listeners = new Map();
function chooseAvatar() {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.oncancel = () => resolve({ ok: false });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve({ ok: false });
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('Avatar exceeds 10 MiB');
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
        resolve({ ok: true, path: '', dataUrl: canvas.toDataURL('image/png') });
      } catch (error) { resolve({ ok: false, error: error.message }); }
    };
    input.click();
  });
}
const picker = require('../shared/client-file-picker').createClientFilePicker(
  (channel,...args) => client.request('ipc:invoke', channel,...args),
  (channel,payload) => { for (const listener of listeners.get(channel) || []) listener({},payload); });
client.onEvent(event => {
  if (event.type === 'snapshot') for (const listener of listeners.get('backend:reconnected') || []) listener({}, event.snapshot);
  if (event.type === 'connection') for (const listener of listeners.get('backend:connection') || []) listener({}, event);
  if (event.type === 'authentication-required') window.location.replace('/login');
  for (const listener of listeners.get(event.channel) || []) listener({}, event.payload);
});
const ready = client.connect().then(snapshot => { window.cibypBackend = client; window.cibypPlatform = snapshot.platform; return snapshot; });
window.addEventListener('beforeunload', () => { picker.close(); client.close(); });
ready.catch(error => { if (/Authentication|401/.test(error.message)) window.location.replace('/login'); });
const ipcRenderer = {
  async invoke(channel, ...args) {
    await ready;
    if (channel === 'avatar:pickAndEncode') return chooseAvatar();
    if (picker.handles(channel)) return picker.invoke(channel, ...args);
    if (channel === 'backend:request') return client.request(...args);
    if (channel === 'codeoss:open') return client.request('ipc:invoke', 'codeoss:open-web', ...args);
    if (channel === 'codeoss:layout') return null;
    if (channel === 'backend:remote-status') return { connected: false, url: '' };
    if (channel === 'window:isMaximized') return false;
    return client.request('ipc:invoke', channel, ...args);
  },
  send(channel, ...args) { this.invokeSend(channel, args).catch(error => console.error('[backend]', error)); },
  async invokeSend(channel, args) { await ready; return client.request('ipc:send', channel, ...args); },
  on(channel, listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(listener); },
  removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
};
const contextBridge = { exposeInMainWorld(name, value) { window[name] = value; } };
module.exports = { ipcRenderer, contextBridge };
