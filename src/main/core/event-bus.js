/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

/**
 * 主进程事件总线：把「发给某个窗口」的推送改成「发给订阅者」。
 *
 * 改造前，LLM 流式/重试/用量等事件都硬编码 `getMainWindow().webContents.send(...)`，
 * 于是没有 GUI 窗口时事件直接丢失，WebUI 只能"遥控"渲染进程。现在：
 *   - 订阅者（subscribe）按通道订阅，可声明 sessionKey 过滤（事件负载带 sessionKey 时生效）；
 *   - 汇聚器（addSink）拿到全部事件，主窗口 sink 维持既有 GUI 行为，
 *     WebUI 的 WS sink / 无头运行时 sink 各取所需。
 *
 * 事件负载约定：payload 为对象且可带 `sessionKey`（没有则视为全局事件）。
 */
function createEventBus({ onError } = {}) {
  const subscribers = new Map(); // channel -> Set<{ fn, sessionKey }>
  const sinks = new Set();

  function reportError(error, channel) {
    if (typeof onError === 'function') {
      try {
        onError(error, channel);
        return;
      } catch {
        /* fallthrough */
      }
    }
    console.error(`[event-bus] ${channel} subscriber failed:`, error);
  }

  function matches(entry, payload) {
    if (!entry.sessionKey) return true;
    const key = payload && typeof payload === 'object' ? payload.sessionKey : undefined;
    // 未标注归属的事件（旧调用点/全局广播）不过滤，保持兼容
    return key == null || key === entry.sessionKey;
  }

  return {
    /**
     * 发布事件。所有匹配的订阅者与全部汇聚器都会收到。
     */
    publish(channel, payload) {
      const deliver = (set) => {
        if (!set) return;
        for (const entry of [...set]) {
          if (!matches(entry, payload)) continue;
          try {
            entry.fn(payload);
          } catch (error) {
            reportError(error, channel);
          }
        }
      };
      deliver(subscribers.get(channel));
      if (channel !== '*') deliver(subscribers.get('*'));
      for (const sink of [...sinks]) {
        try {
          sink(channel, payload);
        } catch (error) {
          reportError(error, channel);
        }
      }
    },

    /**
     * 订阅通道；options.sessionKey 用于会话级过滤（负载未带 sessionKey 时不过滤）。
     * 返回取消订阅函数。
     */
    subscribe(channel, fn, options = {}) {
      if (typeof fn !== 'function') throw new TypeError('subscriber must be a function');
      const entry = { fn, sessionKey: options.sessionKey || null };
      let set = subscribers.get(channel);
      if (!set) {
        set = new Set();
        subscribers.set(channel, set);
      }
      set.add(entry);
      return () => {
        set.delete(entry);
        if (set.size === 0) subscribers.delete(channel);
      };
    },

    /** 订阅全部通道（通配）。 */
    subscribeAll(fn, options = {}) {
      return this.subscribe('*', fn, options);
    },

    /** 注册汇聚器（主窗口 / WS / 无头运行时），拿到所有事件。返回注销函数。 */
    addSink(fn) {
      if (typeof fn !== 'function') throw new TypeError('sink must be a function');
      sinks.add(fn);
      return () => sinks.delete(fn);
    },

    /**
     * 主窗口 sink：维持改造前的 GUI 推送行为（无窗口时静默跳过）。
     */
    createWindowSink(getWindow) {
      return (channel, payload) => {
        const win = typeof getWindow === 'function' ? getWindow() : null;
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
      };
    },

    get subscriberCount() {
      let total = 0;
      for (const set of subscribers.values()) total += set.size;
      return total;
    },
  };
}

module.exports = { createEventBus };
