/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const mainDir = require('node:path').resolve(__dirname, '..');

module.exports = function registerGamesIpc({
  ipcMain,
  BrowserWindow,
  path,
  getSettings,
  LLMProviders,
  fetchLLMWithRetry,
  DEFAULT_TIMEOUT_MS,
  logTs,
  estimateTokens,
  recordTokenUsage,
  persistSettings,
  broadcastUsageChanged,
}) {
  // ---- Sanguosha Game Window ----
  let sanguoshaWindow = null;
  let sanguoshaConfig = { aiCount: 3 };

  ipcMain.handle('sanguosha:open', async (_, aiCount) => {
    try {
      sanguoshaConfig.aiCount = aiCount || 3;
      if (sanguoshaWindow && !sanguoshaWindow.isDestroyed()) {
        sanguoshaWindow.focus();
        return { ok: true };
      }
      sanguoshaWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 900,
        minHeight: 650,
        title: '三国杀',
        frame: false,
        icon: path.join(mainDir, '../../assets/icons/icon.png'),
        webPreferences: {
          preload: path.join(mainDir, '../preload/generated/sanguosha-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      sanguoshaWindow.loadFile(path.join(mainDir, '../renderer/pages/sanguosha.html'));
      sanguoshaWindow.on('closed', () => {
        sanguoshaWindow = null;
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('sanguosha:getConfig', () => sanguoshaConfig);
  ipcMain.handle('sanguosha:close', () => {
    if (sanguoshaWindow && !sanguoshaWindow.isDestroyed()) sanguoshaWindow.close();
  });

  ipcMain.handle('sanguosha:aiDecision', async (_, gameState, playerInfo) => {
    // Use LLM for AI decision making — reuses fetchLLMWithRetry for reliability.
    try {
      const llm = getSettings().llm;
      if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
        if (!llm.zenApiKey || !llm.model) return { ok: true, action: 'auto' };
      } else if (!llm.apiUrl || !llm.model) {
        return { ok: true, action: 'auto' };
      }

      const req = LLMProviders.buildLLMRequest(llm, {
        messages: [
          {
            role: 'system',
            content: gameState.systemPrompt || '你是三国杀AI玩家',
          },
          {
            role: 'user',
            content: gameState.userPrompt || JSON.stringify(playerInfo),
          },
        ],
        temperature: 0.7,
        max_tokens: 300,
        stream: false,
      });
      const result = await fetchLLMWithRetry({
        label: 'LLM:sanguosha',
        apiUrl: req.url,
        transport: req.transport,
        apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
        headers: req.headers,
        body: req.body,
        options: {
          maxRetries: llm.maxRetries ?? undefined,
          timeoutMs: Math.min(llm.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60000),
        },
      });
      if (!result.ok) return { ok: true, action: 'auto' };
      let rawData;
      try {
        rawData = await result.response.json();
      } finally {
        result.releaseController?.();
      }
      if (rawData.error) return { ok: true, action: 'auto' };
      const data = LLMProviders.parseLLMResponse(rawData, req.transport);
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) return { ok: true, action: 'auto' };
      console.log(
        `[LLM:sanguosha ${logTs()}] ✓ ${llm.model} → "${String(content).replace(/\s+/g, ' ').slice(0, 120)}"`,
      );

      const usage = data.usage || {};
      const usageTokens =
        usage.total_tokens || estimateTokens(JSON.stringify(req.body)) + estimateTokens(content);
      getSettings().llm.dailyTokensUsed = (getSettings().llm.dailyTokensUsed || 0) + usageTokens;
      recordTokenUsage(usage, llm.model);
      persistSettings();
      broadcastUsageChanged();

      return { ok: true, action: 'llm', content };
    } catch (e) {
      return { ok: true, action: 'auto' };
    }
  });

  // ---- Flying Flower Game Window ----
  let flyingflowerWindow = null;
  let flyingflowerConfig = { aiCount: 3 };

  ipcMain.handle('flyingflower:open', async (_, aiCount) => {
    try {
      flyingflowerConfig.aiCount = aiCount || 3;
      if (flyingflowerWindow && !flyingflowerWindow.isDestroyed()) {
        flyingflowerWindow.focus();
        return { ok: true };
      }
      flyingflowerWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 700,
        minHeight: 550,
        title: '飞花令',
        frame: false,
        icon: path.join(mainDir, '../../assets/icons/icon.png'),
        webPreferences: {
          preload: path.join(mainDir, '../preload/generated/flyingflower-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      flyingflowerWindow.loadFile(path.join(mainDir, '../renderer/pages/flyingflower.html'));
      flyingflowerWindow.on('closed', () => {
        flyingflowerWindow = null;
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('flyingflower:getConfig', () => flyingflowerConfig);
  ipcMain.handle('flyingflower:close', () => {
    if (flyingflowerWindow && !flyingflowerWindow.isDestroyed()) flyingflowerWindow.close();
  });

  // ---- Undercover Game Window ----
  let undercoverWindow = null;
  let undercoverConfig = { aiCount: 4 };

  ipcMain.handle('undercover:open', async (_, aiCount) => {
    try {
      undercoverConfig.aiCount = aiCount || 4;
      if (undercoverWindow && !undercoverWindow.isDestroyed()) {
        undercoverWindow.focus();
        return { ok: true };
      }
      undercoverWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 700,
        minHeight: 550,
        title: '谁是卧底',
        frame: false,
        icon: path.join(mainDir, '../../assets/icons/icon.png'),
        webPreferences: {
          preload: path.join(mainDir, '../preload/generated/undercover-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      undercoverWindow.loadFile(path.join(mainDir, '../renderer/pages/undercover.html'));
      undercoverWindow.on('closed', () => {
        undercoverWindow = null;
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('undercover:getConfig', () => undercoverConfig);
  ipcMain.handle('undercover:close', () => {
    if (undercoverWindow && !undercoverWindow.isDestroyed()) undercoverWindow.close();
  });

  // ---- Idiom Chain Game Window ----
  let idiomWindow = null;
  let idiomConfig = { aiCount: 3 };

  ipcMain.handle('idiom:open', async (_, aiCount) => {
    try {
      idiomConfig.aiCount = aiCount || 3;
      if (idiomWindow && !idiomWindow.isDestroyed()) {
        idiomWindow.focus();
        return { ok: true };
      }
      idiomWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 700,
        minHeight: 550,
        title: '成语接龙',
        frame: false,
        icon: path.join(mainDir, '../../assets/icons/icon.png'),
        webPreferences: {
          preload: path.join(mainDir, '../preload/generated/idiom-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      idiomWindow.loadFile(path.join(mainDir, '../renderer/pages/idiom.html'));
      idiomWindow.on('closed', () => {
        idiomWindow = null;
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('idiom:getConfig', () => idiomConfig);
  ipcMain.handle('idiom:close', () => {
    if (idiomWindow && !idiomWindow.isDestroyed()) idiomWindow.close();
  });

  // ---- Guess Character Game Window ----
  let guessCharacterWindow = null;
  let guessCharacterConfig = { aiCount: 1, category: 'mixed' };

  ipcMain.handle('guesscharacter:open', async (_, aiCount, category) => {
    try {
      guessCharacterConfig.aiCount = aiCount || 1;
      guessCharacterConfig.category = category || 'mixed';
      if (guessCharacterWindow && !guessCharacterWindow.isDestroyed()) {
        guessCharacterWindow.focus();
        return { ok: true };
      }
      guessCharacterWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 700,
        minHeight: 550,
        title: '是否猜人物',
        frame: false,
        icon: path.join(mainDir, '../../assets/icons/icon.png'),
        webPreferences: {
          preload: path.join(mainDir, '../preload/generated/guesscharacter-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      guessCharacterWindow.loadFile(path.join(mainDir, '../renderer/pages/guesscharacter.html'));
      guessCharacterWindow.on('closed', () => {
        guessCharacterWindow = null;
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('guesscharacter:getConfig', () => guessCharacterConfig);
  ipcMain.handle('guesscharacter:close', () => {
    if (guessCharacterWindow && !guessCharacterWindow.isDestroyed()) guessCharacterWindow.close();
  });
};
