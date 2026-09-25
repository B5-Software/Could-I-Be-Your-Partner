  function bindVoiceSettings() {
    const setChkId = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice[key] = el.checked;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    };
    setChkId('setting-voice-stt', 'sttEnabled');
    setChkId('setting-voice-tts', 'ttsEnabled');
    setChkId('setting-voice-tts-auto', 'ttsAutoSpeak');

    const bind = (id, key, transform) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        const val = el.type === 'checkbox' ? el.checked : el.value;
        if (transform) transform(s.voice, val);
        else s.voice[key] = val;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    };
    bind('setting-voice-tts-lang', 'ttsLang');
    bind('setting-voice-stt-model', 'sttModel');
    bind('setting-voice-kws-threshold', 'threshold', (voice, val) => { if (!voice.kws) voice.kws = {}; voice.kws.threshold = parseFloat(val) || 0.25; });
    bind('setting-voice-stt-send-keywords', 'sttSendKeywords', (voice, val) => {
      voice.sttSendKeywords = String(val || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    });

    // 中文音色
    const zhEl = document.getElementById('setting-voice-zh');
    if (zhEl) zhEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.ttsVoices) s.voice.ttsVoices = {};
      s.voice.ttsVoices.zh = zhEl.value;
      await saveVoiceSettings(s);
      try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
    });
    const enEl = document.getElementById('setting-voice-en');
    if (enEl) enEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.ttsVoices) s.voice.ttsVoices = {};
      s.voice.ttsVoices.en = enEl.value;
      await saveVoiceSettings(s);
      try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
    });

    // 长文本自动分块开关
    const chunkToggleEl = document.getElementById('setting-voice-tts-chunk');
    if (chunkToggleEl) {
      chunkToggleEl.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice.ttsAutoChunk = chunkToggleEl.checked;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
        const sizeEl = document.getElementById('setting-voice-tts-chunk-size');
        const row = sizeEl && sizeEl.closest('.setting-item');
        if (row) row.style.opacity = chunkToggleEl.checked ? '1' : '0.4';
      });
    }
    const chunkSizeEl = document.getElementById('setting-voice-tts-chunk-size');
    if (chunkSizeEl) {
      chunkSizeEl.addEventListener('input', () => {
        const valEl = document.getElementById('setting-voice-tts-chunk-size-val');
        if (valEl) valEl.textContent = chunkSizeEl.value + '字';
      });
      chunkSizeEl.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice.ttsChunkChars = parseInt(chunkSizeEl.value) || 80;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    }
    // 语速/音量 range
    for (const [id, key, label] of [['setting-voice-speed', 'ttsSpeed', 'x'], ['setting-voice-volume', 'ttsVolume', '%']]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        const valEl = document.getElementById(id + '-val');
        if (valEl) valEl.textContent = key === 'ttsSpeed' ? (parseInt(el.value) / 100).toFixed(2) + label : el.value + label;
      });
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice[key] = parseInt(el.value) / 100;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    }
    // 唤醒
    setChkId('setting-voice-wake', 'wakeEnabled');
    // 热键
    const hotkeyEl = document.getElementById('setting-voice-hotkey');
    if (hotkeyEl) hotkeyEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      s.voice.hotkey = hotkeyEl.value;
      await saveVoiceSettings(s);
    });
    // 试听按钮
    const testBtn = document.getElementById('btn-voice-test');
    if (testBtn) testBtn.addEventListener('click', () => {
      const lang = document.getElementById('setting-voice-tts-lang')?.value || 'zh';
      const testTexts = { zh: '你好，我是你的AI伙伴，很高兴能为你服务！', en: 'Hello! I am your AI partner, ready to assist you.', de: 'Hallo! Ich bin dein KI-Partner und helfe dir gerne.' };
      try { if (window.VoiceUI) window.VoiceUI.speakText(testTexts[lang] || testTexts.zh, lang); } catch (_) {}
    });
    // 添加唤醒词
    const addBtn = document.getElementById('btn-voice-add-wake');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const phrase = document.getElementById('voice-new-wake-phrase')?.value?.trim();
      const action = document.getElementById('voice-new-wake-action')?.value || 'voicebar';
      if (!phrase) return;
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.wakeWords) s.voice.wakeWords = [];
      s.voice.wakeWords.push({ phrase, action, enabled: true });
      document.getElementById('voice-new-wake-phrase').value = '';
      await saveVoiceSettings(s, '唤醒词已添加');
      renderWakeWordsList(s);
    });
    // 录制热键
    const recBtn = document.getElementById('btn-voice-record-hotkey');
    if (recBtn) {
      recBtn.addEventListener('click', () => {
        const input = document.getElementById('setting-voice-hotkey');
        if (!input) return;
        const origText = recBtn.textContent;
        const origDisabled = recBtn.disabled;
        recBtn.textContent = '按下组合键（松开结束）…';
        recBtn.disabled = true;

        // 归一化按键名（修饰键统一命名，字母大写，空格映射为 Space）
        const norm = (e) => {
          const k = e.key || '';
          if (k === 'Control' || k === 'Ctrl') return 'Control';
          if (k === 'Shift') return 'Shift';
          if (k === 'Alt') return 'Alt';
          if (k === 'Meta') return 'Command';
          if (k === ' ') return 'Space';
          if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase();
          return k;
        };

        const pressed = new Set();   // 当前按住的键（归一化）
        const recorded = new Set();  // 本次录制出现过的键（用于最终组合）
        const isModifier = (n) => ['Control', 'Shift', 'Alt', 'Command'].includes(n);

        const render = () => {
          // 修饰键按固定顺序排列在前，主键在后
          const mods = ['Control', 'Command', 'Shift', 'Alt'].filter((m) => recorded.has(m));
          const main = [...recorded].find((n) => !isModifier(n));
          const parts = main ? [...mods, main] : mods;
          input.value = parts.join('+');
        };

        const cleanup = (commit) => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('keyup', onKeyUp, true);
          window.removeEventListener('blur', onBlur, true);
          recBtn.textContent = origText;
          recBtn.disabled = origDisabled;
          // 提交录制结果：触发 change 事件以持久化到设置
          if (commit && recorded.size > 0) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };

        const onKeyDown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') { cleanup(false); return; }
          const n = norm(e);
          if (!n) return;
          pressed.add(n);
          recorded.add(n);
          render();
        };

        const onKeyUp = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const n = norm(e);
          if (!n) return;
          pressed.delete(n);
          // 全部松开且本次已录入至少一个键 → 完成
          if (pressed.size === 0 && recorded.size > 0) {
            cleanup(true);
          }
        };

        const onBlur = () => {
          if (recorded.size > 0 && pressed.size === 0) {
            cleanup(true);
          }
        };

        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur, true);
      });
    }
    // 刷新模型状态
    const refreshBtn = document.getElementById('btn-voice-refresh-status');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshVoiceModelStatus());
  }

  bindVoiceSettings();
  loadVoiceSettings();
  // 启动时将语音设置同步给 VoiceUI（试听/自动朗读依赖 settings 判开关）
  window.api.getSettings().then((s) => {
    if (window.VoiceUI) {
      try { window.VoiceUI.applySettings(s); } catch (_) {}
    }
  });
