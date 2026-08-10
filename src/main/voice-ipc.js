/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 语音子系统主进程装配：IPC 注册、唤醒动作路由、置顶语音条窗口、隐藏常驻采集窗口、全局热键。
 * 推理核心在 voice-engine.js / voice-worker.js。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { BrowserWindow, globalShortcut } = require('electron');
const { VoiceEngine } = require('./voice-engine');

let engine = null;
let voiceBarWindow = null;
let captureWindow = null;
let ctx = null; // { app, getSettings, persistSettings, getMainWindow, showWindowFromTray, onWakeAction }
let barAudioShared = false; // 唤醒命中后：采集窗音频同时分流到语音条 STT 会话（避免丢句首）

// 会话归属前缀：stt.final / tts 事件按 sessionId/reqId 前缀路由到对应窗口
const SESSION_MAIN_PREFIX = 'main';
const SESSION_BAR_PREFIX = 'bar';
const SESSION_WEB_PREFIX = 'web';

function log(...a) { console.log('[voice-ipc]', ...a); }

function voiceSettings() {
  const s = ctx.getSettings() || {};
  return s.voice || {};
}

/** 向所有相关渲染窗口广播语音事件（接收方按 id 过滤） */
function broadcast(channel, payload) {
  const targets = [ctx.getMainWindow(), voiceBarWindow];
  for (const w of targets) {
    try {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    } catch (_) {}
  }
  // WebUI 推送（P2：web-control-service 通过 onVoiceEvent 钩子订阅）
  if (typeof ctx.onVoiceEvent === 'function') {
    try { ctx.onVoiceEvent(channel, payload); } catch (_) {}
  }
}

// ---------- 置顶语音条窗口 ----------
function openVoiceBar() {
  if (voiceBarWindow && !voiceBarWindow.isDestroyed()) {
    try { voiceBarWindow.show(); voiceBarWindow.focus(); } catch (_) {}
    return voiceBarWindow;
  }
  voiceBarWindow = new BrowserWindow({
    width: 560,
    height: 170,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/voice-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    voiceBarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    voiceBarWindow.setAlwaysOnTop(true, 'screen-saver');
  } catch (_) {}
  voiceBarWindow.loadFile(path.join(__dirname, '../renderer/pages/voice-bar.html'));
  voiceBarWindow.on('closed', () => {
    voiceBarWindow = null;
  });
  return voiceBarWindow;
}

function closeVoiceBar() {
  // 清理语音条残留的听写会话（窗口可能被定时关闭，未走正常 finishDictation）
  if (engine) {
    try { engine.cancelStt(`${SESSION_BAR_PREFIX}-stt`); } catch (_) {}
  }
  barAudioShared = false;
  if (voiceBarWindow && !voiceBarWindow.isDestroyed()) {
    try { voiceBarWindow.close(); } catch (_) {}
  }
  voiceBarWindow = null;
}

// ---------- 隐藏常驻采集窗口（后台唤醒的麦克风来源） ----------
function ensureCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) return captureWindow;
  captureWindow = new BrowserWindow({
    width: 10,
    height: 10,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/voice-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  captureWindow.loadFile(path.join(__dirname, '../renderer/pages/voice-capture.html'));
  captureWindow.on('closed', () => { captureWindow = null; });
  return captureWindow;
}

function destroyCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    try { captureWindow.destroy(); } catch (_) {}
  }
  captureWindow = null;
}

// ---------- 唤醒 ----------
async function startWake() {
  const v = voiceSettings();
  const words = (v.wakeWords || []).filter((w) => w && w.phrase && w.enabled !== false);
  if (!words.length) {
    log('无有效唤醒词，跳过启动');
    return { ok: false, error: 'no-wake-words' };
  }
  await engine.startWake(words);
  ensureCaptureWindow();
  // 采集窗口加载完成后通知其开始推流
  const startPushing = () => {
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.webContents.send('voice-capture:control', { command: 'start' });
    }
  };
  if (captureWindow.webContents.isLoading()) {
    captureWindow.webContents.once('did-finish-load', startPushing);
  } else {
    startPushing();
  }
  log('后台唤醒已启用');
  return { ok: true };
}

async function stopWake() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    try { captureWindow.webContents.send('voice-capture:control', { command: 'stop' }); } catch (_) {}
  }
  destroyCaptureWindow();
  barAudioShared = false;
  await engine.stopWake();
  log('后台唤醒已停用');
  return { ok: true };
}

async function setWakeEnabled(enabled) {
  const s = ctx.getSettings();
  if (s.voice) s.voice.wakeEnabled = !!enabled;
  try { ctx.persistSettings && ctx.persistSettings(); } catch (_) {}
  if (enabled) return startWake();
  return stopWake();
}

/** 唤醒命中路由 */
async function onWake({ keyword, phrase, action }) {
  log('唤醒命中:', keyword, '→', action);
  // 命中即停止正在播放的 TTS（barge-in）
  try { engine.cancelAllTts(); } catch (_) {}
  broadcast('voice:wake', { keyword, phrase, action });
  if (action === 'mainwindow') {
    ctx.showWindowFromTray();
    return;
  }
  // 默认动作：弹出置顶语音条并进入听写
  // 立即开启 STT 会话并让采集窗音频分流（用户往往唤醒词刚说完继续说指令，
  // 若等语音条窗口重新 getUserMedia 会丢句首 → whisper 识别严重失真）
  if (voiceSettings().sttEnabled === false) {
    log('STT 已禁用，跳过直通识别');
    openVoiceBar();
    return;
  }
  barAudioShared = true;
  try {
    // VAD 用默认参数，与主窗口听写完全一致（自定义参数曾导致识别风格漂移）
    await engine.startStt('bar-stt');
  } catch (e) {
    barAudioShared = false;
    log('唤醒直通 STT 启动失败:', e.message);
  }
  const bar = openVoiceBar();
  const notify = () => {
    if (voiceBarWindow && !voiceBarWindow.isDestroyed()) {
      voiceBarWindow.webContents.send('voicebar:wake-hit', { keyword, phrase, shared: true });
    }
  };
  if (bar.webContents.isLoading()) bar.webContents.once('did-finish-load', notify);
  else notify();
}

// ---------- 全局热键 ----------
let registeredHotkey = null;
function registerHotkey() {
  const v = voiceSettings();
  const acc = v.hotkey;
  try { if (registeredHotkey) globalShortcut.unregister(registeredHotkey); } catch (_) {}
  registeredHotkey = null;
  if (!acc || v.pushToTalk === false) return;
  try {
    const ok = globalShortcut.register(acc, () => {
      const win = ctx.getMainWindow();
      if (!win || win.isDestroyed()) return;
      ctx.showWindowFromTray();
      win.webContents.send('voice:hotkey-toggle');
    });
    if (ok) {
      registeredHotkey = acc;
      log('全局热键已注册:', acc);
    } else {
      log('全局热键注册失败（被占用？）:', acc);
    }
  } catch (e) {
    log('全局热键异常:', e.message);
  }
}

// ---------- IPC 注册 ----------
function registerIpc(ipcMain) {
  ipcMain.handle('voice:getStatus', () => {
    try {
      return { ok: true, ...engine.status(), settings: voiceSettings() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 音频帧入口（fire-and-forget）：{ target:'wake' } 或 { target:'stt', sessionId }
  ipcMain.on('voice:audio', (_, data) => {
    try {
      if (!data || !data.samples) return;
      if (data.target === 'wake') {
        engine.feedWakeAudio(data.samples);
        // 唤醒命中后 → 采集窗音频同时喂给语音条 STT 会话（防丢句首）
        if (barAudioShared) engine.feedStt('bar-stt', data.samples);
      } else if (data.target === 'stt' && data.sessionId) {
        engine.feedStt(data.sessionId, data.samples);
      }
    } catch (_) {}
  });

  ipcMain.handle('voice:stt:start', async (_, opts = {}) => {
    try {
      const sessionId = opts.sessionId || `${SESSION_MAIN_PREFIX}-${Date.now()}`;
      await engine.startStt(sessionId, opts);
      return { ok: true, sessionId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('voice:stt:cancel', (_, sessionId) => {
    try {
      engine.cancelStt(sessionId);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('voice:stt:stop', (_, sessionId) => {
    try { engine.stopStt(sessionId); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('voice:tts:speak', async (_, data) => {
    try {
      if (!data || !data.text) return { ok: false, error: 'empty-text' };
      const reqId = data.reqId || `tts-${Date.now()}`;
      await engine.speak(reqId, data.text, data);
      return { ok: true, reqId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('voice:tts:stop', () => {
    try { engine.cancelAllTts(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('voice:wake:setEnabled', async (_, enabled) => {
    try { return await setWakeEnabled(!!enabled); } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('voice:wake:restart', async () => {
    try {
      if (!voiceSettings().wakeEnabled) return { ok: true, skipped: true };
      await stopWake();
      return await startWake();
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('voice:bar:open', () => { openVoiceBar(); return { ok: true }; });
  ipcMain.handle('voice:bar:close', () => { closeVoiceBar(); return { ok: true }; });

  // 语音条识别完成 → 打开主窗口并把文字填入当前模式输入框（autoSend=true 时自动发送）
  ipcMain.on('voice:bar:command', (_, data) => {
    try {
      const win = ctx.getMainWindow();
      if (!win || win.isDestroyed()) return;
      const text = (data && data.text ? data.text : (typeof data === 'string' ? data : '')).trim();
      if (!text) return;
      ctx.showWindowFromTray();
      win.webContents.send('voice:bar:fill', { text, autoSend: true });
    } catch (e) {
      log('voice:bar:command 处理失败:', e && e.message);
    }
  });

  // 语音条请求打开主窗口（可携带识别文本：填入输入框不发送）
  ipcMain.on('voice:bar:show-main', (_, data) => {
    try {
      ctx.showWindowFromTray();
      const win = ctx.getMainWindow();
      if (!win || win.isDestroyed()) return;
      const text = (data && data.text ? data.text : '').trim();
      if (text) win.webContents.send('voice:bar:fill', { text, autoSend: false });
    } catch (e) {
      log('voice:bar:show-main 处理失败:', e && e.message);
    }
  });

  // 语音条 / 采集窗口主动报告状态（用于主界面显示麦克风状态等）
  ipcMain.on('voice:client-state', (_, state) => {
    broadcast('voice:client-state', state);
  });
}

// ---------- 引擎事件接线 ----------
function wireEngineEvents() {
  engine.on('wake', (info) => { onWake(info); });
  engine.on('stt.partial', (msg) => broadcast('voice:stt-partial', msg));
  engine.on('stt.final', (msg) => broadcast('voice:stt-final', msg));
  engine.on('tts.audio', (msg) => broadcast('voice:tts-audio', msg));
  engine.on('tts.done', (msg) => broadcast('voice:tts-done', msg));
  engine.on('tts.error', (msg) => broadcast('voice:tts-error', msg));
  engine.on('engine.error', (msg) => {
    log('引擎错误:', msg.scope, msg.error);
    broadcast('voice:error', msg);
  });
}

/**
 * 初始化语音子系统。
 * @param {object} context {
 *   ipcMain, app,
 *   getSettings: () => settings,
 *   persistSettings: () => void,
 *   getMainWindow: () => BrowserWindow,
 *   showWindowFromTray: () => void,
 *   onVoiceEvent?: (channel, payload) => void   // WebUI 桥（P2）
 * }
 */
function initVoice(context) {
  ctx = context;
  engine = new VoiceEngine({ app: ctx.app, getSettings: ctx.getSettings });
  engine.resolveModels();
  wireEngineEvents();
  registerIpc(ctx.ipcMain);
  registerHotkey();

  // 开机自启后台唤醒
  if (voiceSettings().wakeEnabled) {
    setTimeout(() => { startWake().catch((e) => log('自启唤醒失败:', e.message)); }, 3000);
  }
  return {
    engine,
    getStatus() { return engine ? engine.status() : null; },
    openVoiceBar,
    closeVoiceBar,
    setWakeEnabled,
    startWake,
    stopWake,
    registerHotkey,
    /** 设置变更后调用（唤醒词/热键/开关等） */
    async onSettingsChanged(prevVoice) {
      const v = voiceSettings();
      const prev = prevVoice || {};
      // STT 模型变更 → 重载模型并重建 worker（识别器路径锁定在 init 时）
      if (v.sttModel !== prev.sttModel) {
        const wasWake = await engine.reloadModels();
        if (wasWake && v.wakeEnabled) {
          try { await startWake(); } catch (e) { log('模型重载后重建唤醒失败:', e.message); }
        }
      }
      if (!!v.wakeEnabled !== !!prev.wakeEnabled) {
        await setWakeEnabled(!!v.wakeEnabled);
      } else if (v.wakeEnabled && JSON.stringify(v.wakeWords) !== JSON.stringify(prev.wakeWords)) {
        await startWake(); // 词表变更 → 重建 KWS
      }
      if (v.hotkey !== prev.hotkey || v.pushToTalk !== prev.pushToTalk) registerHotkey();
    },
    async dispose() {
      try { if (registeredHotkey) globalShortcut.unregister(registeredHotkey); } catch (_) {}
      destroyCaptureWindow();
      closeVoiceBar();
      if (engine) await engine.dispose();
    },
  };
}

module.exports = { initVoice };
