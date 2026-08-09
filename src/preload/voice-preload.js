/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 语音条窗口 / 隐藏采集窗口共用的预加载脚本。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceApi', {
  // 设置（语音条读取 sttSendKeywords 等）
  getSettings: () => ipcRenderer.invoke('settings:get'),

  // 音频帧上行（Int16 ArrayBuffer, 16kHz mono）
  sendAudio: (target, sessionId, samples) =>
    ipcRenderer.send('voice:audio', { target, sessionId, samples }),

  sttStart: (opts) => ipcRenderer.invoke('voice:stt:start', opts || {}),
  sttStop: (sessionId) => ipcRenderer.invoke('voice:stt:stop', sessionId),
  sttCancel: (sessionId) => ipcRenderer.invoke('voice:stt:cancel', sessionId),

  ttsSpeak: (data) => ipcRenderer.invoke('voice:tts:speak', data),
  ttsStop: () => ipcRenderer.invoke('voice:tts:stop'),

  // 语音条 → 主窗口
  barSendCommand: (text, autoSend) =>
    ipcRenderer.send('voice:bar:command', { text, autoSend: autoSend !== false }),
  // 打开主窗口并把识别文本填入当前模式输入框（默认不发送，仅填入）
  barShowMain: (text) => ipcRenderer.send('voice:bar:show-main', { text }),
  barClose: () => ipcRenderer.invoke('voice:bar:close'),
  reportState: (state) => ipcRenderer.send('voice:client-state', state),

  // 事件订阅（返回退订函数）
  onSttPartial: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voice:stt-partial', l);
    return () => ipcRenderer.removeListener('voice:stt-partial', l);
  },
  onSttFinal: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voice:stt-final', l);
    return () => ipcRenderer.removeListener('voice:stt-final', l);
  },
  onTtsAudio: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voice:tts-audio', l);
    return () => ipcRenderer.removeListener('voice:tts-audio', l);
  },
  onTtsDone: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voice:tts-done', l);
    return () => ipcRenderer.removeListener('voice:tts-done', l);
  },
  onWake: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voice:wake', l);
    return () => ipcRenderer.removeListener('voice:wake', l);
  },
  onWakeHit: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voicebar:wake-hit', l);
    return () => ipcRenderer.removeListener('voicebar:wake-hit', l);
  },
  onCaptureControl: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voice-capture:control', l);
    return () => ipcRenderer.removeListener('voice-capture:control', l);
  },
  onError: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('voice:error', l);
    return () => ipcRenderer.removeListener('voice:error', l);
  },
});
