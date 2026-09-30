/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

/** One native listener per channel; every subscription owns its own disposer. */
function createChannelSubscriptions(ipcRenderer) {
  const channels = new Map();
  function subscribe(channel, callback) {
    if (typeof callback !== 'function') throw new TypeError('Event callback must be a function');
    let entry = channels.get(channel);
    if (!entry) {
      const subscribers = new Set();
      const listener = (_event, ...args) => {
        // A subscriber can add/remove subscriptions during a notification.
        for (const subscription of [...subscribers]) {
          if (!subscription.active) continue;
          try {
            subscription.callback(...args);
          } catch (error) {
            console.error(`[preload] ${channel} subscriber failed:`, error);
          }
        }
      };
      entry = { subscribers, listener };
      channels.set(channel, entry);
      ipcRenderer.on(channel, listener);
    }
    const subscription = { callback, active: true };
    entry.subscribers.add(subscription);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      entry.subscribers.delete(subscription);
      if (entry.subscribers.size === 0 && channels.get(channel) === entry) {
        ipcRenderer.removeListener(channel, entry.listener);
        channels.delete(channel);
      }
    };
  }
  function dispose() {
    for (const [channel, entry] of channels) {
      for (const subscription of entry.subscribers) subscription.active = false;
      ipcRenderer.removeListener(channel, entry.listener);
    }
    channels.clear();
  }
  return { subscribe, dispose };
}

module.exports = { createChannelSubscriptions };
