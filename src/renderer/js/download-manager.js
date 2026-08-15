/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Download Manager（渲染进程）
 * 基于 aria2 的下载管理 UI：进度展示、暂停/恢复/取消、添加任务。
 * 通过 window.api.aria2.* IPC 与主进程 Aria2Manager 交互。
 *
 * 对外暴露 window.DownloadManager，供 app.js / agent.js 调用：
 *   - openModal() / closeModal()
 *   - addDownload(url, opts) → gid
 *   - refresh() 手动刷新
 */

'use strict';

(function () {
  const MODAL_ID = 'download-manager-modal';
  const ADD_MODAL_ID = 'add-download-modal';
  const POLL_INTERVAL = 1000; // 模态框打开时轮询间隔

  let pollTimer = null;
  let aria2Ready = false;
  let lastDownloads = { active: [], waiting: [], stopped: [] };

  // ===== 工具函数 =====
  function $(id) { return document.getElementById(id); }

  function formatBytes(bytes) {
    bytes = parseInt(bytes || '0', 10);
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
  }

  function formatSpeed(bytesPerSec) {
    return formatBytes(bytesPerSec) + '/s';
  }

  function getFileName(files) {
    if (!files || !files[0]) return '未知文件';
    return files[0].path ? files[0].path.split(/[\\/]/).pop() : (files[0].uris?.[0]?.uri || '未知').split('/').pop();
  }

  function getProgress(item) {
    const total = parseInt(item.totalLength || '0', 10);
    const completed = parseInt(item.completedLength || '0', 10);
    if (total === 0) return 0;
    return Math.min(100, Math.round((completed / total) * 100));
  }

  function statusLabel(status) {
    const map = {
      active: '下载中', waiting: '等待', paused: '已暂停',
      complete: '已完成', error: '错误', removed: '已取消',
      complete_meta: '已完成(元数据)'
    };
    return map[status] || status;
  }

  function statusColor(status) {
    const map = {
      active: 'var(--accent, #4a9eff)', waiting: '#f59e0b', paused: '#6b7280',
      complete: '#10b981', error: '#ef4444', removed: '#9ca3af'
    };
    return map[status] || '#6b7280';
  }

  // ===== aria2 连接 =====
  async function ensureReady() {
    if (aria2Ready) return true;
    try {
      const res = await window.api.aria2.start();
      if (res.ok) {
        aria2Ready = true;
        updateStatusBar();
        return true;
      }
      $('dm-status-text').textContent = 'aria2 启动失败: ' + (res.error || '未知错误');
      return false;
    } catch (e) {
      $('dm-status-text').textContent = 'aria2 连接失败: ' + e.message;
      return false;
    }
  }

  async function updateStatusBar() {
    try {
      const res = await window.api.aria2.status();
      if (res.ok) {
        if (res.ready) {
          $('dm-status-text').textContent = `aria2 运行中 (端口 ${res.port})`;
        } else {
          $('dm-status-text').textContent = 'aria2 未启动';
        }
      }
    } catch {}
  }

  // ===== 渲染下载列表 =====
  function renderDownloads(data) {
    lastDownloads = data;
    const listEl = $('download-list');
    const all = [
      ...(data.active || []),
      ...(data.waiting || []),
      ...(data.stopped || [])
    ];

    // 更新角标计数（活跃 + 等待）
    const pending = (data.active || []).length + (data.waiting || []).length;
    updateBadge(pending);

    if (all.length === 0) {
      listEl.innerHTML = '<div class="download-empty">暂无下载任务</div>';
      $('dm-global-speed').textContent = '';
      return;
    }

    // 计算全局速度
    let totalSpeed = 0;
    for (const item of data.active || []) {
      totalSpeed += parseInt(item.downloadSpeed || '0', 10);
    }
    $('dm-global-speed').textContent = totalSpeed > 0 ? `总速度: ${formatSpeed(totalSpeed)}` : '';

    // 渲染列表
    listEl.innerHTML = all.map(item => renderItem(item)).join('');

    // 绑定操作按钮事件
    listEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', handleItemAction);
    });
  }

  function renderItem(item) {
    const gid = item.gid;
    const name = getFileName(item.files);
    const progress = getProgress(item);
    const status = item.status;
    const color = statusColor(status);
    const total = parseInt(item.totalLength || '0', 10);
    const completed = parseInt(item.completedLength || '0', 10);
    const speed = parseInt(item.downloadSpeed || '0', 10);
    const sizeText = total > 0
      ? `${formatBytes(completed)} / ${formatBytes(total)}`
      : `${formatBytes(completed)}`;
    const speedText = status === 'active' && speed > 0 ? formatSpeed(speed) : '';
    const errText = item.errorMessage ? `<div class="dl-item-error">${escapeHtml(item.errorMessage)}</div>` : '';

    // 操作按钮
    let actions = '';
    if (status === 'active') {
      actions = `<button class="btn-icon btn-xs" data-action="pause" data-gid="${gid}" title="暂停"><i class="fa-solid fa-pause"></i></button>`;
    } else if (status === 'paused' || status === 'waiting') {
      actions = `<button class="btn-icon btn-xs" data-action="resume" data-gid="${gid}" title="恢复"><i class="fa-solid fa-play"></i></button>`;
    }
    if (status !== 'removed') {
      actions += `<button class="btn-icon btn-xs" data-action="cancel" data-gid="${gid}" title="取消"><i class="fa-solid fa-stop"></i></button>`;
    }
    if (status === 'complete' || status === 'error' || status === 'removed') {
      actions += `<button class="btn-icon btn-xs" data-action="remove" data-gid="${gid}" title="删除记录"><i class="fa-solid fa-trash"></i></button>`;
    }

    return `
      <div class="dl-item" data-gid="${gid}">
        <div class="dl-item-header">
          <span class="dl-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="dl-item-status" style="color:${color}">${statusLabel(status)}</span>
        </div>
        <div class="dl-progress-bar">
          <div class="dl-progress-fill" style="width:${progress}%;background:${color}"></div>
        </div>
        <div class="dl-item-info">
          <span class="dl-item-size">${sizeText}</span>
          <span class="dl-item-speed">${speedText}</span>
          <span class="dl-item-pct">${progress}%</span>
          <span class="dl-item-actions">${actions}</span>
        </div>
        ${errText}
      </div>
    `;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ===== 操作处理 =====
  async function handleItemAction(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    const gid = btn.dataset.gid;
    btn.disabled = true;
    try {
      switch (action) {
        case 'pause':
          await window.api.aria2.pause(gid);
          break;
        case 'resume':
          await window.api.aria2.unpause(gid);
          break;
        case 'cancel':
          if (!confirm('确定取消此下载任务？')) { btn.disabled = false; return; }
          await window.api.aria2.cancel(gid, true);
          break;
        case 'remove':
          await window.api.aria2.removeResult(gid);
          break;
      }
    } catch (err) {
      console.error('[download-manager] 操作失败:', err);
    } finally {
      btn.disabled = false;
      await refresh();
    }
  }

  // ===== 刷新 =====
  async function refresh() {
    if (!await ensureReady()) return;
    try {
      const res = await window.api.aria2.listAll();
      if (res.ok) {
        renderDownloads(res);
      } else {
        $('dm-status-text').textContent = '获取下载列表失败: ' + (res.error || '');
      }
    } catch (e) {
      $('dm-status-text').textContent = '刷新失败: ' + e.message;
    }
  }

  // ===== 轮询 =====
  function startPolling() {
    stopPolling();
    refresh();
    pollTimer = setInterval(refresh, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ===== 模态框 =====
  function openModal() {
    $(MODAL_ID).classList.remove('hidden');
    startPolling();
  }

  function closeModal() {
    fadeOutHide($(MODAL_ID));
    stopPolling();
  }

  function openAddDialog() {
    // 预填工作区路径作为默认目录
    const ws = (typeof agent !== 'undefined' && agent.workspacePath) || '';
    $('add-dl-dir').value = ws;
    $('add-dl-url').value = '';
    $('add-dl-filename').value = '';
    $(ADD_MODAL_ID).classList.remove('hidden');
    $('add-dl-url').focus();
  }

  function closeAddDialog() {
    fadeOutHide($(ADD_MODAL_ID));
  }

  async function confirmAddDownload() {
    const url = $('add-dl-url').value.trim();
    const filename = $('add-dl-filename').value.trim();
    const dir = $('add-dl-dir').value.trim();
    if (!url) { $('add-dl-url').focus(); return; }
    if (!dir) { alert('请填写保存目录'); $('add-dl-dir').focus(); return; }

    const opts = { dir };
    if (filename) opts.out = filename;

    $('btn-add-dl-confirm').disabled = true;
    try {
      const res = await window.api.aria2.addUri(url, opts);
      if (res.ok) {
        closeAddDialog();
        await refresh();
      } else {
        alert('添加下载失败: ' + (res.error || '未知错误'));
      }
    } catch (e) {
      alert('添加下载异常: ' + e.message);
    } finally {
      $('btn-add-dl-confirm').disabled = false;
    }
  }

  // ===== 清除已完成 =====
  async function clearCompleted() {
    const stopped = lastDownloads.stopped || [];
    if (stopped.length === 0) return;
    if (!confirm(`确定清除 ${stopped.length} 条已完成/已取消的记录？`)) return;
    for (const item of stopped) {
      try { await window.api.aria2.removeResult(item.gid); } catch {}
    }
    await refresh();
  }

  // ===== 角标更新 =====
  function updateBadge(count) {
    const badges = ['download-badge', 'download-badge-code'];
    for (const id of badges) {
      const el = $(id);
      if (!el) continue;
      if (count > 0) {
        el.textContent = count;
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  }

  // ===== 初始化绑定 =====
  function init() {
    // 工具栏按钮（Chat + Code）
    $('btn-show-downloads')?.addEventListener('click', openModal);
    $('btn-code-show-downloads')?.addEventListener('click', openModal);
    $('btn-close-download-manager')?.addEventListener('click', closeModal);

    // 模态框背景点击关闭
    $(MODAL_ID)?.addEventListener('click', (e) => {
      if (e.target === $(MODAL_ID)) closeModal();
    });

    // 操作按钮
    $('btn-dm-add')?.addEventListener('click', openAddDialog);
    $('btn-dm-refresh')?.addEventListener('click', refresh);
    $('btn-dm-clear-completed')?.addEventListener('click', clearCompleted);

    // 添加下载对话框
    $('btn-close-add-download')?.addEventListener('click', closeAddDialog);
    $('btn-add-dl-cancel')?.addEventListener('click', closeAddDialog);
    $('btn-add-dl-confirm')?.addEventListener('click', confirmAddDownload);
    $(ADD_MODAL_ID)?.addEventListener('click', (e) => {
      if (e.target === $(ADD_MODAL_ID)) closeAddDialog();
    });
    $('add-dl-url')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmAddDownload();
    });

    // 快捷键 Ctrl+D
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'd' && !e.shiftKey && !e.altKey) {
        // 不在输入框中时才触发
        const tag = document.activeElement?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          openModal();
        }
      }
    });

    console.log('[download-manager] 已初始化');
  }

  // 暴露 API
  window.DownloadManager = {
    openModal,
    closeModal,
    refresh,
    init,
    /** 供 Agent 工具调用：添加下载并返回 gid */
    async addDownload(url, opts = {}) {
      if (!await ensureReady()) return { ok: false, error: 'aria2 未就绪' };
      try {
        const res = await window.api.aria2.addUri(url, opts);
        updateBadge(1); // 触发角标更新
        return res;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  };

  // DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
