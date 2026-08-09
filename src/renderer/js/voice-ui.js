/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 主窗口语音控制器：
 *   - 输入框语音听写（麦克风按钮 / 全局热键）
 *   - AI 流式回复的实时 TTS 播报（SentenceFeeder → 主进程合成 → 流式播放）
 *   - 打断（barge-in）：开始说话/唤醒即停止播报
 */

'use strict';

(function () {
  const DICTATION_SESSION = 'main-dictation';
  const TTS_REQ_PREFIX = 'main-tts';

  let settings = null;
  let mic = null;
  let player = null;
  let feeder = null;
  let dictating = false;
  let dictationBaseText = '';
  let dictationInput = null; // 本次听写固定的目标输入框
  let streamFeedActive = false; // 当前是否有 LLM 流在投喂
  let fedAnyChunk = false;
  let ttsReqCounter = 0;

  function voiceCfg() {
    return (settings && settings.voice) || {};
  }
  function sttEnabled() { return voiceCfg().sttEnabled !== false; }
  function ttsOn() { return voiceCfg().ttsEnabled === true; }
  function autoSpeakOn() { return ttsOn() && voiceCfg().ttsAutoSpeak === true; }

  // 当前激活模式所属的输入框：'chat' | 'code' | 'babe'
  function getActiveMode() {
    if (typeof window.getCurrentMode === 'function') {
      const m = window.getCurrentMode();
      if (m === 'code' || m === 'babe') return m;
    }
    // 兜底：从激活页面推断
    if (document.getElementById('page-code')?.classList.contains('active')) return 'code';
    if (document.getElementById('page-babe')?.classList.contains('active')) return 'babe';
    return 'chat';
  }

  const INPUT_ID = { chat: 'chat-input', code: 'code-chat-input', babe: 'babe-chat-input' };
  const MIC_ID = { chat: 'btn-mic', code: 'btn-code-mic', babe: 'btn-babe-mic' };

  function getChatInput() {
    const mode = getActiveMode();
    return document.getElementById(INPUT_ID[mode]) || document.getElementById('chat-input');
  }

  function getMicButtons() {
    return Object.values(MIC_ID).map(id => document.getElementById(id)).filter(Boolean);
  }

  function ensurePlayer() {
    if (!player) {
      player = new VoicePlayer();
      player.setVolume(voiceCfg().ttsVolume != null ? voiceCfg().ttsVolume : 1.0);
    }
    return player;
  }

  function ensureFeeder() {
    if (!feeder) {
      feeder = new SentenceFeeder({
        langOverride: voiceCfg().ttsLang || 'auto',
        enabled: () => true, // speak 调用方自行判断开关
        speak: (sentence, lang) => {
          if (!window.api || !window.api.voiceTtsSpeak) return;
          const reqId = `${TTS_REQ_PREFIX}-${ttsReqCounter}`;
          window.api.voiceTtsSpeak({
            reqId,
            text: sentence,
            lang,
            speed: voiceCfg().ttsSpeed != null ? voiceCfg().ttsSpeed : 1.0,
          }).catch(() => {});
        },
      });
    }
    feeder.opts.langOverride = voiceCfg().ttsLang || 'auto';
    return feeder;
  }

  // ---------- 听写 ----------
  async function startDictation() {
    if (dictating || !sttEnabled()) return;
    if (!window.api || !window.api.voiceSttStart) return;
    try {
      // 开始说话即打断播报
      stopSpeaking();
      const r = await window.api.voiceSttStart({ sessionId: DICTATION_SESSION });
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'stt start failed');
      if (!mic) mic = new VoiceMic();
      mic.onChunk = (buf) => window.api.voiceSendAudio('stt', DICTATION_SESSION, buf);
      mic.onLevel = null;
      await mic.start();
      dictating = true;
      dictationInput = getChatInput();
      const input = dictationInput;
      if (input) {
        dictationBaseText = input.value;
        input.dataset.origPlaceholder = input.placeholder;
        input.placeholder = '正在聆听…';
        input.focus();
      }
      updateMicButton(true);
    } catch (e) {
      dictating = false;
      updateMicButton(false);
      if (typeof window.showToast === 'function') {
        window.showToast('麦克风不可用：' + (e && e.message ? e.message : e), 'error', 4000);
      }
    }
  }

  async function stopDictation(cancel) {
    if (!dictating) return;
    dictating = false;
    updateMicButton(false);
    try { if (mic) await mic.stop(); } catch (_) {}
    const input = dictationInput;
    dictationInput = null;
    if (input) input.placeholder = input.dataset.origPlaceholder || input.placeholder;
    try {
      if (cancel) await window.api.voiceSttCancel(DICTATION_SESSION);
      else await window.api.voiceSttStop(DICTATION_SESSION);
      if (cancel) {
        // 还原听写前文本
        if (input) input.value = dictationBaseText;
      }
    } catch (_) {}
  }

  function toggleDictation() {
    if (dictating) stopDictation(false);
    else startDictation();
  }

  function updateMicButton(active) {
    const activeId = MIC_ID[getActiveMode()];
    getMicButtons().forEach(btn => {
      const isActive = active && btn.id === activeId;
      btn.classList.toggle('mic-active', isActive);
      const icon = btn.querySelector('i');
      if (icon) icon.className = isActive ? 'fa-solid fa-stop' : 'fa-solid fa-microphone';
    });
  }

  // ---------- TTS 播报 ----------
  function stopSpeaking() {
    try { if (window.api && window.api.voiceTtsStop) window.api.voiceTtsStop(); } catch (_) {}
    try { if (player) player.stop(); } catch (_) {}
    try { if (feeder) feeder.cancel(); } catch (_) {}
    streamFeedActive = false;
    fedAnyChunk = false;
    ttsReqCounter++;
  }

  /** agent.js 流式钩子：token 增量 */
  function feedStreamChunk(content) {
    if (!autoSpeakOn()) return;
    if (!content) return;
    if (!streamFeedActive) {
      streamFeedActive = true;
      fedAnyChunk = false;
      ensureFeeder().reset();
      ttsReqCounter++;
    }
    fedAnyChunk = true;
    feeder.push(content);
  }

  /** agent.js 流式钩子：结束（data 为最终消息，用于非流式回退） */
  function feedStreamEnd(finalContent) {
    if (!autoSpeakOn()) { streamFeedActive = false; fedAnyChunk = false; return; }
    if (!streamFeedActive && !fedAnyChunk && finalContent) {
      // 非流式路径：一次性播报最终文本
      ensureFeeder().reset();
      feeder.push(finalContent);
    }
    if (feeder) feeder.flush();
    streamFeedActive = false;
    fedAnyChunk = false;
  }

  /** 手动朗读一段文本（设置页试听 / 消息喇叭按钮） */
  function speakText(text, lang) {
    if (!ttsOn() || !text) return;
    stopSpeaking();
    ensureFeeder().reset();
    const f = ensureFeeder();
    const prevOverride = f.opts.langOverride;
    if (lang) f.opts.langOverride = lang;
    f.push(text);
    f.flush();
    f.opts.langOverride = prevOverride;
  }

  // ---------- 事件接线 ----------
  function wireEvents() {
    if (!window.api) return;
    if (window.api.onVoiceSttPartial) {
      window.api.onVoiceSttPartial((msg) => {
        if (!msg || msg.sessionId !== DICTATION_SESSION || !dictating) return;
        const input = dictationInput;
        if (!input) return;
        const sep = dictationBaseText && !/\s$/.test(dictationBaseText) ? ' ' : '';
        input.value = dictationBaseText + (msg.text ? sep + msg.text : '');
        input.dispatchEvent(new Event('input', { bubbles: true })); // 触发自动增高
        input.scrollTop = input.scrollHeight;
      });
    }
    if (window.api.onVoiceSttFinal) {
      window.api.onVoiceSttFinal((msg) => {
        if (!msg || msg.sessionId !== DICTATION_SESSION) return;
        // 优先用本次听写固定目标框；停止后可能已置空，回退到当前激活输入框
        const input = dictationInput || getChatInput();
        if (input) {
          const sep = dictationBaseText && !/\s$/.test(dictationBaseText) ? ' ' : '';
          const finalText = (msg.text || '').trim();
          input.value = finalText ? dictationBaseText + sep + finalText : dictationBaseText;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        }
      });
    }
    if (window.api.onVoiceTtsAudio) {
      window.api.onVoiceTtsAudio((msg) => {
        if (!msg || !msg.reqId || String(msg.reqId).indexOf(TTS_REQ_PREFIX) !== 0) return;
        ensurePlayer().push(msg.reqId, msg.samples, msg.sampleRate);
      });
    }
    if (window.api.onVoiceTtsDone) {
      window.api.onVoiceTtsDone((msg) => {
        if (!msg || !msg.reqId || String(msg.reqId).indexOf(TTS_REQ_PREFIX) !== 0) return;
        ensurePlayer().finish(msg.reqId);
      });
    }
    if (window.api.onVoiceHotkeyToggle) {
      window.api.onVoiceHotkeyToggle(() => toggleDictation());
    }
    if (window.api.onVoiceWake) {
      window.api.onVoiceWake(() => stopSpeaking());
    }
    if (window.api.onVoiceError) {
      window.api.onVoiceError((msg) => {
        if (typeof window.showToast === 'function' && msg && msg.error) {
          window.showToast('语音引擎：' + msg.error, 'warn', 4000);
        }
      });
    }
  }

  function bindMicButton() {
    getMicButtons().forEach(btn => btn.addEventListener('click', () => toggleDictation()));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dictating) stopDictation(true);
    });
  }

  /** 由 app.js 在设置加载/保存后调用 */
  function applySettings(s) {
    settings = s;
    if (player) player.setVolume(voiceCfg().ttsVolume != null ? voiceCfg().ttsVolume : 1.0);
    if (feeder) feeder.opts.langOverride = voiceCfg().ttsLang || 'auto';
    // 总开关关闭时立即停止播报与听写
    if (!ttsOn()) stopSpeaking();
    if (!sttEnabled() && dictating) stopDictation(true);
  }

  function init() {
    bindMicButton();
    wireEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.VoiceUI = {
    applySettings,
    feedStreamChunk,
    feedStreamEnd,
    speakText,
    stopSpeaking,
    toggleDictation,
    startDictation,
    stopDictation,
    get dictating() { return dictating; },
  };
})();
