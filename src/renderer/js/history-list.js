/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * HistoryList — 历史列表虚拟滚动
 *
 * 目标：历史记录多时只渲染可视窗口内的条目，离屏条目用上下占位高度替代，
 * 大幅降低 DOM 节点数量与内存占用。条目高度固定（CSS 保证），滚动时按步长
 * 计算窗口并重建；交互统一走容器事件委托（data-action），不受重建影响。
 *
 * 使用方式：
 *   HistoryList.attach(container, {
 *     renderItem(item, index) => html,   // 每项含 .history-item[data-id] 与 [data-action] 按钮
 *     onAction(action, item, event),     // 委托点击回调
 *     renderEmpty() => html,
 *     stride,                            // 条目高度+间距（默认 78）
 *     overscan                            // 上下预渲染行数（默认 6）
 *   });
 *   HistoryList.setItems(container, items);
 *   HistoryList.showMessage(container, html);
 *   HistoryList.materializeAll() / HistoryList.restoreAll();  // 镜像快照前展开/恢复
 */

'use strict';

(function () {
  const states = new Map();
  const DEFAULT_STRIDE = 78;   // .history-item 固定 70px + 8px gap
  const DEFAULT_OVERSCAN = 6;

  function createState(container, opts) {
    const scrollParent = container.closest('.page') || container;
    const state = {
      container,
      scrollParent,
      items: [],
      renderItem: opts.renderItem || (() => ''),
      onAction: opts.onAction || (() => {}),
      renderEmpty: opts.renderEmpty || (() => ''),
      stride: Math.max(1, Number(opts.stride) || DEFAULT_STRIDE),
      overscan: Math.max(0, Number(opts.overscan) || DEFAULT_OVERSCAN),
      start: 0,
      end: 0,
      scrollPending: false,
      messageMode: false
    };

    container.classList.add('history-list-virtual');

    const onScroll = () => {
      if (state.scrollPending) return;
      state.scrollPending = true;
      requestAnimationFrame(() => {
        state.scrollPending = false;
        renderWindow(state);
      });
    };
    if (scrollParent !== container) {
      scrollParent.addEventListener('scroll', onScroll, { passive: true });
    } else {
      container.addEventListener('scroll', onScroll, { passive: true });
    }
    state._onScroll = onScroll;

    const onClick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || !container.contains(btn)) return;
      const itemEl = btn.closest('.history-item[data-id]');
      const id = itemEl ? itemEl.dataset.id : btn.dataset.id;
      const item = state.items.find(it => String(it.id) === String(id));
      state.onAction(btn.dataset.action, item, e);
    };
    container.addEventListener('click', onClick);
    state._onClick = onClick;

    // 容器尺寸变化（窗口缩放/页面显示）时重算窗口
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => renderWindow(state, true));
      ro.observe(scrollParent);
      state._ro = ro;
    }

    return state;
  }

  function computeRange(state) {
    const { container, scrollParent, items, stride, overscan } = state;
    if (!items.length) return { start: 0, end: 0 };
    const totalStride = items.length * stride;
    const viewH = scrollParent.clientHeight || container.clientHeight;
    const scrollTop = scrollParent === container ? container.scrollTop : scrollParent.scrollTop;
    // 列表内容不足以滚动时直接全量渲染
    if (viewH >= totalStride) return { start: 0, end: items.length };
    const containerTop = scrollParent === container
      ? 0
      : container.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top + scrollTop;
    const visibleTop = scrollTop - containerTop;
    const start = Math.max(0, Math.floor((visibleTop - overscan * stride) / stride));
    const end = Math.min(items.length, Math.ceil((visibleTop + viewH + overscan * stride) / stride));
    return { start, end };
  }

  function renderWindow(state, force = false) {
    const { container, items, stride, renderItem } = state;
    if (state.messageMode) return;
    const range = computeRange(state);
    if (!force && range.start === state.start && range.end === state.end) return;
    state.start = range.start;
    state.end = range.end;

    if (!items.length) {
      container.innerHTML = state.renderEmpty();
      return;
    }

    const html = items.slice(range.start, range.end)
      .map((item, i) => state.renderItem(item, range.start + i))
      .join('');
    const topPad = Math.max(0, range.start * stride);
    const bottomPad = Math.max(0, (items.length - range.end) * stride);
    const topSpacer = topPad > 0 ? `<div class="history-list-spacer" style="height:${topPad}px"></div>` : '';
    const bottomSpacer = bottomPad > 0 ? `<div class="history-list-spacer" style="height:${bottomPad}px"></div>` : '';
    container.innerHTML = topSpacer + html + bottomSpacer;
  }

  function attach(container, opts = {}) {
    if (!container) return;
    if (states.has(container)) return;
    states.set(container, createState(container, opts));
    renderWindow(states.get(container), true);
  }

  function setItems(container, items) {
    const state = states.get(container);
    if (!state) return;
    state.items = Array.isArray(items) ? items : [];
    state.messageMode = false;
    state.start = -1;
    state.end = -1;
    renderWindow(state, true);
  }

  function showMessage(container, html) {
    const state = states.get(container);
    if (!state) return;
    state.messageMode = true;
    state.items = [];
    state.start = 0;
    state.end = 0;
    container.innerHTML = html || '';
  }

  function getItems(container) {
    const state = states.get(container);
    return state ? state.items.slice() : [];
  }

  function scrollToTop(container) {
    const state = states.get(container);
    if (state) state.scrollParent.scrollTop = 0;
    else if (container) container.scrollTop = 0;
  }

  // 镜像快照前调用：把所有窗口临时展开为完整列表，快照后再恢复。
  function materializeAll() {
    for (const state of states.values()) {
      if (state.messageMode || !state.items.length) continue;
      const html = state.items.map((item, i) => state.renderItem(item, i)).join('');
      state._fullStart = state.start;
      state._fullEnd = state.end;
      state.container.innerHTML = html;
    }
  }

  function restoreAll() {
    for (const state of states.values()) {
      if (state.messageMode || !state.items.length) continue;
      if (state._fullStart === undefined) continue;
      state.start = -1; // 强制重建窗口
      state.end = -1;
      renderWindow(state, true);
      delete state._fullStart;
      delete state._fullEnd;
    }
  }

  function detach(container) {
    const state = states.get(container);
    if (!state) return;
    if (state.scrollParent !== container) {
      state.scrollParent.removeEventListener('scroll', state._onScroll);
    } else {
      container.removeEventListener('scroll', state._onScroll);
    }
    container.removeEventListener('click', state._onClick);
    if (state._ro) state._ro.disconnect();
    container.classList.remove('history-list-virtual');
    states.delete(container);
  }

  window.HistoryList = {
    attach,
    setItems,
    showMessage,
    getItems,
    scrollToTop,
    materializeAll,
    restoreAll,
    detach
  };

  // ---- 历史页搜索：过滤 + Ctrl/Cmd+F 打开（由 05-chat-ui.js 的页面级路由分发）----
  window.makeHistorySearch = function (config) {
    if (!config || !config.inputId) return null;
    const input = document.getElementById(config.inputId);
    if (!input) return null;
    const countEl = document.getElementById(config.countId);
    let query = '';

    function matches(item) {
      const text = String(config.getSearchText ? config.getSearchText(item) : '').toLowerCase();
      return text.includes(query);
    }

    function refresh() {
      const raw = config.getRawItems ? config.getRawItems() : [];
      const filtered = query ? raw.filter(matches) : raw;
      if (countEl) {
        countEl.textContent = query ? `${filtered.length} / ${raw.length}` : '';
      }
      input.classList.toggle('has-results', !!query);
      if (typeof config.onFilterChange === 'function') config.onFilterChange(filtered);
    }

    function clearQuery() {
      if (!query && !input.value) return;
      query = '';
      input.value = '';
      refresh();
    }

    function open() {
      input.focus({ preventScroll: true });
      try { input.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      Promise.resolve().then(() => input.focus({ preventScroll: true }));
    }

    function close() {
      clearQuery();
      input.blur();
    }

    input.addEventListener('input', () => {
      query = input.value.trim().toLowerCase();
      refresh();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    const api = { open, close, clear: clearQuery, refresh, getQuery: () => query };
    if (config.key && typeof window.registerPageSearch === 'function') {
      window.registerPageSearch(config.key, api);
    }
    return api;
  };
})();
