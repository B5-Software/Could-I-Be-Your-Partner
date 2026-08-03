/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Virtual Scroller — 聊天记录动态渲染
 *
 * 目标：只渲染可视区域附近的消息，离屏消息保留占位高度。
 * 仅作用于"渲染层"：不影响 ContextManager 的实际上下文消息数组。
 *
 * 使用方式（由 app.js 调用）：
 *   VirtualScroller.attach(containerEl)         // 初始化监听
 *   VirtualScroller.markBatchStart()             // 批量加载开始（暂停滚动渲染）
 *   VirtualScriter.markBatchEnd()                // 批量加载结束（触发首屏渲染）
 *   VirtualScroller.observeMessage(el)           // 注册单个消息元素
 *   VirtualScroller.pause() / resume()           // 暂停/恢复观察（子代理运行时）
 *
 * 实现：IntersectionObserver 检测可见性，离屏消息保持占位高度，
 *      不渲染 markdown（或降级为纯文本占位），可见时才渲染。
 */

'use strict';

(function () {
  let container = null;
  let observer = null;
  let paused = false;
  let batchMode = false;
  const pendingRender = new Set(); // 待渲染的元素（批量加载时累积）

  // 离屏消息的占位高度估算（像素）。实际渲染后会被真实高度替代。
  const PLACEHOLDER_MIN_HEIGHT = 60;

  function isElementInViewport(el, containerEl) {
    const rect = el.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    // 提前预渲染：上下各扩展 200px 缓冲区
    const buffer = 200;
    return rect.bottom > containerRect.top - buffer &&
           rect.top < containerRect.bottom + buffer;
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
   * 将消息降级为占位状态（离屏时）
   */
  function unrenderMessageContent(el) {
    if (el.dataset.vscRendered !== '1') return;
    const contentEl = el.querySelector('.message-content');
    if (!contentEl) return;
    // 保存当前高度作为占位高度，避免滚动跳动
    const height = el.offsetHeight;
    el.style.minHeight = Math.max(height, PLACEHOLDER_MIN_HEIGHT) + 'px';
    el.classList.add('vsc-placeholder');
    // 清空 markdown 内容释放内存（保留原始 raw content 在 dataset 中）
    const role = el.classList.contains('assistant') ? 'assistant' : 'user';
    if (role === 'assistant') {
      contentEl.innerHTML = '<span class="vsc-placeholder-text">消息内容已折叠（滚动到此处自动展开）</span>';
    }
    el.dataset.vscRendered = '0';
  }

  function handleIntersect(entries) {
    if (paused || batchMode) return;
    for (const entry of entries) {
      const el = entry.target;
      if (entry.isIntersecting) {
        // 进入可视区：渲染 markdown
        renderMessageContent(el);
      } else {
        // 离开可视区：降级为占位（仅对已渲染的消息）
        if (el.dataset.vscRendered === '1') {
          unrenderMessageContent(el);
        }
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
    if (container) {
      container.querySelectorAll('[data-vsc-observed="1"]').forEach(el => {
        delete el.dataset.vscObserved;
        delete el.dataset.vscRendered;
        delete el.dataset.vscRawContent;
        el.classList.remove('vsc-placeholder');
        el.style.minHeight = '';
      });
    }
  }

  window.VirtualScroller = {
    attach,
    observeMessage,
    markBatchStart,
    markBatchEnd,
    pause,
    resume,
    reset
  };

  console.log('[VirtualScroller] 模块已加载');
})();
