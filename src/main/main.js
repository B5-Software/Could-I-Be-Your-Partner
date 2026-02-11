/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { app, BrowserWindow, ipcMain, nativeTheme, dialog, clipboard, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const userDataPath = app.getPath('userData');
const dataDir = path.join(userDataPath, 'data');
const imagesDir = path.join(userDataPath, 'images');
const skillsDir = path.join(userDataPath, 'skills');
const historyDir = path.join(dataDir, 'history');
const workspacesBaseDir = path.join(app.getPath('documents'), 'Could-I-Be-Your-Partner');

[dataDir, imagesDir, skillsDir, historyDir, workspacesBaseDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const settingsPath = path.join(dataDir, 'settings.json');
const memoryPath = path.join(dataDir, 'memory.json');
const knowledgePath = path.join(dataDir, 'knowledge.json');

function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return def; } }
function saveJSON(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8'); }

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + otherCount * 0.4);
}

function resetDailyUsageIfNeeded() {
  const today = getTodayKey();
  if (settings.llm.dailyTokenDate !== today) {
    settings.llm.dailyTokenDate = today;
    settings.llm.dailyTokensUsed = 0;
  }
  if (settings.imageGen.dailyImageDate !== today) {
    settings.imageGen.dailyImageDate = today;
    settings.imageGen.dailyImagesUsed = 0;
  }
}

function persistSettings() {
  saveJSON(settingsPath, settings);
}

let settings = loadJSON(settingsPath, {
  llm: {
    apiUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxContextLength: 8192,
    maxResponseTokens: 8192,
    dailyMaxTokens: 0,
    dailyTokensUsed: 0,
    dailyTokenDate: ''
  },
  imageGen: {
    apiUrl: 'https://api.siliconflow.cn/v1/images/generations',
    apiKey: '',
    model: 'Kwai-Kolors/Kolors',
    imageSize: '1024x1024',
    dailyMaxImages: 0,
    dailyImagesUsed: 0,
    dailyImageDate: ''
  },
  theme: { mode: 'system', accentColor: '#4f8cff', backgroundColor: '#f5f7fa' },
  tools: {},
  autoApproveSensitive: false,
  aiPersona: { name: 'Partner', avatar: '', bio: '你的全能AI伙伴~', pronouns: 'Ta', personality: '活泼可爱、热情友善', customPrompt: '' },
  entropy: { source: 'csprng', trngMode: 'network', trngSerialPort: '', trngSerialBaud: 115200, trngNetworkHost: '192.168.4.1', trngNetworkPort: 80 },
  proxy: { mode: 'system', http: '', https: '', bypass: 'localhost,127.0.0.1' }
});
if (fs.existsSync(settingsPath)) {
  const saved = loadJSON(settingsPath, {});
  settings = { ...settings, ...saved, llm: { ...settings.llm, ...(saved.llm || {}) }, imageGen: { ...settings.imageGen, ...(saved.imageGen || {}) }, theme: { ...settings.theme, ...(saved.theme || {}) }, aiPersona: { ...settings.aiPersona, ...(saved.aiPersona || {}) }, entropy: { ...settings.entropy, ...(saved.entropy || {}) }, proxy: { ...settings.proxy, ...(saved.proxy || {}) } };
}
saveJSON(settingsPath, settings);

let memory = loadJSON(memoryPath, []);
let knowledge = loadJSON(knowledgePath, []);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    title: 'Could I Be Your Partner',
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/index.html'));
}

app.whenReady().then(() => {
  // 启动时复制 OCR traineddata 文件到当前执行目录根，避免 GFW blocking
  const appPath = app.getAppPath();
  const srcOcrDir = path.join(appPath, 'assets', 'ocr');
  const destOcrDir = process.cwd();
  if (fs.existsSync(srcOcrDir)) {
    try {
      const files = fs.readdirSync(srcOcrDir);
      for (const file of files) {
        if (file.endsWith('.traineddata') || file.endsWith('.gz')) {
          const destPath = path.join(destOcrDir, file);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(path.join(srcOcrDir, file), destPath);
          }
        }
      }
    } catch (e) {
      console.error('Failed to copy OCR data:', e);
    }
  }
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---- IPC: Window Controls ----
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximize', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); return mainWindow.isMaximized(); } });
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window:isMaximized', () => mainWindow ? mainWindow.isMaximized() : false);

// ---- IPC: Settings ----
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_, newSettings) => {
  settings = { ...settings, ...newSettings };
  saveJSON(settingsPath, settings);
  return settings;
});

// ---- IPC: Theme ----
ipcMain.handle('theme:get', () => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, mode: settings.theme.mode }));
nativeTheme.on('updated', () => {
  if (mainWindow) mainWindow.webContents.send('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
});

// ---- IPC: Memory ----
ipcMain.handle('memory:search', (_, query) => {
  const q = (query || '').toLowerCase();
  return memory.filter(m => (m.content || '').toLowerCase().includes(q) || (m.tags || []).some(t => t.toLowerCase().includes(q)));
});
ipcMain.handle('memory:add', (_, item) => {
  item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  item.createdAt = new Date().toISOString();
  memory.push(item);
  saveJSON(memoryPath, memory);
  return item;
});
ipcMain.handle('memory:delete', (_, id) => {
  memory = memory.filter(m => m.id !== id);
  saveJSON(memoryPath, memory);
  return true;
});
ipcMain.handle('memory:update', (_, { id, data }) => {
  const idx = memory.findIndex(m => m.id === id);
  if (idx >= 0) { memory[idx] = { ...memory[idx], ...data, updatedAt: new Date().toISOString() }; saveJSON(memoryPath, memory); return memory[idx]; }
  return null;
});

// ---- IPC: Knowledge Base ----
ipcMain.handle('knowledge:search', (_, query) => {
  const q = (query || '').toLowerCase();
  return knowledge.filter(k => (k.content || '').toLowerCase().includes(q) || (k.title || '').toLowerCase().includes(q));
});
ipcMain.handle('knowledge:add', (_, item) => {
  item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  item.createdAt = new Date().toISOString();
  knowledge.push(item);
  saveJSON(knowledgePath, knowledge);
  return item;
});
ipcMain.handle('knowledge:delete', (_, id) => {
  knowledge = knowledge.filter(k => k.id !== id);
  saveJSON(knowledgePath, knowledge);
  return true;
});
ipcMain.handle('knowledge:update', (_, { id, data }) => {
  const idx = knowledge.findIndex(k => k.id === id);
  if (idx >= 0) { knowledge[idx] = { ...knowledge[idx], ...data, updatedAt: new Date().toISOString() }; saveJSON(knowledgePath, knowledge); return knowledge[idx]; }
  return null;
});

// ---- IPC: File Operations ----
ipcMain.handle('fs:readFile', (_, filePath) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf-8') }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:writeFile', (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:createFile', (_, filePath, content) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content || '', 'utf-8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:deleteFile', (_, filePath) => {
  try { fs.unlinkSync(filePath); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:moveFile', (_, src, dest) => {
  try { fs.renameSync(src, dest); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:copyFile', (_, src, dest) => {
  try { fs.copyFileSync(src, dest); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:listDirectory', (_, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return { ok: true, entries: entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:makeDirectory', (_, dirPath) => {
  try { fs.mkdirSync(dirPath, { recursive: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:deleteDirectory', (_, dirPath) => {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:localSearch', async (_, dirPath, pattern, options = {}) => {
  return new Promise((resolve) => {
    const results = [];
    const {
      ignoreCase = true,
      maxResults = 200,
      fileOnly = false,
      dirOnly = false,
      regex = false,
      depth = -1 // -1 means unlimited
    } = options;
    
    let searchPattern = pattern;
    if (regex) {
      try {
        searchPattern = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch (e) {
        resolve({ ok: false, error: `Invalid regex pattern: ${e.message}` });
        return;
      }
    }
    
    function matches(name) {
      if (regex) {
        return searchPattern.test(name);
      } else {
        const haystack = ignoreCase ? name.toLowerCase() : name;
        const needle = ignoreCase ? pattern.toLowerCase() : pattern;
        return haystack.includes(needle);
      }
    }
    
    function walk(dir, currentDepth = 0) {
      if (results.length >= maxResults) return;
      if (depth >= 0 && currentDepth > depth) return;
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= maxResults) break;
          
          const full = path.join(dir, e.name);
          const isDir = e.isDirectory();
          
          // Apply file/dir filters
          if (fileOnly && isDir) continue;
          if (dirOnly && !isDir) continue;
          
          // Check if matches pattern
          if (matches(e.name)) {
            results.push(full);
          }
          
          // Recurse into directories
          if (isDir) {
            walk(full, currentDepth + 1);
          }
        }
      } catch { /* skip inaccessible */ }
    }
    
    // Run search asynchronously
    setImmediate(() => {
      try {
        walk(dirPath);
        resolve({ ok: true, results, count: results.length });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });
});

// ---- IPC: Terminal Management ----
const terminals = new Map();
let terminalIdCounter = 0;

ipcMain.handle('terminal:make', () => {
  try {
    const pty = require('node-pty');
    const id = ++terminalIdCounter;
    const shellName = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    const term = pty.spawn(shellName, [], { name: 'xterm', cols: 120, rows: 30, cwd: os.homedir() });
    let buffer = '';
    term.onData(data => { buffer += data; });
    terminals.set(id, { term, buffer: () => { const b = buffer; buffer = ''; return b; } });
    return { ok: true, terminalId: id };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('terminal:run', (_, id, command) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  t.buffer();
  t.term.write(command + '\r');
  return new Promise(resolve => {
    setTimeout(() => { resolve({ ok: true, output: t.buffer() }); }, 2000);
  });
});
ipcMain.handle('terminal:await', (_, id, command) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  t.buffer();
  t.term.write(command + '\r');
  return new Promise(resolve => {
    const timeout = setTimeout(() => { resolve({ ok: true, output: t.buffer(), timedOut: true }); }, 120000);
    let checkInterval = setInterval(() => {
      const output = t.buffer();
      if (output.includes('$') || output.includes('>') || output.includes('#') || output.includes('%')) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        resolve({ ok: true, output });
      }
    }, 500);
  });
});
ipcMain.handle('terminal:kill', (_, id) => {
  const t = terminals.get(id);
  if (t) { t.term.kill(); terminals.delete(id); }
  return { ok: true };
});

// ---- IPC: Clipboard ----
ipcMain.handle('clipboard:read', () => {
  try {
    return { ok: true, content: clipboard.readText() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('clipboard:write', (_, text) => {
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Screenshot ----
ipcMain.handle('screenshot:take', async (_, workspacePath) => {
  try {
    const sources = await require('electron').desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (sources.length > 0) {
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      const imgPath = path.join(targetDir, `screenshot_${Date.now()}.png`);
      fs.writeFileSync(imgPath, sources[0].thumbnail.toPNG());
      return { ok: true, path: imgPath };
    }
    return { ok: false, error: '无法截取屏幕' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: System Info ----
ipcMain.handle('system:info', () => ({
  ok: true,
  platform: process.platform, arch: process.arch, hostname: os.hostname(),
  cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(),
  homeDir: os.homedir(), tempDir: os.tmpdir(), nodeVersion: process.versions.node,
  electronVersion: process.versions.electron
}));
ipcMain.handle('system:network', () => {
  try {
    const interfaces = os.networkInterfaces();
    const result = {};
    for (const [name, addrs] of Object.entries(interfaces)) {
      result[name] = addrs.map(a => ({ address: a.address, family: a.family, internal: a.internal }));
    }
    return { ok: true, interfaces: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Shell & Browser ----
ipcMain.handle('shell:openBrowser', (_, url) => {
  try {
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('shell:openFileExplorer', (_, p) => {
  try {
    shell.openPath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Run JS Code (sandboxed) ----
ipcMain.handle('code:runJS', (_, code) => {
  return new Promise((resolve) => {
    const { fork } = require('child_process');
    const runner = fork(path.join(__dirname, '../tools/js-runner.js'), [], { silent: true, timeout: 30000 });
    let output = '';
    let error = '';
    runner.stdout.on('data', d => { output += d.toString(); });
    runner.stderr.on('data', d => { error += d.toString(); });
    runner.on('message', msg => { resolve({ ok: true, result: msg }); });
    runner.on('exit', code => {
      if (code !== 0) resolve({ ok: false, error: error || `Process exited with code ${code}` });
      else resolve({ ok: true, output });
    });
    runner.send({ code });
    setTimeout(() => { try { runner.kill(); } catch {} resolve({ ok: false, error: '执行超时' }); }, 30000);
  });
});

// ---- IPC: Run JS Code (Node.js enabled) ----
ipcMain.handle('code:runNodeJS', (_, code) => {
  return new Promise((resolve) => {
    const { fork } = require('child_process');
    const runner = fork(path.join(__dirname, '../tools/js-runner-node.js'), [], { silent: true, timeout: 30000 });
    let output = '';
    let error = '';
    runner.stdout.on('data', d => { output += d.toString(); });
    runner.stderr.on('data', d => { error += d.toString(); });
    runner.on('message', msg => { resolve({ ok: true, result: msg }); });
    runner.on('exit', code => {
      if (code !== 0) resolve({ ok: false, error: error || `Process exited with code ${code}` });
      else resolve({ ok: true, output });
    });
    runner.send({ code });
    setTimeout(() => { try { runner.kill(); } catch {} resolve({ ok: false, error: '执行超时' }); }, 30000);
  });
});

// ---- IPC: Run Shell Script ----
ipcMain.handle('code:runShell', (_, script) => {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const tmpFile = path.join(os.tmpdir(), `script_${Date.now()}${process.platform === 'win32' ? '.ps1' : '.sh'}`);
    fs.writeFileSync(tmpFile, script, 'utf-8');
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const args = process.platform === 'win32' ? ['-File', tmpFile] : [tmpFile];
    execFile(shell, args, { timeout: 120000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) resolve({ ok: false, error: err.message, stderr });
      else resolve({ ok: true, output: stdout, stderr });
    });
  });
});

// ---- IPC: Image Generation ----
ipcMain.handle('image:generate', async (_, prompt, workspacePath) => {
  try {
    const { net } = require('electron');
    const apiUrl = settings.imageGen.apiUrl;
    const apiKey = settings.imageGen.apiKey;
    const model = settings.imageGen.model;
    const imageSize = settings.imageGen.imageSize;
    if (!apiKey) return { ok: false, error: '请先配置生图API Key' };

    resetDailyUsageIfNeeded();
    const maxImages = settings.imageGen.dailyMaxImages || 0;
    if (maxImages > 0 && settings.imageGen.dailyImagesUsed >= maxImages) {
      return { ok: false, error: '已达到今日生图上限，请明天再试' };
    }

    const body = JSON.stringify({ model, prompt, image_size: imageSize, batch_size: 1, num_inference_steps: 20, guidance_scale: 7.5 });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body
    });
    const data = await response.json();
    if (data.images && data.images[0] && data.images[0].url) {
      const imgUrl = data.images[0].url;
      const imgResponse = await fetch(imgUrl);
      const buffer = Buffer.from(await imgResponse.arrayBuffer());
      
      // Save to workspace if provided, otherwise use imagesDir
      const saveDir = workspacePath || imagesDir;
      const imgPath = path.join(saveDir, `generated_${Date.now()}.png`);
      fs.writeFileSync(imgPath, buffer);
      
      settings.imageGen.dailyImagesUsed = (settings.imageGen.dailyImagesUsed || 0) + 1;
      persistSettings();
      
      // Return file:// URL for display
      const fileUrl = 'file://' + imgPath.replace(/\\/g, '/');
      return { ok: true, path: imgPath, url: fileUrl };
    }
    return { ok: false, error: '生图API未返回有效图片' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Web Search & Fetch ----
ipcMain.handle('web:search', async (_, query, workspacePath) => {
  if (!mainWindow) return { ok: false, error: '主窗口未就绪' };

  // 创建离屏隐藏窗口进行后台渲染
  const offscreenWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    await offscreenWindow.webContents.loadURL(url, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // 等待渲染稳定
    await new Promise(r => setTimeout(r, 2000));

    const result = await offscreenWindow.webContents.executeJavaScript(`(() => {
      const items = [];
      const nodes = document.querySelectorAll('li.b_algo');
      for (let i = 0; i < nodes.length && items.length < 15; i++) {
        const li = nodes[i];
        const a = li.querySelector('h2 a');
        const p = li.querySelector('p, .b_caption p');
        items.push({
          title: a ? a.textContent.trim() : '',
          url: a ? a.href : '',
          snippet: p ? p.textContent.trim() : '',
          id: li.id || ''
        });
      }
      return {
        title: document.title,
        url: location.href,
        results: items,
        html: document.documentElement.outerHTML.slice(0, 150000)
      };
    })()`);

    const image = await offscreenWindow.webContents.capturePage();
    const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
    const imgPath = path.join(targetDir, `bing_${Date.now()}.png`);
    fs.writeFileSync(imgPath, image.toPNG());

    return {
      ok: true,
      query,
      url: result.url,
      title: result.title,
      results: result.results,
      html: result.html,
      screenshotPath: imgPath,
      screenshotUrl: `file://${imgPath}`
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      if (!offscreenWindow.isDestroyed()) {
        offscreenWindow.close();
      }
    } catch { /* ignore */ }
  }
});
ipcMain.handle('web:fetch', async (_, url) => {
  try {
    const resp = await fetch(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      } 
    });
    const text = await resp.text();
    return { ok: true, content: text.substring(0, 200000) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Tarot ----
const tarotCards = require('../data/tarot.js');

function drawTarotCSPRNG() {
  const crypto = require('crypto');
  const range = tarotCards.length;
  const max = Math.floor(0x100000000 / range) * range;
  let val;
  do {
    val = crypto.randomBytes(4).readUInt32BE(0);
  } while (val >= max);
  const card = tarotCards[val % range];
  const isReversed = crypto.randomBytes(1)[0] < 128;
  return {
    ...card,
    isReversed,
    orientation: isReversed ? 'reversed' : 'upright',
    meaningOfUpright: card.meaningOfUpright,
    meaningOfReversed: card.meaningOfReversed,
    entropySource: 'CSPRNG'
  };
}

async function drawTarotTRNG() {
  const entropy = settings.entropy || {};
  const mode = entropy.trngMode || 'network';
  let raw;
  if (mode === 'serial') {
    raw = await getTRNGFromSerial(entropy.trngSerialPort, entropy.trngSerialBaud || 115200);
  } else {
    raw = await getTRNGFromNetwork(entropy.trngNetworkHost || '192.168.4.1', entropy.trngNetworkPort || 80);
  }
  // raw should be { cardIndex, isReversed } from the TRNG device
  const card = tarotCards[raw.cardIndex % tarotCards.length];
  const isReversed = raw.isReversed;
  return {
    ...card,
    isReversed,
    orientation: isReversed ? 'reversed' : 'upright',
    meaningOfUpright: card.meaningOfUpright,
    meaningOfReversed: card.meaningOfReversed,
    entropySource: 'TRNG'
  };
}

async function getTRNGFromSerial(portPath, baud) {
  return new Promise((resolve, reject) => {
    if (!portPath) return reject(new Error('未配置TRNG串口'));
    let { SerialPort } = {};
    try { ({ SerialPort } = require('serialport')); } catch {
      return reject(new Error('serialport 模块未安装，请运行 npm install serialport'));
    }
    const port = new SerialPort({ path: portPath, baudRate: baud });
    let buf = '';
    const timeout = setTimeout(() => { port.close(); reject(new Error('TRNG串口超时')); }, 10000);
    port.write('DRAW\n');
    port.on('data', (data) => {
      buf += data.toString();
      if (buf.includes('\n')) {
        clearTimeout(timeout);
        port.close();
        try {
          const json = JSON.parse(buf.trim());
          resolve({ cardIndex: json.cardIndex, isReversed: json.isReversed });
        } catch (e) { reject(new Error('TRNG串口数据解析失败: ' + buf)); }
      }
    });
    port.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function getTRNGFromNetwork(host, port) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('TRNG网络超时')), 10000);
    const req = http.get(`http://${host}:${port}/api/draw`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(data);
          resolve({ cardIndex: json.cardIndex, isReversed: json.isReversed });
        } catch (e) { reject(new Error('TRNG网络数据解析失败: ' + data)); }
      });
    });
    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('TRNG网络请求超时')); });
  });
}

ipcMain.handle('tarot:draw', async () => {
  try {
    const source = settings.entropy?.source || 'csprng';
    if (source === 'trng') {
      return await drawTarotTRNG();
    }
    return drawTarotCSPRNG();
  } catch (e) {
    // Fallback to CSPRNG on TRNG failure
    console.error('TRNG failed, falling back to CSPRNG:', e.message);
    const result = drawTarotCSPRNG();
    result.entropySource = 'CSPRNG (TRNG fallback: ' + e.message + ')';
    return result;
  }
});

// ---- IPC: TRNG Serial Port List ----
ipcMain.handle('trng:listPorts', async () => {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return { ok: true, ports };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('trng:test', async () => {
  try {
    const source = settings.entropy?.source || 'csprng';
    if (source === 'trng') {
      const result = await drawTarotTRNG();
      return { ok: true, result };
    }
    return { ok: true, result: drawTarotCSPRNG() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Skills ----
ipcMain.handle('skills:list', () => {
  try {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.json'));
    return files.map(f => loadJSON(path.join(skillsDir, f), {}));
  } catch { return []; }
});
ipcMain.handle('skills:create', (_, skill) => {
  skill.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  skill.createdAt = new Date().toISOString();
  saveJSON(path.join(skillsDir, `${skill.id}.json`), skill);
  return skill;
});
ipcMain.handle('skills:delete', (_, id) => {
  try { fs.unlinkSync(path.join(skillsDir, `${id}.json`)); return true; } catch { return false; }
});

// ---- IPC: LLM API Call ----
ipcMain.handle('llm:chat', async (_, messages, options = {}) => {
  try {
    const apiUrl = settings.llm.apiUrl;
    const apiKey = settings.llm.apiKey;
    const model = settings.llm.model;
    if (!apiUrl || !apiKey || !model) return { ok: false, error: '请先在设置中配置LLM API' };

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    const body = {
      model,
      messages,
      temperature: options.temperature ?? settings.llm.temperature,
      max_tokens: options.max_tokens ?? settings.llm.maxResponseTokens ?? 8192,
      stream: false
    };
    if (options.tools) body.tools = options.tools;
    if (options.tool_choice) body.tool_choice = options.tool_choice;

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (data.error) return { ok: false, error: data.error.message || JSON.stringify(data.error) };
    const usageTokens = data.usage?.total_tokens
      || estimateTokens(JSON.stringify(body)) + estimateTokens(data.choices?.[0]?.message?.content || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    persistSettings();
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: LLM Streaming ----
ipcMain.handle('llm:chatStream', async (_, messages, options = {}) => {
  try {
    const apiUrl = settings.llm.apiUrl;
    const apiKey = settings.llm.apiKey;
    const model = settings.llm.model;
    if (!apiUrl || !apiKey || !model) return { ok: false, error: '请先在设置中配置LLM API' };

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    const body = {
      model,
      messages,
      temperature: options.temperature ?? settings.llm.temperature,
      max_tokens: options.max_tokens ?? settings.llm.maxResponseTokens ?? 8192,
      stream: true
    };
    if (options.tools) body.tools = options.tools;
    if (options.tool_choice) body.tool_choice = options.tool_choice;

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let toolCalls = [];
    let finishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            mainWindow?.webContents.send('llm:stream-chunk', { content: delta.content, requestId: options.requestId });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                while (toolCalls.length <= tc.index) toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
                if (tc.id) toolCalls[tc.index].id = tc.id;
                if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }
          if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
        } catch {}
      }
    }

    mainWindow?.webContents.send('llm:stream-end', { requestId: options.requestId });
    const usageTokens = estimateTokens(JSON.stringify(body)) + estimateTokens(fullContent || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    persistSettings();
    return { ok: true, data: { choices: [{ message: { role: 'assistant', content: fullContent, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: finishReason }] } };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Paths ----
ipcMain.handle('app:getPath', (_, name) => {
  if (name === 'images') return imagesDir;
  if (name === 'data') return dataDir;
  if (name === 'skills') return skillsDir;
  if (name === 'userData') return userDataPath;
  return app.getPath(name);
});

// ---- IPC: Dialog (系统对话框) ----
ipcMain.handle('dialog:confirm', async (_, message) => {
  // 发送请求到renderer进程显示确认对话框
  mainWindow.webContents.send('show-confirm-dialog', message);
  
  // 等待renderer的响应
  return new Promise((resolve) => {
    ipcMain.once('confirm-dialog-response', (_, response) => {
      resolve(response);
    });
  });
});

// ---- IPC: Dialog File Picker (系统对话框) ----
ipcMain.handle('dialog:openFile', async (_, options = {}) => {
  try {
    const properties = ['openFile'];
    if (options.multiple) properties.push('multiSelections');
    if (options.directory) properties.push('openDirectory');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件',
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties
    });
    return { ok: !result.canceled, paths: result.filePaths || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dialog:saveFile', async (_, options = {}) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath,
      filters: options.filters
    });
    return { ok: !result.canceled, path: result.filePath || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Chat History ----
ipcMain.handle('history:list', () => {
  try {
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json')).sort((a, b) => b.localeCompare(a));
    return files.map(f => { const data = loadJSON(path.join(historyDir, f), {}); return { id: data.id, title: data.title || '未命名对话', createdAt: data.createdAt, updatedAt: data.updatedAt, messageCount: (data.messages || []).length }; });
  } catch { return []; }
});

ipcMain.handle('history:get', (_, id) => {
  const p = path.join(historyDir, `${id}.json`);
  return loadJSON(p, null);
});

ipcMain.handle('history:save', (_, conversation) => {
  conversation.updatedAt = new Date().toISOString();
  if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
  saveJSON(path.join(historyDir, `${conversation.id}.json`), conversation);
  return { ok: true };
});

ipcMain.handle('history:delete', (_, id) => {
  try { fs.unlinkSync(path.join(historyDir, `${id}.json`)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('history:rename', (_, id, title) => {
  const p = path.join(historyDir, `${id}.json`);
  const data = loadJSON(p, null);
  if (data) { data.title = title; data.updatedAt = new Date().toISOString(); saveJSON(p, data); return { ok: true }; }
  return { ok: false };
});

// ---- IPC: Workspace (Agent Working Directory) ----
ipcMain.handle('firmware:export', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, error: '用户取消' };
    const destDir = path.join(result.filePaths[0], 'CIBYP-TRNG');
    const srcDir = path.join(app.getAppPath(), 'IoT-Firmware', 'CIBYP-TRNG');
    
    // 创建目标目录
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    
    // 复制所有文件
    function copyDir(src, dest) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDir(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
    
    copyDir(srcDir, destDir);
    return { ok: true, path: destDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Workspace (Agent Working Directory) ----
ipcMain.handle('workspace:create', () => {
  const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const dir = path.join(workspacesBaseDir, ts);
  fs.mkdirSync(dir, { recursive: true });
  return { ok: true, path: dir };
});

ipcMain.handle('workspace:getBase', () => workspacesBaseDir);

ipcMain.handle('workspace:openInExplorer', (_, dirPath) => {
  shell.openPath(dirPath || workspacesBaseDir);
  return { ok: true };
});

ipcMain.handle('workspace:getFileTree', (_, dirPath) => {
  try {
    const tree = generateFileTree(dirPath, '', 0, 3); // 最多3层
    return { ok: true, tree };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function generateFileTree(dir, prefix, depth, maxDepth) {
  if (depth >= maxDepth) return '';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let result = '';
    entries.forEach((entry, i) => {
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      result += prefix + connector + entry.name + (entry.isDirectory() ? '/\n' : '\n');
      if (entry.isDirectory() && depth < maxDepth - 1) {
        result += generateFileTree(path.join(dir, entry.name), newPrefix, depth + 1, maxDepth);
      }
    });
    return result;
  } catch {
    return '';
  }
}

// ---- IPC: System Info (Enhanced) ----
ipcMain.handle('system:fullInfo', () => ({
  platform: process.platform,
  arch: process.arch,
  hostname: os.hostname(),
  username: os.userInfo().username,
  homeDir: os.homedir(),
  tempDir: os.tmpdir(),
  documentsDir: app.getPath('documents'),
  desktopDir: app.getPath('desktop'),
  downloadsDir: app.getPath('downloads'),
  cpus: os.cpus().length,
  totalMemory: os.totalmem(),
  freeMemory: os.freemem(),
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron,
  osRelease: os.release(),
  osType: os.type(),
  systemDrive: process.platform === 'win32' ? process.env.SystemDrive || 'C:' : '/',
  pathSep: path.sep
}));

// ---- IPC: File Import for Knowledge Base ----
ipcMain.handle('knowledge:importFile', async (_, filePath, workspacePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    let textContent = '';
    let images = [];
    const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;

    if (['.txt', '.csv', '.md', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.log', '.sh', '.bat', '.ps1', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.h', '.css'].includes(ext)) {
      textContent = readTextWithEncoding(filePath);
    } else if (['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'].includes(ext)) {
      // Use JSZip to extract from Office Open XML / ODF formats
      const AdmZip = requireAdmZip();
      if (!AdmZip) return { ok: false, error: '需要安装adm-zip包来处理此文件格式' };
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();

      if (ext === '.docx') {
        const docEntry = entries.find(e => e.entryName === 'word/document.xml');
        if (docEntry) {
          const xml = docEntry.getData().toString('utf-8');
          textContent = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        // Extract images
        entries.filter(e => e.entryName.startsWith('word/media/')).forEach(e => {
          const imgPath = path.join(targetDir, `import_${Date.now()}_${path.basename(e.entryName)}`);
          fs.writeFileSync(imgPath, e.getData());
          images.push(imgPath);
        });
      } else if (ext === '.xlsx' || ext === '.ods') {
        // Parse spreadsheet to CSV
        const sheetEntries = entries.filter(e => e.entryName.match(/xl\/worksheets\/sheet\d+\.xml|content\.xml/));
        for (const se of sheetEntries) {
          const xml = se.getData().toString('utf-8');
          const rows = [];
          const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
          for (const rowXml of rowMatches) {
            const cells = [];
            const cellMatches = rowXml.match(/<v>([^<]*)<\/v>/g) || [];
            for (const c of cellMatches) cells.push(c.replace(/<\/?v>/g, ''));
            if (cells.length > 0) rows.push(cells.join(','));
          }
          textContent += rows.join('\n') + '\n';
        }
      } else if (ext === '.pptx' || ext === '.odp') {
        const slideEntries = entries.filter(e => e.entryName.match(/ppt\/slides\/slide\d+\.xml|content\.xml/));
        for (const se of slideEntries) {
          const xml = se.getData().toString('utf-8');
          const txt = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          textContent += txt + '\n---\n';
        }
        entries.filter(e => e.entryName.startsWith('ppt/media/')).forEach(e => {
          const imgPath = path.join(targetDir, `import_${Date.now()}_${path.basename(e.entryName)}`);
          fs.writeFileSync(imgPath, e.getData());
          images.push(imgPath);
        });
      } else if (ext === '.odt') {
        const contentEntry = entries.find(e => e.entryName === 'content.xml');
        if (contentEntry) {
          const xml = contentEntry.getData().toString('utf-8');
          textContent = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
    } else if (['.doc', '.ppt', '.xls'].includes(ext)) {
      // Legacy binary formats - try to extract raw text
      const buf = fs.readFileSync(filePath);
      const rawText = buf.toString('utf-8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').replace(/\s+/g, ' ');
      // Extract readable portions
      const readable = rawText.match(/[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9\s,.;:!?(){}\[\]\-_+=@#$%^&*'"\/\\]+/g) || [];
      textContent = readable.join(' ').substring(0, 50000);
    } else if (ext === '.pdf') {
      // Basic PDF text extraction
      const buf = fs.readFileSync(filePath);
      const content = buf.toString('latin1');
      const textBlocks = [];
      const streamMatches = content.match(/stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g) || [];
      for (const sm of streamMatches) {
        const inner = sm.replace(/^stream[\r\n]+/, '').replace(/[\r\n]+endstream$/, '');
        // Try to extract text operators
        const tjMatches = inner.match(/\(([^)]*)\)/g) || [];
        for (const tj of tjMatches) {
          const text = tj.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\\\/g, '\\');
          if (text.length > 1 && /[a-zA-Z\u4e00-\u9fff]/.test(text)) textBlocks.push(text);
        }
      }
      textContent = textBlocks.join(' ') || '(PDF文本提取有限，建议使用OCR)';
    } else {
      // Try reading as text
      try { textContent = readTextWithEncoding(filePath); } catch { return { ok: false, error: '不支持的文件格式' }; }
    }

    return { ok: true, content: textContent.substring(0, 100000), images, fileName, ext };
  } catch (e) { return { ok: false, error: e.message }; }
});

function requireAdmZip() {
  try { return require('adm-zip'); } catch { return null; }
}

function readTextWithEncoding(filePath) {
  try {
    const chardet = require('chardet');
    const iconv = require('iconv-lite');
    const buf = fs.readFileSync(filePath);
    const detected = chardet.detect(buf) || 'utf-8';
    const encoding = detected.toLowerCase();
    if (iconv.encodingExists(encoding)) {
      return iconv.decode(buf, encoding);
    }
    return buf.toString('utf-8');
  } catch {
    return fs.readFileSync(filePath, 'utf-8');
  }
}

// ---- IPC: Read file as base64 (for images) ----
ipcMain.handle('fs:readFileBase64', (_, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    return { ok: true, data: `data:${mime};base64,${buf.toString('base64')}`, mime };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Save uploaded file ----
ipcMain.handle('fs:saveUploadedFile', (_, fileName, data) => {
  try {
    const ext = path.extname(fileName).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
    const targetDir = isImage ? imagesDir : path.join(userDataPath, 'uploads');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `${Date.now()}_${fileName}`);
    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = Buffer.from(data);
    } else {
      const base64 = data.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(base64, 'base64');
    }
    fs.writeFileSync(targetPath, buffer);
    return { ok: true, path: targetPath, isImage };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: GeoGebra ----
// GeoGebra now runs in the main window, not a separate window

ipcMain.handle('geogebra:init', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.initGeoGebra()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:evalCommand', async (_, cmd) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`window.evalGeoGebraCommand("${cmd.replace(/"/g, '\\"')}")`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:getAllObjects', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.getAllGeoGebraObjects()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:deleteObject', async (_, name) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`window.deleteGeoGebraObject("${name.replace(/"/g, '\\"')}")`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:exportPNG', async (_, workspacePath) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.exportGeoGebraPNG()');
    if (result.ok && result.data) {
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      const imgPath = path.join(targetDir, `geogebra_${Date.now()}.png`);
      fs.writeFileSync(imgPath, Buffer.from(result.data, 'base64'));
      return { ok: true, path: imgPath, url: `file://${imgPath}` };
    }
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Skills Update ----
ipcMain.handle('skills:update', (_, id, data) => {
  const p = path.join(skillsDir, `${id}.json`);
  const skill = loadJSON(p, null);
  if (skill) {
    const updated = { ...skill, ...data, updatedAt: new Date().toISOString() };
    saveJSON(p, updated);
    return { ok: true, skill: updated };
  }
  return { ok: false, error: '技能不存在' };
});

// ---- IPC: OCR (tesseract.js) ----
ipcMain.handle('ocr:recognize', async (_, imagePath) => {
  try {
    const { createWorker, OEM } = require('tesseract.js');
    const { pathToFileURL } = require('url');
    // 使用执行目录根的 traineddata，避免 GFW 问题
    const langPath = pathToFileURL(process.cwd()).href;
    const languages = 'chi_sim+eng';
    // Local traineddata files are stored uncompressed, so disable gzip lookup.
    const worker = await createWorker(languages, OEM.LSTM_ONLY, { langPath, gzip: false });
    try {
      const { data: { text } } = await worker.recognize(imagePath);
      return { ok: true, text };
    } finally {
      await worker.terminate();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ---- IPC: Download File ----
ipcMain.handle('file:download', async (_, url, filename, workspacePath) => {
  try {
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');
    
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    // 确定文件名
    let targetFilename = filename;
    if (!targetFilename) {
      const urlPath = parsedUrl.pathname;
      targetFilename = path.basename(urlPath) || 'download';
    }
    
    // 获取工作区路径
    if (!workspacePath) {
      return { ok: false, error: '未设置工作区路径' };
    }
    
    const savePath = path.join(workspacePath, targetFilename);
    
    return new Promise((resolve) => {
      protocol.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          // 处理重定向
          resolve({ ok: false, error: '请使用重定向后的最终URL' });
          return;
        }
        
        if (response.statusCode !== 200) {
          resolve({ ok: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        
        const fileStream = fs.createWriteStream(savePath);
        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const progress = Math.floor((downloadedBytes / totalBytes) * 100);
            console.log(`[Download] ${progress}% (${downloadedBytes}/${totalBytes} bytes)`);
          }
        });
        
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          resolve({ ok: true, path: savePath, size: downloadedBytes });
        });
        
        fileStream.on('error', (err) => {
          fs.unlink(savePath, () => {});
          resolve({ ok: false, error: err.message });
        });
      }).on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
