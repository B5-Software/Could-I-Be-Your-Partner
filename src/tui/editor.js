/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 输入框的行编辑器（多行缓冲 + 光标 + 历史调阅）。
 *
 * 与键位约定一致（对标 Claude Code / OpenCode）：
 *   Enter 提交 · Alt+Enter / Ctrl+J 换行 · ↑↓ 历史 · Ctrl+A/E 行首行尾
 *   Ctrl+W 删词 · Ctrl+U/K 删到行首/行尾 · Ctrl+D 删除 · Ctrl+P/N 历史
 *   Alt+B/F 词移动 · Ctrl+Left/Right 词移动
 *
 * 用字符数组存缓冲（CJK 安全），光标即数组下标。
 */

'use strict';

class LineEditor {
  constructor(options = {}) {
    this.chars = [];
    this.cursor = 0;
    this.history = Array.isArray(options.history) ? options.history.slice() : [];
    this.historyIndex = -1; // -1 = 未在调阅历史
    this.draft = ''; // 离开历史调阅时保留的草稿
    this.maxHistory = options.maxHistory || 200;
  }

  get value() {
    return this.chars.join('');
  }

  get isEmpty() {
    return this.chars.length === 0;
  }

  setValue(text) {
    this.chars = Array.from(String(text == null ? '' : text));
    this.cursor = this.chars.length;
    this.historyIndex = -1;
  }

  insert(text) {
    const add = Array.from(String(text == null ? '' : text));
    if (add.length === 0) return;
    this.chars = [...this.chars.slice(0, this.cursor), ...add, ...this.chars.slice(this.cursor)];
    this.cursor += add.length;
    this.historyIndex = -1;
  }

  newline() {
    this.insert('\n');
  }

  backspace() {
    if (this.cursor === 0) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    this.historyIndex = -1;
  }

  deleteForward() {
    if (this.cursor >= this.chars.length) return;
    this.chars.splice(this.cursor, 1);
    this.historyIndex = -1;
  }

  left() {
    if (this.cursor > 0) this.cursor -= 1;
  }

  right() {
    if (this.cursor < this.chars.length) this.cursor += 1;
  }

  vertical(direction) {
    let start = this.cursor;
    while (start > 0 && this.chars[start - 1] !== '\n') start--;
    const column = this.cursor - start;
    if (direction < 0) {
      if (start === 0) return false;
      const end = start - 1;
      start = end;
      while (start > 0 && this.chars[start - 1] !== '\n') start--;
      this.cursor = Math.min(end, start + column);
    } else {
      let next = this.cursor;
      while (next < this.chars.length && this.chars[next] !== '\n') next++;
      if (next === this.chars.length) return false;
      const start = next + 1;
      next = start;
      while (next < this.chars.length && this.chars[next] !== '\n') next++;
      this.cursor = Math.min(next, start + column);
    }
    return true;
  }

  home() {
    // 跳到当前行行首（多行缓冲）
    let i = this.cursor;
    while (i > 0 && this.chars[i - 1] !== '\n') i -= 1;
    this.cursor = i;
  }

  end() {
    let i = this.cursor;
    while (i < this.chars.length && this.chars[i] !== '\n') i += 1;
    this.cursor = i;
  }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.chars[i - 1])) i -= 1;
    while (i > 0 && !/\s/.test(this.chars[i - 1])) i -= 1;
    this.cursor = i;
  }

  wordRight() {
    let i = this.cursor;
    while (i < this.chars.length && !/\s/.test(this.chars[i])) i += 1;
    while (i < this.chars.length && /\s/.test(this.chars[i])) i += 1;
    this.cursor = i;
  }

  /** Ctrl+U：删到行首 */
  killToStart() {
    const start = (() => {
      let i = this.cursor;
      while (i > 0 && this.chars[i - 1] !== '\n') i -= 1;
      return i;
    })();
    this.chars.splice(start, this.cursor - start);
    this.cursor = start;
    this.historyIndex = -1;
  }

  /** Ctrl+K：删到行尾 */
  killToEnd() {
    const end = (() => {
      let i = this.cursor;
      while (i < this.chars.length && this.chars[i] !== '\n') i += 1;
      return i;
    })();
    this.chars.splice(this.cursor, end - this.cursor);
    this.historyIndex = -1;
  }

  /** Ctrl+W：删前一个词 */
  killWord() {
    const before = this.cursor;
    this.wordLeft();
    this.chars.splice(this.cursor, before - this.cursor);
    this.historyIndex = -1;
  }

  clear() {
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = '';
  }

  /** ↑：历史上一条（到顶后停住） */
  historyPrev() {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.draft = this.value;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    }
    this.setValueKeepingIndex(this.history[this.historyIndex]);
  }

  /** ↓：历史下一条（越过最新一条回到草稿） */
  historyNext() {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.setValueKeepingIndex(this.history[this.historyIndex]);
    } else {
      this.historyIndex = -1;
      this.setValueKeepingIndex(this.draft);
      this.draft = '';
    }
  }

  setValueKeepingIndex(text) {
    this.chars = Array.from(String(text == null ? '' : text));
    this.cursor = this.chars.length;
  }

  /** 提交：清空输入并把内容写入历史（去重、限量） */
  commit() {
    const value = this.value;
    if (value.trim() !== '') {
      if (this.history[this.history.length - 1] !== value) {
        this.history.push(value);
        if (this.history.length > this.maxHistory) this.history.shift();
      }
    }
    this.clear();
    return value;
  }

  /** 处理键事件；返回 'submit' | 'handled' | 'ignored' */
  handleKey(key) {
    if (!key) return 'ignored';
    switch (key.name) {
      case 'char':
        if (key.ctrl) return this._ctrl(key.char) ? 'handled' : 'ignored';
        if (key.alt) return 'ignored';
        this.insert(key.char);
        return 'handled';
      case 'paste':
        this.insert(String(key.text || '').replace(/\r\n?/g, '\n'));
        return 'handled';
      case 'enter':
        if (key.alt) {
          this.newline();
          return 'handled';
        }
        return this.value.trim() === '' ? 'ignored' : 'submit';
      case 'backspace':
        this.backspace();
        return 'handled';
      case 'delete':
        this.deleteForward();
        return 'handled';
      case 'left':
        if (key.ctrl) this.wordLeft();
        else this.left();
        return 'handled';
      case 'right':
        if (key.ctrl) this.wordRight();
        else this.right();
        return 'handled';
      case 'home':
        this.home();
        return 'handled';
      case 'end':
        this.end();
        return 'handled';
      case 'up':
        if (!key.ctrl && this.vertical(-1)) return 'handled';
        if (key.ctrl || this.cursorAtFirstLine()) {
          this.historyPrev();
          return 'handled';
        }
        return 'ignored';
      case 'down':
        if (!key.ctrl && this.vertical(1)) return 'handled';
        if (key.ctrl || this.cursorAtLastLine()) {
          this.historyNext();
          return 'handled';
        }
        return 'ignored';
      default:
        return 'ignored';
    }
  }

  _ctrl(char) {
    switch (char) {
      case 'a':
        this.home();
        return true;
      case 'e':
        this.end();
        return true;
      case 'b':
        this.wordLeft();
        return true;
      case 'f':
        this.wordRight();
        return true;
      case 'u':
        this.killToStart();
        return true;
      case 'k':
        this.killToEnd();
        return true;
      case 'w':
        this.killWord();
        return true;
      case 'd':
        if (this.isEmpty) return false; // 空输入的 Ctrl+D 留给应用层（退出）
        this.deleteForward();
        return true;
      case 'p':
        this.historyPrev();
        return true;
      case 'n':
        this.historyNext();
        return true;
      case 'j':
        this.newline();
        return true;
      default:
        return false;
    }
  }

  cursorAtFirstLine() {
    return !this.chars.slice(0, this.cursor).includes('\n');
  }

  cursorAtLastLine() {
    return !this.chars.slice(this.cursor).includes('\n');
  }
}

module.exports = { LineEditor };
