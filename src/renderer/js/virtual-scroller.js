/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Virtual Scroller — 聊天记录动态渲染
 *
 * 目标：只渲染可视区域附近的消息，离屏消息保留占位高度。
 * 仅作用于"渲染层"：不影响 ContextManager 的实际上下文消息数组。
 *
 * 内存优化（大历史记录）：
 *   - 离屏且已渲染的消息：清空 markdown 内容释放内存（保留 raw content）
 *   - 超过 VIRTUALIZE_THRESHOLD 条后，距离可视区超过 FAR_MARGIN 的
 *     消息节点会从 DOM 中移除，替换为等高的占位 div；滚动回来时重建。
 *     这样上万条历史也只会保留少量 DOM 节点。
 *
 * 使用方式（由 app.js 调用）：
 *   VirtualScroller.attach(containerEl)         // 初始化监听
 *   VirtualScroller.markBatchStart()             // 批量加载开始（暂停滚动渲染）
 *   VirtualScroller.markBatchEnd()                // 批量加载结束（触发首屏渲染）
 *   VirtualScroller.observeMessage(el, raw)       // 注册单个消息元素
 *   VirtualScroller.pause() / resume()            // 暂停/恢复观察（子代理运行时）
 *   VirtualScroller.reset()                       // 清理所有观察状态（切换会话）
 *
 * 实现：IntersectionObserver 检测可见性，可见才渲染 markdown。
 */

'use strict';

(function () {
  let container = null;
  let observer = null;
  let paused = false;
  let batchMode = false;
  const pendingRender = new Set(); // 待渲染的元素（批量加载时累积）
  const observedEls = new Set();   // 所有已注册消息元素（用于统计数量）
  const spacerMap = new Map();     // 已回收的消息元素 -> 占位 div

  // 离屏消息的占位高度估算（像素）。实际渲染后会被真实高度替代。
  const PLACEHOLDER_MIN_HEIGHT = 60;
  // 超过该消息数后启用"远端节点回收"（避免小会话不必要的重建开销）
  const VIRTUALIZE_THRESHOLD = 300;
  // 节点离开可视区超过该像素距离时回收
  const FAR_MARGIN = 1500;

  function isElementInViewport(el, containerEl) {
    const rect = el.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    // 提前预渲染：上下各扩展 200px 缓冲区
    const buffer = 200;
    return rect.bottom > containerRect.top - buffer &&
           rect.top < containerRect.bottom + buffer;
  }

  function isFarOffscreen(el, containerEl) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    return rect.bottom < containerRect.top - FAR_MARGIN ||
           rect.top > containerRect.bottom + FAR_MARGIN;
  }

  /**
   * 渲染单个消息的 markdown 内容（如果尚未渲染）
   */
  function renderMessageContent(el) {
    if (el.dataset.vscRendered === '1') return;
    const rawContent = el.dataset.vscRawContent;
    if (!rawContent) {
      el.dataset.vscRendered = '1';
      return;
    }
    const contentEl = el.querySelector('.message-content');
    if (!contentEl) {
      el.dataset.vscRendered = '1';
      return;
    }
    // 调用全局 renderMarkdown（由 app.js 暴露）
    if (typeof window.renderMarkdown === 'function') {
      contentEl.innerHTML = window.renderMarkdown(rawContent);
    }
    el.dataset.vscRendered = '1';
    el.style.minHeight = '';
    el.classList.remove('vsc-placeholder');
  }

  /**
   * 将消息降级为占位状态（离屏时）。统一处理 user/assistant：
   * 清空渲染内容释放内存（原始内容保留在 dataset.vscRawContent 中）。
   */
  function unrenderMessageContent(el) {
    if (el.dataset.vscRendered !== '1') return;
    const contentEl = el.querySelector('.message-content');
    if (!contentEl) return;
    // 保存当前高度作为占位高度，避免滚动跳动
    const height = el.offsetHeight;
    el.style.minHeight = Math.max(height, PLACEHOLDER_MIN_HEIGHT) + 'px';
    el.classList.add('vsc-placeholder');
    // 清空渲染内容释放内存
    contentEl.innerHTML = '<span class="vsc-placeholder-text">消息内容已折叠（滚动到此处自动展开）</span>';
    el.dataset.vscRendered = '0';
  }

  /**
   * 从 DOM 中回收远端消息节点，替换为等高的占位 div（释放内存）。
   * 滚动回可视区时由 restoreMessage 重建。
   */
  function pruneMessage(el) {
    if (!el || !el.isConnected || spacerMap.has(el)) return;
    if (observedEls.size <= VIRTUALIZE_THRESHOLD) return;
    // 仅回收当前容器内的节点（避免误伤 Babe/Code 等独立容器的消息）
    if (!container || !container.contains(el)) return;
    if (!isFarOffscreen(el, container)) return;
    // 先确保已释放 markdown 内容
    if (el.dataset.vscRendered === '1') unrenderMessageContent(el);
    const height = el.offsetHeight || PLACEHOLDER_MIN_HEIGHT;
    const spacer = document.createElement('div');
    spacer.className = 'vsc-spacer';
    spacer.dataset.vscSpacerFor = '';
    spacer.style.minHeight = Math.max(height, PLACEHOLDER_MIN_HEIGHT) + 'px';
    spacer.style.width = '100%';
    if (observer) observer.unobserve(el);
    el.replaceWith(spacer);
    spacerMap.set(el, spacer);
    if (observer) observer.observe(spacer);
  }

  /**
   * 将占位 div 恢复为真实消息节点（滚动回可视区时）
   * 直接复用原消息节点（元素一直存活在 spacerMap 中），无需重建骨架。
   */
  function restoreMessage(el, spacer) {
    if (!spacer || !spacer.isConnected) {
      spacerMap.delete(el);
      return;
    }
    if (observer) observer.unobserve(spacer);
    spacer.replaceWith(el);
    if (observer) observer.observe(el);
    spacerMap.delete(el);
    // 恢复后立即渲染（如果在可视区）
    if (el.dataset.vscRendered === '0') renderMessageContent(el);
  }

  function handleIntersect(entries) {
    if (paused || batchMode) return;
    for (const entry of entries) {
      const el = entry.target;
      if (entry.isIntersecting) {
        // 命中占位 div：恢复对应消息节点
        if (el.classList.contains('vsc-spacer')) {
          for (const [orig, spacer] of spacerMap) {
            if (spacer === el) {
              restoreMessage(orig, spacer);
              break;
            }
          }
          continue;
        }
        // 进入可视区：渲染 markdown
        renderMessageContent(el);
      } else {
        // 离开可视区：先降级为占位释放内容，若距离太远且消息量很大则回收节点
        if (el.dataset.vscRendered === '1') unrenderMessageContent(el);
        pruneMessage(el);
      }
    }
  }

  function attach(containerEl) {
    container = containerEl;
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(handleIntersect, {
      root: containerEl,
      // 提前预渲染：上下各扩展 200px
      rootMargin: '200px 0px 200px 0px',
      threshold: 0
    });
    console.log('[VirtualScroller] 已挂载到容器:', containerEl?.id || 'unknown');
  }

  /**
   * 注册单个消息元素以观察可见性
   * @param {HTMLElement} el 消息元素
   * @param {string} [rawContent] 原始 markdown 内容（assistant 消息需要）
   */
  function observeMessage(el, rawContent) {
    if (!el || !observer) return;
    // 避免重复观察
    if (el.dataset.vscObserved === '1') return;
    el.dataset.vscObserved = '1';
    if (rawContent) {
      el.dataset.vscRawContent = rawContent;
      // 初始状态：未渲染（等 IntersectionObserver 触发）
      el.dataset.vscRendered = '0';
      el.classList.add('vsc-placeholder');
      el.style.minHeight = PLACEHOLDER_MIN_HEIGHT + 'px';
    } else {
      // user 消息或无需 markdown 的消息：直接渲染
      el.dataset.vscRendered = '1';
    }
    observedEls.add(el);
    observer.observe(el);
    // 批量模式下累积，稍后统一处理首屏
    if (batchMode) {
      pendingRender.add(el);
    } else if (isElementInViewport(el, container)) {
      // 非批量模式：立即可见的直接渲染
      renderMessageContent(el);
    }
  }

  /**
   * 批量加载开始：暂停 IntersectionObserver 回调
   */
  function markBatchStart() {
    batchMode = true;
    pendingRender.clear();
  }

  /**
   * 批量加载结束：触发首屏渲染
   * 在批量加载过程中，所有消息都注册为占位状态，
   * 现在检查哪些在可视区域并渲染它们。
   */
  function markBatchEnd() {
    batchMode = false;
    // 渲染当前可视区域内的所有消息
    if (container && pendingRender.size > 0) {
      for (const el of pendingRender) {
        if (isElementInViewport(el, container)) {
          renderMessageContent(el);
        }
      }
    }
    pendingRender.clear();
    // 滚动到底部
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function pause() {
    paused = true;
  }

  function resume() {
    paused = false;
    // 恢复时检查所有观察元素，渲染可见的
    if (container) {
      for (const el of container.querySelectorAll('[data-vsc-observed="1"]')) {
        if (isElementInViewport(el, container) && el.dataset.vscRendered === '0') {
          renderMessageContent(el);
        }
      }
    }
  }

  /**
   * 清理所有观察状态（切换会话时调用）
   */
  function reset() {
    if (observer) observer.disconnect();
    pendingRender.clear();
    // 恢复所有被回收的节点（替换回真实消息节点），保持 DOM 完整
    for (const [el, spacer] of spacerMap) {
      if (spacer && spacer.isConnected) {
        try { spacer.replaceWith(el); } catch { /* ignore */ }
      }
    }
    spacerMap.clear();
    if (container) {
      container.querySelectorAll('[data-vsc-observed="1"]').forEach(el => {
        delete el.dataset.vscObserved;
        delete el.dataset.vscRendered;
        delete el.dataset.vscRawContent;
        el.classList.remove('vsc-placeholder');
        el.style.minHeight = '';
      });
    }
    observedEls.clear();
  }

  // ---- Code/Babe 消息容器轻量懒渲染 ----
  // 与主 VirtualScroller 完全隔离：通过 scroll + rAF 回收离屏消息的
  // 渲染内容（innerHTML 清空、保留高度占位），原始 markdown 存于
  // dataset.lazyRaw，滚回可视区时重新渲染。避免长会话下
  // Code/Babe 容器 DOM 无界增长（这些容器未接入主虚拟滚动）。
  const lazyStates = new WeakMap();

  /**
   * 为独立消息容器启用懒渲染（如 #code-chat-messages / #babe-chat-messages）。
   * @param {HTMLElement} containerEl 消息容器
   * @param {object} [opts]
   * @param {number} [opts.threshold=200] 消息数超过该值才启用折叠
   * @param {number} [opts.farMargin=1200] 离开可视区超过该像素距离才折叠
   * @param {string} [opts.selector='.message'] 消息元素选择器
   * @param {string} [opts.contentSel='.message-content'] 内容元素选择器
   * @param {string} [opts.skipSel] 跳过折叠的元素选择器（如流式气泡）
   */
  function attachLazyContainer(containerEl, opts = {}) {
    if (!containerEl || lazyStates.has(containerEl)) return;
    const state = {
      threshold: opts.threshold || 200,
      farMargin: opts.farMargin || 1200,
      selector: opts.selector || '.message',
      contentSel: opts.contentSel || '.message-content',
      skipSel: opts.skipSel || '',
      scrollPending: false
    };
    const processLazy = () => {
      state.scrollPending = false;
      if (!containerEl.isConnected) return;
      const msgs = containerEl.querySelectorAll(state.selector);
      if (msgs.length <= state.threshold) return;
      const cRect = containerEl.getBoundingClientRect();
      for (const el of msgs) {
        if (el.dataset.vscObserved === '1') continue;
        if (state.skipSel && el.matches(state.skipSel)) continue;
        const contentEl = el.querySelector(state.contentSel);
        if (!contentEl || !contentEl.childNodes.length) continue;
        const r = el.getBoundingClientRect();
        const far = r.bottom < cRect.top - state.farMargin || r.top > cRect.bottom + state.farMargin;
        if (far && el.dataset.lazy !== '0') {
          // 折叠：释放渲染内容，保留高度
          el.dataset.lazy = '0';
          const h = el.offsetHeight || 60;
          el.style.minHeight = Math.max(h, 60) + 'px';
          contentEl.innerHTML = '<span class="vsc-placeholder-text">消息内容已折叠（滚动到此处自动展开）</span>';
        } else if (!far && el.dataset.lazy === '0') {
          // 恢复：重新渲染原始内容
          el.dataset.lazy = '1';
          el.style.minHeight = '';
          const raw = el.dataset.lazyRaw;
          if (raw) {
            if (el.dataset.lazyRole === 'md' && typeof window.renderMarkdown === 'function') {
              contentEl.innerHTML = window.renderMarkdown(raw);
            } else if (typeof window.escapeHtml === 'function') {
              contentEl.innerHTML = window.escapeHtml(raw);
            } else {
              contentEl.innerHTML = raw;
            }
          }
        }
      }
    };
    const onScroll = () => {
      if (state.scrollPending) return;
      state.scrollPending = true;
      requestAnimationFrame(processLazy);
    };
    containerEl.addEventListener('scroll', onScroll, { passive: true });
    lazyStates.set(containerEl, state);
  }

  function resetLazyContainer(containerEl) {
    const state = lazyStates.get(containerEl);
    if (!state) return;
    // 恢复所有被折叠的消息（切换会话时由调用方清空容器）
    containerEl.querySelectorAll('[data-lazy="0"]').forEach(el => {
      el.dataset.lazy = '1';
      el.style.minHeight = '';
      const contentEl = el.querySelector(state.contentSel);
      const raw = el.dataset.lazyRaw;
      if (contentEl && raw) {
        if (el.dataset.lazyRole === 'md' && typeof window.renderMarkdown === 'function') {
          contentEl.innerHTML = window.renderMarkdown(raw);
        } else if (typeof window.escapeHtml === 'function') {
          contentEl.innerHTML = window.escapeHtml(raw);
        } else {
          contentEl.innerHTML = raw;
        }
      }
    });
  }

  window.VirtualScroller = {
    attach,
    observeMessage,
    markBatchStart,
    markBatchEnd,
    pause,
    resume,
    reset,
    attachLazyContainer,
    resetLazyContainer
  };

  console.log('[VirtualScroller] 模块已加载');
})();
