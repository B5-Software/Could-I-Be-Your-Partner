/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 极简 tar（ustar + GNU longname）编解码：零依赖、确定性、可单测。
 *
 * 为什么自己写：工作区同步要在 Windows/macOS/Linux 三端把 tar 流直接接进
 * SSH 通道（宿主侧没有可靠的系统 tar 语义，且不想引入重量级依赖）。
 * 只实现同步需要的子集：
 *   - 写：普通文件 / 目录 / GNU longname（>100 字符路径）
 *   - 读：普通文件 / 目录 / GNU longname / pax 的 path 扩展 / 校验和
 * 不实现：符号链接、设备、稀疏文件、xattrs（工作区同步用不到，遇到就跳过并告警）
 */

'use strict';

const BLOCK = 512;

/** 八进制字段写入（tar 传统格式：余位补 NUL/空格） */
function putOctal(buf, offset, length, value) {
  const s = Math.max(0, Math.floor(value || 0)).toString(8);
  const padded = s.padStart(length - 1, '0').slice(0, length - 1);
  buf.write(padded, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function putString(buf, offset, length, str) {
  const b = Buffer.from(String(str || ''), 'utf8');
  // 定长字段（如 typeflag 1 字节）不做 NUL 截断，剩余位置由调用方的零初始化兜底
  b.copy(buf, offset, 0, Math.min(b.length, length));
}

/** 生成 512 字节头 */
function makeHeader({ name, prefix = '', size = 0, mode = 0o644, mtime = Math.floor(Date.now() / 1000), type = '0', linkname = '' }) {
  const buf = Buffer.alloc(BLOCK);
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) {
    // 异常路径：调用方本应先做 ustar prefix 拆分或写 pax 头。这里按 UTF-8 边界安全截断。
    let cut = 100;
    while (cut > 0 && (nameBuf[cut] & 0xc0) === 0x80) cut--;
    nameBuf.copy(buf, 0, 0, cut);
  } else {
    nameBuf.copy(buf, 0);
  }
  putOctal(buf, 100, 8, mode);
  putOctal(buf, 108, 8, 0);
  putOctal(buf, 116, 8, 0);
  putOctal(buf, 124, 12, size);
  putOctal(buf, 136, 12, mtime);
  buf.write('        ', 148, 8, 'ascii'); // 校验和占位
  putString(buf, 156, 1, type);
  putString(buf, 157, 100, linkname);
  putString(buf, 257, 6, 'ustar');
  putString(buf, 263, 2, '00');
  putString(buf, 265, 32, 'root');
  putString(buf, 297, 32, 'root');
  if (prefix) putString(buf, 345, 155, prefix);
  // 校验和
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

/**
 * ustar 路径拆分：name ≤100 且 prefix ≤155（合计 255，覆盖绝大多数工作区路径）。
 * 拆不出来返回 null，由调用方改用 pax 扩展头。
 */
function splitUstarName(fullName) {
  if (Buffer.byteLength(fullName, 'utf8') <= 100) return { name: fullName, prefix: '' };
  const parts = fullName.split('/');
  for (let i = 1; i < parts.length; i++) {
    const name = parts.slice(i).join('/');
    const prefix = parts.slice(0, i).join('/');
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
      return { name, prefix };
    }
  }
  return null;
}

/** pax 记录（长度自洽：LENGTH KEY=VALUE\n，LENGTH 含自身） */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  for (let i = 0; i < 4; i++) {
    const next = String(len).length + Buffer.byteLength(body, 'utf8');
    if (next === len) break;
    len = next;
  }
  return `${len}${body}`;
}

function padTo(data) {
  const rem = data.length % BLOCK;
  if (rem === 0) return Buffer.alloc(0);
  return Buffer.alloc(BLOCK - rem);
}

/**
 * 打包一组条目。
 *
 * 路径长度策略（按兼容性优先级）：
 *   1. ≤100 字节：直接放 name
 *   2. ≤255 字节：ustar name/prefix 拆分（libarchive / GNU tar / bsdtar 都支持）
 *   3. 更长：pax 扩展头（typeflag 'x'，POSIX 标准），条目自身的 name 用安全截断占位
 *
 * @param {Array<{name:string, data?:Buffer|string, type?:'0'|'5', mode?:number, mtime?:number}>} entries
 * @returns {Buffer}
 */
function writeTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const type = e.type || '0';
    const data = type === '5' ? Buffer.alloc(0) : (Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8'));
    let split = splitUstarName(e.name);
    if (!split) {
      // pax：把完整路径放进扩展头，条目头里的 name 只需是一个安全的短占位
      const paxData = Buffer.from(paxRecord('path', e.name), 'utf8');
      chunks.push(makeHeader({ name: 'PaxHeader', size: paxData.length, type: 'x', mtime: e.mtime }));
      chunks.push(paxData, padTo(paxData));
      const parts = e.name.split('/');
      split = { name: parts[parts.length - 1].slice(0, 40), prefix: '' };
    }
    chunks.push(makeHeader({ name: split.name, prefix: split.prefix, size: data.length, mode: e.mode, mtime: e.mtime, type }));
    if (data.length) {
      chunks.push(data, padTo(data));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // 结束块
  return Buffer.concat(chunks);
}

function parseOctal(buf, offset, length) {
  const s = buf.toString('ascii', offset, offset + length).replace(/\0.*$/, '').trim();
  if (!s) return 0;
  // 兼容 base-256（高位为 1 时）
  if (buf[offset] & 0x80) return buf.readUInt32BE(offset + length - 4);
  return parseInt(s, 8) || 0;
}

/** 校验头（返回 true/false，不做抛错，交给调用方决定严格程度） */
function headerChecksumOk(buf, offset) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += (i >= 148 && i < 156) ? 32 : buf[offset + i];
  }
  const expect = parseOctal(buf, offset + 148, 8);
  return sum === expect;
}

/**
 * 解析 tar 流（Buffer）。
 * @returns {{ entries: Array<{name,data,mode,mtime,type}>, warnings: string[] }}
 */
function parseTar(buf) {
  const entries = [];
  const warnings = [];
  let off = 0;
  let longName = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break; // 结束块
    if (!headerChecksumOk(buf, off)) {
      warnings.push(`第 ${off} 字节处校验和不匹配，停止解析`);
      break;
    }
    let name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const size = parseOctal(h, 124, 12);
    const mode = parseOctal(h, 100, 8);
    const mtime = parseOctal(h, 136, 12);
    const type = String.fromCharCode(h[156]);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      warnings.push(`条目 ${name} 数据不完整，停止解析`);
      break;
    }
    const data = buf.subarray(dataStart, dataEnd);

    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (type === 'x' || type === 'g') {
      // pax 扩展：解析 path= 行（GNU tar --format=posix 时会出现）
      const text = data.toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
      if (m) longName = m[1];
    } else if (type === '0' || type === '\0') {
      entries.push({ name: longName || name, data: Buffer.from(data), mode, mtime, type: '0' });
      longName = null;
    } else if (type === '5') {
      entries.push({ name: longName || name, data: Buffer.alloc(0), mode, mtime, type: '5' });
      longName = null;
    } else {
      warnings.push(`跳过不支持的条目类型 "${type}": ${longName || name}`);
      longName = null;
    }
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return { entries, warnings };
}

/** 目录条目生成辅助：把相对路径集合补齐为目录树条目（保证解包时目录权限正确） */
function dirEntriesFor(relPaths) {
  const dirs = new Set();
  for (const p of relPaths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return [...dirs].sort().map((name) => ({ name: name + '/', type: '5', mode: 0o755 }));
}

module.exports = { writeTar, parseTar, dirEntriesFor, splitUstarName, paxRecord, BLOCK };
