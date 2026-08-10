/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 置顶语音条逻辑：唤醒/手动打开后自动开始听写，实时显示识别文本；
 * - 唤醒命中场景由常驻采集窗直通分流音频（shared 模式，不重新 getUserMedia，防丢句首）；
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
  let sharedStream = false; // true=音频由采集窗分流（唤醒命中场景），本窗口不采集
  let autoCloseTimer = null;
  let silenceTimer = null;
  let maxListenTimer = null;
  let state = 'idle'; // idle | listening | thinking | speaking | error
  let pendingSend = true;
  let sendKeywords = []; // 识别到即自动停止并发送的关键词
  let voiceSettings = {};
  let lastKeyword = ''; // 本次唤醒使用的唤醒词（识别文本段首剔除用）

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

  async function startDictation(shared) {
    clearTimeout(autoCloseTimer);
    clearTimeout(silenceTimer);
    clearTimeout(maxListenTimer);
    let sttOn = true;
    try {
      const cfg = await window.voiceApi.getSettings();
      sttOn = !(cfg && cfg.voice && cfg.voice.sttEnabled === false);
    } catch (_) {}
    if (!sttOn) { setState('error', '语音识别已关闭'); armAutoClose(4000); return; }
    // 模式切换（如窗口已自采又被唤醒命中）：先停旧采集，会话保持 bar-stt 幂等
    if (listening && shared !== sharedStream) {
      listening = false;
      if (!sharedStream) {
        try { await mic.stop(); } catch (_) {}
      }
      mic.onChunk = null;
    }
    el.text.textContent = '';
    pendingSend = true;
    setState('listening', '聆听中…');
    try {
      // 唤醒直通（主进程 onWake）已预建会话；此处幂等重开。VAD 用默认参数（与主窗口听写一致）
      const r = await window.voiceApi.sttStart({
        sessionId: SESSION_ID,
      });
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'stt start failed');
      if (shared) {
        sharedStream = true;
        mic.onChunk = null;
        mic.onLevel = setMeter;
      } else {
        sharedStream = false;
        mic.onChunk = (buf) => window.voiceApi.sendAudio('stt', SESSION_ID, buf);
        mic.onLevel = setMeter;
        await mic.start();
      }
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
    // 先置标志再停：sttStop 异步触发 stt.final，若后置 pendingSend 会有竞态（final 先到 → 误发送）
    pendingSend = send;
    if (!sharedStream) {
      try { await mic.stop(); } catch (_) {}
    }
    await window.voiceApi.sttStop(SESSION_ID);
    // shared 模式窗口不再采集，避免残留监听
    if (sharedStream) { mic.onChunk = null; }
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
    const text = stripSendKeyword(stripLeadKeyword((msg.text || '').trim()));
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

  // 剔除段首的唤醒词（唤醒直通补喂了命中前缓冲，识别文本常以唤醒词开头，如"伙伴伙伴查一下…"）
  function stripLeadKeyword(text) {
    if (!lastKeyword || !text) return text;
    const t = text.trim();
    const compact = lastKeyword.replace(/\s+/g, '');
    const plain = lastKeyword.replace(/[\s,，。.、:：；;!！?？·~～]+/g, '');
    let out = t;
    for (const k of [lastKeyword, compact, plain]) {
      if (k && out.startsWith(k)) {
        out = out.slice(k.length).trim();
        break;
      }
    }
    return out === t ? t : out.replace(/^[\s,，。.、:：；;!！?？·~～]+/, '').trim();
  }

  // 重新识别：丢弃当前会话并重新开始（不触发 final，不发送）
  el.btnRestart.addEventListener('click', async () => {
    clearTimeout(autoCloseTimer);
    clearTimeout(silenceTimer);
    clearTimeout(maxListenTimer);
    if (listening) {
      listening = false;
      pendingSend = false;
      if (!sharedStream) {
        try { await mic.stop(); } catch (_) {}
      }
      try { await window.voiceApi.sttCancel(SESSION_ID); } catch (_) {}
    }
    startDictation(sharedStream);
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

  // 唤醒命中 → 立即开始听写（shared=true：音频由采集窗分流，本窗口不采集）
  // 页面加载兜底：600ms 内无唤醒命中则视为手动打开（自采听写）
  let manualTimer = setTimeout(() => { startDictation(false); }, 600);
  window.voiceApi.onWakeHit((d) => {
    clearTimeout(manualTimer);
    lastKeyword = String((d && (d.phrase || d.keyword)) || '').trim();
    startDictation(!!(d && d.shared));
  });
})();