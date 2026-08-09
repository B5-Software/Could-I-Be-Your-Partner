/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 置顶语音条逻辑：唤醒/手动打开后自动开始听写，实时显示识别文本；
 * - 识别到发送关键词（设置 sttSendKeywords）→ 自动停止听写并发送；
 * - 说完话静默超过阈值 → 自动打开主窗口，把识别文本填入当前模式输入框并自动发送；
 * - 手动点击"主窗口" → 打开主窗口并把识别文本填入输入框（不发送）。
 */

'use strict';

(function () {
  const SESSION_ID = 'bar-stt';
  // 说完话后的静默等待时长（ms）：partial 停止这么久即认为语句完成
  const SILENCE_DONE_MS = 2000;
  // 最长聆听时长（ms），兜底防止无限听
  const MAX_LISTEN_MS = 60000;
  const el = {
    bar: document.getElementById('bar'),
    state: document.getElementById('bar-state'),
    text: document.getElementById('bar-text'),
    meter: document.getElementById('bar-meter'),
    btnMain: document.getElementById('btn-main'),
    btnRestart: document.getElementById('btn-restart'),
    btnClose: document.getElementById('btn-close'),
  };

  const mic = new VoiceMic();
  let listening = false;
  let autoCloseTimer = null;
  let silenceTimer = null;
  let maxListenTimer = null;
  let state = 'idle'; // idle | listening | thinking | speaking | error
  let pendingSend = true;
  let sendKeywords = []; // 识别到即自动停止并发送的关键词
  let voiceSettings = {};

  function setState(s, label) {
    state = s;
    el.bar.className = 'voice-bar state-' + s;
    if (label) el.state.textContent = label;
  }

  function setMeter(level) {
    const bars = el.meter.children;
    const v = Math.max(0.06, Math.min(1, level));
    for (let i = 0; i < bars.length; i++) {
      const f = Math.abs(i - 2) / 2; // 中间高两边低
      bars[i].style.height = (4 + v * 20 * (1 - f * 0.7)) + 'px';
    }
  }

  function armAutoClose(ms) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(() => { window.voiceApi.barClose(); }, ms);
  }

  // 说完话静默 → 自动收尾：停止听写 → stt.final 的事件里自动发送
  function armSilenceDone() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (listening && pendingSend) finishDictation(true);
    }, SILENCE_DONE_MS);
  }

  async function startDictation() {
    clearTimeout(autoCloseTimer);
    clearTimeout(silenceTimer);
    clearTimeout(maxListenTimer);
    el.text.textContent = '';
    pendingSend = true;
    setState('listening', '聆听中…');
    try {
      const r = await window.voiceApi.sttStart({ sessionId: SESSION_ID });
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'stt start failed');
      mic.onChunk = (buf) => window.voiceApi.sendAudio('stt', SESSION_ID, buf);
      mic.onLevel = setMeter;
      await mic.start();
      listening = true;
      // 最长聆听兜底
      maxListenTimer = setTimeout(() => { if (listening) finishDictation(true); }, MAX_LISTEN_MS);
    } catch (e) {
      setState('error', '麦克风不可用');
      el.text.textContent = String(e && e.message ? e.message : e);
      armAutoClose(6000);
    }
  }

  async function finishDictation(send) {
    if (!listening) return;
    listening = false;
    clearTimeout(silenceTimer);
    clearTimeout(maxListenTimer);
    try { await mic.stop(); } catch (_) {}
    await window.voiceApi.sttStop(SESSION_ID);
    // stt.final 事件里处理 send
    pendingSend = send;
  }

  function applyText(text, autoCloseMs) {
    el.text.textContent = text;
    if (autoCloseMs) armAutoClose(autoCloseMs);
  }

  window.voiceApi.onSttPartial((msg) => {
    if (!msg || msg.sessionId !== SESSION_ID) return;
    const text = (msg.text || '').trim();
    el.text.textContent = text;
    // 识别中命中发送关键词 → 立即自动收尾并发送（无需等待说完/静止）
    if (text && sendKeywords.length) {
      const hit = sendKeywords.find((k) => k && text.endsWith(k));
      if (hit && listening) {
        clearTimeout(silenceTimer);
        finishDictation(true);
        return;
      }
    }
    // 有内容后开始"说完静默计时"；每次增量刷新
    if (text) armSilenceTimeout();
  });

  // 静默累计：只有语句完整（以标点/关键词结尾）或超时阈值才收尾，防止半句误发
  function armSilenceTimeout() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (listening) finishDictation(true);
    }, SILENCE_DONE_MS);
  }

  window.voiceApi.onSttFinal((msg) => {
    if (!msg || msg.sessionId !== SESSION_ID) return;
    const text = stripSendKeyword((msg.text || '').trim());
    if (text && pendingSend) {
      setState('thinking', '发送中…');
      applyText(text, 4000);
      window.voiceApi.barSendCommand(text, true);
      armAutoClose(4000);
    } else if (text) {
      setState('idle', '已识别');
      applyText(text, 8000);
    } else {
      setState('idle', '未听清，点击重新识别');
      armAutoClose(6000);
    }
    pendingSend = true;
  });

  // 剔除结尾的发送关键词，避免把"发送"字样本身当指令内容
  function stripSendKeyword(text) {
    if (!sendKeywords.length) return text;
    const hit = sendKeywords.find((k) => k && text.endsWith(k));
    return hit ? text.slice(0, text.length - hit.length).trim() : text;
  }

  // 唤醒命中 → 立即开始听写
  window.voiceApi.onWakeHit(() => { startDictation(); });

  el.btnRestart.addEventListener('click', async () => {
    if (listening) { await finishDictation(false); }
    startDictation();
  });

  // 打开主窗口：携带已识别文本填入当前模式输入框（不自动发送）
  el.btnMain.addEventListener('click', async () => {
    const text = (el.text.textContent || '').trim();
    if (listening) await finishDictation(false);
    window.voiceApi.barShowMain(text);
    window.voiceApi.barClose();
  });

  el.btnClose.addEventListener('click', async () => {
    if (listening) await finishDictation(false);
    window.voiceApi.barClose();
  });

  // 加载发送关键词（voice.sttSendKeywords），与主窗口输入框听写一致
  (async () => {
    try {
      if (window.voiceApi && typeof window.voiceApi.getSettings === 'function') {
        const s = await window.voiceApi.getSettings();
        if (s && s.voice) {
          voiceSettings = s.voice;
          sendKeywords = (s.voice.sttSendKeywords || []).filter(Boolean);
        }
        // 主题：应用设置里强制浅/深色，并同步自定义强调色
        const th = (s && s.theme) || {};
        if (th.mode === 'dark' || th.mode === 'light') {
          document.documentElement.dataset.theme = th.mode;
        }
        const accent = th.accentColor || '';
        if (/^#[0-9a-fA-F]{3,8}$/.test(accent)) {
          document.documentElement.style.setProperty('--accent', accent);
        }
      }
    } catch (_) {}
  })();

  // 手动点开（非唤醒）时也开始听写
  startDictation();
})();