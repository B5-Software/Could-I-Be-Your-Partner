/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 置顶语音条逻辑：唤醒后自动开始听写，实时显示识别文本；
 * 静默自动收尾 → 指令发送主窗口 Agent 后台执行 → 等待 TTS 回复（主窗口出声）。
 */

'use strict';

(function () {
  const SESSION_ID = 'bar-stt';
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
  let state = 'idle'; // idle | listening | thinking | speaking | error

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

  async function startDictation() {
    clearTimeout(autoCloseTimer);
    el.text.textContent = '';
    setState('listening', '聆听中…');
    try {
      const r = await window.voiceApi.sttStart({ sessionId: SESSION_ID });
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'stt start failed');
      mic.onChunk = (buf) => window.voiceApi.sendAudio('stt', SESSION_ID, buf);
      mic.onLevel = setMeter;
      await mic.start();
      listening = true;
      // 最长聆听 60s 自动停止
      armAutoClose(60000);
    } catch (e) {
      setState('error', '麦克风不可用');
      el.text.textContent = String(e && e.message ? e.message : e);
      armAutoClose(6000);
    }
  }

  async function finishDictation(send) {
    if (!listening) return;
    listening = false;
    try { await mic.stop(); } catch (_) {}
    await window.voiceApi.sttStop(SESSION_ID);
    // stt.final 事件里处理 send
    pendingSend = send;
  }

  let pendingSend = true;

  window.voiceApi.onSttPartial((msg) => {
    if (!msg || msg.sessionId !== SESSION_ID) return;
    el.text.textContent = msg.text || '';
  });

  window.voiceApi.onSttFinal((msg) => {
    if (!msg || msg.sessionId !== SESSION_ID) return;
    const text = (msg.text || '').trim();
    if (text && pendingSend) {
      setState('thinking', '执行中…');
      el.text.textContent = text;
      window.voiceApi.barSendCommand(text);
      // Agent 回复经主窗口 TTS 播报；语音条显示片刻后自动关闭
      armAutoClose(20000);
    } else if (text) {
      setState('idle', '已识别（未发送）');
      el.text.textContent = text;
      armAutoClose(8000);
    } else {
      setState('idle', '未听清，点击重新识别');
      armAutoClose(6000);
    }
    pendingSend = true;
  });

  // 唤醒命中 → 立即开始听写
  window.voiceApi.onWakeHit(() => { startDictation(); });

  el.btnRestart.addEventListener('click', async () => {
    if (listening) { await finishDictation(false); }
    startDictation();
  });
  el.btnMain.addEventListener('click', () => window.voiceApi.barShowMain());
  el.btnClose.addEventListener('click', async () => {
    if (listening) await finishDictation(false);
    window.voiceApi.barClose();
  });

  // 手动点开（非唤醒）时也开始听写
  startDictation();
})();
