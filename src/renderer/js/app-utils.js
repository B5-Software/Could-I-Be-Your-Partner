/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

'use strict';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && p.type === 'text' && p.text)
      .map(p => p.text)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

function cssEscape(str) {
  if (typeof str !== 'string') return '';
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str);
  return str.replace(/["\\]/g, '\\$&');
}

function fmtTokenCount(n, pfx = '') {
  const num = Number(n) || 0;
  if (num >= 1e15) return `${pfx}${(num / 1e15).toFixed(2)}P`;
  if (num >= 1e12) return `${pfx}${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `${pfx}${(num / 1e9).toFixed(2)}G`;
  if (num >= 1e6) return `${pfx}${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${pfx}${(num / 1e3).toFixed(1)}K`;
  return `${pfx}${num}`;
}

// 工作累计用时格式化：不足 1 小时显示 mm:ss，否则 hh:mm:ss
function formatWorkDuration(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 0) return '00:00';
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${m}:${ss}` : `${m}:${ss}`;
}

function escapeHtmlSimple(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getPathDirname(filePath) {
  const p = String(filePath || '');
  const idxSlash = p.lastIndexOf('/');
  const idxBackslash = p.lastIndexOf('\\');
  const idx = Math.max(idxSlash, idxBackslash);
  return idx >= 0 ? p.slice(0, idx) : '';
}

function joinPath(base, name) {
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base}${base.endsWith(sep) ? '' : sep}${name}`;
}

function getPathBasename(filePath) {
  const p = String(filePath || '').replace(/[\\/]+$/, '');
  const idxSlash = p.lastIndexOf('/');
  const idxBackslash = p.lastIndexOf('\\');
  const idx = Math.max(idxSlash, idxBackslash);
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = text;
  const codeBlocks = [];
  const mathBlocks = [];
  const inlineMath = [];
  const tables = [];

  html = html.replace(/(\n|^)(\|.+\|)\n(\|[-:\s|]+\|)\n((?:\|.+\|\n?)*)/gm, (match, prefix, header, separator, rows) => {
    const tableData = {
      header: header.trim().split('|').filter(c => c.trim()).map(c => c.trim()),
      rows: rows.trim().split('\n').map(row => row.split('|').filter(c => c.trim()).map(c => c.trim()))
    };
    tables.push(tableData);
    return `${prefix}__TABLE${tables.length - 1}__`;
  });

  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (m, math) => {
    mathBlocks.push(math);
    return `__MATHBLOCK${mathBlocks.length - 1}__`;
  });
  html = html.replace(/\$([^$\n]+?)\$/g, (m, math) => {
    inlineMath.push(math);
    return `__INLINEMATH${inlineMath.length - 1}__`;
  });
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    codeBlocks.push({ lang: (lang || '').trim(), code });
    return `__CODEBLOCK${codeBlocks.length - 1}__`;
  });

  html = escapeHtml(html);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^[\-\*] (.+)$/gm, '<UL_ITEM>$1</UL_ITEM>');
  html = html.replace(/(<UL_ITEM>.*<\/UL_ITEM>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/<UL_ITEM>/g, '<li>').replace(/<\/UL_ITEM>/g, '</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<OL_ITEM>$1</OL_ITEM>');
  html = html.replace(/(<OL_ITEM>.*<\/OL_ITEM>\n?)+/g, '<ol>$&</ol>');
  html = html.replace(/<OL_ITEM>/g, '<li>').replace(/<\/OL_ITEM>/g, '</li>');
  html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" data-external="true">$1</a>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  html = html.replace(/__TABLE(\d+)__/g, (m, i) => {
    const table = tables[parseInt(i)];
    let tableHtml = '<div class="table-wrapper" style="overflow-x:auto;margin:12px 0;"><table class="markdown-table" style="border-collapse:collapse;width:100%;max-width:100%;">';
    tableHtml += '<thead><tr>';
    table.header.forEach(cell => {
      tableHtml += `<th style="border:1px solid var(--border-color);padding:8px;background:var(--bg-secondary);text-align:left;font-weight:600;">${escapeHtml(cell)}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';
    table.rows.forEach(row => {
      if (row.length > 0) {
        tableHtml += '<tr>';
        row.forEach(cell => {
          tableHtml += `<td style="border:1px solid var(--border-color);padding:8px;">${escapeHtml(cell)}</td>`;
        });
        tableHtml += '</tr>';
      }
    });
    tableHtml += '</tbody></table></div>';
    return tableHtml;
  });

  html = html.replace(/__CODEBLOCK(\d+)__/g, (m, i) => {
    const { lang, code } = codeBlocks[parseInt(i)];
    return `<pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`;
  });
  html = html.replace(/__MATHBLOCK(\d+)__/g, (m, i) => {
    const math = mathBlocks[parseInt(i)];
    try {
      if (window.katex) return `<div class="math-block">${window.katex.renderToString(math, { displayMode: true, throwOnError: false })}</div>`;
    } catch {}
    return `<div class="math-block">$$${escapeHtml(math)}$$</div>`;
  });
  html = html.replace(/__INLINEMATH(\d+)__/g, (m, i) => {
    const math = inlineMath[parseInt(i)];
    try {
      if (window.katex) return `<span class="math-inline">${window.katex.renderToString(math, { displayMode: false, throwOnError: false })}</span>`;
    } catch {}
    return `<span class="math-inline">$${escapeHtml(math)}$</span>`;
  });
  if (!html.startsWith('<')) html = '<p>' + html + '</p>';
  return html;
}

function sessionStatusLabel(status) {
  const map = {
    running: '运行中',
    waiting_approval: '等待审批',
    waiting_tool_auth: '等待授权',
    queued: '排队中',
    done: '已完成',
    error: '失败',
    interrupted: '已中断',
    stopped: '已停止',
    crashed: '异常退出',
    idle: '空闲'
  };
  return map[status] || status || '空闲';
}

function sessionAttentionMeta(attention) {
  if (!attention || !attention.kind) return null;
  const map = {
    approval: { label: '等待审批', cls: 'attention-approval', icon: 'fa-hand' },
    'tool-auth': { label: '等待授权', cls: 'attention-tool-auth', icon: 'fa-shield-halved' },
    questionnaire: { label: '等待问卷回答', cls: 'attention-questionnaire', icon: 'fa-clipboard-question' },
    game: { label: '等待游戏回应', cls: 'attention-game', icon: 'fa-gamepad' }
  };
  return map[attention.kind] || {
    label: attention.label || '等待处理',
    cls: 'attention-other',
    icon: 'fa-hourglass-half'
  };
}

function sessionStatusBadge(status, lastError, attention) {
  const meta = sessionAttentionMeta(attention);
  if (meta) {
    const title = lastError ? ` title="${escapeHtml(lastError)}"` : '';
    return `<span class="history-status attention ${meta.cls}"${title}><i class="fa-solid ${meta.icon}"></i> ${escapeHtml(meta.label)}</span>`;
  }
  const label = sessionStatusLabel(status);
  const title = lastError ? ` title="${escapeHtml(lastError)}"` : '';
  return `<span class="history-status status-${escapeHtml(status || 'idle')}"${title}><i class="fa-solid fa-circle"></i> ${escapeHtml(label)}</span>`;
}

/**
 * 取历史条目的实时展示状态：若该会话当前仍在 SessionManager 中（后台运行/等待交互），
 * 用实时 status/attention 覆盖磁盘快照，使历史列表能显示"等待审批/问卷/游戏邀请"等，
 * 而不是停留在"运行中"。
 */
function getSessionLiveState(mode, item) {
  const fallback = { status: (item && item.status) || 'idle', attention: null, lastError: (item && item.lastError) || null };
  const sm = window.__sessionManager;
  if (!sm || !item || !item.id) return fallback;
  const live = sm.list(mode).find(s => String(s.id) === String(item.id));
  if (!live) return fallback;
  let attention = live.attention || null;
  if (!attention && live.status === 'waiting_approval') attention = { kind: 'approval', label: '等待审批' };
  if (!attention && live.status === 'waiting_tool_auth') attention = { kind: 'tool-auth', label: '等待授权' };
  return { status: live.status, attention, lastError: live.lastError || fallback.lastError };
}

function showToast(message, type = 'info', duration = 5000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = {
    error: 'fa-circle-xmark',
    warn: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
    success: 'fa-circle-check'
  };
  const kind = icons[type] ? type : 'info';
  const el = document.createElement('div');
  el.className = `toast-item toast-${kind}`;
  el.innerHTML = `<i class="fa-solid ${icons[kind]} toast-icon"></i><span class="toast-text">${escapeHtml(String(message))}</span>`;
  container.appendChild(el);
  // 渐显：双 rAF 确保初始样式先落地，再触发过渡
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-visible')));
  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    el.classList.remove('toast-visible');
    el.classList.add('toast-leave');
    setTimeout(() => el.remove(), 320);
  };
  const removeTimer = setTimeout(dismiss, duration);
  el.addEventListener('click', () => { clearTimeout(removeTimer); dismiss(); });
}

window.showToast = showToast;

// ---- 模态框渐隐（fade-out）辅助 ----
// 关闭模态框时先播放 fadeOut 动画，动画结束后再真正隐藏/移除 DOM。
// CSS 侧配合 `.modal-fade-out { animation: fadeOut ... forwards }` 使用。
// 「动效」设置中关闭模态框动画时（html[data-modal-animations="off"]），直接瞬时关闭。
const MODAL_FADE_MS = 200;

function _modalAnimationsEnabled() {
  return document.documentElement.getAttribute('data-modal-animations') !== 'off';
}

function _fadeOutPrepare(el) {
  if (!_modalAnimationsEnabled()) return false;
  if (!el || el.classList.contains('modal-fade-out')) return false;
  el.classList.add('modal-fade-out');
  return true;
}

// 渐隐后加 .hidden（适用于 .modal-overlay 等静态模态框）
function fadeOutHide(el, cb) {
  if (!el || el.classList.contains('hidden')) { if (cb) cb(); return; }
  if (!_fadeOutPrepare(el)) { el.classList.add('hidden'); if (cb) cb(); return; }
  setTimeout(() => {
    if (!el.parentNode) { if (cb) cb(); return; }
    el.classList.add('hidden');
    el.classList.remove('modal-fade-out');
    if (cb) cb();
  }, MODAL_FADE_MS);
}

// 渐隐后从 DOM 移除（适用于动态创建的模态框）
function fadeOutRemove(el, cb) {
  if (!el || !el.parentNode) { if (cb) cb(); return; }
  if (!_fadeOutPrepare(el)) { el.remove(); if (cb) cb(); return; }
  setTimeout(() => {
    el.remove();
    if (cb) cb();
  }, MODAL_FADE_MS);
}

window.fadeOutHide = fadeOutHide;
window.fadeOutRemove = fadeOutRemove;
