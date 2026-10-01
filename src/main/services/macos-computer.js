/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const KEY_CODES = {
  A: 0,
  S: 1,
  D: 2,
  F: 3,
  H: 4,
  G: 5,
  Z: 6,
  X: 7,
  C: 8,
  V: 9,
  B: 11,
  Q: 12,
  W: 13,
  E: 14,
  R: 15,
  Y: 16,
  T: 17,
  1: 18,
  2: 19,
  3: 20,
  4: 21,
  6: 22,
  5: 23,
  '=': 24,
  9: 25,
  7: 26,
  '-': 27,
  8: 28,
  0: 29,
  ']': 30,
  O: 31,
  U: 32,
  '[': 33,
  I: 34,
  P: 35,
  Enter: 36,
  L: 37,
  J: 38,
  "'": 39,
  K: 40,
  ';': 41,
  '\\': 42,
  ',': 43,
  '/': 44,
  N: 45,
  M: 46,
  '.': 47,
  Tab: 48,
  Space: 49,
  '`': 50,
  Backspace: 51,
  Escape: 53,
  LeftSuper: 55,
  LeftShift: 56,
  CapsLock: 57,
  LeftAlt: 58,
  LeftControl: 59,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  End: 119,
  PageDown: 121,
  Left: 123,
  Right: 124,
  Down: 125,
  Up: 126,
};
const MODIFIERS = new Map([
  [55, 1 << 20],
  [56, 1 << 17],
  [58, 1 << 19],
  [59, 1 << 18],
]);

function loadMacBridge() {
  return require('../native/macos-computer/cibyp_computer.node');
}

function createMacComputer(bridge = loadMacBridge()) {
  const invoke = (action, args = {}) => {
    const result = JSON.parse(bridge.invoke(action, JSON.stringify(args)));
    if (result.ok === false) {
      const error = new Error(result.error);
      error.code = result.code;
      throw error;
    }
    return result;
  };
  const heldModifiers = new Set();
  let dragging = false;
  const button = (value, down, count = 1) => {
    invoke('button', { button: value, down, count });
    if (value === 0) dragging = down;
  };
  const keys = (down, values) => {
    for (const code of values) {
      if (!Number.isInteger(code)) throw new Error('Unknown macOS key');
      if (MODIFIERS.has(code)) {
        if (down) heldModifiers.add(code);
        else heldModifiers.delete(code);
      }
      let flags = 0;
      for (const held of heldModifiers) flags |= MODIFIERS.get(held);
      invoke('key', { code, down, flags });
    }
  };
  return {
    invoke,
    getUITree: async () => {
      const result = JSON.parse(await bridge.getUITree());
      if (result.ok === false) {
        const error = new Error(result.error);
        error.code = result.code;
        throw error;
      }
      return result;
    },
    Key: KEY_CODES,
    Point: class Point {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    mouse: {
      setPosition: async (point) => {
        invoke('move', { ...point, drag: dragging });
      },
      getPosition: async () => invoke('cursor'),
      pressButton: async (value) => button(value, true),
      releaseButton: async (value) => {
        dragging = false;
        button(value, false);
      },
      click: async (value) => {
        try {
          button(value, true);
        } finally {
          button(value, false);
        }
      },
      doubleClick: async (value) => {
        try {
          button(value, true, 1);
        } finally {
          button(value, false, 1);
        }
        try {
          button(value, true, 2);
        } finally {
          button(value, false, 2);
        }
      },
      scrollDown: async (amount) => {
        invoke('scroll', { vertical: -amount, horizontal: 0 });
      },
      scrollUp: async (amount) => {
        invoke('scroll', { vertical: amount, horizontal: 0 });
      },
      scrollRight: async (amount) => {
        invoke('scroll', { vertical: 0, horizontal: -amount });
      },
      scrollLeft: async (amount) => {
        invoke('scroll', { vertical: 0, horizontal: amount });
      },
    },
    keyboard: {
      pressKey: async (...values) => keys(true, values),
      releaseKey: async (...values) => keys(false, values),
      type: async (value) => {
        const characters = Array.from(String(value));
        if (characters.length > 50000) throw new Error('Text exceeds 50000 characters');
        for (let offset = 0; offset < characters.length; offset += 128) {
          invoke('type', { text: characters.slice(offset, offset + 128).join('') });
          await new Promise((resolve) => setImmediate(resolve));
        }
      },
    },
  };
}

module.exports = { createMacComputer, loadMacBridge, KEY_CODES };
