  /* ==================== 屏幕软键盘 (OSK) ==================== */
  function getOskCore() {
    return window.OskCoreInstance || null;
  }
  function toggleOsk() {
    const osk = getOskCore();
    if (!osk) return;
    if (osk.visible) osk.hide();
    else { osk._ensureDict().catch(() => {}); osk.show(); }
    syncOskBtn();
  }

  function syncOskBtn() {
    const osk = getOskCore();
    const btn = document.getElementById('osk-toggle-btn');
    if (btn && osk) {
      btn.classList.toggle('active', osk.visible);
      btn.setAttribute('data-active', osk.visible ? '1' : '0');
    }
  }

  // 标题栏按钮
  const oskToggleBtn = document.getElementById('osk-toggle-btn');
  if (oskToggleBtn) {
    oskToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOsk();
    });
  }

  // 快捷键 F8
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F8') {
      e.preventDefault();
      toggleOsk();
    }
  });

  // WebUI → 切换屏幕软键盘
  if (typeof window.api?.onWebControlToggleOsk === 'function') {
    window.api.onWebControlToggleOsk(() => { toggleOsk(); syncOskBtn(); });
  }

  // OSK 状态变化 → 同步标题栏按钮 + WebUI
  function oskStateObserver() {
    const osk = getOskCore();
    if (!osk) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(oskStateObserver, 50));
      } else {
        setTimeout(oskStateObserver, 100);
      }
      return;
    }
    const origPush = osk._pushWebState.bind(osk);
    osk._pushWebState = () => {
      syncOskBtn();
      origPush();
    };
  }
  oskStateObserver();

  // 设置变化 → 同步到 OSK（含子页面 settings:changed 广播）
  if (typeof window.api?.onSettingsChanged === 'function') {
    window.api.onSettingsChanged((s) => {
      if (s && s.ime && getOskCore()) getOskCore().applySettings(s.ime);
      // 托盘语音唤醒开关 → 设置页勾选状态联动回显
      if (s && s.voice && typeof s.voice.wakeEnabled === 'boolean') {
        const wakeEl = document.getElementById('setting-voice-wake');
        if (wakeEl && wakeEl.checked !== s.voice.wakeEnabled) wakeEl.checked = s.voice.wakeEnabled;
      }
    });
  }

  // 语音唤醒：采集窗状态/引擎错误 → 全局 toast。
  // macOS 隐藏采集窗口的 getUserMedia 失败（麦克风权限）与 AudioContext 挂起此前完全静默，
  // 用户勾选唤醒后毫无反应也看不到原因。
  if (typeof window.api?.onVoiceClientState === 'function') {
    let lastCaptureError = '';
    window.api.onVoiceClientState((d) => {
      if (!d || d.source !== 'capture') return;
      if (d.error) {
        if (d.error === lastCaptureError) return;
        lastCaptureError = d.error;
        const hint = /(notallowed|permission|denied|拒绝|权限)/i.test(d.error)
          ? '（请在 系统设置 → 隐私与安全性 → 麦克风 中允许本应用）'
          : '';
        if (typeof window.showToast === 'function') {
          window.showToast(`语音唤醒采集失败：${d.error}${hint}`, 'error', 7000);
        }
      } else {
        lastCaptureError = '';
      }
    });
  }
  if (typeof window.api?.onVoiceError === 'function') {
    let lastWakeError = '';
    window.api.onVoiceError((d) => {
      if (!d || d.scope !== 'wake') return;
      const msg = String(d.error || d.message || '');
      if (!msg || msg === lastWakeError) return;
      lastWakeError = msg;
      if (typeof window.showToast === 'function') {
        window.showToast(`语音唤醒异常：${msg}`, 'error', 7000);
      }
    });
  }
