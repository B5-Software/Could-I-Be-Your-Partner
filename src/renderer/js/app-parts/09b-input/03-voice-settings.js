  /* ==================== 设置页：语音标签 ==================== */
  async function loadVoiceSettings() {
    const s = await window.api.getSettings();
    const v = s.voice || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    setChk('setting-voice-stt', v.sttEnabled !== false);
    set('setting-voice-stt-model', (v.sttModel === 'tiny' ? 'tiny' : 'base'));
    set('setting-voice-stt-send-keywords', (v.sttSendKeywords || []).join('、'));
    setChk('setting-voice-tts', v.ttsEnabled === true);
    setChk('setting-voice-tts-auto', v.ttsAutoSpeak === true);
    set('setting-voice-tts-lang', v.ttsLang || 'auto');
    set('setting-voice-zh', (v.ttsVoices && v.ttsVoices.zh) || 'zf_xiaoxiao');
    set('setting-voice-en', (v.ttsVoices && v.ttsVoices.en) || 'af_heart');
    const speedEl = document.getElementById('setting-voice-speed');
    const speedValEl = document.getElementById('setting-voice-speed-val');
    const speed = Math.round((v.ttsSpeed != null ? v.ttsSpeed : 1.0) * 100);
    if (speedEl) { speedEl.value = Math.max(50, Math.min(200, speed)); if (speedValEl) speedValEl.textContent = (speed / 100).toFixed(2) + 'x'; }
    const volEl = document.getElementById('setting-voice-volume');
    const volValEl = document.getElementById('setting-voice-volume-val');
    const vol = Math.round((v.ttsVolume != null ? v.ttsVolume : 1.0) * 100);
    if (volEl) { volEl.value = Math.max(10, Math.min(100, vol)); if (volValEl) volValEl.textContent = vol + '%'; }
    const chunkEl = document.getElementById('setting-voice-tts-chunk');
    const chunkSizeEl = document.getElementById('setting-voice-tts-chunk-size');
    const chunkSizeValEl = document.getElementById('setting-voice-tts-chunk-size-val');
    const chunkEnabled = v.ttsAutoChunk !== false;
    if (chunkEl) chunkEl.checked = chunkEnabled;
    const chunkChars = v.ttsChunkChars != null ? Math.round(v.ttsChunkChars) : 120;
    if (chunkSizeEl) {
      chunkSizeEl.value = Math.max(40, Math.min(300, chunkChars));
      if (chunkSizeValEl) chunkSizeValEl.textContent = Math.max(40, Math.min(300, chunkChars)) + '字';
    }
    const chunkRow = chunkSizeEl && chunkSizeEl.closest('.setting-item');
    if (chunkRow) chunkRow.style.opacity = chunkEnabled ? '1' : '0.4';
    setChk('setting-voice-wake', v.wakeEnabled === true);
    set('setting-voice-kws-threshold', (v.kws && v.kws.threshold != null) ? String(v.kws.threshold) : '0.25');
    set('setting-voice-hotkey', v.hotkey || 'Control+Shift+Space');
    renderWakeWordsList(s);
    refreshVoiceModelStatus();
  }

  async function renderWakeWordsList(s) {
    const listEl = document.getElementById('voice-wake-words-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const words = (s && s.voice && s.voice.wakeWords) || [];
    if (words.length === 0) {
      listEl.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary)">暂无唤醒词</span>';
      return;
    }
    words.forEach((w, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;';
      const tag = document.createElement('span');
      tag.textContent = w.phrase;
      tag.style.cssText = 'flex:1;padding:2px 8px;background:var(--surface-alt);border-radius:4px;';
      const actLabel = w.action === 'mainwindow' ? '弹主窗' : '语音条';
      const actEl = document.createElement('span');
      actEl.textContent = actLabel;
      actEl.style.cssText = 'font-size:10px;color:var(--text-tertiary);min-width:40px;text-align:right;';
      const enChk = document.createElement('input');
      enChk.type = 'checkbox';
      enChk.checked = w.enabled !== false;
      enChk.title = '启用';
      enChk.style.cssText = 'margin:0;cursor:pointer';
      enChk.addEventListener('change', async () => {
        const currentS = await window.api.getSettings();
        const currentW = (currentS.voice && currentS.voice.wakeWords) || [];
        if (currentW[idx]) currentW[idx].enabled = enChk.checked;
        if (!currentS.voice) currentS.voice = {};
        currentS.voice.wakeWords = currentW;
        await saveVoiceSettings(currentS, '唤醒词已更新');
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon';
      delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      delBtn.style.cssText = 'font-size:10px;padding:0;width:18px;height:18px';
      delBtn.addEventListener('click', async () => {
        const currentS = await window.api.getSettings();
        const currentW = (currentS.voice && currentS.voice.wakeWords) || [];
        currentW.splice(idx, 1);
        if (!currentS.voice) currentS.voice = {};
        currentS.voice.wakeWords = currentW;
        await saveVoiceSettings(currentS, '唤醒词已删除');
        renderWakeWordsList(currentS);
      });
      row.appendChild(tag);
      row.appendChild(actEl);
      row.appendChild(enChk);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  async function saveVoiceSettings(s, toast) {
    if (typeof s === 'string') { toast = s; s = await window.api.getSettings(); }
    if (!s) s = await window.api.getSettings();
    try {
      await saveSettings(s);
      if (toast && typeof window.showToast === 'function') window.showToast(toast, 'success', 2000);
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('保存失败: ' + (e && e.message), 'error', 3000);
    }
  }

  async function refreshVoiceModelStatus() {
    const el = document.getElementById('voice-model-status');
    if (!el) return;
    try {
      const r = await window.api.voiceGetStatus();
      if (r && r.ok) {
        const caps = r.capabilities;
        if (caps) {
          const mark = (ok) => (ok ? '就绪' : '缺失');
          const deNote = caps.ttsDe && caps.ttsDe.ready === false ? '（德语音色可选，未下载）' : '';
          el.textContent = `语音识别: ${mark(caps.stt?.ready !== false)} · 语音朗读: ${mark(caps.tts?.ready !== false)}${deNote} · 后台唤醒: ${mark(caps.wake?.ready !== false)}`;
        } else if (r.missing && r.missing.length) {
          el.textContent = '缺失模型: ' + r.missing.join(', ');
        } else {
          el.textContent = '模型就绪（Whisper 识别 + Kokoro 中英 + Piper 德语）';
        }
      } else {
        el.textContent = '语音引擎未启动或模型缺失';
      }
    } catch {
      el.textContent = '无法查询引擎状态';
    }
    refreshVoiceGate().catch(() => {});
  }

  /** 语音模型门控：按能力（STT / TTS / 唤醒）分别锁定，缺一个不影响其余功能 */
  async function refreshVoiceGate() {
    const gate = document.getElementById('voice-model-gate');
    const panel = document.querySelector('.settings-panel[data-tab="voice"]');
    if (!gate || !panel) return;
    let st = null;
    try {
      st = window.api?.voiceGetStatus ? await window.api.voiceGetStatus() : null;
    } catch (_) {}
    if (st && st.supported === false) {
      gate.classList.add('hidden');
      panel.querySelectorAll('.settings-group[data-voice-cap]').forEach((g) => {
        g.classList.remove('voice-locked');
        try { g.inert = false; } catch (_) {}
      });
      return;
    }
    const caps = st?.capabilities || null;
    const missing = st?.missingRequired || [];
    const sttReady = caps?.stt ? caps.stt.ready !== false : !missing.some(id => String(id).startsWith('stt-'));
    const ttsReady = caps?.tts ? caps.tts.ready !== false : !missing.includes('tts-kokoro');
    const wakeReady = caps?.wake ? caps.wake.ready !== false : !(missing.includes('kws') || missing.includes('vad'));
    const capReady = { stt: sttReady, tts: ttsReady, wake: wakeReady };
    panel.querySelectorAll('.settings-group[data-voice-cap]').forEach((g) => {
      const ready = capReady[g.dataset.voiceCap] !== false;
      g.classList.toggle('voice-locked', !ready);
      try { g.inert = !ready; } catch (_) { g.style.pointerEvents = ready ? '' : 'none'; }
    });
    const allReady = sttReady && ttsReady && wakeReady;
    gate.classList.toggle('hidden', allReady);
    const txt = document.getElementById('voice-model-gate-text');
    if (txt && !allReady) {
      const labelMap = { vad: 'VAD', kws: '唤醒词 KWS', 'stt-base': 'Whisper base', 'stt-tiny': 'Whisper tiny', 'tts-kokoro': 'Kokoro 语音合成', 'tts-piper-de': 'Piper 德语' };
      const fmt = (arr) => (arr || []).map(id => labelMap[id] || id).join('、');
      const parts = [];
      if (!sttReady) parts.push(`语音识别（缺 ${fmt(caps?.stt?.missing) || 'Whisper'}）`);
      if (!ttsReady) parts.push(`语音朗读（缺 ${fmt(caps?.tts?.missing) || 'Kokoro'}）`);
      if (!wakeReady) parts.push(`后台唤醒（缺 ${fmt(caps?.wake?.missing) || 'KWS/VAD'}）`);
      const usable = [];
      if (sttReady) usable.push('语音识别');
      if (ttsReady) usable.push('语音朗读');
      if (wakeReady) usable.push('后台唤醒');
      const titleEl = gate.querySelector('.voice-model-gate-text strong');
      if (titleEl) titleEl.textContent = allReady ? '语音模型未就绪' : '部分语音模型未就绪';
      txt.textContent = `${parts.join('；')}。${usable.length ? usable.join('、') + ' 仍可正常使用；' : ''}可前往「资源下载」按需下载缺失模型。`;
    }
    try { window.VoiceUI?.refreshMicVisibility?.(); } catch (_) {}
  }
