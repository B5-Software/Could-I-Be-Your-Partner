/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 终端按键解码：把 stdin 的原始字节流解析成语义键事件。
 *
 *   { name, ctrl, alt, shift, meta, char?, text?, sequence }
 *
 * 支持：方向键 / 编辑键 / 翻页 / Home / End、Ctrl+字母、Alt+字母、Shift+Tab、
 * 修饰键组合（CSI 1;5A 形式）、功能键、括号粘贴（bracketed paste）。
 * 序列跨 chunk 到达时内部缓冲；`flush()` 把残留的孤立 ESC 判定为 Escape 键。
 */

'use strict';

const CH = String.fromCharCode(27); // ESC
const BS = String.fromCharCode(8);
const DEL = String.fromCharCode(127);
const PASTE_START = CH + '[200~';
const PASTE_END = CH + '[201~';

/** CSI 修饰参数 → 修饰键（xterm 编码：参数 = 1 + 位掩码 shift|alt|ctrl|meta） */
function parseModifier(param) {
  const bits = (Number(param) || 1) - 1;
  return {
    shift: Boolean(bits & 1),
    alt: Boolean(bits & 2),
    ctrl: Boolean(bits & 4),
    meta: Boolean(bits & 8),
  };
}

const CSI_LETTERS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab',
};

const CSI_TILDE = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

const SS3_LETTERS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

const CTRL_CHARS = {
  0: 'space',
  8: 'backspace',
  9: 'tab',
  10: 'enter',
  13: 'enter',
  27: 'escape',
};

function keyEvent(name, mods, extra) {
  return Object.assign(
    {
      name,
      ctrl: Boolean(mods && mods.ctrl),
      alt: Boolean(mods && mods.alt),
      shift: Boolean(mods && mods.shift),
      meta: Boolean(mods && mods.meta),
    },
    extra || {},
  );
}

/**
 * 创建解码器实例。
 * @returns {{push(chunk: string): object[], flush(): object[], get pending(): string}}
 */
function createKeyDecoder() {
  let buffer = '';
  let pasting = false;
  let pasteBuffer = '';

  function decode() {
    const events = [];
    let i = 0;

    while (i < buffer.length) {
      const ch = buffer[i];

      // ---- 括号粘贴：整段作为 paste 事件 ----
      if (pasting) {
        const end = buffer.indexOf(PASTE_END, i);
        if (end === -1) {
          pasteBuffer += buffer.slice(i);
          i = buffer.length;
          break;
        }
        pasteBuffer += buffer.slice(i, end);
        i = end + PASTE_END.length;
        events.push(keyEvent('paste', null, { text: pasteBuffer }));
        pasteBuffer = '';
        pasting = false;
        continue;
      }

      // ---- ESC 序列 ----
      if (ch === CH) {
        const rest = buffer.slice(i);

        if (rest.startsWith(PASTE_START)) {
          i += PASTE_START.length;
          pasting = true;
          pasteBuffer = '';
          continue;
        }

        if (rest[1] === '[') {
          let j = 2;
          while (j < rest.length) {
            const code = rest.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j += 1;
          }
          if (j >= rest.length) break; // 序列未完整，等待后续 chunk
          const body = rest.slice(2, j);
          const final = rest[j];
          i += j + 1;

          if (final === 'Z') {
            events.push(keyEvent('tab', { shift: true }));
            continue;
          }
          const parts = body.split(';');
          const mods = parts.length > 1 ? parseModifier(parts[1]) : {};
          if (CSI_LETTERS[final]) {
            const name = CSI_LETTERS[final];
            events.push(
              keyEvent(name, final === 'Z' ? Object.assign({}, mods, { shift: true }) : mods),
            );
            continue;
          }
          if (final === '~') {
            const name = CSI_TILDE[Number(parts[0])];
            if (name) events.push(keyEvent(name, mods));
            continue;
          }
          continue; // 未知 CSI：忽略
        }

        if (rest[1] === 'O') {
          if (rest.length < 3) break; // 未完整
          const name = SS3_LETTERS[rest[2]];
          i += 3;
          if (name) events.push(keyEvent(name, {}));
          continue;
        }

        if (rest.length < 2) break; // 孤立 ESC，等 flush() 判定

        // Alt + 字符（Alt+Enter / Alt+Backspace / Alt+字母）
        const next = rest[1];
        i += 2;
        if (next === CH) {
          events.push(keyEvent('escape', {}));
        } else if (next === '\r' || next === '\n') {
          events.push(keyEvent('enter', { alt: true }));
        } else if (next === DEL || next === BS) {
          events.push(keyEvent('backspace', { alt: true }));
        } else {
          events.push(keyEvent(next, { alt: true }, { char: next }));
        }
        continue;
      }

      // ---- 控制字符 ----
      const code = ch.charCodeAt(0);
      i += 1;
      if (ch === '\r' || ch === '\n') {
        events.push(keyEvent('enter', {}));
      } else if (ch === '\t') {
        events.push(keyEvent('tab', {}));
      } else if (ch === DEL || ch === BS) {
        events.push(keyEvent('backspace', {}));
      } else if (code < 32) {
        // 控制字符 → 统一成 { name:'char', char, ctrl:true } 形状
        // （与普通字符同构，编辑器与全局键位判定共用一套分支）
        const char = code === 0 ? ' ' : String.fromCharCode(code + 96);
        events.push(keyEvent('char', { ctrl: true }, { char }));
      } else {
        // ---- 普通字符（含 CJK）----
        events.push(keyEvent('char', {}, { char: ch }));
      }
    }

    buffer = buffer.slice(i);
    return events;
  }

  return {
    push(chunk) {
      buffer += String(chunk == null ? '' : chunk);
      return decode();
    },
    /** 把缓冲里残留的孤立序列判定掉（ESC → escape） */
    flush() {
      const events = [];
      if (buffer === CH) {
        buffer = '';
        events.push(keyEvent('escape', {}));
      } else if (buffer !== '') {
        events.push(...decode());
        if (buffer === CH) {
          buffer = '';
          events.push(keyEvent('escape', {}));
        }
      }
      return events;
    },
    get pending() {
      return buffer;
    },
  };
}

module.exports = { createKeyDecoder, keyEvent, parseModifier };
