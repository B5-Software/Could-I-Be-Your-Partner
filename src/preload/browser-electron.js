/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { BackendClient } = require('../shared/backend-client');
const client = new BackendClient({ url: window.location.origin, onError: error => console.error('[backend]', error) });
const listeners = new Map();
const voiceControls = new Map();
function finishVoiceControl(id, result, error) {
  const pending = voiceControls.get(id); if (!pending) return;
  clearTimeout(pending.timer); voiceControls.delete(id);
  if (error) pending.reject(new Error(error)); else pending.resolve(result);
}
function sendVoiceControl(channel, sessionId) {
  const socket = client.socket;
  if (!socket || socket.readyState !== 1) return Promise.reject(new Error('Audio connection is unavailable'));
  const id = window.crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finishVoiceControl(id, null, 'Audio control timed out'), 30000);
    voiceControls.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ type: 'voice-control', id, sessionId, action: channel.endsWith('cancel') ? 'cancel' : 'stop' })); }
    catch (error) { finishVoiceControl(id, null, error.message); }
  });
}
const publish = (channel, payload) => { for (const listener of listeners.get(channel) || []) listener({}, payload); };
const surfaces = require('./browser-surfaces').createBrowserSurfaces(publish);
const openWorkspace = require('./browser-workspace').createBrowserWorkspace((...args) => client.request(...args));
async function upload(name, bytes) {
  if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('Attachment exceeds 100 MiB');
  const response = await fetch('/api/upload?' + new URLSearchParams({ name }), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CIBYP-Client': '1' }, body: bytes });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Upload failed');
  return result;
}
function chooseFiles(options = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = !!options.multiple;
    if (options.filters?.length) input.accept = options.filters.flatMap(filter => filter.extensions || []).filter(ext => ext !== '*').map(ext => '.' + ext).join(',');
    input.oncancel = () => resolve({ ok: false, canceled: true, paths: [] });
    input.onchange = async () => {
      try {
        const files = [];
        for (const file of input.files || []) files.push({ ...await upload(file.name, await file.arrayBuffer()), name: file.name, size: file.size });
        resolve({ ok: true, files, paths: files.map(file => file.path) });
      } catch (error) { resolve({ ok: false, error: error.message, paths: [] }); }
    };
    input.click();
  });
}
let voiceSettings;
let recognitionSession;
async function startRecognition(options = {}) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return { ok: false, error: 'Download the STT model on the backend or use a browser with speech recognition' };
  if (!window.isSecureContext) return { ok: false, error: 'Microphone access requires HTTPS or localhost' };
  recognitionSession?.recognition.abort();
  const recognition = new Recognition();
  voiceSettings = await client.request('getSettings');
  recognition.lang = voiceSettings.language || window.navigator.language;
  recognition.interimResults = true;
  const state = { recognition, sessionId: options.sessionId, text: '', canceled: false };
  recognitionSession = state;
  recognition.onresult = event => {
    state.text = [...event.results].map(result => result[0].transcript).join('');
    publish('voice:stt-partial', { sessionId: state.sessionId, text: state.text });
  };
  recognition.onerror = event => { state.canceled = true; publish('voice:error', { sessionId: state.sessionId, error: event.error }); };
  recognition.onend = () => {
    if (recognitionSession === state) recognitionSession = null;
    publish('voice:stt-final', { sessionId: state.sessionId, text: state.canceled ? '' : state.text, browserRecognition: true });
  };
  recognition.start(); return { ok: true, sessionId: state.sessionId, browserRecognition: true };
}
async function speak(data) {
  if (!window.speechSynthesis) return { ok: false, error: 'Speech synthesis is unavailable in this browser' };
  voiceSettings = await client.request('getSettings');
  const utterance = new window.SpeechSynthesisUtterance(String(data.text || ''));
  utterance.lang = data.lang === 'auto' ? voiceSettings.language || window.navigator.language : data.lang || window.navigator.language;
  utterance.rate = Math.max(.5, Math.min(2, Number(data.speed) || 1));
  utterance.volume = Math.max(0, Math.min(1, voiceSettings.voice?.ttsVolume ?? 1));
  utterance.onend = () => publish('voice:tts-done', { reqId: data.reqId });
  utterance.onerror = event => publish('voice:tts-error', { reqId: data.reqId, error: event.error });
  window.speechSynthesis.speak(utterance);
  return { ok: true, reqId: data.reqId };
}
function chooseAvatar() {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.oncancel = () => resolve({ ok: false });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve({ ok: false });
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('Avatar exceeds 10 MiB');
        const bitmap = await window.createImageBitmap(file);
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
const editorFiles = require('./browser-editor-files').createBrowserEditorFiles((...args) => client.request(...args), picker);
client.onEvent(event => {
  if (event.type === 'voice-control-result') finishVoiceControl(event.id, event.result, event.error);
  if (event.type === 'connection' && !event.connected) for (const id of voiceControls.keys()) finishVoiceControl(id, null, 'Audio connection interrupted');
  if (event.type === 'snapshot') for (const listener of listeners.get('backend:reconnected') || []) listener({}, event.snapshot);
  if (event.type === 'connection') for (const listener of listeners.get('backend:connection') || []) listener({}, event);
  if (event.type === 'authentication-required') window.location.replace('/login');
  for (const listener of listeners.get(event.channel) || []) listener({}, event.payload);
});
const ready = client.connect().then(snapshot => { window.cibypBackend = client; window.cibypPlatform = snapshot.platform; return snapshot; });
window.addEventListener('pagehide', () => { recognitionSession?.recognition.abort(); picker.close(); client.close(); window.speechSynthesis?.cancel(); });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
ready.catch(error => { if (/Authentication|401/.test(error.message)) window.location.replace('/login'); });
const ipcRenderer = {
  async invoke(channel, ...args) {
    await ready;
    if (channel === 'avatar:pickAndEncode') return chooseAvatar();
    if (channel === 'dialog:pickLocalFiles') return chooseFiles(args[0]);
    if (channel === 'workspace:openInExplorer' || channel === 'shell:openFileExplorer') return openWorkspace(args[0]);
    if (channel === 'fs:saveUploadedFile') return upload(args[0], args[1]);
    if (channel === 'dialog:confirm') return window.confirm(String(args[0] || ''));
    if (channel === 'voice:tts:speak') return speak(args[0]);
    if (channel === 'voice:tts:stop') { window.speechSynthesis?.cancel(); return { ok: true }; }
    if (channel === 'voice:getStatus') {
      const status = await client.request('ipc:invoke', channel);
      return { ...status, supported: true, browser: true, capabilities: { ...status.capabilities, stt: { ready: !!(window.isSecureContext && (status.capabilities?.stt?.ready || window.SpeechRecognition || window.webkitSpeechRecognition)) }, tts: { ready: !!window.speechSynthesis }, wake: { ready: false } } };
    }
    if (channel === 'voice:stt:start') {
      const result = await client.request('ipc:invoke', channel, ...args);
      return result?.ok ? result : startRecognition(args[0]);
    }
    if ((channel === 'voice:stt:stop' || channel === 'voice:stt:cancel') && recognitionSession?.sessionId === args[0]) {
      recognitionSession.canceled = channel.endsWith('cancel');
      recognitionSession.recognition[recognitionSession.canceled ? 'abort' : 'stop']();
      return { ok: true };
    }
    if (channel === 'voice:stt:stop' || channel === 'voice:stt:cancel') return sendVoiceControl(channel, args[0]);
    if (/^(sanguosha|flyingflower|undercover|idiom|guesscharacter):getConfig$/.test(channel)) return { aiCount: Number(new URLSearchParams(window.location.search).get('aiCount')) || 3, category: new URLSearchParams(window.location.search).get('category') || 'mixed' };
    if (surfaces.handles(channel)) return surfaces.invoke(channel, args[0]);
    if (editorFiles.handles(channel)) return editorFiles.invoke(channel, ...args);
    if (picker.handles(channel)) return picker.invoke(channel, ...args);
    if (channel === 'backend:request') return client.request(...args);
    if (channel === 'codeoss:open') return client.request('ipc:invoke', 'codeoss:open-web', ...args);
    if (channel === 'codeoss:layout') return null;
    if (channel === 'backend:remote-status') return { connected: false, url: '' };
    if (channel === 'window:isMaximized') return false;
    return client.request('ipc:invoke', channel, ...args);
  },
  send(channel, ...args) {
    if (channel === 'voice:audio') {
      const value = args[0], socket = client.socket;
      if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 1024 * 1024) { publish('voice:error', { sessionId: value.sessionId, error: 'Audio connection interrupted; reconnect and try again' }); return; }
      socket.send(JSON.stringify({ type: 'voice-audio', sessionId: value.sessionId, samples: value.samples }, require('../shared/wire-values').replacer));
      return;
    }
    this.invokeSend(channel, args).catch(error => console.error('[backend]', error));
  },
  async invokeSend(channel, args) { await ready; return client.request('ipc:send', channel, ...args); },
  on(channel, listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(listener); },
  removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
};
const contextBridge = { exposeInMainWorld(name, value) { window[name] = value; } };
module.exports = { ipcRenderer, contextBridge };
