  /* ==================== 设置页：输入法标签 ==================== */
  async function loadImeSettings() {
    const s = await window.api.getSettings();
    const ime = s.ime || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    set('setting-ime-mode', ime.mode || 'zh');
    set('setting-ime-candidate-count', ime.candidateCount ?? 9);
    setChk('setting-ime-enabled', ime.enabled);
    const opEl = document.getElementById('setting-ime-opacity');
    const opVal = document.getElementById('setting-ime-opacity-val');
    const opPct = Math.round((ime.opacity ?? 1) * 100);
    if (opEl) { opEl.value = Math.max(30, Math.min(100, opPct)); if (opVal) opVal.textContent = opEl.value + '%'; }
  }

  function bindImeSettings() {
    const els = {
      'setting-ime-mode': (v) => ({ mode: v }),
      'setting-ime-candidate-count': (v) => ({ candidateCount: parseInt(v) || 9 }),
      'setting-ime-enabled': (v) => ({ enabled: !!v }),
      'setting-ime-opacity': (v) => ({ opacity: (parseInt(v) || 100) / 100 }),
    };
    Object.keys(els).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const build = els[id];
      const handler = async (e) => {
        let val = e.target.value;
        if (e.target.type === 'checkbox') val = e.target.checked;
        const s = await window.api.getSettings();
        s.ime = Object.assign({}, s.ime || {}, build(val));
        await saveSettings(s);
        if (getOskCore()) getOskCore().applySettings(s.ime);
        if (id === 'setting-ime-enabled') {
          const osk = getOskCore();
          if (val && osk) { osk._ensureDict().catch(() => {}); osk.show(); }
          if (!val && osk) osk.hide();
        }
        window.showToast?.('输入法设置已保存', 'success', 2000);
      };
      el.addEventListener('change', handler);
      if (el.type === 'range') {
        el.addEventListener('input', () => {
          const valId = id + '-val';
          const valEl = document.getElementById(valId);
          if (valEl) valEl.textContent = (id === 'setting-ime-opacity') ? el.value + '%' : el.value + 'px';
        });
      }
    });
  }

  // 挂载到 loadSettingsPage：每次打开设置页时刷新输入法设置
  bindImeSettings();
  loadImeSettings();
