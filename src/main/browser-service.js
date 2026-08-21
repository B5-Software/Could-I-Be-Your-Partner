/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Playwright 浏览器控制服务：按工作区维护浏览器上下文/页面、有头模式横幅、
 * 浏览器 IPC 工具（导航/截图/点击/输入/执行脚本等）。
 * 通过工厂函数注入 settings / mainWindow / imagesDir 访问器。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, dialog, screen } = require('electron');

module.exports = function registerPlaywrightIpc({ ipcMain, getSettings, getMainWindow, getImagesDir, getUserDataPath }) {
let _pwBrowser = null; // shared browser instance (chromium.launch 或 launchPersistentContext)
let _pwDataMode = 'isolated'; // 当前浏览器实例的数据模式（isolated/persistent/profile-copy）
const _pwWorkspaces = new Map(); // workspacePath -> { context, page }

// Get Playwright settings (with defaults)
function _getPwSettings() {
  const s = getSettings() || {};
  const dm = s.playwright?.dataMode;
  return {
    mode: s.playwright?.mode || 'auto',
    path: s.playwright?.path || '',
    followLang: s.playwright?.followLang !== false,
    args: s.playwright?.args || '',
    // 默认有头模式（headless=false）。settings.playwright.headless 显式为 true 时才无头
    headless: s.playwright?.headless === true,
    // 横幅开关：默认开启。仅在 headed 模式下显示，headless 模式始终不显示
    bannerEnabled: s.playwright?.bannerEnabled !== false,
    // 浏览器数据模式：isolated(每次全新) / persistent(持久化配置) / profile-copy(系统浏览器副本)
    dataMode: (dm === 'persistent' || dm === 'profile-copy') ? dm : 'isolated',
    // profile-copy 的来源浏览器（chrome/edge），用于定位系统 User Data 目录
    profileSource: s.playwright?.profileSource === 'edge' ? 'edge' : (s.playwright?.profileSource === 'chrome' ? 'chrome' : '')
  };
}

// ---- 浏览器数据目录（持久化 / 系统浏览器副本）----

function _getPersistentProfileDir() {
  const base = typeof getUserDataPath === 'function' ? getUserDataPath() : path.join(process.cwd(), 'userdata');
  return path.join(base, 'playwright-profile');
}

function _getCloneProfileDir() {
  const base = typeof getUserDataPath === 'function' ? getUserDataPath() : path.join(process.cwd(), 'userdata');
  return path.join(base, 'playwright-profile-clone');
}

// 各平台 Chrome/Edge 默认 User Data 目录（profile-copy 来源）
function _defaultUserDataDir(browserKey) {
  const home = require('os').homedir();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return browserKey === 'edge'
      ? path.join(local, 'Microsoft', 'Edge', 'User Data')
      : path.join(local, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    return browserKey === 'edge'
      ? path.join(appSupport, 'Microsoft Edge')
      : path.join(appSupport, 'Google', 'Chrome');
  }
  return browserKey === 'edge'
    ? path.join(home, '.config', 'microsoft-edge')
    : path.join(home, '.config', 'google-chrome');
}

// 异步统计目录大小与文件数（大目录可能耗时，调用方自行决定是否展示进度）
async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(d) {
    let entries = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        try { const st = await fs.promises.stat(full); files++; bytes += st.size; } catch { /* race */ }
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

// 带进度的递归复制（先删目标再复制；onProgress(0..1)）
async function copyDirWithProgress(src, dst, onProgress) {
  const stat = await dirStats(src);
  const totalBytes = Math.max(1, stat.bytes);
  let copied = 0;
  let lastCb = 0;
  async function walk(s, d) {
    await fs.promises.mkdir(d, { recursive: true });
    let entries = [];
    try { entries = await fs.promises.readdir(s, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const from = path.join(s, e.name);
      const to = path.join(d, e.name);
      if (e.isDirectory()) await walk(from, to);
      else {
        try {
          await fs.promises.copyFile(from, to);
          try { const st = await fs.promises.stat(from); copied += st.size; } catch { /* race */ }
          if (typeof onProgress === 'function') {
            const now = Date.now();
            if (now - lastCb > 120) { lastCb = now; onProgress(Math.min(1, copied / totalBytes)); }
          }
        } catch { /* 单文件失败不阻断（如被占用的锁文件） */ }
      }
    }
  }
  await walk(src, dst);
  if (typeof onProgress === 'function') onProgress(1);
  return { files: stat.files, bytes: totalBytes };
}

// Search for browser binaries on the system
function _searchBrowserBinaries() {
  const found = [];
  const { execSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const candidates = [];

  if (process.platform === 'win32') {
    // Windows registry-based paths
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      { name: 'Microsoft Edge', path: `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`, channel: 'msedge' },
      { name: 'Microsoft Edge (x86)', path: `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`, channel: 'msedge' },
      { name: 'Google Chrome', path: `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`, channel: 'chrome' },
      { name: 'Google Chrome (x86)', path: `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`, channel: 'chrome' },
      { name: 'Google Chrome (User)', path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`, channel: 'chrome' }
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', channel: 'msedge' },
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', channel: 'chrome' },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium', channel: 'chromium' }
    );
  } else {
    // Linux
    candidates.push(
      { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge', channel: 'msedge' },
      { name: 'Google Chrome', path: '/usr/bin/google-chrome', channel: 'chrome' },
      { name: 'Google Chrome (alt)', path: '/usr/bin/google-chrome-stable', channel: 'chrome' },
      { name: 'Chromium', path: '/usr/bin/chromium', channel: 'chromium' },
      { name: 'Chromium (alt)', path: '/usr/bin/chromium-browser', channel: 'chromium' }
    );
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c.path)) {
        found.push({ name: c.name, path: c.path, channel: c.channel });
      }
    } catch { /* skip */ }
  }
  return found;
}

// Get Accept-Language header value based on app language
function _getPwAcceptLanguage(lang) {
  const map = {
    'zh-CN': 'zh-CN,zh;q=0.9,en;q=0.8',
    'en': 'en-US,en;q=0.9',
    'de': 'de-DE,de;q=0.9,en;q=0.8'
  };
  return map[lang] || map['en'];
}

async function _launchPwBrowser(overrideSettings = null) {
  // 检查现有实例是否仍然连接；若已断开（用户关闭/崩溃），置空后重新启动
  // 注意：持久化模式下 _pwBrowser 是 BrowserContext（无 isConnected 方法），
  // 其死亡由 disconnected 监听器清理，这里默认存活。
  if (_pwBrowser) {
    let alive = true;
    try {
      if (typeof _pwBrowser.isConnected === 'function') alive = _pwBrowser.isConnected();
    } catch {
      console.log('[Playwright] 检查连接状态异常，清理后重新启动');
      alive = false;
    }
    if (alive) {
      return _pwBrowser;
    }
    console.log('[Playwright] 现有实例已断开，清理后重新启动');
    _pwBrowser = null;
    _pwWorkspaces.clear();
    _hidePwBanner();
  }
  const { chromium } = require('playwright');
  // 支持临时覆盖设置（用于测试启动），不修改全局 settings，避免恢复时覆盖已保存的设置
  const pwSettings = overrideSettings || _getPwSettings();
  console.log('[Playwright] _launchPwBrowser mode=', pwSettings.mode, 'path=', pwSettings.path, 'headless=', pwSettings.headless);
  const appLang = getSettings()?.language || 'zh-CN';
  const headless = !!pwSettings.headless;

  // Parse extra args from user
  let extraArgs = [];
  if (pwSettings.args) {
    extraArgs = pwSettings.args.split('\n').map(s => s.trim()).filter(Boolean);
  }
  // 只过滤会抑制 Chrome 自带"正受到自动测试软件的控制"提示条的参数
  // 注意：--disable-blink-features=AutomationControlled 是反网站检测的，应保留
  // 只有 --disable-automation 和 --excludeSwitches=enable-automation 会抑制 Chrome 自带提示条
  extraArgs = extraArgs.filter(a =>
    !/--disable-automation(?:=|$)/.test(a) &&
    !/--excludeSwitches.*enable-automation/.test(a)
  );
  // 默认添加反自动化检测参数（防网站识别 webdriver，但保留 Chrome 自带提示条）
  const hasAntiDetect = extraArgs.some(a => /--disable-blink-features.*AutomationControlled/.test(a));
  if (!hasAntiDetect) {
    extraArgs.push('--disable-blink-features=AutomationControlled');
  }

  let lastError = null;

  // ---- 浏览器数据模式：persistent / profile-copy → launchPersistentContext ----
  // （登录态/cookies/localStorage 落盘到专用目录，跨会话保留；与系统浏览器完全隔离）
  const dataMode = pwSettings.dataMode === 'persistent' || pwSettings.dataMode === 'profile-copy'
    ? pwSettings.dataMode : 'isolated';
  if (dataMode !== 'isolated') {
    const userDataDir = dataMode === 'profile-copy' ? _getCloneProfileDir() : _getPersistentProfileDir();
    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* ignore */ }
    // 复用与隔离模式相同的浏览器来源链（custom → chromium → edge → chrome → auto → 内置回退），
    // 唯一区别是 launch → launchPersistentContext
    const tryPersistent = async (launchOpts) => {
      const launchConfig = {
        headless,
        viewport: { width: 1280, height: 720 },
        args: extraArgs,
        ...launchOpts
      };
      if (dataMode === 'profile-copy') {
        // 副本里的 Cookie 是源浏览器用"真实钥匙串密钥"加密的；
        // Playwright 默认注入 --use-mock-keychain（macOS）会用 mock 密钥解密失败，
        // Chromium 会把解不开的 Cookie 静默删除。改用真实钥匙串以保留登录态
        // （首次启动 macOS 可能弹一次钥匙串授权，选"始终允许"）。
        if (process.platform === 'darwin') {
          launchConfig.ignoreDefaultArgs = ['--use-mock-keychain'];
        }
      }
      const ctx = await chromium.launchPersistentContext(userDataDir, launchConfig);
      _pwBrowser = ctx;
      _pwDataMode = dataMode;
      console.log(`[Playwright] launched persistent context (${dataMode}) dir=${userDataDir} headless=${headless}`);
      _onPwBrowserLaunched(!headless);
      _attachPwDisconnectListener(ctx);
      return ctx;
    };
    if (pwSettings.mode === 'custom' && pwSettings.path) {
      return await tryPersistent({ executablePath: pwSettings.path });
    }
    if (pwSettings.mode === 'chromium') {
      return await tryPersistent({});
    }
    if (pwSettings.mode === 'edge') {
      return await tryPersistent({ channel: 'msedge' });
    }
    if (pwSettings.mode === 'chrome') {
      return await tryPersistent({ channel: 'chrome' });
    }
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await tryPersistent({ channel });
      } catch (e) {
        console.warn('Channel', channel, 'persistent launch failed:', e.message);
        lastError = e;
      }
    }
    try {
      return await tryPersistent({});
    } catch (e) {
      throw new Error('无法启动持久化 Playwright 浏览器: ' + (lastError?.message || e.message));
    }
  }
  _pwDataMode = 'isolated';

  if (pwSettings.mode === 'custom' && pwSettings.path) {
    // Custom browser path
    try {
      _pwBrowser = await chromium.launch({
        headless,
        executablePath: pwSettings.path,
        args: extraArgs
      });
      console.log('Playwright launched with custom path:', pwSettings.path, 'headless:', headless);
      _onPwBrowserLaunched(!headless);
      _attachPwDisconnectListener(_pwBrowser);
      return _pwBrowser;
    } catch (e) {
      console.warn('Custom browser launch failed:', e.message);
      throw new Error('无法启动指定的浏览器: ' + e.message);
    }
  }

  if (pwSettings.mode === 'chromium') {
    try {
      _pwBrowser = await chromium.launch({ headless, args: extraArgs });
      console.log('Playwright launched with built-in Chromium, headless:', headless);
      _onPwBrowserLaunched(!headless);
      _attachPwDisconnectListener(_pwBrowser);
      return _pwBrowser;
    } catch (e) {
      throw new Error('内置 Chromium 启动失败: ' + e.message + '。请运行 npx playwright install chromium。');
    }
  }

  if (pwSettings.mode === 'edge') {
    try {
      _pwBrowser = await chromium.launch({ headless, channel: 'msedge', args: extraArgs });
      console.log('Playwright launched with Microsoft Edge, headless:', headless);
      _onPwBrowserLaunched(!headless);
      _attachPwDisconnectListener(_pwBrowser);
      return _pwBrowser;
    } catch (e) {
      // 用户显式选择 Edge，失败时不应回退到 Chrome，直接报错
      throw new Error('无法启动 Microsoft Edge: ' + e.message + '。请确认 Edge 已安装。');
    }
  }

  if (pwSettings.mode === 'chrome') {
    try {
      _pwBrowser = await chromium.launch({ headless, channel: 'chrome', args: extraArgs });
      console.log('Playwright launched with Google Chrome, headless:', headless);
      _onPwBrowserLaunched(!headless);
      _attachPwDisconnectListener(_pwBrowser);
      return _pwBrowser;
    } catch (e) {
      // 用户显式选择 Chrome，失败时不应回退到 Edge，直接报错
      throw new Error('无法启动 Google Chrome: ' + e.message + '。请确认 Chrome 已安装。');
    }
  }

  // Auto mode: try Edge → Chrome → Chromium
  const channels = ['msedge', 'chrome'];
  for (const channel of channels) {
    try {
      _pwBrowser = await chromium.launch({ headless, channel, args: extraArgs });
      console.log('Playwright launched with channel:', channel, 'headless:', headless);
      _onPwBrowserLaunched(!headless);
      _attachPwDisconnectListener(_pwBrowser);
      return _pwBrowser;
    } catch (e) {
      console.warn('Channel', channel, 'launch failed:', e.message);
      lastError = e;
    }
  }
  try {
    _pwBrowser = await chromium.launch({ headless, args: extraArgs });
    console.log('Playwright launched with built-in Chromium (auto fallback), headless:', headless);
    _onPwBrowserLaunched(!headless);
    _attachPwDisconnectListener(_pwBrowser);
    return _pwBrowser;
  } catch (e) {
    throw new Error('无法启动Playwright浏览器（未找到Edge/Chrome，且Playwright浏览器未安装）。请安装Microsoft Edge或Google Chrome，或运行 npx playwright install chromium。错误: ' + (lastError?.message || e.message));
  }
}

// ---- Playwright 有头模式屏幕右上角横幅 ----
// 在屏幕右上角（不是窗口右上角）显示一个 always-on-top 横幅，提示用户不要关闭浏览器
// 显示条件：headed 模式 + 用户启用 banner（settings.playwright.bannerEnabled）
// 无头模式始终不显示
let _pwBannerWindow = null;
function _onPwBrowserLaunched(headed) {
  if (headed && _getPwSettings().bannerEnabled) {
    _showPwBanner();
  } else {
    _hidePwBanner();
  }
}
// 为浏览器实例注册 disconnected 监听器（仅在首次启动时注册一次）
// 浏览器被用户关闭、崩溃、或主动关闭时自动清理状态并隐藏横幅
function _attachPwDisconnectListener(browser) {
  if (!browser || browser._cibypDisconnectListener) return;
  browser._cibypDisconnectListener = () => {
    console.log('[Playwright] Browser disconnected, cleaning up');
    // 标记正在清理，避免 pw:closeBrowser handler 重复 close
    if (browser._cibypClosing) return;
    browser._cibypClosing = true;
    _pwBrowser = null;
    _pwWorkspaces.clear();
    _hidePwBanner();
  };
  browser.on('disconnected', browser._cibypDisconnectListener);
}
function _showPwBanner() {
  if (_pwBannerWindow && !_pwBannerWindow.isDestroyed()) return;
  try {
    const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
    const bannerWidth = 320;
    const bannerHeight = 56;
    _pwBannerWindow = new BrowserWindow({
      width: bannerWidth,
      height: bannerHeight,
      x: Math.max(0, sw - bannerWidth - 12),
      y: 12,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      focusable: false,
      hasShadow: false,
      type: 'toolbar',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    _pwBannerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    _pwBannerWindow.setAlwaysOnTop(true, 'screen-saver');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; background: transparent; }
      body {
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        -webkit-app-region: no-drag;
      }
      .banner {
        width: 100%; height: 100%;
        background: linear-gradient(135deg, rgba(231, 111, 81, 0.96), rgba(231, 76, 60, 0.96));
        color: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.15);
        display: flex; align-items: center; gap: 10px;
        padding: 0 16px;
        font-size: 13px;
        backdrop-filter: blur(8px);
      }
      .banner .icon { font-size: 18px; font-style: normal; font-weight: 700; line-height: 1; }
      .banner .title { font-weight: 700; font-size: 13px; }
      .banner .sub { font-size: 11px; opacity: 0.9; }
    </style></head><body>
      <div class="banner">
        <span class="icon">&#9888;</span>
        <div>
          <div class="title">请勿关闭浏览器</div>
          <div class="sub">Agent 正在使用此浏览器执行自动化任务</div>
        </div>
      </div>
    </body></html>`;
    _pwBannerWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    _pwBannerWindow.setIgnoreMouseEvents(true);
    _pwBannerWindow.showInactive();
  } catch (e) {
    console.warn('[Playwright] Failed to show banner:', e.message);
  }
}
function _hidePwBanner() {
  if (_pwBannerWindow && !_pwBannerWindow.isDestroyed()) {
    try { _pwBannerWindow.destroy(); } catch {}
    _pwBannerWindow = null;
  }
}

async function _closePwBrowserInternal() {
  for (const [, ws] of _pwWorkspaces) {
    await ws.context.close().catch(() => {});
  }
  _pwWorkspaces.clear();
  if (_pwBrowser) {
    await _pwBrowser.close().catch(() => {});
    _pwBrowser = null;
  }
  _pwDataMode = 'isolated';
}

async function ensureBrowser(workspacePath) {
  const key = workspacePath || '__default__';
  // 每次调用 Playwright 工具都重新显示横幅（Agent 第二轮操作浏览器时横幅已被隐藏）
  _showPwBanner();
  const existing = _pwWorkspaces.get(key);
  if (existing) {
    try { if (!existing.page.isClosed()) return existing.page; } catch { /* ignore */ }
    _pwWorkspaces.delete(key);
  }
  const pwSettings = _getPwSettings();
  const appLang = getSettings()?.language || 'zh-CN';
  const contextOptions = { viewport: { width: 1280, height: 720 } };
  // Apply browser language based on app language setting
  if (pwSettings.followLang) {
    const acceptLang = _getPwAcceptLanguage(appLang);
    contextOptions.locale = appLang;
    contextOptions.extraHTTPHeaders = { 'Accept-Language': acceptLang };
  }
  let context;
  const wantPersistent = pwSettings.dataMode === 'persistent' || pwSettings.dataMode === 'profile-copy';
  if (wantPersistent) {
    // 持久化模式：浏览器实例即上下文（launchPersistentContext），
    // 多工作区共享同一 cookies 集（与真实用户行为一致），各自独立页面
    if (!_pwBrowser || _pwDataMode === 'isolated') {
      if (_pwBrowser) await _closePwBrowserInternal();
      await _launchPwBrowser();
    }
    context = (_pwBrowser.contexts && _pwBrowser.contexts()[0]) || _pwBrowser;
    if (!context) throw new Error('持久化浏览器上下文未就绪');
    // 持久化模式下 locale/viewport 在启动参数中不可动态改，语言头按需补注
    if (pwSettings.followLang) {
      try { await context.setExtraHTTPHeaders({ 'Accept-Language': _getPwAcceptLanguage(appLang) }); } catch { /* ignore */ }
    }
  } else {
    if (_pwDataMode !== 'isolated' && _pwBrowser) await _closePwBrowserInternal();
    const browser = await _launchPwBrowser();
    context = await browser.newContext(contextOptions);
  }
  // 注入反自动化检测脚本（在页面脚本执行前覆盖 navigator.webdriver 等属性）
  // 注意：launch 参数 --disable-blink-features=AutomationControlled 已经隐藏了大部分检测，
  // 这里再注入脚本作为双重保险，覆盖更多属性。持久化上下文只注入一次。
  if (!context._cibypInitApplied) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      // 覆盖 chrome 对象（仅 Chrome 有，Edge 也有）
      if (!window.chrome) {
        window.chrome = { runtime: {}, app: { isInstalled: false } };
      }
      // 覆盖 permissions API（部分网站通过 Permissions.query 检测）
      const origQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (origQuery) {
        window.navigator.permissions.query = (params) => (
          params && params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params)
        );
      }
    });
    context._cibypInitApplied = true;
  }
  const page = await context.newPage();
  _pwWorkspaces.set(key, { context, page });
  return page;
}

function _getPage(workspacePath) {
  const key = workspacePath || '__default__';
  const ws = _pwWorkspaces.get(key);
  return ws ? ws.page : null;
}

// 每次调用 Playwright 工具时都重新显示横幅（Agent 第二轮操作浏览器时横幅已被 idle 隐藏）
// 无论浏览器是新启动还是已缓存，都确保横幅可见
function _ensurePwBannerShown() {
  try { _showPwBanner(); } catch { /* ignore */ }
}

ipcMain.handle('browser:navigate', async (_, url, waitUntil, workspacePath) => {
  try {
    if (!url || typeof url !== 'string') return { ok: false, error: 'URL 参数缺失或无效' };
    let page = _getPage(workspacePath);
    if (!page) page = await ensureBrowser(workspacePath);
    let targetUrl = url;
    if (!/^https?:\/\//.test(targetUrl)) targetUrl = 'https://' + targetUrl;
    await page.goto(targetUrl, { waitUntil: waitUntil || 'load', timeout: 30000 });
    return { ok: true, url: targetUrl, title: await page.title() };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:screenshot', async (_, fullPage, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    const buf = await page.screenshot({ fullPage: !!fullPage, type: 'png' });
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    let filePath = null;
    try {
      // Code 模式：检测 .cibyp-code-history 目录，保存到其 assets/ 子目录
      let saveDir = getImagesDir();
      if (workspacePath && fs.existsSync(workspacePath)) {
        const codeHistDir = path.join(workspacePath, '.cibyp-code-history');
        if (fs.existsSync(codeHistDir)) {
          const assetsDir = path.join(codeHistDir, 'assets');
          try { fs.mkdirSync(assetsDir, { recursive: true }); } catch {}
          saveDir = assetsDir;
        } else {
          saveDir = workspacePath;
        }
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fname = 'browser-screenshot-' + ts + '.png';
      filePath = path.join(saveDir, fname);
      fs.writeFileSync(filePath, buf);
    } catch (saveErr) { console.warn('Screenshot save failed:', saveErr.message); }
    return { ok: true, dataUrl, filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:click', async (_, selector, timeout, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    await page.click(selector, { timeout: timeout || 5000 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:type', async (_, selector, text, submit, clear, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    if (clear !== false) await page.fill(selector, '');
    await page.fill(selector, text);
    if (submit) {
      await page.press(selector, 'Enter');
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:getContent', async (_, selector, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    const url = page.url();
    const title = await page.title();
    if (selector) {
      const text = await page.$eval(selector, el => el.innerText || '').catch(() => '');
      const html = await page.$eval(selector, el => el.innerHTML || '').catch(() => '');
      return { ok: true, html: (html || '').slice(0, 5000), text: (text || '').slice(0, 3000), url, title };
    }
    const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    const html = await page.evaluate(() => document.documentElement.outerHTML || '').catch(() => '');
    return { ok: true, html: (html || '').slice(0, 5000), text: (text || '').slice(0, 3000), url, title };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:evaluate', async (_, script, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    const result = await page.evaluate(script);
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:scroll', async (_, direction, amount, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    const dy = direction === 'down' ? (amount || 500) : -(amount || 500);
    await page.evaluate(d => window.scrollBy(0, d), dy);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:back', async (_, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    await page.goBack({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:forward', async (_, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    await page.goForward({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:refresh', async (_, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:wait', async (_, selector, timeout, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    if (selector) {
      await page.waitForSelector(selector, { timeout: timeout || 5000 });
      return { ok: true, message: `元素 ${selector} 已出现` };
    }
    await page.waitForTimeout(timeout || 1000);
    return { ok: true, message: `已等待 ${timeout || 1000}ms` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:hover', async (_, selector, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    await page.hover(selector, { timeout: 5000 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:select', async (_, selector, value, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    await page.selectOption(selector, value);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:getInfo', async (_, workspacePath) => {
  try {
    _ensurePwBannerShown();
    const page = _getPage(workspacePath);
    if (!page) return { ok: false, error: 'no page' };
    return {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => '')
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:close', async (_, workspacePath) => {
  try {
    if (workspacePath) {
      const ws = _pwWorkspaces.get(workspacePath);
      if (ws) {
        await ws.context.close().catch(() => {});
        _pwWorkspaces.delete(workspacePath);
      }
    } else {
      // close all
      for (const [key, ws] of _pwWorkspaces) {
        await ws.context.close().catch(() => {});
      }
      _pwWorkspaces.clear();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Playwright Settings ----
ipcMain.handle('pw:searchBrowsers', async () => {
  try {
    const found = _searchBrowserBinaries();
    return { ok: true, browsers: found };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('pw:browserDialog', async () => {
  try {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择浏览器可执行文件',
      filters: [
        { name: '可执行文件', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled) return { ok: false };
    return { ok: true, path: result.filePaths[0] };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('pw:testLaunch', async (_, testPwSettings) => {
  try {
    // 不修改全局 settings，直接用 overrideSettings 启动测试
    _pwBrowser = null;
    _pwDataMode = 'isolated';
    // Close existing workspaces to force relaunch
    for (const [key, ws] of _pwWorkspaces) {
      await ws.context.close().catch(() => {});
    }
    _pwWorkspaces.clear();
    // Try launching with override settings
    const browser = await _launchPwBrowser(testPwSettings || {});
    const ok = !!browser;
    // 获取浏览器真实 product 信息（用于验证 channel 选择是否生效）
    let productInfo = '';
    try {
      // 持久化模式下 browser 即 BrowserContext（无 newContext）
      const ctx = (typeof browser.newContext === 'function')
        ? await browser.newContext()
        : (browser.contexts && browser.contexts()[0]) || browser;
      const page = await ctx.newPage();
      const version = await page.context().newCDPSession(page).then(s => s.send('Browser.getVersion')).catch(() => null);
      if (version) productInfo = version.product || '';
      if (ctx !== browser) await ctx.close().catch(() => {});
      else await page.close().catch(() => {});
    } catch { /* ignore version probe */ }
    // Close the test browser
    await browser.close().catch(() => {});
    _pwBrowser = null;
    return { ok, message: '浏览器启动成功' + (productInfo ? `（${productInfo}）` : '') };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- 浏览器数据模式：系统浏览器配置副本（profile-copy）----

// 枚举可复制的系统浏览器 User Data 来源（含存在性校验）
ipcMain.handle('pw:getProfileSources', async () => {
  try {
    const candidates = [
      { id: 'chrome', name: 'Google Chrome' },
      { id: 'edge', name: 'Microsoft Edge' }
    ];
    const sources = [];
    for (const c of candidates) {
      const dir = _defaultUserDataDir(c.id);
      const exists = fs.existsSync(dir);
      let size = null;
      if (exists) {
        try { size = await dirStats(dir); } catch { /* ignore */ }
      }
      sources.push({ id: c.id, name: c.name, userDataDir: dir, exists, files: size ? size.files : 0, bytes: size ? size.bytes : 0 });
    }
    return { ok: true, sources };
  } catch (e) { return { ok: false, error: e.message }; }
});

let _pwCopyProgressWin = null;
function _showCopyProgress() {
  if (_pwCopyProgressWin && !_pwCopyProgressWin.isDestroyed()) return _pwCopyProgressWin;
  try {
    _pwCopyProgressWin = new BrowserWindow({
      width: 380, height: 110, frame: false, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      show: false, transparent: true, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
      .card { background: rgba(28,28,34,.96); color:#fff; border-radius: 12px; padding: 14px 16px;
              box-shadow: 0 10px 30px rgba(0,0,0,.35); }
      .t { font-size: 12.5px; font-weight: 600; margin-bottom: 8px; }
      .bar { height: 6px; background: rgba(255,255,255,.15); border-radius: 99px; overflow: hidden; }
      .fill { height: 100%; width: 0%; background: linear-gradient(90deg,#4f8cff,#38c6d9); border-radius: 99px; transition: width .15s ease; }
      .pct { font-size: 11px; opacity: .75; margin-top: 6px; text-align: right; font-variant-numeric: tabular-nums; }
    </style></head><body><div class="card">
      <div class="t">正在复制浏览器配置…</div>
      <div class="bar"><div class="fill" id="f"></div></div>
      <div class="pct" id="p">0%</div>
    </div></body></html>`;
    _pwCopyProgressWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    _pwCopyProgressWin.showInactive();
  } catch (e) {
    console.warn('[Playwright] copy progress window failed:', e.message);
    _pwCopyProgressWin = null;
  }
  return _pwCopyProgressWin;
}
function _updateCopyProgress(pct) {
  const win = _pwCopyProgressWin;
  if (!win || win.isDestroyed()) return;
  const v = Math.max(0, Math.min(100, Math.round(pct * 100)));
  try {
    win.webContents.executeJavaScript(`(function(){var f=document.getElementById('f');var p=document.getElementById('p');if(f)f.style.width='${v}%';if(p)p.textContent='${v}%';})();`);
  } catch { /* ignore */ }
}
function _hideCopyProgress() {
  if (_pwCopyProgressWin && !_pwCopyProgressWin.isDestroyed()) {
    try { _pwCopyProgressWin.destroy(); } catch {}
  }
  _pwCopyProgressWin = null;
}

// 复制系统浏览器 User Data → 独立副本目录（首次确认 + 进度窗）
ipcMain.handle('pw:copyProfile', async (_, sourceId) => {
  const src = _defaultUserDataDir(sourceId === 'edge' ? 'edge' : 'chrome');
  if (!fs.existsSync(src)) return { ok: false, error: `未找到 ${sourceId === 'edge' ? 'Edge' : 'Chrome'} 的用户数据目录` };
  const dst = _getCloneProfileDir();
  // 预估大小
  let stat = { files: 0, bytes: 0 };
  try { stat = await dirStats(src); } catch { /* ignore */ }
  const mb = (stat.bytes / 1048576).toFixed(1);
  // 确认对话框：必须先关闭源浏览器；提示体积
  try {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['开始复制', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '复制浏览器配置',
      message: `将复制 ${sourceId === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} 的用户数据到 Agent 专用目录`,
      detail: `来源：${src}\n大小约 ${mb} MB（${stat.files} 个文件）\n\n注意：\n· 请先完全退出该浏览器，否则部分文件可能复制失败\n· 副本与原配置相互独立，之后在 Agent 浏览器中的操作不影响原浏览器\n· 部分站点可能因 Cookie 加密机制需要重新登录一次\n\n目标目录：${dst}`
    });
    if (response !== 0) return { ok: false, canceled: true };
  } catch (e) { return { ok: false, error: e.message }; }
  // 清空旧副本
  try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* ignore */ }
  _showCopyProgress();
  try {
    await copyDirWithProgress(src, dst, (p) => _updateCopyProgress(p));
    _hideCopyProgress();
    return { ok: true, dest: dst, files: stat.files, bytes: stat.bytes };
  } catch (e) {
    _hideCopyProgress();
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pw:closeBrowser', async () => {
  try {
    await _closePwBrowserInternal();
    _hidePwBanner();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- 头像框系统 ----
// 列出所有内置 SVG 头像框
ipcMain.handle('avatar-frames:list', async () => {
  try {
    const framesDir = path.join(__dirname, '..', 'renderer', 'assets', 'avatar-frames');
    const files = await fs.promises.readdir(framesDir);
    const list = files
      .filter(f => f.endsWith('.svg'))
      .sort()
      .map(f => ({ id: f.replace(/\.svg$/, ''), file: f }));
    return { ok: true, frames: list };
  } catch (e) { return { ok: false, frames: [], error: e.message }; }
});

// 读取单个 SVG 头像框内容
ipcMain.handle('avatar-frames:get', async (_, id) => {
  try {
    const file = id.endsWith('.svg') ? id : `${id}.svg`;
    const filePath = path.join(__dirname, '..', 'renderer', 'assets', 'avatar-frames', file);
    const content = await fs.promises.readFile(filePath, 'utf8');
    return { ok: true, content };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 隐藏 Playwright 横幅（不关闭浏览器）— Agent 工作完成时调用
ipcMain.handle('pw:hideBanner', () => {
  _hidePwBanner();
  return { ok: true };
});

  return { _hidePwBanner, ensureBrowser, _getPwSettings, _defaultUserDataDir, dirStats, copyDirWithProgress, _getPersistentProfileDir, _getCloneProfileDir };
};
