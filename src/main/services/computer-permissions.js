/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

function createComputerPermissions({
  platform,
  preferences,
  app,
  shell,
  nativeStatus,
  nativeRequest,
  getSettings,
  persistSettings,
}) {
  const requested = new Set();
  const identity = app.getPath('exe');
  function status() {
    if (platform !== 'darwin')
      return {
        ok: true,
        location: 'host',
        platform,
        accessibility: 'not-required',
        screen: 'not-required',
        ready: true,
      };
    let native, backendError;
    try {
      native = nativeStatus();
    } catch (error) {
      backendError = error.message;
    }
    let accessibility = native?.accessibility ? 'granted' : 'denied';
    let screen = native?.screen ? 'granted' : 'denied';
    if (!native) {
      try {
        accessibility = preferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
      } catch {
        accessibility = 'unknown';
      }
      try {
        screen = preferences.getMediaAccessStatus('screen');
      } catch {
        screen = 'unknown';
      }
    }
    return {
      ok: true,
      location: 'host',
      platform,
      accessibility,
      screen,
      postEvents: native ? !!native.postEvents : false,
      ready: !!native && accessibility === 'granted' && !!native.postEvents && screen === 'granted',
      backend: 'native-AX-CG',
      backendError,
      executable: identity,
      packaged: !!app.isPackaged,
      appName: app.getName(),
      restartMayBeRequired: screen !== 'granted' || accessibility !== 'granted',
      guidance:
        '在系统设置 → 隐私与安全性中，为当前运行的应用开启「辅助功能」及「屏幕与系统音频录制」。开发模式需授权 Electron；安装版需授权 CIBYP。修改后重新检测，系统尚未刷新时退出并重启应用。',
    };
  }
  function check(kind) {
    if (platform !== 'darwin') return null;
    const current = status();
    if (current.backendError)
      return {
        ok: false,
        code: 'computer_backend_unavailable',
        error:
          'macOS 原生控制模块未就绪。开发环境运行 npm run build:computer；安装版请使用包含该模块的新版本。',
        permissions: current,
      };
    if (
      kind === 'screen'
        ? current.screen === 'granted'
        : current.accessibility === 'granted' && (kind === 'tree' || current.postEvents)
    )
      return null;
    return {
      ok: false,
      code: kind === 'screen' ? 'screen_permission_required' : 'accessibility_required',
      error: current.guidance,
      permissions: current,
      retryable: false,
    };
  }
  async function request(permission) {
    if (!['accessibility', 'screen'].includes(permission))
      return { ok: false, error: 'Unknown permission' };
    if (platform !== 'darwin') return status();
    const current = status();
    if (current[permission] === 'granted') return current;
    const settings = getSettings();
    const marks = settings.permissions?.computerRequests || {};
    const key = `${identity}:${permission}`;
    if (requested.has(key) || marks[key]) return { ...current, alreadyRequested: true };
    // Mark BEFORE the native call; repeated clicks/restarts cannot trigger a prompt loop.
    requested.add(key);
    settings.permissions ||= {};
    settings.permissions.computerRequests = { ...marks, [key]: true };
    await persistSettings();
    try {
      nativeRequest(permission);
    } catch (error) {
      return { ...status(), ok: false, error: error.message };
    }
    return status();
  }
  async function openSettings(permission) {
    if (platform !== 'darwin' || !['accessibility', 'screen'].includes(permission))
      return { ok: false, error: 'Unsupported permission settings' };
    await shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?Privacy_${permission === 'screen' ? 'ScreenCapture' : 'Accessibility'}`,
    );
    return { ok: true };
  }
  return { status, check, request, openSettings };
}

module.exports = { createComputerPermissions };
