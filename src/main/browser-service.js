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

const { BrowserWindow, dialog, screen } = require('electron');

module.exports = function registerPlaywrightIpc({ ipcMain, getSettings, getMainWindow, getImagesDir }) {
let _pwBrowser = null; // shared browser instance (chromium.launch)
const _pwWorkspaces = new Map(); // workspacePath -> { context, page }

// Get Playwright settings (with defaults)
function _getPwSettings() {
  const s = getSettings() || {};
  return {
    mode: s.playwright?.mode || 'auto',
    path: s.playwright?.path || '',
    followLang: s.playwright?.followLang !== false,
    args: s.playwright?.args || '',
    // 默认有头模式（headless=false）。settings.playwright.headless 显式为 true 时才无头
    headless: s.playwright?.headless === true,
    // 横幅开关：默认开启。仅在 headed 模式下显示，headless 模式始终不显示
    bannerEnabled: s.playwright?.bannerEnabled !== false
  };
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
  if (_pwBrowser) {
    try {
      if (typeof _pwBrowser.isConnected === 'function' ? _pwBrowser.isConnected() : false) {
        return _pwBrowser;
      }
      console.log('[Playwright] 现有实例已断开，清理后重新启动');
    } catch {
      console.log('[Playwright] 检查连接状态异常，清理后重新启动');
    }
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

async function ensureBrowser(workspacePath) {
  const key = workspacePath || '__default__';
  // 每次调用 Playwright 工具都重新显示横幅（Agent 第二轮操作浏览器时横幅已被隐藏）
  _showPwBanner();
  if (_pwWorkspaces.has(key)) return _pwWorkspaces.get(key).page;
  const browser = await _launchPwBrowser();
  const pwSettings = _getPwSettings();
  const appLang = getSettings()?.language || 'zh-CN';
  const contextOptions = { viewport: { width: 1280, height: 720 } };
  // Apply browser language based on app language setting
  if (pwSettings.followLang) {
    const acceptLang = _getPwAcceptLanguage(appLang);
    contextOptions.locale = appLang;
    contextOptions.extraHTTPHeaders = { 'Accept-Language': acceptLang };
  }
  const context = await browser.newContext(contextOptions);
  // 注入反自动化检测脚本（在页面脚本执行前覆盖 navigator.webdriver 等属性）
  // 注意：launch 参数 --disable-blink-features=AutomationControlled 已经隐藏了大部分检测，
  // 这里再注入脚本作为双重保险，覆盖更多属性
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
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const version = await page.context().newCDPSession(page).then(s => s.send('Browser.getVersion')).catch(() => null);
      if (version) productInfo = version.product || '';
      await ctx.close().catch(() => {});
    } catch { /* ignore version probe */ }
    // Close the test browser
    await browser.close().catch(() => {});
    _pwBrowser = null;
    return { ok, message: '浏览器启动成功' + (productInfo ? `（${productInfo}）` : '') };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('pw:closeBrowser', async () => {
  try {
    // Close all contexts
    for (const [key, ws] of _pwWorkspaces) {
      await ws.context.close().catch(() => {});
    }
    _pwWorkspaces.clear();
    // Close browser
    if (_pwBrowser) {
      await _pwBrowser.close().catch(() => {});
      _pwBrowser = null;
    }
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

  return { _hidePwBanner, ensureBrowser, _getPwSettings };
};
