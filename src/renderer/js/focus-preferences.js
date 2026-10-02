/* SPDX-License-Identifier: GPL-3.0-or-later */
// Minimal windows share only appearance settings, never the main App API.
(() => {
  const api = window.vmSplash || window.vmDesktop || window.voiceApi;
  const apply = ({ theme = {} } = {}) => {
    document.documentElement.dataset.focusOutlines = theme.focusOutlines === false ? 'off' : 'on';
    if (/^#[0-9a-f]{6}$/i.test(theme.accentColor || ''))
      document.documentElement.style.setProperty('--accent', theme.accentColor);
  };
  api?.getTheme?.().then(apply).catch(() => {});
  api?.onThemeApply?.(apply);
})();
