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

  // 高亮片段：主进程返回 {pre, hit, post}，这里拼出带 <mark> 的 HTML
  window.buildSearchSnippetHtml = function (snippet) {
    if (!snippet) return '';
    return escapeHtml(String(snippet.pre || ''))
      + '<mark>' + escapeHtml(String(snippet.hit || '')) + '</mark>'
      + escapeHtml(String(snippet.post || ''));
  };

  /**
   * 历史搜索 V2：标题/内容两种模式 + 每组 10 条分页。
   * - 标题模式：客户端过滤（瞬间完成）
   * - 内容模式：主进程异步扫描历史文件，按时间新→旧、每次 10 条返回，
   *   渲染器分批渲染，绝不把全部内容一次性灌进 DOM。
   */
  window.makeHistorySearchV2 = function (config) {
    if (!config || !config.inputId || !config.listId) return null;
    const input = document.getElementById(config.inputId);
    const listEl = document.getElementById(config.listId);
    if (!input || !listEl) return null;
    const countEl = document.getElementById(config.countId);
    const PAGE_SIZE = 10;
    let query = '';
    let field = 'title'; // 'title' | 'content'
    let page = 0;
    let total = 0;
    let items = [];
    let requestSeq = 0;

    // ---- 注入 标题/内容 切换 + 分页控件 ----
    const bar = input.closest('.search-bar') || input.parentElement;
    const modeWrap = document.createElement('span');
    modeWrap.className = 'history-search-mode';
    const btnTitle = document.createElement('button');
    btnTitle.type = 'button';
    btnTitle.dataset.f = 'title';
    btnTitle.textContent = '标题';
    const btnContent = document.createElement('button');
    btnContent.type = 'button';
    btnContent.dataset.f = 'content';
    btnContent.textContent = '内容';
    modeWrap.append(btnTitle, btnContent);

    const pagerWrap = document.createElement('span');
    pagerWrap.className = 'history-search-pager hidden';
    const btnPrev = document.createElement('button');
    btnPrev.type = 'button';
    btnPrev.dataset.p = 'prev';
    btnPrev.title = '上一组';
    btnPrev.textContent = '‹';
    const pageInfo = document.createElement('span');
    pageInfo.className = 'hs-page-info';
    const btnNext = document.createElement('button');
    btnNext.type = 'button';
    btnNext.dataset.p = 'next';
    btnNext.title = '下一组';
    btnNext.textContent = '›';
    pagerWrap.append(btnPrev, pageInfo, btnNext);
    bar.appendChild(modeWrap);
    bar.appendChild(pagerWrap);

    function setField(f) {
      field = f;
      btnTitle.classList.toggle('active', f === 'title');
      btnContent.classList.toggle('active', f === 'content');
    }

    function updatePager() {
      if (!query) {
        pagerWrap.classList.add('hidden');
        return;
      }
      pagerWrap.classList.remove('hidden');
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      pageInfo.textContent = `${page + 1}/${pages}`;
      btnPrev.disabled = page <= 0;
      btnNext.disabled = page + 1 >= pages;
    }

    function updateCount() {
      if (!countEl) return;
      countEl.textContent = query ? `${total} 条` : '';
    }

    function delegate() {
      listEl.onclick = (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const itemEl = btn.closest('[data-id]');
        const id = itemEl ? itemEl.dataset.id : btn.dataset.id;
        const item = items.find(it => String(it.id) === String(id));
        if (typeof config.onAction === 'function') config.onAction(btn.dataset.action, item, e);
      };
    }

    function renderEmpty(message) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><p>${escapeHtml(message || '没有匹配的历史记录')}</p></div>`;
    }

    function renderBusy() {
      listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>正在搜索内容…</p></div>';
    }

    function render() {
      if (!query) {
        if (typeof config.restoreItems === 'function') config.restoreItems();
        updateCount();
        updatePager();
        return;
      }
      if (!items.length) {
        renderEmpty(field === 'content' ? '没有匹配的内容' : '没有匹配的标题');
      } else {
        const html = items.map(it => (field === 'content' && typeof config.renderContentItem === 'function')
          ? config.renderContentItem(it)
          : config.renderItem(it)).join('');
        if (typeof HistoryList !== 'undefined' && typeof HistoryList.showMessage === 'function') {
          HistoryList.showMessage(listEl, html);
        } else {
          listEl.innerHTML = html;
        }
        delegate();
      }
      updateCount();
      updatePager();
    }

    async function run() {
      if (!query) { render(); return; }
      const seq = ++requestSeq;
      if (field === 'title') {
        const raw = (typeof config.getRawItems === 'function') ? config.getRawItems() : [];
        const getTitle = typeof config.getTitleText === 'function'
          ? config.getTitleText
          : (it => (it && it.title) || '');
        const filtered = raw.filter(it => String(getTitle(it) || '').toLowerCase().includes(query));
        total = filtered.length;
        items = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        render();
        return;
      }
      if (!window.api || typeof window.api.historySearch !== 'function') {
        renderEmpty('当前版本不支持内容搜索');
        return;
      }
      renderBusy();
      try {
        const res = await window.api.historySearch({
          mode: config.searchMode || 'chat',
          query,
          field: 'content',
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
          workspacePath: (typeof config.getWorkspacePath === 'function') ? config.getWorkspacePath() : null
        });
        if (seq !== requestSeq) return;
        if (!res || !res.ok) {
          renderEmpty((res && res.error) || '搜索失败');
          return;
        }
        total = Number(res.total) || 0;
        items = Array.isArray(res.results) ? res.results : [];
      } catch (e) {
        if (seq !== requestSeq) return;
        renderEmpty('搜索失败：' + (e && e.message ? e.message : e));
        return;
      }
      render();
    }

    input.addEventListener('input', () => {
      query = input.value.trim().toLowerCase();
      page = 0;
      run();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    btnTitle.addEventListener('click', () => {
      if (field === 'title') return;
      setField('title');
      page = 0;
      run();
    });
    btnContent.addEventListener('click', () => {
      if (field === 'content') return;
      setField('content');
      page = 0;
      run();
    });
    btnPrev.addEventListener('click', () => {
      if (page > 0) { page--; run(); }
    });
    btnNext.addEventListener('click', () => {
      if ((page + 1) * PAGE_SIZE < total) { page++; run(); }
    });

    function open() {
      input.focus({ preventScroll: true });
      try { input.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      Promise.resolve().then(() => input.focus({ preventScroll: true }));
    }
    function close() {
      query = '';
      input.value = '';
      page = 0;
      setField('title');
      input.blur();
      run();
    }
    const api = {
      open,
      close,
      clear: close,
      refresh: () => { page = 0; run(); },
      getQuery: () => query
    };
    if (config.key && typeof window.registerPageSearch === 'function') {
      window.registerPageSearch(config.key, api);
    }
    setField('title');
    return api;
  };
})();
