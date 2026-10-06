/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { dataPath } = require('../core/data-path');

module.exports = function createHistoryService({
  path,
  imagesDir,
  dataDir,
  loadJSON,
  getSettings,
  fs,
  saveJSON,
  historyDir,
  babeHistoryDir,
  scheduleSettingsPersist,
  ipcMain,
  getCodeHistoryDir,
}) {
  // ---- IPC: Chat History ----
  // ---- 历史保存防抖队列 ----
  // agentLoop 每轮迭代都会全量保存历史（1~2 次），一次对话可达数十次。
  // 防抖合并：仅保留最后一次数据写盘（紧凑 JSON），大幅降低 JSON 序列化
  // 与磁盘 I/O 的峰值压力；退出前 flush 保证数据不丢失。
  // ---- History v2：图片外置 + 元数据索引 ----
  // 1) 会话消息里的 base64 图片（image_url part）落盘到 images/history/<id>/，历史 JSON 只存文件引用；
  //    恢复会话（用于上下文/LLM 请求）时再 rehydrate 回 data URL。
  // 2) 列表元数据维护在 *-index.json，history:list/code:listHistory 不再解析全部历史文件。
  const historyImagesDir = path.join(imagesDir, 'history');
  const HISTORY_INDEX_VERSION = 2;

  function _historyIndexFile(kind, dir) {
    if (kind === 'chat') return path.join(dataDir, 'history-index.json');
    if (kind === 'babe') return path.join(dataDir, 'babe-history-index.json');
    return path.join(dir, 'index.json');
  }

  function _loadHistoryIndex(indexFile) {
    const data = loadJSON(indexFile, null);
    if (
      data &&
      data.version === HISTORY_INDEX_VERSION &&
      data.entries &&
      typeof data.entries === 'object'
    ) {
      return data.entries;
    }
    return null;
  }

  function _saveHistoryIndex(indexFile, entries) {
    // 统一记录运行位置：跨模式继续会话时做同步护栏（见 code:loadHistory）
    try {
      const loc =
        (getSettings().runtime && getSettings().runtime.location) === 'vm' ? 'vm' : 'host';
      if (entries && typeof entries === 'object') {
        for (const k of Object.keys(entries)) {
          if (entries[k] && typeof entries[k] === 'object') entries[k].runtimeLocation = loc;
        }
      }
    } catch {
      /* ignore */
    }

    try {
      fs.mkdirSync(path.dirname(indexFile), { recursive: true });
      saveJSON(indexFile, { version: HISTORY_INDEX_VERSION, entries }, false);
    } catch {
      /* ignore */
    }
  }

  function _historyJsonFiles(dir, indexFile) {
    try {
      const indexName = indexFile ? path.basename(indexFile) : '';
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== indexName);
    } catch {
      return [];
    }
  }

  function _rebuildHistoryIndex(dir, indexFile, metaBuilder) {
    const entries = {};
    for (const f of _historyJsonFiles(dir, indexFile)) {
      try {
        const filePath = path.join(dir, f);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const meta = metaBuilder(f.replace(/\.json$/, ''), data, filePath);
        if (meta) entries[meta.id] = meta;
      } catch {
        /* 单个损坏文件跳过 */
      }
    }
    _saveHistoryIndex(indexFile, entries);
    return entries;
  }

  function _getHistoryIndex(dir, indexFile, metaBuilder) {
    let entries = _loadHistoryIndex(indexFile);
    const fileCount = _historyJsonFiles(dir, indexFile).length;
    if (!entries || Object.keys(entries).length !== fileCount) {
      entries = _rebuildHistoryIndex(dir, indexFile, metaBuilder);
    }
    return entries;
  }

  function _putHistoryIndexEntry(indexFile, id, meta) {
    const entries = _loadHistoryIndex(indexFile) || {};
    entries[id] = meta;
    _saveHistoryIndex(indexFile, entries);
  }

  function _removeHistoryIndexEntry(indexFile, id) {
    const entries = _loadHistoryIndex(indexFile);
    if (!entries) return;
    delete entries[id];
    _saveHistoryIndex(indexFile, entries);
  }

  function _historyImageExt(mime) {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/gif') return 'gif';
    return 'bin';
  }

  function _externalizeHistoryImages(conversation) {
    if (!conversation || !Array.isArray(conversation.messages)) return conversation;
    const dir = dataPath(historyImagesDir, String(conversation.id || 'unknown'));
    let counter = 0;
    for (const msg of [
      ...conversation.messages,
      ...(conversation.workingContext?.entries || []).map((entry) => entry.message).filter(Boolean),
    ]) {
      if (!Array.isArray(msg && msg.content)) continue;
      for (const part of msg.content) {
        const url = part && part.image_url && part.image_url.url;
        if (typeof url !== 'string' || !url.startsWith('data:')) continue;
        try {
          const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
          if (!m) continue;
          const file = path.join(dir, `img-${Date.now()}-${counter++}.${_historyImageExt(m[1])}`);
          fs.mkdirSync(dir, { recursive: true });
          if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
          const { pathToFileURL } = require('url');
          part.image_url = {
            url: pathToFileURL(file).href,
            _cibypHistoryFile: true,
          };
        } catch {
          /* 失败保留原始数据 */
        }
      }
    }
    return conversation;
  }

  function _rehydrateHistoryImages(conversation) {
    if (!conversation || !Array.isArray(conversation.messages)) return conversation;
    const { fileURLToPath } = require('url');
    for (const msg of [
      ...conversation.messages,
      ...(conversation.workingContext?.entries || []).map((entry) => entry.message).filter(Boolean),
    ]) {
      if (!Array.isArray(msg && msg.content)) continue;
      for (const part of msg.content) {
        const iu = part && part.image_url;
        if (!iu || !iu._cibypHistoryFile || typeof iu.url !== 'string') continue;
        try {
          const p = fileURLToPath(iu.url);
          if (!fs.existsSync(p)) continue;
          const ext = path.extname(p).slice(1).toLowerCase();
          const mime =
            ext === 'jpg'
              ? 'image/jpeg'
              : ext === 'png'
                ? 'image/png'
                : ext === 'webp'
                  ? 'image/webp'
                  : ext === 'gif'
                    ? 'image/gif'
                    : 'application/octet-stream';
          part.image_url = {
            url: `data:${mime};base64,` + fs.readFileSync(p).toString('base64'),
          };
        } catch {
          /* ignore */
        }
      }
    }
    return conversation;
  }

  function _deleteHistoryImages(conversationId) {
    try {
      fs.rmSync(dataPath(historyImagesDir, String(conversationId)), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore */
    }
  }

  // 一次性迁移：把现存历史里的 base64 图片外置（备份原目录，只执行一次）
  async function migrateHistoryV2() {
    if (getSettings().performance?.historyV2Migrated) return;
    try {
      const jobs = [
        { dir: historyDir, indexFile: _historyIndexFile('chat', historyDir) },
        {
          dir: babeHistoryDir,
          indexFile: _historyIndexFile('babe', babeHistoryDir),
        },
      ];
      // 迁移前整目录备份一次（只备份 >1MB 的文件以控制磁盘占用）
      const backupRoot = path.join(dataDir, 'history-v1-backup');
      try {
        fs.mkdirSync(backupRoot, { recursive: true });
      } catch {
        /* ignore */
      }
      let migrated = 0;
      for (const { dir, indexFile } of jobs) {
        const files = _historyJsonFiles(dir, indexFile);
        for (let i = 0; i < files.length; i++) {
          if (i % 5 === 0) await new Promise((r) => setImmediate(r));
          const filePath = path.join(dir, files[i]);
          try {
            if (fs.statSync(filePath).size < 256 * 1024) continue;
            const raw = fs.readFileSync(filePath, 'utf8');
            if (!raw.includes('"data:')) continue;
            const data = JSON.parse(raw);
            _externalizeHistoryImages(data);
            try {
              fs.copyFileSync(filePath, path.join(backupRoot, path.basename(dir) + '-' + files[i]));
            } catch {
              /* ignore */
            }
            saveJSON(filePath, data, false);
            migrated++;
          } catch {
            /* 单个失败不影响其余 */
          }
        }
      }
      getSettings().performance = getSettings().performance || {};
      getSettings().performance.historyV2Migrated = true;
      scheduleSettingsPersist();
      if (migrated > 0)
        console.log(`[history] v2 migration externalized images in ${migrated} file(s)`);
    } catch (e) {
      console.warn('[history] v2 migration failed:', e && e.message);
    }
  }

  const pendingHistorySaves = new Map(); // key -> { timer, filePath, data }
  const HISTORY_SAVE_DEBOUNCE_MS = 1200;

  function queueHistorySave(key, filePath, data) {
    const existing = pendingHistorySaves.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      pendingHistorySaves.delete(key);
      try {
        saveJSON(
          filePath,
          require('../../shared/reasoning').retention(
            data,
            getSettings().llm?.preserveEncryptedReasoning === true,
          ),
          false,
        );
      } catch (e) {
        console.error('queueHistorySave write failed:', e);
      }
    }, HISTORY_SAVE_DEBOUNCE_MS);
    pendingHistorySaves.set(key, { timer, filePath, data });
  }

  function flushPendingHistorySaves() {
    if (pendingHistorySaves.size === 0) return;
    for (const [key, { timer, filePath, data }] of pendingHistorySaves) {
      clearTimeout(timer);
      try {
        saveJSON(
          filePath,
          require('../../shared/reasoning').retention(
            data,
            getSettings().llm?.preserveEncryptedReasoning === true,
          ),
          false,
        );
      } catch (e) {
        console.error('flushPendingHistorySaves write failed:', e);
      }
      pendingHistorySaves.delete(key);
    }
  }

  function _chatHistoryMeta(id, data) {
    return {
      id: data.id || id,
      title: data.title || '未命名对话',
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
      mode: data.mode || 'chat',
      status: data.status || 'idle',
      lastError: data.lastError || null,
      usage: data.usage || null,
      finishedAt: data.finishedAt || null,
      workingMs: Number(data.workingMs) || 0,
    };
  }

  ipcMain.handle('history:list', () => {
    try {
      flushPendingHistorySaves();
      const indexFile = _historyIndexFile('chat', historyDir);
      const entries = _getHistoryIndex(historyDir, indexFile, _chatHistoryMeta);
      return Object.values(entries)
        .filter(Boolean)
        .sort((a, b) =>
          String(b.updatedAt || b.createdAt || '').localeCompare(
            String(a.updatedAt || a.createdAt || ''),
          ),
        );
    } catch {
      return [];
    }
  });

  // ---- 历史搜索（标题/内容）----
  // field='title' 只匹配标题；field='content' 扫描各会话消息内容并生成关键词上下文片段。
  // 按时间新→旧排序，offset/limit 分页返回，避免把全部历史内容一次灌给渲染器。
  function _extractHistorySearchText(msg) {
    if (!msg) return '';
    if (msg.role === 'tool') return `${msg.name || ''} ${msg.content || ''}`;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map((p) => (p && p.text ? p.text : '')).join(' ');
    }
    return '';
  }

  function _makeSearchSnippet(text, idx, len, radius = 40) {
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + len + radius);
    return {
      pre: (start > 0 ? '…' : '') + text.slice(start, idx),
      hit: text.slice(idx, idx + len),
      post: text.slice(idx + len, end) + (end < text.length ? '…' : ''),
    };
  }

  ipcMain.handle('history:search', async (_, opts = {}) => {
    const mode = opts.mode || 'chat';
    const field = opts.field === 'content' ? 'content' : 'title';
    const query = String(opts.query || '')
      .trim()
      .toLowerCase();
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.min(50, Math.max(1, Number(opts.limit) || 10));
    if (!query) return { ok: true, total: 0, results: [], hasMore: false };

    let dir;
    if (mode === 'code') {
      dir = getCodeHistoryDir(opts.workspacePath || getSettings().codeMode?.lastWorkspace || null);
      if (!dir) return { ok: false, error: '未打开 Code 工作区' };
    } else if (mode === 'babe') {
      dir = babeHistoryDir;
    } else {
      dir = historyDir;
    }

    try {
      flushPendingHistorySaves();
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      const matches = [];
      const SNIPPET_CAP = 30;
      const MSG_SCAN_CAP = 800;
      const MSG_LEN_CAP = 30000;
      for (let fi = 0; fi < files.length; fi++) {
        // 定期让出事件循环，避免扫描大量历史时阻塞主进程
        if (fi % 8 === 0) await new Promise((r) => setImmediate(r));
        try {
          const filePath = path.join(dir, files[fi]);
          const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
          const id = files[fi].replace(/\.json$/, '');
          const title = data.title || '未命名';
          const updatedAt = data.updatedAt || data.ts || null;
          const messages = Array.isArray(data.messages) ? data.messages : [];
          if (field === 'title') {
            if (!String(title).toLowerCase().includes(query)) continue;
            matches.push({
              id,
              title,
              updatedAt,
              messageCount: messages.length,
              workspacePath: data.workspacePath || null,
              affection: data.affection ?? 0,
              snippets: [],
              snippetTotal: 0,
            });
          } else {
            const snippets = [];
            const scanLimit = Math.min(messages.length, MSG_SCAN_CAP);
            for (let mi = 0; mi < scanLimit && snippets.length < SNIPPET_CAP; mi++) {
              const text = _extractHistorySearchText(messages[mi]).slice(0, MSG_LEN_CAP);
              if (!text) continue;
              const lower = text.toLowerCase();
              let idx = 0;
              while (snippets.length < SNIPPET_CAP) {
                idx = lower.indexOf(query, idx);
                if (idx === -1) break;
                snippets.push(_makeSearchSnippet(text, idx, query.length));
                idx += Math.max(1, query.length);
              }
            }
            if (!snippets.length) continue;
            matches.push({
              id,
              title,
              updatedAt,
              messageCount: messages.length,
              workspacePath: data.workspacePath || null,
              affection: data.affection ?? 0,
              snippets,
              snippetTotal: snippets.length,
            });
          }
        } catch {
          /* 单个历史文件损坏时跳过 */
        }
      }
      matches.sort((a, b) => {
        const ta = typeof a.updatedAt === 'number' ? a.updatedAt : Date.parse(a.updatedAt) || 0;
        const tb = typeof b.updatedAt === 'number' ? b.updatedAt : Date.parse(b.updatedAt) || 0;
        return tb - ta;
      });
      const total = matches.length;
      const results = matches.slice(offset, offset + limit);
      return { ok: true, total, hasMore: offset + limit < total, results };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('history:get', (_, id) => {
    flushPendingHistorySaves();
    const p = dataPath(historyDir, id, '.json');
    return _rehydrateHistoryImages(loadJSON(p, null));
  });

  ipcMain.handle('history:save', (_, conversation) => {
    if (!conversation || !conversation.id) return { ok: false, error: 'invalid conversation' };
    conversation.updatedAt = new Date().toISOString();
    if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
    _externalizeHistoryImages(conversation);
    queueHistorySave(
      'history:' + conversation.id,
      dataPath(historyDir, conversation.id, '.json'),
      conversation,
    );
    _putHistoryIndexEntry(
      _historyIndexFile('chat', historyDir),
      conversation.id,
      _chatHistoryMeta(conversation.id, conversation),
    );
    return { ok: true, queued: true };
  });

  ipcMain.handle('history:delete', (_, id) => {
    try {
      flushPendingHistorySaves();
      fs.unlinkSync(dataPath(historyDir, id, '.json'));
      _removeHistoryIndexEntry(_historyIndexFile('chat', historyDir), id);
      _deleteHistoryImages(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('history:rename', (_, id, title) => {
    flushPendingHistorySaves();
    const p = dataPath(historyDir, id, '.json');
    const data = loadJSON(p, null);
    if (data) {
      data.title = title;
      data.updatedAt = new Date().toISOString();
      saveJSON(p, data, false);
      _putHistoryIndexEntry(_historyIndexFile('chat', historyDir), id, _chatHistoryMeta(id, data));
      return { ok: true };
    }
    return { ok: false };
  });

  return {
    _historyIndexFile,
    _getHistoryIndex,
    _putHistoryIndexEntry,
    _removeHistoryIndexEntry,
    _externalizeHistoryImages,
    _rehydrateHistoryImages,
    _deleteHistoryImages,
    migrateHistoryV2,
    queueHistorySave,
    flushPendingHistorySaves,
  };
};
