/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Crash report window renderer.
 */

'use strict';

(function () {
  const api = window.crashReportAPI;
  const statusEl = document.getElementById('cr-status');
  if (!api) {
    if (statusEl) statusEl.textContent = 'bridge unavailable';
    return;
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
  }

  function fmtSize(n) {
    if (!Number.isFinite(n)) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function render(info) {
    if (!info) return;
    const meta = info.meta || {};
    document.getElementById('cr-when').textContent = '检测于 ' + fmtTime(info.detectedAt);
    const mem = info.currentMemory || {};
    document.getElementById('cr-overview').innerHTML = [
      ['原因', info.records && info.records.length ? '未捕获异常 / 进程异常' : '进程异常退出（无 JS 记录）'],
      ['上次正常退出', fmtTime(info.previousCleanExit)],
      ['被中断会话', String(info.crashedSessionCount || 0)],
      ['版本', `${esc(meta.name)} ${esc(meta.version)}`],
      ['运行时', `Electron ${esc(meta.electron)} / Chromium ${esc(meta.chrome)} / Node ${esc(meta.node)}`],
      ['平台', `${esc(meta.platform)} ${esc(meta.arch)}`],
      ['当前内存', mem.rss ? `RSS ${fmtSize(mem.rss)} · Heap ${fmtSize(mem.heapUsed)} / ${fmtSize(mem.heapTotal)}` : '-'],
      ['日志文件', esc(info.logPath || '-')],
    ].map(([k, v]) => `<div>${esc(k)}</div><b>${v}</b>`).join('');

    const recordsEl = document.getElementById('cr-records');
    if (info.records && info.records.length) {
      recordsEl.innerHTML = info.records.slice().reverse().map((r) => `
        <div class="cr-record">
          <div><span class="src">${esc(r.source)}</span> · ${esc(fmtTime(r.ts))}</div>
          <div>${esc(r.message || '')}</div>
          ${r.stack ? `<pre>${esc(r.stack)}</pre>` : ''}
        </div>`).join('');
    } else {
      recordsEl.innerHTML = '<div class="cr-empty">无记录（可能是原生进程崩溃，请查看下方转储文件与日志尾部）</div>';
    }

    const dumpsEl = document.getElementById('cr-dumps');
    if (info.dumps && info.dumps.length) {
      dumpsEl.innerHTML = info.dumps.map((d) => `
        <div class="cr-dump">
          <span class="name">${esc(d.name)}</span>
          <span class="size">${fmtSize(d.size)}</span>
          <span class="size">${esc(fmtTime(d.mtimeMs))}</span>
        </div>`).join('');
    } else {
      dumpsEl.innerHTML = '<div class="cr-empty">无 dump 文件</div>';
    }

    document.getElementById('cr-log').textContent = info.logTail || '（无日志）';
  }

  async function refresh() {
    setStatus('加载中…');
    try {
      render(await api.getInfo());
      setStatus('');
    } catch (e) {
      setStatus('加载失败: ' + e.message);
    }
  }

  document.getElementById('cr-close').addEventListener('click', () => api.close());
  document.getElementById('cr-open-dir').addEventListener('click', async () => {
    try { await api.openDumpsDir(); } catch { /* ignore */ }
  });
  document.getElementById('cr-export').addEventListener('click', async () => {
    setStatus('正在导出…');
    try {
      const r = await api.exportBundle();
      setStatus(r && r.ok ? '已导出: ' + r.path : (r && r.canceled ? '' : '导出失败: ' + ((r && r.error) || 'unknown')));
    } catch (e) { setStatus('导出失败: ' + e.message); }
  });
  document.getElementById('cr-heap').addEventListener('click', async () => {
    setStatus('正在写入内存快照…');
    try {
      const r = await api.heapSnapshot();
      setStatus(r && r.ok ? `已导出 (${fmtSize(r.size)}): ${r.path}` : (r && r.canceled ? '' : '失败: ' + ((r && r.error) || 'unknown')));
    } catch (e) { setStatus('失败: ' + e.message); }
  });
  document.getElementById('cr-dismiss').addEventListener('click', async () => {
    try { await api.dismiss(); } catch { /* ignore */ }
  });

  refresh();
})();
