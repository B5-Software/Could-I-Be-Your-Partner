/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 选中文本右键菜单（Chat / Code / Babe 通用）：
 *   复制（带格式）/ 复制为纯文本 / 引用到输入框 / 复制代码块 / 全选本消息
 * 通过 capture 阶段 contextmenu 抢占，原有消息/图片/文件树菜单在无选区时不受影响。
 */

(() => {
  const MENU_CLASS = 'selection-context-menu';
  const OTHER_MENU_SELECTORS = '.message-context-menu, .image-context-menu, .file-tree-context-menu, .session-context-menu, .automation-context-menu';

  const tr = (key, fallback) => (typeof window.t === 'function' ? window.t(key, fallback) : fallback);

  function closeSelectionMenus() {
    document.querySelectorAll('.' + MENU_CLASS).forEach((m) => m.remove());
  }

  function getModeInput() {
    let mode = 'chat';
    try { mode = (typeof window.getCurrentMode === 'function') ? window.getCurrentMode() : 'chat'; } catch { /* ignore */ }
    if (mode === 'code') return document.getElementById('code-chat-input');
    if (mode === 'babe') return document.getElementById('babe-chat-input');
    return document.getElementById('chat-input');
  }

  function getSelectionScope() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = String(sel.toString() || '');
    if (!text.trim()) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (!startEl || !startEl.closest) return null;
    if (startEl.closest('input, textarea, [contenteditable="true"], .' + MENU_CLASS)) return null;
    if (startEl.closest('img.chat-image')) return null;
    const container = startEl.closest('#chat-messages, #code-chat-messages, #babe-chat-messages');
    if (!container) return null;
    const msgEl = startEl.closest('.message, .babe-message');
    return { sel, range, text, container, msgEl, startEl };
  }

  function selectionPlainText(scope) {
    return String(scope.text || '').replace(/\r\n/g, '\n');
  }

  function selectionHtml(scope) {
    try {
      const div = document.createElement('div');
      div.appendChild(scope.range.cloneContents());
      div.querySelectorAll('.streaming-cursor, .katex-mathml').forEach((el) => el.remove());
      return div.innerHTML;
    } catch {
      return '';
    }
  }

  function selectedCodeBlock(scope) {
    const pre = scope.startEl && scope.startEl.closest ? scope.startEl.closest('pre') : null;
    if (!pre) return '';
    return String(pre.textContent || '').trim();
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    try { await window.api.writeClipboard(text); return true; } catch { return false; }
  }

  async function copyRich(scope) {
    const text = selectionPlainText(scope);
    const html = selectionHtml(scope) || `<pre>${text}</pre>`;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
        return true;
      }
    } catch { /* fall through */ }
    return copyText(text);
  }

  function quoteToInput(scope) {
    const input = getModeInput();
    if (!input) return false;
    const isUser = scope.msgEl && scope.msgEl.classList.contains('user');
    const role = isUser ? tr('ui.chat.me', '我') : tr('ui.chat.ai', 'AI');
    const timeEl = scope.msgEl ? scope.msgEl.querySelector('.message-time, .babe-msg-time') : null;
    const time = timeEl ? String(timeEl.textContent || '').trim() : '';
    const attribution = [tr('ui.chat.quote', '引用'), role, time].filter(Boolean).join(' · ');
    const quoted = selectionPlainText(scope).split('\n').map((l) => '> ' + l).join('\n');
    const block = `${quoted}\n> — ${attribution}`;
    const existing = String(input.value || '');
    input.value = existing.trim() ? `${existing.replace(/\s+$/, '')}\n${block}\n` : `${block}\n`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    try { input.focus(); } catch { /* ignore */ }
    return true;
  }

  function selectWholeMessage(scope) {
    if (!scope.msgEl) return false;
    const target = scope.msgEl.querySelector('.message-content, .babe-msg-bubble, .babe-msg-body') || scope.msgEl;
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  function makeEntry(icon, label, onClick) {
    const item = document.createElement('div');
    item.style.cssText = 'padding:8px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;white-space:nowrap;color:var(--text-primary);';
    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid ${icon}`;
    iconEl.style.cssText = 'width:20px;flex-shrink:0;text-align:center;font-size:13px;';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    item.append(iconEl, labelEl);
    item.addEventListener('mouseenter', () => { item.style.backgroundColor = 'var(--bg-hover)'; });
    item.addEventListener('mouseleave', () => { item.style.backgroundColor = 'transparent'; });
    item.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return item;
  }

  function toast(message, type) {
    if (typeof window.showToast === 'function') window.showToast(message, type || 'success', 1600);
  }

  function showSelectionMenu(x, y, scope) {
    closeSelectionMenus();
    const menu = document.createElement('div');
    menu.className = MENU_CLASS;
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);padding:4px 0;z-index:10001;min-width:190px;`;

    const add = (icon, label, fn) => menu.appendChild(makeEntry(icon, label, fn));

    add('fa-clipboard', tr('ui.chat.copyFormatted', '复制（带格式）'), async () => {
      menu.remove();
      const ok = await copyRich(scope);
      toast(ok ? tr('ui.chat.copied', '已复制') : tr('ui.chat.copyFailed', '复制失败'), ok ? 'success' : 'error');
    });
    add('fa-file-lines', tr('ui.chat.copyPlain', '复制为纯文本'), async () => {
      menu.remove();
      const ok = await copyText(selectionPlainText(scope));
      toast(ok ? tr('ui.chat.copied', '已复制') : tr('ui.chat.copyFailed', '复制失败'), ok ? 'success' : 'error');
    });
    add('fa-quote-right', tr('ui.chat.quoteAction', '引用'), () => {
      menu.remove();
      if (quoteToInput(scope)) toast(tr('ui.chat.quoted', '已引用到输入框'));
    });
    const code = selectedCodeBlock(scope);
    if (code) {
      add('fa-code', tr('ui.chat.copyCode', '复制代码块'), async () => {
        menu.remove();
        const ok = await copyText(code);
        toast(ok ? tr('ui.chat.copied', '已复制') : tr('ui.chat.copyFailed', '复制失败'), ok ? 'success' : 'error');
      });
    }
    add('fa-object-group', tr('ui.chat.selectMessage', '全选本消息'), () => {
      menu.remove();
      selectWholeMessage(scope);
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) menu.style.left = Math.max(4, window.innerWidth - rect.width - 8) + 'px';
    if (y + rect.height > window.innerHeight - 8) menu.style.top = Math.max(4, window.innerHeight - rect.height - 8) + 'px';

    setTimeout(() => {
      const cleanup = () => {
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
      };
      const onDocClick = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); cleanup(); }
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape') { menu.remove(); cleanup(); }
      };
      const onScroll = () => { menu.remove(); cleanup(); };
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
  }

  document.addEventListener('contextmenu', (e) => {
    try {
      const target = e.target;
      if (target && target.closest && target.closest(OTHER_MENU_SELECTORS)) return;
      const scope = getSelectionScope();
      if (!scope) return;
      e.preventDefault();
      e.stopPropagation();
      showSelectionMenu(e.clientX, e.clientY, scope);
    } catch { /* ignore */ }
  }, true);
})();
