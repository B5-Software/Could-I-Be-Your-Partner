/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
(function () {
  const api = window.crashReportAPI;
  const el = (id) => document.getElementById(id);
  const status = (text, error = false) => {
    el('cr-status').textContent = text;
    el('cr-status').dataset.error = String(error);
  };
  const time = (value) => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : '未记录';
  };
  const size = (value) => Number.isFinite(value) ? value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KB' : (value / 1048576).toFixed(1) + ' MB' : '未记录';
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value == null ? '' : String(value);
    if (className) node.className = className;
    return node;
  };
  const sourceName = (value) => ({ uncaughtException: '主进程异常', unhandledRejection: '未处理的异步错误', 'render-process-gone': '渲染进程退出', 'child-process-gone': '子进程退出' })[value] || value || '进程异常';
  function render(info) {
    const records = Array.isArray(info.records) ? info.records.slice().reverse() : [];
    const dumps = Array.isArray(info.dumps) ? info.dumps : [];
    const latest = records[0];
    const meta = info.meta || {};
    el('cr-description').textContent = '应用已重新启动。可继续使用，或保存诊断信息以便排查。';
    el('cr-cause').textContent = latest?.message || '未捕获到具体异常。可展开最近日志或检查原生转储文件。';
    el('cr-source').textContent = latest ? sourceName(latest.source) : '异常退出标记';
    el('cr-when').textContent = latest?.ts ? time(latest.ts) : '检测于 ' + time(info.detectedAt);
    el('cr-sessions').textContent = (info.crashedSessionCount || 0) + ' 个';
    el('cr-version').textContent = meta.version || '未记录';
    el('cr-record-count').textContent = String(records.length);
    el('cr-dump-count').textContent = dumps.length + ' 个转储文件';
    el('cr-records').replaceChildren();
    for (const record of records) {
      const article = text('article', '', 'cr-record');
      article.append(text('div', sourceName(record.source) + ' · ' + time(record.ts), 'cr-record-header'), text('p', record.message, 'cr-record-message'));
      if (record.stack) article.append(text('pre', record.stack));
      el('cr-records').append(article);
    }
    if (!records.length) el('cr-records').append(text('p', '没有 JavaScript 异常记录。原生进程退出信息可能保存在日志或转储中。', 'cr-empty'));
    const memory = info.currentMemory || {};
    el('cr-overview').replaceChildren();
    for (const [label, value] of [
      ['应用', (meta.name || 'CIBYP') + ' ' + (meta.version || '')],
      ['运行环境', 'Electron ' + (meta.electron || '—') + ' / Chromium ' + (meta.chrome || '—') + ' / Node ' + (meta.node || '—')],
      ['操作系统', (meta.platform || '—') + ' ' + (meta.arch || '')],
      ['上次正常退出', time(info.previousCleanExit)],
      ['本次进程内存', 'RSS ' + size(memory.rss) + ' · Heap ' + size(memory.heapUsed) + ' / ' + size(memory.heapTotal)],
      ['日志文件', info.logPath || '未记录'],
    ]) el('cr-overview').append(text('dt', label), text('dd', value));
    el('cr-dumps').replaceChildren();
    for (const dump of dumps) {
      const row = text('div', '', 'cr-dump');
      row.append(text('span', dump.name, 'name'), text('span', size(dump.size), 'cr-muted'), text('span', time(dump.mtimeMs), 'cr-muted'));
      el('cr-dumps').append(row);
    }
    if (!dumps.length) el('cr-dumps').append(text('p', '没有原生转储文件。', 'cr-empty'));
    el('cr-log').textContent = info.logTail || '暂无日志。';
    document.querySelector('main').setAttribute('aria-busy', 'false');
    status('关闭此窗口会保留异常记录。');
  }
  function action(id, work, pending, complete) {
    el(id).addEventListener('click', async () => {
      const button = el(id);
      button.disabled = true;
      status(pending);
      try {
        const result = await work();
        if (result?.canceled) status('操作已取消。');
        else if (result?.ok === false) throw new Error(result.error || '操作未完成');
        else status(typeof complete === 'function' ? complete(result) : complete);
      } catch (error) { status(pending.replace(/…$/, '') + '失败：' + error.message, true); }
      finally { button.disabled = false; }
    });
  }
  if (!api) { status('无法连接诊断服务。请关闭窗口后重新打开应用。', true); return; }
  for (const id of ['cr-close', 'cr-continue']) action(id, () => api.close(), '正在关闭…', '');
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); api.close(); } });
  action('cr-copy', () => api.copyReport(), '正在复制报告…', '诊断报告已复制，可粘贴到问题反馈中。');
  action('cr-export', () => api.exportBundle(), '正在导出诊断包…', (result) => '诊断包已保存：' + result.path);
  action('cr-open-logs', () => api.openLogsDir(), '正在打开日志目录…', '日志目录已打开。');
  action('cr-open-dir', () => api.openDumpsDir(), '正在打开转储目录…', '转储目录已打开。');
  action('cr-heap', () => api.heapSnapshot(), '正在导出内存快照…', (result) => '内存快照已保存（' + size(result.size) + '）：' + result.path);
  action('cr-dismiss', () => api.dismiss(), '正在清除记录…', '记录已清除。');
  api.getInfo().then(render).catch((error) => {
    el('cr-heading').textContent = '诊断信息暂时不可用';
    el('cr-description').textContent = '可继续使用应用，或打开日志目录手动检查。';
    document.querySelector('main').setAttribute('aria-busy', 'false');
    status('读取失败：' + error.message, true);
  });
  const updateContrast = () => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (/^#[0-9a-f]{6}$/i.test(accent)) {
      const rgb = [1, 3, 5].map((offset) => parseInt(accent.slice(offset, offset + 2), 16) / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      document.body.style.setProperty('--cr-accent-text', luminance > .179 ? '#101828' : '#ffffff');
    }
  };
  new MutationObserver(updateContrast).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
  updateContrast();
})();
