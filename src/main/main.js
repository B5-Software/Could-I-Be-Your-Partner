/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { app, BrowserWindow, ipcMain, nativeTheme, dialog, clipboard, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EmailService } = require('./email-service');
const { importSpreadsheetFile, exportSpreadsheetFile } = require('./spreadsheet-io');
const { WebControlService } = require('./web-control-service');

const emailService = new EmailService();
const webControlService = new WebControlService();
const APP_VERSION = app.getVersion();

// Single instance lock — quit immediately if another instance is already running
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const userDataPath = app.getPath('userData');
const dataDir = path.join(userDataPath, 'data');
const imagesDir = path.join(userDataPath, 'images');
const skillsDir = path.join(userDataPath, 'skills');
const historyDir = path.join(dataDir, 'history');
const workspacesBaseDir = path.join(app.getPath('documents'), 'Could-I-Be-Your-Partner');

[dataDir, imagesDir, skillsDir, historyDir, workspacesBaseDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const settingsPath = path.join(dataDir, 'settings.json');
const memoryPath = path.join(dataDir, 'memory.json');
const knowledgePath = path.join(dataDir, 'knowledge.json');

function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return def; } }
function saveJSON(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8'); }

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + otherCount * 0.4);
}

function resetDailyUsageIfNeeded() {
  const today = getTodayKey();
  if (settings.llm.dailyTokenDate !== today) {
    settings.llm.dailyTokenDate = today;
    settings.llm.dailyTokensUsed = 0;
  }
  if (settings.imageGen.dailyImageDate !== today) {
    settings.imageGen.dailyImageDate = today;
    settings.imageGen.dailyImagesUsed = 0;
  }
}

function persistSettings() {
  saveJSON(settingsPath, settings);
}

function gcdBigInt(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1n;
}

function normalizeRational(num, den) {
  if (den === 0n) throw new Error('除数不能为0');
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcdBigInt(n, d);
  return { n: n / g, d: d / g };
}

function parseExactNumber(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('数字为空');
  const m = s.match(/^([+-])?(\d+)?(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m) throw new Error(`无法解析数字: ${s}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] || '0';
  const fracPart = m[3] || '';
  const exp = parseInt(m[4] || '0', 10);
  const digits = (intPart + fracPart).replace(/^0+/, '') || '0';
  let n = BigInt(digits);
  let d = 10n ** BigInt(fracPart.length);
  if (exp > 0) n *= 10n ** BigInt(exp);
  if (exp < 0) d *= 10n ** BigInt(-exp);
  return normalizeRational(sign * n, d);
}

function addRational(a, b) { return normalizeRational(a.n * b.d + b.n * a.d, a.d * b.d); }
function subRational(a, b) { return normalizeRational(a.n * b.d - b.n * a.d, a.d * b.d); }
function mulRational(a, b) { return normalizeRational(a.n * b.n, a.d * b.d); }
function divRational(a, b) { return normalizeRational(a.n * b.d, a.d * b.n); }

function powRational(base, exponent) {
  if (exponent.d !== 1n) throw new Error('仅支持整数幂');
  const expInt = exponent.n;
  const absExp = expInt < 0n ? -expInt : expInt;
  if (absExp > 10000n) throw new Error('指数过大');
  const nPow = base.n ** absExp;
  const dPow = base.d ** absExp;
  if (expInt >= 0n) return normalizeRational(nPow, dPow);
  return normalizeRational(dPow, nPow);
}

function modRational(a, b) {
  if (a.d !== 1n || b.d !== 1n) throw new Error('取模仅支持整数');
  if (b.n === 0n) throw new Error('取模除数不能为0');
  return normalizeRational(a.n % b.n, 1n);
}

function toExactFractionString(r) {
  if (r.d === 1n) return r.n.toString();
  return `${r.n.toString()}/${r.d.toString()}`;
}

function toDecimalString(r, maxDigits = 80) {
  const sign = r.n < 0n ? '-' : '';
  let n = r.n < 0n ? -r.n : r.n;
  const d = r.d;
  const integerPart = n / d;
  let remainder = n % d;
  if (remainder === 0n) return sign + integerPart.toString();

  const seen = new Map();
  const digits = [];
  let repeatStart = -1;
  while (remainder !== 0n) {
    if (seen.has(remainder)) {
      repeatStart = seen.get(remainder);
      break;
    }
    if (digits.length >= maxDigits) break;
    seen.set(remainder, digits.length);
    remainder *= 10n;
    const digit = remainder / d;
    digits.push(digit.toString());
    remainder %= d;
  }

  if (repeatStart >= 0) {
    const nonRepeat = digits.slice(0, repeatStart).join('');
    const repeat = digits.slice(repeatStart).join('');
    return `${sign}${integerPart.toString()}.${nonRepeat}(${repeat})`;
  }
  if (remainder !== 0n) {
    return `${sign}${integerPart.toString()}.${digits.join('')}...`;
  }
  return `${sign}${integerPart.toString()}.${digits.join('')}`;
}

function normalizeCalcExpression(expr) {
  const fullWidthMap = {
    '（': '(', '）': ')', '【': '(', '】': ')', '｛': '(', '｝': ')',
    '＋': '+', '－': '-', '×': '*', '✕': '*', '✖': '*', '＊': '*',
    '÷': '/', '／': '/', '﹣': '-', '−': '-', '—': '-', '＾': '^', '％': '%',
    '，': ',', '。': '.'
  };
  let s = String(expr || '').trim();
  s = s.replace(/[\uFF10-\uFF19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[（）【】｛｝＋－×✕✖＊÷／﹣−—＾％，。]/g, ch => fullWidthMap[ch] || ch);
  s = s.replace(/[\[\{]/g, '(').replace(/[\]\}]/g, ')');
  s = s.replace(/\s+/g, '');
  s = s.replace(/,/g, '');
  s = s.replace(/\*\*/g, '^');
  s = s.replace(/mod/gi, '%');
  s = s.replace(/π/g, 'pi');
  s = s.replace(/[×·⋅]/g, '*').replace(/÷/g, '/');
  s = s.replace(/(\d|\)|%)([xX])(\d|\()/g, '$1*$3');
  s = s.replace(/(\d|\))(?=\()/g, '$1*');
  s = s.replace(/\)(?=\d|\.)/g, ')*');
  return s;
}

function tokenizeCalcExpression(normalizedExpr) {
  const tokens = [];
  let i = 0;
  while (i < normalizedExpr.length) {
    const ch = normalizedExpr[i];
    if ('()+-*/^%'.includes(ch)) {
      tokens.push({ type: ch === '(' ? 'lp' : ch === ')' ? 'rp' : 'op', value: ch });
      i++;
      continue;
    }
    const sub = normalizedExpr.slice(i);
    const numMatch = sub.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numMatch) {
      tokens.push({ type: 'num', value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }
    const piMatch = sub.match(/^pi/i);
    if (piMatch) {
      throw new Error('为保证精确计算，暂不支持 pi 等无理常数');
    }
    throw new Error(`无法识别的符号: ${ch}`);
  }
  return tokens;
}

function toRpn(tokens) {
  const output = [];
  const ops = [];
  const precedence = { 'u+': 5, 'u-': 5, '%u': 5, '^': 4, '*': 3, '/': 3, '%': 3, '+': 2, '-': 2 };
  const rightAssoc = new Set(['^', 'u+', 'u-']);
  let prevType = 'start';

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'num') {
      output.push(t);
      prevType = 'num';
      continue;
    }
    if (t.type === 'lp') {
      ops.push(t);
      prevType = 'lp';
      continue;
    }
    if (t.type === 'rp') {
      while (ops.length && ops[ops.length - 1].type !== 'lp') output.push(ops.pop());
      if (!ops.length || ops[ops.length - 1].type !== 'lp') throw new Error('括号不匹配');
      ops.pop();
      prevType = 'rp';
      continue;
    }
    if (t.type === 'op') {
      let op = t.value;
      if ((op === '+' || op === '-') && (prevType === 'start' || prevType === 'op' || prevType === 'lp')) {
        op = op === '+' ? 'u+' : 'u-';
      } else if (op === '%' && (prevType === 'num' || prevType === 'rp')) {
        const next = tokens[i + 1];
        if (!next || next.type === 'op' || next.type === 'rp') {
          op = '%u';
        }
      }
      const current = { type: 'op', value: op };
      while (ops.length && ops[ops.length - 1].type === 'op') {
        const top = ops[ops.length - 1].value;
        const pTop = precedence[top];
        const pCur = precedence[op];
        if (pTop > pCur || (pTop === pCur && !rightAssoc.has(op))) output.push(ops.pop());
        else break;
      }
      ops.push(current);
      prevType = 'op';
      continue;
    }
  }

  while (ops.length) {
    const op = ops.pop();
    if (op.type === 'lp' || op.type === 'rp') throw new Error('括号不匹配');
    output.push(op);
  }
  return output;
}

function evaluateCalcExpression(expr) {
  const normalized = normalizeCalcExpression(expr);
  if (!normalized) throw new Error('表达式为空');
  const tokens = tokenizeCalcExpression(normalized);
  const rpn = toRpn(tokens);
  const stack = [];

  for (const t of rpn) {
    if (t.type === 'num') {
      stack.push(parseExactNumber(t.value));
      continue;
    }
    if (t.type === 'op') {
      if (t.value === 'u+' || t.value === 'u-' || t.value === '%u') {
        if (stack.length < 1) throw new Error('表达式不完整');
        const a = stack.pop();
        if (t.value === 'u+') stack.push(a);
        if (t.value === 'u-') stack.push(normalizeRational(-a.n, a.d));
        if (t.value === '%u') stack.push(divRational(a, normalizeRational(100n, 1n)));
        continue;
      }
      if (stack.length < 2) throw new Error('表达式不完整');
      const b = stack.pop();
      const a = stack.pop();
      if (t.value === '+') stack.push(addRational(a, b));
      else if (t.value === '-') stack.push(subRational(a, b));
      else if (t.value === '*') stack.push(mulRational(a, b));
      else if (t.value === '/') stack.push(divRational(a, b));
      else if (t.value === '^') stack.push(powRational(a, b));
      else if (t.value === '%') stack.push(modRational(a, b));
      else throw new Error(`不支持的运算符: ${t.value}`);
    }
  }
  if (stack.length !== 1) throw new Error('表达式不合法');
  const result = stack[0];
  return {
    expression: expr,
    normalizedExpression: normalized,
    fraction: toExactFractionString(result),
    decimal: toDecimalString(result),
    isInteger: result.d === 1n
  };
}

function parseStrictInteger(value, fieldName = 'value') {
  const s = String(value ?? '').trim();
  if (!/^[+-]?\d+$/.test(s)) {
    throw new Error(`${fieldName} 必须是整数`);
  }
  return BigInt(s);
}

function absBigInt(v) {
  return v < 0n ? -v : v;
}

function gcdBigIntAbs(a, b) {
  let x = absBigInt(a);
  let y = absBigInt(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function factorInteger(value) {
  const input = String(value ?? '').trim();
  const parsed = parseStrictInteger(value, 'value');
  if (parsed === 0n) {
    return {
      input,
      sign: 0,
      factors: [],
      note: '0 的因数分解不唯一（任意非0整数都可整除0）'
    };
  }

  let n = absBigInt(parsed);
  const factors = [];
  let exp2 = 0;
  while (n % 2n === 0n) {
    n /= 2n;
    exp2++;
  }
  if (exp2 > 0) factors.push({ prime: '2', exponent: exp2 });

  let p = 3n;
  while (p * p <= n) {
    let exp = 0;
    while (n % p === 0n) {
      n /= p;
      exp++;
    }
    if (exp > 0) factors.push({ prime: p.toString(), exponent: exp });
    p += 2n;
  }
  if (n > 1n) factors.push({ prime: n.toString(), exponent: 1 });

  return {
    input,
    sign: parsed < 0n ? -1 : 1,
    factors,
    normalized: (parsed < 0n ? '-' : '') + factors.map(f => `${f.prime}${f.exponent > 1 ? '^' + f.exponent : ''}`).join(' * ')
  };
}

function calcGcdLcm(values) {
  if (!Array.isArray(values) || values.length < 2) {
    throw new Error('values 至少需要2个整数');
  }
  const nums = values.map((v, idx) => parseStrictInteger(v, `values[${idx}]`));
  const absNums = nums.map(absBigInt);

  let gcd = absNums[0];
  let lcm = absNums[0];
  for (let i = 1; i < absNums.length; i++) {
    const cur = absNums[i];
    gcd = gcdBigIntAbs(gcd, cur);
    if (lcm === 0n || cur === 0n) {
      lcm = 0n;
    } else {
      lcm = (lcm / gcdBigIntAbs(lcm, cur)) * cur;
    }
  }

  return {
    inputs: values.map(v => String(v)),
    gcd: gcd.toString(),
    lcm: lcm.toString()
  };
}

function parseBaseBigInt(value, base) {
  if (!Number.isInteger(base) || base < 2 || base > 36) {
    throw new Error('进制范围必须在2~36');
  }
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) throw new Error('value 不能为空');
  const neg = raw.startsWith('-');
  const body = (neg || raw.startsWith('+')) ? raw.slice(1) : raw;
  if (!body) throw new Error('value 不能为空');

  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  const b = BigInt(base);
  let n = 0n;
  for (const ch of body) {
    const idx = digits.indexOf(ch);
    if (idx < 0 || idx >= base) {
      throw new Error(`字符 ${ch} 不属于 ${base} 进制`);
    }
    n = n * b + BigInt(idx);
  }
  return neg ? -n : n;
}

function convertBase(value, fromBase, toBase) {
  const parsed = parseBaseBigInt(value, Number(fromBase));
  const targetBase = Number(toBase);
  if (!Number.isInteger(targetBase) || targetBase < 2 || targetBase > 36) {
    throw new Error('进制范围必须在2~36');
  }
  return {
    input: String(value),
    fromBase: Number(fromBase),
    toBase: targetBase,
    decimal: parsed.toString(10),
    result: parsed.toString(targetBase)
  };
}

function calcFactorial(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('n 必须是非负整数');
  }
  if (n > 2000) {
    throw new Error('n 过大，当前限制为 2000');
  }
  let acc = 1n;
  for (let i = 2n; i <= BigInt(n); i++) {
    acc *= i;
  }
  const value = acc.toString();
  return { n, value, digits: value.length };
}

function ensureFiniteNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是有限数值`);
  return n;
}

function parseComplex(z, name = 'z') {
  if (!z || typeof z !== 'object') throw new Error(`${name} 必须是对象 {re,im}`);
  return { re: ensureFiniteNumber(z.re, `${name}.re`), im: ensureFiniteNumber(z.im, `${name}.im`) };
}

function cAdd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
function cSub(a, b) { return { re: a.re - b.re, im: a.im - b.im }; }
function cMul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cDiv(a, b) {
  const den = b.re * b.re + b.im * b.im;
  if (Math.abs(den) < 1e-15) throw new Error('复数除法分母为0');
  return { re: (a.re * b.re + a.im * b.im) / den, im: (a.im * b.re - a.re * b.im) / den };
}
function cAbs(a) { return Math.hypot(a.re, a.im); }
function cArg(a) { return Math.atan2(a.im, a.re); }
function cConj(a) { return { re: a.re, im: -a.im }; }
function cPowInt(a, n) {
  if (!Number.isInteger(n)) throw new Error('复数幂仅支持整数指数');
  if (n === 0) return { re: 1, im: 0 };
  if (n < 0) return cDiv({ re: 1, im: 0 }, cPowInt(a, -n));
  let res = { re: 1, im: 0 };
  let base = { ...a };
  let exp = n;
  while (exp > 0) {
    if (exp & 1) res = cMul(res, base);
    base = cMul(base, base);
    exp >>= 1;
  }
  return res;
}

function complexMath(operation, aRaw, bRaw, exponent) {
  const a = parseComplex(aRaw, 'a');
  let out;
  switch (operation) {
    case 'add': out = cAdd(a, parseComplex(bRaw, 'b')); break;
    case 'sub': out = cSub(a, parseComplex(bRaw, 'b')); break;
    case 'mul': out = cMul(a, parseComplex(bRaw, 'b')); break;
    case 'div': out = cDiv(a, parseComplex(bRaw, 'b')); break;
    case 'pow': out = cPowInt(a, Number(exponent)); break;
    case 'conjugate': out = cConj(a); break;
    case 'abs': return { operation, a, value: cAbs(a) };
    case 'arg': return { operation, a, value: cArg(a) };
    default: throw new Error(`不支持的复数操作: ${operation}`);
  }
  return { operation, a, b: bRaw || null, result: out };
}

function normalizeMatrix(M, name = 'matrix') {
  if (!Array.isArray(M) || M.length === 0) throw new Error(`${name} 不能为空矩阵`);
  const rows = M.length;
  const cols = Array.isArray(M[0]) ? M[0].length : 0;
  if (cols === 0) throw new Error(`${name} 列数不能为0`);
  const mat = M.map((row, i) => {
    if (!Array.isArray(row) || row.length !== cols) throw new Error(`${name} 每行列数必须一致`);
    return row.map((v, j) => ensureFiniteNumber(v, `${name}[${i}][${j}]`));
  });
  return { mat, rows, cols };
}

function matrixAddSub(A, B, sign) {
  if (A.rows !== B.rows || A.cols !== B.cols) throw new Error('矩阵加减要求维度一致');
  const out = Array.from({ length: A.rows }, (_, i) => Array.from({ length: A.cols }, (_, j) => A.mat[i][j] + sign * B.mat[i][j]));
  return out;
}

function matrixMul(A, B) {
  if (A.cols !== B.rows) throw new Error('矩阵乘法维度不匹配');
  const out = Array.from({ length: A.rows }, () => Array.from({ length: B.cols }, () => 0));
  for (let i = 0; i < A.rows; i++) {
    for (let k = 0; k < A.cols; k++) {
      for (let j = 0; j < B.cols; j++) {
        out[i][j] += A.mat[i][k] * B.mat[k][j];
      }
    }
  }
  return out;
}

function matrixTranspose(A) {
  return Array.from({ length: A.cols }, (_, j) => Array.from({ length: A.rows }, (_, i) => A.mat[i][j]));
}

function matrixDeterminant(A) {
  if (A.rows !== A.cols) throw new Error('行列式仅适用于方阵');
  const n = A.rows;
  const m = A.mat.map(r => r.slice());
  let det = 1;
  let sign = 1;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) pivot = r;
    if (Math.abs(m[pivot][i]) < 1e-12) return 0;
    if (pivot !== i) {
      [m[i], m[pivot]] = [m[pivot], m[i]];
      sign *= -1;
    }
    const piv = m[i][i];
    det *= piv;
    for (let r = i + 1; r < n; r++) {
      const f = m[r][i] / piv;
      for (let c = i; c < n; c++) m[r][c] -= f * m[i][c];
    }
  }
  return det * sign;
}

function matrixInverse(A) {
  if (A.rows !== A.cols) throw new Error('逆矩阵仅适用于方阵');
  const n = A.rows;
  const m = A.mat.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) pivot = r;
    if (Math.abs(m[pivot][i]) < 1e-12) throw new Error('矩阵不可逆（奇异）');
    if (pivot !== i) [m[i], m[pivot]] = [m[pivot], m[i]];
    const piv = m[i][i];
    for (let c = 0; c < 2 * n; c++) m[i][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = m[r][i];
      for (let c = 0; c < 2 * n; c++) m[r][c] -= f * m[i][c];
    }
  }
  return m.map(row => row.slice(n));
}

function matrixRank(A) {
  const m = A.mat.map(r => r.slice());
  const rows = A.rows;
  const cols = A.cols;
  let rank = 0;
  let r = 0;
  for (let c = 0; c < cols && r < rows; c++) {
    let pivot = r;
    for (let i = r + 1; i < rows; i++) if (Math.abs(m[i][c]) > Math.abs(m[pivot][c])) pivot = i;
    if (Math.abs(m[pivot][c]) < 1e-12) continue;
    [m[r], m[pivot]] = [m[pivot], m[r]];
    const piv = m[r][c];
    for (let j = c; j < cols; j++) m[r][j] /= piv;
    for (let i = 0; i < rows; i++) {
      if (i === r) continue;
      const f = m[i][c];
      for (let j = c; j < cols; j++) m[i][j] -= f * m[r][j];
    }
    rank++;
    r++;
  }
  return rank;
}

function matrixMath(operation, Araw, Braw) {
  const A = normalizeMatrix(Araw, 'A');
  switch (operation) {
    case 'add': return { operation, result: matrixAddSub(A, normalizeMatrix(Braw, 'B'), 1) };
    case 'sub': return { operation, result: matrixAddSub(A, normalizeMatrix(Braw, 'B'), -1) };
    case 'mul': return { operation, result: matrixMul(A, normalizeMatrix(Braw, 'B')) };
    case 'transpose': return { operation, result: matrixTranspose(A) };
    case 'determinant': return { operation, result: matrixDeterminant(A) };
    case 'inverse': return { operation, result: matrixInverse(A) };
    case 'rank': return { operation, result: matrixRank(A) };
    default: throw new Error(`不支持的矩阵操作: ${operation}`);
  }
}

function normalizeVector(v, name = 'vector') {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${name} 不能为空`);
  return v.map((x, i) => ensureFiniteNumber(x, `${name}[${i}]`));
}

function assertSameDim(a, b) {
  if (a.length !== b.length) throw new Error('向量维度不一致');
}

function vectorDot(a, b) {
  assertSameDim(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function vectorCross(a, b) {
  assertSameDim(a, b);
  if (a.length === 3) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  if (a.length === 7) {
    return [
      a[1] * b[2] - a[2] * b[1] + a[3] * b[4] - a[4] * b[3] + a[5] * b[6] - a[6] * b[5],
      a[2] * b[0] - a[0] * b[2] + a[3] * b[5] - a[5] * b[3] + a[6] * b[4] - a[4] * b[6],
      a[0] * b[1] - a[1] * b[0] + a[3] * b[6] - a[6] * b[3] + a[4] * b[5] - a[5] * b[4],
      a[4] * b[0] - a[0] * b[4] + a[5] * b[1] - a[1] * b[5] + a[6] * b[2] - a[2] * b[6],
      a[0] * b[3] - a[3] * b[0] + a[5] * b[2] - a[2] * b[5] + a[1] * b[6] - a[6] * b[1],
      a[6] * b[0] - a[0] * b[6] + a[1] * b[3] - a[3] * b[1] + a[2] * b[4] - a[4] * b[2],
      a[0] * b[5] - a[5] * b[0] + a[2] * b[3] - a[3] * b[2] + a[4] * b[1] - a[1] * b[4]
    ];
  }
  throw new Error('叉积仅支持3维或7维向量');
}

function vectorMath(operation, araw, braw, craw) {
  const a = normalizeVector(araw, 'a');
  switch (operation) {
    case 'add': {
      const b = normalizeVector(braw, 'b');
      assertSameDim(a, b);
      return { operation, result: a.map((x, i) => x + b[i]) };
    }
    case 'sub': {
      const b = normalizeVector(braw, 'b');
      assertSameDim(a, b);
      return { operation, result: a.map((x, i) => x - b[i]) };
    }
    case 'dot': return { operation, result: vectorDot(a, normalizeVector(braw, 'b')) };
    case 'cross': return { operation, result: vectorCross(a, normalizeVector(braw, 'b')) };
    case 'mixed': {
      const b = normalizeVector(braw, 'b');
      const c = normalizeVector(craw, 'c');
      return { operation, result: vectorDot(a, vectorCross(b, c)) };
    }
    case 'norm': return { operation, result: Math.hypot(...a) };
    default: throw new Error(`不支持的向量操作: ${operation}`);
  }
}

function formatInterval(l, r, li, ri, v = 'x') {
  const left = l === -Infinity ? '(-∞' : `${li ? '[' : '('}${l}`;
  const right = r === Infinity ? '+∞)' : `${r}${ri ? ']' : ')'}`;
  return `${v} ∈ ${left}, ${right}`;
}

function solveInequality(coefficients, relation, variable = 'x') {
  if (!Array.isArray(coefficients) || (coefficients.length !== 2 && coefficients.length !== 3)) {
    throw new Error('仅支持线性(2项)或二次(3项)不等式');
  }
  if (!['<', '<=', '>', '>='].includes(relation)) throw new Error('relation 必须是 < <= > >=');
  const c = coefficients.map((x, i) => ensureFiniteNumber(x, `coefficients[${i}]`));
  const isLe = relation === '<' || relation === '<=';
  const includeEq = relation === '<=' || relation === '>=';

  if (c.length === 2) {
    const [a, b] = c;
    if (Math.abs(a) < 1e-12) {
      const ok = isLe ? b < 0 || (includeEq && b === 0) : b > 0 || (includeEq && b === 0);
      return { degree: 0, relation, always: ok, solution: ok ? '全体实数' : '无解' };
    }
    const x0 = -b / a;
    const gtSide = a > 0 ? 'right' : 'left';
    const wantGt = relation === '>' || relation === '>=';
    const pickRight = (wantGt && gtSide === 'right') || (!wantGt && gtSide === 'left');
    const interval = pickRight
      ? formatInterval(x0, Infinity, includeEq, false, variable)
      : formatInterval(-Infinity, x0, false, includeEq, variable);
    return { degree: 1, boundary: [x0], relation, solution: interval };
  }

  const [a, b, d] = c;
  if (Math.abs(a) < 1e-12) return solveInequality([b, d], relation, variable);
  const delta = b * b - 4 * a * d;
  if (delta < 0) {
    const positiveAll = a > 0;
    const ok = (relation === '>' || relation === '>=') ? positiveAll : !positiveAll;
    if (includeEq && !ok && Math.abs(delta) < 1e-12) return { degree: 2, relation, solution: '无解' };
    return { degree: 2, discriminant: delta, relation, solution: ok ? '全体实数' : '无解' };
  }
  const s = Math.sqrt(Math.max(0, delta));
  let x1 = (-b - s) / (2 * a);
  let x2 = (-b + s) / (2 * a);
  if (x1 > x2) [x1, x2] = [x2, x1];
  const wantPositive = relation === '>' || relation === '>=';
  const outside = (a > 0 && wantPositive) || (a < 0 && !wantPositive);
  const eq = includeEq;
  const solution = outside
    ? `${formatInterval(-Infinity, x1, false, eq, variable)} ∪ ${formatInterval(x2, Infinity, eq, false, variable)}`
    : formatInterval(x1, x2, eq, eq, variable);
  return { degree: 2, relation, discriminant: delta, roots: [x1, x2], solution };
}

function solveLinearSystem(Araw, braw) {
  const A = normalizeMatrix(Araw, 'A');
  const b = normalizeVector(braw, 'b');
  if (A.rows !== b.length) throw new Error('A 行数必须等于 b 维数');
  const m = A.rows;
  const n = A.cols;
  const aug = A.mat.map((row, i) => [...row, b[i]]);
  let r = 0;
  const pivots = [];

  for (let c = 0; c < n && r < m; c++) {
    let pivot = r;
    for (let i = r + 1; i < m; i++) if (Math.abs(aug[i][c]) > Math.abs(aug[pivot][c])) pivot = i;
    if (Math.abs(aug[pivot][c]) < 1e-12) continue;
    [aug[r], aug[pivot]] = [aug[pivot], aug[r]];
    const pv = aug[r][c];
    for (let j = c; j <= n; j++) aug[r][j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const f = aug[i][c];
      for (let j = c; j <= n; j++) aug[i][j] -= f * aug[r][j];
    }
    pivots.push(c);
    r++;
  }

  for (let i = 0; i < m; i++) {
    const leftZero = aug[i].slice(0, n).every(v => Math.abs(v) < 1e-10);
    if (leftZero && Math.abs(aug[i][n]) > 1e-10) {
      return { status: 'no_solution', message: '方程组无解' };
    }
  }

  if (pivots.length < n) {
    return { status: 'infinite_solutions', rank: pivots.length, variables: n, message: '方程组有无穷多解' };
  }

  const x = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const row = pivots.indexOf(i);
    x[i] = row >= 0 ? aug[row][n] : 0;
  }
  return { status: 'unique', solution: x };
}

function polyEvalComplex(coeffs, z) {
  let acc = { re: 0, im: 0 };
  for (const a of coeffs) {
    acc = cAdd(cMul(acc, z), { re: a, im: 0 });
  }
  return acc;
}

function solvePolynomial(coefficients) {
  if (!Array.isArray(coefficients) || coefficients.length < 2) throw new Error('coefficients 至少需要2项');
  const co = coefficients.map((v, i) => ensureFiniteNumber(v, `coefficients[${i}]`));
  while (co.length > 2 && Math.abs(co[0]) < 1e-14) co.shift();
  const degree = co.length - 1;
  if (degree < 1 || degree > 4) throw new Error('仅支持1~4次多项式');

  const lead = co[0];
  const c = co.map(v => v / lead);
  const n = degree;
  let roots = Array.from({ length: n }, (_, k) => {
    const theta = 2 * Math.PI * k / n;
    return { re: Math.cos(theta), im: Math.sin(theta) };
  });

  for (let iter = 0; iter < 200; iter++) {
    let maxDelta = 0;
    const next = roots.map((zk, k) => {
      let denom = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        denom = cMul(denom, cSub(zk, roots[j]));
      }
      const fzk = polyEvalComplex(c, zk);
      const corr = cDiv(fzk, denom);
      const nz = cSub(zk, corr);
      maxDelta = Math.max(maxDelta, cAbs(cSub(nz, zk)));
      return nz;
    });
    roots = next;
    if (maxDelta < 1e-12) break;
  }

  const pretty = roots.map(r => ({
    re: Math.abs(r.re) < 1e-12 ? 0 : r.re,
    im: Math.abs(r.im) < 1e-12 ? 0 : r.im,
    text: `${Math.abs(r.re) < 1e-12 ? 0 : r.re}${(Math.abs(r.im) < 1e-12 ? 0 : r.im) >= 0 ? '+' : ''}${Math.abs(r.im) < 1e-12 ? 0 : r.im}i`
  }));
  return { degree, roots: pretty };
}

function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function combBigInt(n, r) {
  if (r < 0 || r > n) return 0n;
  let k = Math.min(r, n - r);
  let num = 1n;
  let den = 1n;
  for (let i = 1; i <= k; i++) {
    num *= BigInt(n - k + i);
    den *= BigInt(i);
  }
  return num / den;
}

function distributionCalc(distribution, operation, params, x) {
  const dist = String(distribution);
  const op = String(operation);
  if (dist === 'normal') {
    const mu = ensureFiniteNumber(params.mu ?? 0, 'mu');
    const sigma = ensureFiniteNumber(params.sigma, 'sigma');
    if (sigma <= 0) throw new Error('sigma 必须>0');
    if (op === 'mean') return { distribution: dist, operation: op, result: mu };
    if (op === 'variance') return { distribution: dist, operation: op, result: sigma * sigma };
    const xv = ensureFiniteNumber(x, 'x');
    if (op === 'pdf') {
      const z = (xv - mu) / sigma;
      return { distribution: dist, operation: op, result: Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI)) };
    }
    if (op === 'cdf') {
      const z = (xv - mu) / (sigma * Math.sqrt(2));
      return { distribution: dist, operation: op, result: 0.5 * (1 + erfApprox(z)) };
    }
    throw new Error('normal 仅支持 pdf/cdf/mean/variance');
  }
  if (dist === 'binomial') {
    const n = Number(params.n);
    const p = ensureFiniteNumber(params.p, 'p');
    if (!Number.isInteger(n) || n < 0) throw new Error('n 必须是非负整数');
    if (p < 0 || p > 1) throw new Error('p 必须在[0,1]');
    if (op === 'mean') return { distribution: dist, operation: op, result: n * p };
    if (op === 'variance') return { distribution: dist, operation: op, result: n * p * (1 - p) };
    const k = Number(x);
    if (!Number.isInteger(k) || k < 0 || k > n) return { distribution: dist, operation: op, result: 0 };
    if (op === 'pmf') {
      const c = Number(combBigInt(n, k).toString());
      return { distribution: dist, operation: op, result: c * (p ** k) * ((1 - p) ** (n - k)) };
    }
    if (op === 'cdf') {
      let s = 0;
      for (let i = 0; i <= k; i++) {
        const c = Number(combBigInt(n, i).toString());
        s += c * (p ** i) * ((1 - p) ** (n - i));
      }
      return { distribution: dist, operation: op, result: s };
    }
    throw new Error('binomial 仅支持 pmf/cdf/mean/variance');
  }
  if (dist === 'poisson') {
    const lambda = ensureFiniteNumber(params.lambda, 'lambda');
    if (lambda <= 0) throw new Error('lambda 必须>0');
    if (op === 'mean' || op === 'variance') return { distribution: dist, operation: op, result: lambda };
    const k = Number(x);
    if (!Number.isInteger(k) || k < 0) return { distribution: dist, operation: op, result: 0 };
    const pmf = Math.exp(-lambda) * (lambda ** k) / Number(calcFactorial(k).value);
    if (op === 'pmf') return { distribution: dist, operation: op, result: pmf };
    if (op === 'cdf') {
      let s = 0;
      for (let i = 0; i <= k; i++) s += Math.exp(-lambda) * (lambda ** i) / Number(calcFactorial(i).value);
      return { distribution: dist, operation: op, result: s };
    }
    throw new Error('poisson 仅支持 pmf/cdf/mean/variance');
  }
  if (dist === 'uniform') {
    const a = ensureFiniteNumber(params.a, 'a');
    const b = ensureFiniteNumber(params.b, 'b');
    if (!(b > a)) throw new Error('uniform 要求 b > a');
    if (op === 'mean') return { distribution: dist, operation: op, result: (a + b) / 2 };
    if (op === 'variance') return { distribution: dist, operation: op, result: ((b - a) ** 2) / 12 };
    const xv = ensureFiniteNumber(x, 'x');
    if (op === 'pdf') return { distribution: dist, operation: op, result: (xv >= a && xv <= b) ? 1 / (b - a) : 0 };
    if (op === 'cdf') {
      if (xv <= a) return { distribution: dist, operation: op, result: 0 };
      if (xv >= b) return { distribution: dist, operation: op, result: 1 };
      return { distribution: dist, operation: op, result: (xv - a) / (b - a) };
    }
    throw new Error('uniform 仅支持 pdf/cdf/mean/variance');
  }
  throw new Error(`不支持的分布: ${dist}`);
}

function combinatorics(operation, nRaw, rRaw, repetition = false) {
  const n = Number(nRaw);
  const r = Number(rRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || n < 0 || r < 0) {
    throw new Error('n 与 r 必须是非负整数');
  }
  let result;
  if (operation === 'permutation') {
    if (repetition) {
      result = BigInt(n) ** BigInt(r);
    } else {
      if (r > n) result = 0n;
      else {
        result = 1n;
        for (let i = 0; i < r; i++) result *= BigInt(n - i);
      }
    }
  } else if (operation === 'combination') {
    if (repetition) {
      result = combBigInt(n + r - 1, r);
    } else {
      result = combBigInt(n, r);
    }
  } else {
    throw new Error('operation 必须是 permutation 或 combination');
  }
  return { operation, n, r, repetition: !!repetition, result: result.toString() };
}

function parseBaseDigit(ch) {
  const d = '0123456789abcdefghijklmnopqrstuvwxyz';
  return d.indexOf(ch.toLowerCase());
}

function bigIntToBase(n, base) {
  if (n === 0n) return '0';
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  let x = n < 0n ? -n : n;
  const b = BigInt(base);
  let out = '';
  while (x > 0n) {
    const r = Number(x % b);
    out = digits[r] + out;
    x /= b;
  }
  return n < 0n ? '-' + out : out;
}

function parseBaseFractionToRational(value, base) {
  const s = String(value || '').trim();
  if (!s) throw new Error('value 不能为空');
  const sign = s.startsWith('-') ? -1n : 1n;
  const body = (s.startsWith('-') || s.startsWith('+')) ? s.slice(1) : s;
  const [intPartRaw, fracPartRaw = ''] = body.split('.');
  if (body.split('.').length > 2) throw new Error('value 格式错误');
  const intPart = intPartRaw || '0';
  const fracPart = fracPartRaw || '';
  const b = BigInt(base);

  let intVal = 0n;
  for (const ch of intPart) {
    const d = parseBaseDigit(ch);
    if (d < 0 || d >= base) throw new Error(`字符 ${ch} 不属于 ${base} 进制`);
    intVal = intVal * b + BigInt(d);
  }

  let fracNum = 0n;
  for (const ch of fracPart) {
    const d = parseBaseDigit(ch);
    if (d < 0 || d >= base) throw new Error(`字符 ${ch} 不属于 ${base} 进制`);
    fracNum = fracNum * b + BigInt(d);
  }
  const fracDen = b ** BigInt(fracPart.length);
  const num = sign * (intVal * fracDen + fracNum);
  return normalizeRational(num, fracDen);
}

function rationalToBaseString(r, base, precision = 40) {
  const b = BigInt(base);
  const sign = r.n < 0n ? '-' : '';
  let n = r.n < 0n ? -r.n : r.n;
  const d = r.d;
  const intPart = n / d;
  let rem = n % d;
  let out = sign + bigIntToBase(intPart, base);
  if (rem === 0n) return out;

  out += '.';
  const seen = new Map();
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  const frac = [];
  let repeatAt = -1;
  while (rem !== 0n && frac.length < precision) {
    if (seen.has(rem)) {
      repeatAt = seen.get(rem);
      break;
    }
    seen.set(rem, frac.length);
    rem *= b;
    const q = rem / d;
    rem %= d;
    frac.push(digits[Number(q)]);
  }

  if (repeatAt >= 0) {
    return out + frac.slice(0, repeatAt).join('') + '(' + frac.slice(repeatAt).join('') + ')';
  }
  if (rem !== 0n) return out + frac.join('') + '...';
  return out + frac.join('');
}

function fractionBaseConvert(value, fromBase, toBase, precision = 40) {
  const fb = Number(fromBase);
  const tb = Number(toBase);
  if (!Number.isInteger(fb) || fb < 2 || fb > 36) throw new Error('fromBase 必须在2~36');
  if (!Number.isInteger(tb) || tb < 2 || tb > 36) throw new Error('toBase 必须在2~36');
  const r = parseBaseFractionToRational(value, fb);
  return {
    input: String(value),
    fromBase: fb,
    toBase: tb,
    fraction: toExactFractionString(r),
    decimal: toDecimalString(r, 80),
    result: rationalToBaseString(r, tb, Number(precision) || 40)
  };
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXmlEntities(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function recognizeImageWithTesseract(imagePath) {
  const { createWorker, OEM } = require('tesseract.js');
  const { pathToFileURL } = require('url');
  const langPath = pathToFileURL(process.cwd()).href;
  const languages = 'chi_sim+eng';
  const worker = await createWorker(languages, OEM.LSTM_ONLY, { langPath, gzip: false });
  try {
    const { data: { text } } = await worker.recognize(imagePath);
    return text;
  } finally {
    await worker.terminate();
  }
}

let settings = loadJSON(settingsPath, {
  llm: {
    apiUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxContextLength: 8192,
    maxResponseTokens: 8192,
    dailyMaxTokens: 0,
    dailyTokensUsed: 0,
    dailyTokenDate: ''
  },
  imageGen: {
    apiUrl: 'https://api.siliconflow.cn/v1/images/generations',
    apiKey: '',
    model: 'Kwai-Kolors/Kolors',
    imageSize: '1024x1024',
    dailyMaxImages: 0,
    dailyImagesUsed: 0,
    dailyImageDate: ''
  },
  theme: { mode: 'system', accentColor: '#4f8cff', backgroundColor: '#f5f7fa' },
  tools: {},
  autoApproveSensitive: false,
  autoOptimizeToolSelection: false,
  aiPersona: { name: 'Partner', avatar: '', bio: '你的全能AI伙伴~', pronouns: 'Ta', personality: '活泼可爱、热情友善', customPrompt: '' },
  userProfile: { name: '', avatar: '', bio: '' },
  entropy: { source: 'csprng', trngMode: 'network', trngSerialPort: '', trngSerialBaud: 115200, trngNetworkHost: '192.168.4.1', trngNetworkPort: 80 },
  proxy: { mode: 'system', http: '', https: '', bypass: 'localhost,127.0.0.1' },
  mcp: { servers: [] },
  email: { enabled: false, mode: 'send-receive', smtpHost: '', smtpPort: 587, smtpSecure: true, imapHost: '', imapPort: 993, imapTls: true, emailUser: '', emailPass: '', ownerAddress: '', totpSecret: '', pollInterval: 30, approvalResendMinutes: 5, maxResends: 3, resendIntervalMinutes: 30 },
  webControl: { enabled: false, port: 3456, password: '', passwordHash: '', enable2FA: false, totpSecret: '' }
});
if (fs.existsSync(settingsPath)) {
  const saved = loadJSON(settingsPath, {});
  settings = { ...settings, ...saved, llm: { ...settings.llm, ...(saved.llm || {}) }, imageGen: { ...settings.imageGen, ...(saved.imageGen || {}) }, theme: { ...settings.theme, ...(saved.theme || {}) }, aiPersona: { ...settings.aiPersona, ...(saved.aiPersona || {}) }, userProfile: { ...settings.userProfile, ...(saved.userProfile || {}) }, entropy: { ...settings.entropy, ...(saved.entropy || {}) }, proxy: { ...settings.proxy, ...(saved.proxy || {}) }, mcp: { ...settings.mcp, ...(saved.mcp || {}) }, email: { ...settings.email, ...(saved.email || {}) }, webControl: { ...settings.webControl, ...(saved.webControl || {}) } };
}
saveJSON(settingsPath, settings);

let memory = loadJSON(memoryPath, []);
let knowledge = loadJSON(knowledgePath, []);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    title: 'Could I Be Your Partner',
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/index.html'));
}

app.whenReady().then(() => {
  // 启动时复制 OCR traineddata 文件到当前执行目录根，避免 GFW blocking
  const appPath = app.getAppPath();
  const srcOcrDir = path.join(appPath, 'assets', 'ocr');
  const destOcrDir = process.cwd();
  if (fs.existsSync(srcOcrDir)) {
    try {
      const files = fs.readdirSync(srcOcrDir);
      for (const file of files) {
        if (file.endsWith('.traineddata') || file.endsWith('.gz')) {
          const destPath = path.join(destOcrDir, file);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(path.join(srcOcrDir, file), destPath);
          }
        }
      }
    } catch (e) {
      console.error('Failed to copy OCR data:', e);
    }
  }
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---- IPC: Window Controls ----
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximize', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); return mainWindow.isMaximized(); } });
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window:isMaximized', () => mainWindow ? mainWindow.isMaximized() : false);

// ---- IPC: Settings ----
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_, newSettings) => {
  settings = { ...settings, ...newSettings };
  saveJSON(settingsPath, settings);
  return settings;
});

// ---- IPC: Theme ----
ipcMain.handle('theme:get', () => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, mode: settings.theme.mode }));
nativeTheme.on('updated', () => {
  if (mainWindow) mainWindow.webContents.send('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
});

// ---- IPC: Memory ----
ipcMain.handle('memory:search', (_, query) => {
  const q = (query || '').toLowerCase();
  return memory.filter(m => (m.content || '').toLowerCase().includes(q) || (m.tags || []).some(t => t.toLowerCase().includes(q)));
});
ipcMain.handle('memory:add', (_, item) => {
  item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  item.createdAt = new Date().toISOString();
  memory.push(item);
  saveJSON(memoryPath, memory);
  return item;
});
ipcMain.handle('memory:delete', (_, id) => {
  memory = memory.filter(m => m.id !== id);
  saveJSON(memoryPath, memory);
  return true;
});
ipcMain.handle('memory:update', (_, { id, data }) => {
  const idx = memory.findIndex(m => m.id === id);
  if (idx >= 0) { memory[idx] = { ...memory[idx], ...data, updatedAt: new Date().toISOString() }; saveJSON(memoryPath, memory); return memory[idx]; }
  return null;
});

// ---- IPC: Knowledge Base ----
ipcMain.handle('knowledge:search', (_, query) => {
  const q = (query || '').toLowerCase();
  return knowledge.filter(k => (k.content || '').toLowerCase().includes(q) || (k.title || '').toLowerCase().includes(q));
});
ipcMain.handle('knowledge:add', (_, item) => {
  item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  item.createdAt = new Date().toISOString();
  knowledge.push(item);
  saveJSON(knowledgePath, knowledge);
  return item;
});
ipcMain.handle('knowledge:delete', (_, id) => {
  knowledge = knowledge.filter(k => k.id !== id);
  saveJSON(knowledgePath, knowledge);
  return true;
});
ipcMain.handle('knowledge:update', (_, { id, data }) => {
  const idx = knowledge.findIndex(k => k.id === id);
  if (idx >= 0) { knowledge[idx] = { ...knowledge[idx], ...data, updatedAt: new Date().toISOString() }; saveJSON(knowledgePath, knowledge); return knowledge[idx]; }
  return null;
});

// ---- IPC: File Operations ----
ipcMain.handle('fs:readFile', (_, filePath) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf-8') }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:writeFile', (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:createFile', (_, filePath, content) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content || '', 'utf-8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:deleteFile', (_, filePath) => {
  try { fs.unlinkSync(filePath); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:moveFile', (_, src, dest) => {
  try { fs.renameSync(src, dest); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:copyFile', (_, src, dest) => {
  try { fs.copyFileSync(src, dest); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:listDirectory', (_, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return { ok: true, entries: entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:makeDirectory', (_, dirPath) => {
  try { fs.mkdirSync(dirPath, { recursive: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:deleteDirectory', (_, dirPath) => {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:localSearch', async (_, dirPath, pattern, options = {}) => {
  return new Promise((resolve) => {
    const results = [];
    const {
      ignoreCase = true,
      maxResults = 200,
      fileOnly = false,
      dirOnly = false,
      regex = false,
      depth = -1 // -1 means unlimited
    } = options;
    
    let searchPattern = pattern;
    if (regex) {
      try {
        searchPattern = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch (e) {
        resolve({ ok: false, error: `Invalid regex pattern: ${e.message}` });
        return;
      }
    }
    
    function matches(name) {
      if (regex) {
        return searchPattern.test(name);
      } else {
        const haystack = ignoreCase ? name.toLowerCase() : name;
        const needle = ignoreCase ? pattern.toLowerCase() : pattern;
        return haystack.includes(needle);
      }
    }
    
    function walk(dir, currentDepth = 0) {
      if (results.length >= maxResults) return;
      if (depth >= 0 && currentDepth > depth) return;
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= maxResults) break;
          
          const full = path.join(dir, e.name);
          const isDir = e.isDirectory();
          
          // Apply file/dir filters
          if (fileOnly && isDir) continue;
          if (dirOnly && !isDir) continue;
          
          // Check if matches pattern
          if (matches(e.name)) {
            results.push(full);
          }
          
          // Recurse into directories
          if (isDir) {
            walk(full, currentDepth + 1);
          }
        }
      } catch { /* skip inaccessible */ }
    }
    
    // Run search asynchronously
    setImmediate(() => {
      try {
        walk(dirPath);
        resolve({ ok: true, results, count: results.length });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });
});

// ---- IPC: Terminal Management ----
const terminals = new Map();
let terminalIdCounter = 0;

ipcMain.handle('terminal:make', () => {
  try {
    const pty = require('node-pty');
    const id = ++terminalIdCounter;
    const shellName = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    const term = pty.spawn(shellName, [], { name: 'xterm', cols: 120, rows: 30, cwd: os.homedir() });
    let buffer = '';
    term.onData(data => { buffer += data; });
    terminals.set(id, { term, buffer: () => { const b = buffer; buffer = ''; return b; } });
    return { ok: true, terminalId: id };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('terminal:run', (_, id, command) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  t.buffer();
  t.term.write(command + '\r');
  return new Promise(resolve => {
    setTimeout(() => { resolve({ ok: true, output: t.buffer() }); }, 2000);
  });
});
ipcMain.handle('terminal:await', (_, id, command) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  t.buffer();
  t.term.write(command + '\r');
  return new Promise(resolve => {
    const timeout = setTimeout(() => { resolve({ ok: true, output: t.buffer(), timedOut: true }); }, 120000);
    let checkInterval = setInterval(() => {
      const output = t.buffer();
      if (output.includes('$') || output.includes('>') || output.includes('#') || output.includes('%')) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        resolve({ ok: true, output });
      }
    }, 500);
  });
});
ipcMain.handle('terminal:kill', (_, id) => {
  const t = terminals.get(id);
  if (t) { t.term.kill(); terminals.delete(id); }
  return { ok: true };
});

// ---- IPC: Clipboard ----
ipcMain.handle('clipboard:read', () => {
  try {
    return { ok: true, content: clipboard.readText() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('clipboard:write', (_, text) => {
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Screenshot ----
ipcMain.handle('screenshot:take', async (_, workspacePath) => {
  try {
    const sources = await require('electron').desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (sources.length > 0) {
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      const imgPath = path.join(targetDir, `screenshot_${Date.now()}.png`);
      fs.writeFileSync(imgPath, sources[0].thumbnail.toPNG());
      return { ok: true, path: imgPath };
    }
    return { ok: false, error: '无法截取屏幕' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: System Info ----
ipcMain.handle('system:info', () => ({
  ok: true,
  platform: process.platform, arch: process.arch, hostname: os.hostname(),
  cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(),
  homeDir: os.homedir(), tempDir: os.tmpdir(), nodeVersion: process.versions.node,
  electronVersion: process.versions.electron
}));
ipcMain.handle('system:network', () => {
  try {
    const interfaces = os.networkInterfaces();
    const result = {};
    for (const [name, addrs] of Object.entries(interfaces)) {
      result[name] = addrs.map(a => ({ address: a.address, family: a.family, internal: a.internal }));
    }
    return { ok: true, interfaces: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Shell & Browser ----
ipcMain.handle('shell:openBrowser', (_, url) => {
  try {
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('shell:openFileExplorer', (_, p) => {
  try {
    shell.openPath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:evaluate', async (_, expression) => {
  try {
    const result = evaluateCalcExpression(expression);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:factorInteger', async (_, value) => {
  try {
    return { ok: true, ...factorInteger(value) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:gcdLcm', async (_, values) => {
  try {
    return { ok: true, ...calcGcdLcm(values) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:baseConvert', async (_, value, fromBase, toBase) => {
  try {
    return { ok: true, ...convertBase(value, fromBase, toBase) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:factorial', async (_, n) => {
  try {
    return { ok: true, ...calcFactorial(Number(n)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:complexMath', async (_, operation, a, b, exponent) => {
  try {
    return { ok: true, ...complexMath(operation, a, b, exponent) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:matrixMath', async (_, operation, A, B) => {
  try {
    return { ok: true, ...matrixMath(operation, A, B) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:vectorMath', async (_, operation, a, b, c) => {
  try {
    return { ok: true, ...vectorMath(operation, a, b, c) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:solveInequality', async (_, coefficients, relation, variable) => {
  try {
    return { ok: true, ...solveInequality(coefficients, relation, variable) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:solveLinearSystem', async (_, A, b) => {
  try {
    return { ok: true, ...solveLinearSystem(A, b) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:solvePolynomial', async (_, coefficients) => {
  try {
    return { ok: true, ...solvePolynomial(coefficients) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:distributionCalc', async (_, distribution, operation, params, x) => {
  try {
    return { ok: true, ...distributionCalc(distribution, operation, params || {}, x) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:combinatorics', async (_, operation, n, r, repetition) => {
  try {
    return { ok: true, ...combinatorics(operation, n, r, repetition) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:fractionBaseConvert', async (_, value, fromBase, toBase, precision) => {
  try {
    return { ok: true, ...fractionBaseConvert(value, fromBase, toBase, precision) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Run JS Code (sandboxed) ----
ipcMain.handle('code:runJS', (_, code) => {
  return new Promise((resolve) => {
    const { fork } = require('child_process');
    const runner = fork(path.join(__dirname, '../tools/js-runner.js'), [], { silent: true, timeout: 30000 });
    let output = '';
    let error = '';
    runner.stdout.on('data', d => { output += d.toString(); });
    runner.stderr.on('data', d => { error += d.toString(); });
    runner.on('message', msg => { resolve({ ok: true, result: msg }); });
    runner.on('exit', code => {
      if (code !== 0) resolve({ ok: false, error: error || `Process exited with code ${code}` });
      else resolve({ ok: true, output });
    });
    runner.send({ code });
    setTimeout(() => { try { runner.kill(); } catch {} resolve({ ok: false, error: '执行超时' }); }, 30000);
  });
});

// ---- IPC: Run JS Code (Node.js enabled) ----
ipcMain.handle('code:runNodeJS', (_, code) => {
  return new Promise((resolve) => {
    const { fork } = require('child_process');
    const runner = fork(path.join(__dirname, '../tools/js-runner-node.js'), [], { silent: true, timeout: 30000 });
    let output = '';
    let error = '';
    runner.stdout.on('data', d => { output += d.toString(); });
    runner.stderr.on('data', d => { error += d.toString(); });
    runner.on('message', msg => { resolve({ ok: true, result: msg }); });
    runner.on('exit', code => {
      if (code !== 0) resolve({ ok: false, error: error || `Process exited with code ${code}` });
      else resolve({ ok: true, output });
    });
    runner.send({ code });
    setTimeout(() => { try { runner.kill(); } catch {} resolve({ ok: false, error: '执行超时' }); }, 30000);
  });
});

// ---- IPC: Run Shell Script ----
ipcMain.handle('code:runShell', (_, script) => {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const tmpFile = path.join(os.tmpdir(), `script_${Date.now()}${process.platform === 'win32' ? '.ps1' : '.sh'}`);
    fs.writeFileSync(tmpFile, script, 'utf-8');
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const args = process.platform === 'win32' ? ['-File', tmpFile] : [tmpFile];
    execFile(shell, args, { timeout: 120000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) resolve({ ok: false, error: err.message, stderr });
      else resolve({ ok: true, output: stdout, stderr });
    });
  });
});

// ---- IPC: Image Generation ----
ipcMain.handle('image:generate', async (_, prompt, workspacePath) => {
  try {
    const { net } = require('electron');
    const apiUrl = settings.imageGen.apiUrl;
    const apiKey = settings.imageGen.apiKey;
    const model = settings.imageGen.model;
    const imageSize = settings.imageGen.imageSize;
    if (!apiKey) return { ok: false, error: '请先配置生图API Key' };

    resetDailyUsageIfNeeded();
    const maxImages = settings.imageGen.dailyMaxImages || 0;
    if (maxImages > 0 && settings.imageGen.dailyImagesUsed >= maxImages) {
      return { ok: false, error: '已达到今日生图上限，请明天再试' };
    }

    const body = JSON.stringify({ model, prompt, image_size: imageSize, batch_size: 1, num_inference_steps: 20, guidance_scale: 7.5 });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body
    });
    const data = await response.json();
    if (data.images && data.images[0] && data.images[0].url) {
      const imgUrl = data.images[0].url;
      const imgResponse = await fetch(imgUrl);
      const buffer = Buffer.from(await imgResponse.arrayBuffer());
      
      // Save to workspace if provided, otherwise use imagesDir
      const saveDir = workspacePath || imagesDir;
      const imgPath = path.join(saveDir, `generated_${Date.now()}.png`);
      fs.writeFileSync(imgPath, buffer);
      
      settings.imageGen.dailyImagesUsed = (settings.imageGen.dailyImagesUsed || 0) + 1;
      persistSettings();
      
      // Return file:// URL for display
      const fileUrl = 'file://' + imgPath.replace(/\\/g, '/');
      return { ok: true, path: imgPath, url: fileUrl };
    }
    return { ok: false, error: '生图API未返回有效图片' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Web Search & Fetch ----
ipcMain.handle('web:search', async (_, query, workspacePath) => {
  if (!mainWindow) return { ok: false, error: '主窗口未就绪' };

  // 创建离屏隐藏窗口进行后台渲染
  const offscreenWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    await offscreenWindow.webContents.loadURL(url, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // 等待渲染稳定
    await new Promise(r => setTimeout(r, 2000));

    const result = await offscreenWindow.webContents.executeJavaScript(`(() => {
      const items = [];
      const nodes = document.querySelectorAll('li.b_algo');
      for (let i = 0; i < nodes.length && items.length < 15; i++) {
        const li = nodes[i];
        const a = li.querySelector('h2 a');
        const p = li.querySelector('p, .b_caption p');
        items.push({
          title: a ? a.textContent.trim() : '',
          url: a ? a.href : '',
          snippet: p ? p.textContent.trim() : '',
          id: li.id || ''
        });
      }
      return {
        title: document.title,
        url: location.href,
        results: items,
        html: document.documentElement.outerHTML.slice(0, 150000)
      };
    })()`);

    const image = await offscreenWindow.webContents.capturePage();
    const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
    const imgPath = path.join(targetDir, `bing_${Date.now()}.png`);
    fs.writeFileSync(imgPath, image.toPNG());

    return {
      ok: true,
      query,
      url: result.url,
      title: result.title,
      results: result.results,
      html: result.html,
      screenshotPath: imgPath,
      screenshotUrl: `file://${imgPath}`
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      if (!offscreenWindow.isDestroyed()) {
        offscreenWindow.close();
      }
    } catch { /* ignore */ }
  }
});
ipcMain.handle('web:fetch', async (_, url) => {
  try {
    const resp = await fetch(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      } 
    });
    const text = await resp.text();
    return { ok: true, content: text.substring(0, 200000) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('web:offscreenSnapshotOCR', async (_, options = {}) => {
  const targetUrl = String(options.url || '').trim();
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 10000;
  const workspacePath = options.workspacePath;
  if (!targetUrl) return { ok: false, error: '缺少URL' };

  const offscreenWindow = new BrowserWindow({
    width: Number(options.width) || 1366,
    height: Number(options.height) || 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    await offscreenWindow.webContents.loadURL(targetUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

    const image = await offscreenWindow.webContents.capturePage();
    const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
    const imgPath = path.join(targetDir, `offscreen_${Date.now()}.png`);
    fs.writeFileSync(imgPath, image.toPNG());

    const ocrText = await recognizeImageWithTesseract(imgPath);
    const pageMeta = await offscreenWindow.webContents.executeJavaScript(`({
      title: document.title || '',
      url: location.href || '',
      text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 50000)
    })`);

    return {
      ok: true,
      requestedUrl: targetUrl,
      finalUrl: pageMeta?.url || targetUrl,
      title: pageMeta?.title || '',
      screenshotPath: imgPath,
      screenshotUrl: `file://${imgPath}`,
      waitMs,
      ocrText: String(ocrText || '').slice(0, 100000),
      renderedText: String(pageMeta?.text || '').slice(0, 100000)
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      if (!offscreenWindow.isDestroyed()) offscreenWindow.close();
    } catch {}
  }
});

ipcMain.handle('web:offscreenRenderedContent', async (_, options = {}) => {
  const targetUrl = String(options.url || '').trim();
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 10000;
  const workspacePath = options.workspacePath;
  const captureScreenshot = options.captureScreenshot !== false;
  const includeHtml = options.includeHtml !== false;
  if (!targetUrl) return { ok: false, error: '缺少URL' };

  const offscreenWindow = new BrowserWindow({
    width: Number(options.width) || 1366,
    height: Number(options.height) || 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    await offscreenWindow.webContents.loadURL(targetUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

    const pageMeta = await offscreenWindow.webContents.executeJavaScript(`({
      title: document.title || '',
      url: location.href || '',
      text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 150000),
      html: (document.documentElement && document.documentElement.outerHTML ? document.documentElement.outerHTML : '').slice(0, 500000)
    })`);

    let screenshotPath = '';
    let screenshotUrl = '';
    if (captureScreenshot) {
      const image = await offscreenWindow.webContents.capturePage();
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      screenshotPath = path.join(targetDir, `offscreen_content_${Date.now()}.png`);
      fs.writeFileSync(screenshotPath, image.toPNG());
      screenshotUrl = `file://${screenshotPath}`;
    }

    return {
      ok: true,
      requestedUrl: targetUrl,
      finalUrl: pageMeta?.url || targetUrl,
      title: pageMeta?.title || '',
      waitMs,
      screenshotPath,
      screenshotUrl,
      renderedText: String(pageMeta?.text || '').slice(0, 150000),
      renderedHtml: includeHtml ? String(pageMeta?.html || '').slice(0, 500000) : ''
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      if (!offscreenWindow.isDestroyed()) offscreenWindow.close();
    } catch {}
  }
});

// ---- IPC: Tarot ----
const tarotCards = require('../data/tarot.js');

function drawTarotCSPRNG() {
  const crypto = require('crypto');
  const range = tarotCards.length;
  const max = Math.floor(0x100000000 / range) * range;
  let val;
  do {
    val = crypto.randomBytes(4).readUInt32BE(0);
  } while (val >= max);
  const card = tarotCards[val % range];
  const isReversed = crypto.randomBytes(1)[0] < 128;
  return {
    ...card,
    isReversed,
    orientation: isReversed ? 'reversed' : 'upright',
    meaningOfUpright: card.meaningOfUpright,
    meaningOfReversed: card.meaningOfReversed,
    entropySource: 'CSPRNG'
  };
}

async function drawTarotTRNG() {
  const entropy = settings.entropy || {};
  const mode = entropy.trngMode || 'network';
  let raw;
  if (mode === 'serial') {
    raw = await getTRNGFromSerial(entropy.trngSerialPort, entropy.trngSerialBaud || 115200);
  } else {
    raw = await getTRNGFromNetwork(entropy.trngNetworkHost || '192.168.4.1', entropy.trngNetworkPort || 80);
  }
  // raw should be { cardIndex, isReversed } from the TRNG device
  const card = tarotCards[raw.cardIndex % tarotCards.length];
  const isReversed = raw.isReversed;
  return {
    ...card,
    isReversed,
    orientation: isReversed ? 'reversed' : 'upright',
    meaningOfUpright: card.meaningOfUpright,
    meaningOfReversed: card.meaningOfReversed,
    entropySource: 'TRNG'
  };
}

async function getTRNGFromSerial(portPath, baud) {
  return new Promise((resolve, reject) => {
    if (!portPath) return reject(new Error('未配置TRNG串口'));
    let { SerialPort } = {};
    try { ({ SerialPort } = require('serialport')); } catch {
      return reject(new Error('serialport 模块未安装，请运行 npm install serialport'));
    }

    const port = new SerialPort({ path: portPath, baudRate: baud });
    let responded = false;

    function safeClose() {
      try { if (port.isOpen) port.close(); } catch {}
    }

    const globalTimeout = setTimeout(() => {
      safeClose();
      if (!responded) { responded = true; reject(new Error('TRNG串口超时')); }
    }, 12000);

    port.on('error', (e) => {
      clearTimeout(globalTimeout);
      if (!responded) { responded = true; reject(e); }
    });

    port.once('open', () => {
      // --- Phase 1: flush phase ---
      // Discard ALL data received in the first 600 ms.
      // This eliminates the ESP32/Arduino bootloader startup log that sits in
      // the OS USB-CDC buffer and would otherwise cause a parse failure.
      let flushing = true;
      let responseBuf = '';

      port.on('data', (chunk) => {
        if (flushing) return; // silently discard startup-log bytes

        responseBuf += chunk.toString();
        // Look for complete JSON line (device sends one JSON object per line)
        const lines = responseBuf.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            clearTimeout(globalTimeout);
            safeClose();
            try {
              const json = JSON.parse(trimmed);
              if (!responded) {
                responded = true;
                resolve({ cardIndex: json.cardIndex, isReversed: json.isReversed });
              }
            } catch (e) {
              if (!responded) {
                responded = true;
                reject(new Error('TRNG串口JSON解析失败: ' + trimmed));
              }
            }
            return;
          }
        }
      });

      // --- Phase 2: after flush window, send command ---
      setTimeout(() => {
        flushing = false;
        responseBuf = '';
        port.write('DRAW\n', (err) => {
          if (err && !responded) {
            clearTimeout(globalTimeout);
            responded = true;
            safeClose();
            reject(new Error('TRNG串口写入失败: ' + err.message));
          }
        });
      }, 600); // 600 ms is enough for typical ESP32 boot log to drain
    });
  });
}

async function getTRNGFromNetwork(host, port) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('TRNG网络超时')), 10000);
    const req = http.get(`http://${host}:${port}/api/draw`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(data);
          resolve({ cardIndex: json.cardIndex, isReversed: json.isReversed });
        } catch (e) { reject(new Error('TRNG网络数据解析失败: ' + data)); }
      });
    });
    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('TRNG网络请求超时')); });
  });
}

ipcMain.handle('tarot:draw', async () => {
  try {
    const source = settings.entropy?.source || 'csprng';
    if (source === 'trng') {
      return await drawTarotTRNG();
    }
    return drawTarotCSPRNG();
  } catch (e) {
    // Fallback to CSPRNG on TRNG failure
    console.error('TRNG failed, falling back to CSPRNG:', e.message);
    const result = drawTarotCSPRNG();
    result.entropySource = 'CSPRNG (TRNG fallback: ' + e.message + ')';
    return result;
  }
});

// ---- IPC: TRNG Serial Port List ----
ipcMain.handle('trng:listPorts', async () => {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return { ok: true, ports };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('trng:test', async () => {
  try {
    const source = settings.entropy?.source || 'csprng';
    if (source === 'trng') {
      const result = await drawTarotTRNG();
      return { ok: true, result };
    }
    return { ok: true, result: drawTarotCSPRNG() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Skills ----
ipcMain.handle('skills:list', () => {
  try {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.json'));
    return files.map(f => loadJSON(path.join(skillsDir, f), {}));
  } catch { return []; }
});
ipcMain.handle('skills:create', (_, skill) => {
  skill.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  skill.createdAt = new Date().toISOString();
  saveJSON(path.join(skillsDir, `${skill.id}.json`), skill);
  return skill;
});
ipcMain.handle('skills:delete', (_, id) => {
  try { fs.unlinkSync(path.join(skillsDir, `${id}.json`)); return true; } catch { return false; }
});

// ---- IPC: LLM API Call ----
ipcMain.handle('llm:chat', async (_, messages, options = {}) => {
  try {
    const apiUrl = settings.llm.apiUrl;
    const apiKey = settings.llm.apiKey;
    const model = settings.llm.model;
    if (!apiUrl || !apiKey || !model) return { ok: false, error: '请先在设置中配置LLM API' };

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    const body = {
      model,
      messages,
      temperature: options.temperature ?? settings.llm.temperature,
      max_tokens: options.max_tokens ?? settings.llm.maxResponseTokens ?? 8192,
      stream: false
    };
    if (options.tools) body.tools = options.tools;
    if (options.tool_choice) body.tool_choice = options.tool_choice;

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (data.error) return { ok: false, error: data.error.message || JSON.stringify(data.error) };
    const usageTokens = data.usage?.total_tokens
      || estimateTokens(JSON.stringify(body)) + estimateTokens(data.choices?.[0]?.message?.content || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    persistSettings();
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: LLM Streaming ----
ipcMain.handle('llm:chatStream', async (_, messages, options = {}) => {
  try {
    const apiUrl = settings.llm.apiUrl;
    const apiKey = settings.llm.apiKey;
    const model = settings.llm.model;
    if (!apiUrl || !apiKey || !model) return { ok: false, error: '请先在设置中配置LLM API' };

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    const body = {
      model,
      messages,
      temperature: options.temperature ?? settings.llm.temperature,
      max_tokens: options.max_tokens ?? settings.llm.maxResponseTokens ?? 8192,
      stream: true
    };
    if (options.tools) body.tools = options.tools;
    if (options.tool_choice) body.tool_choice = options.tool_choice;

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let toolCalls = [];
    let finishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            mainWindow?.webContents.send('llm:stream-chunk', { content: delta.content, requestId: options.requestId });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                while (toolCalls.length <= tc.index) toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
                if (tc.id) toolCalls[tc.index].id = tc.id;
                if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }
          if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
        } catch {}
      }
    }

    mainWindow?.webContents.send('llm:stream-end', { requestId: options.requestId });
    const usageTokens = estimateTokens(JSON.stringify(body)) + estimateTokens(fullContent || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    persistSettings();
    return { ok: true, data: { choices: [{ message: { role: 'assistant', content: fullContent, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: finishReason }] } };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Paths ----
ipcMain.handle('app:getPath', (_, name) => {
  if (name === 'images') return imagesDir;
  if (name === 'data') return dataDir;
  if (name === 'skills') return skillsDir;
  if (name === 'userData') return userDataPath;
  return app.getPath(name);
});
ipcMain.handle('app:getVersion', () => APP_VERSION);

// ---- IPC: Dialog (系统对话框) ----
ipcMain.handle('dialog:confirm', async (_, message) => {
  // 发送请求到renderer进程显示确认对话框
  mainWindow.webContents.send('show-confirm-dialog', message);
  
  // 等待renderer的响应
  return new Promise((resolve) => {
    ipcMain.once('confirm-dialog-response', (_, response) => {
      resolve(response);
    });
  });
});

// ---- IPC: Dialog File Picker (系统对话框) ----
// Avatar: pick image file and return base64 data URL
ipcMain.handle('avatar:pickAndEncode', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择头像图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const fp = result.filePaths[0];
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
    return { ok: true, dataUrl: `data:${mime};base64,` + buf.toString('base64') };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Avatar: encode an existing file path to base64 data URL (for migration)
ipcMain.handle('avatar:encodeFile', async (_, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false };
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
    return { ok: true, dataUrl: `data:${mime};base64,` + buf.toString('base64') };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dialog:openFile', async (_, options = {}) => {
  try {
    const properties = ['openFile'];
    if (options.multiple) properties.push('multiSelections');
    if (options.directory) properties.push('openDirectory');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件',
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties
    });
    return { ok: !result.canceled, paths: result.filePaths || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dialog:saveFile', async (_, options = {}) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath,
      filters: options.filters
    });
    return { ok: !result.canceled, path: result.filePath || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Chat History ----
ipcMain.handle('history:list', () => {
  try {
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json')).sort((a, b) => b.localeCompare(a));
    return files.map(f => { const data = loadJSON(path.join(historyDir, f), {}); return { id: data.id, title: data.title || '未命名对话', createdAt: data.createdAt, updatedAt: data.updatedAt, messageCount: (data.messages || []).length }; });
  } catch { return []; }
});

ipcMain.handle('history:get', (_, id) => {
  const p = path.join(historyDir, `${id}.json`);
  return loadJSON(p, null);
});

ipcMain.handle('history:save', (_, conversation) => {
  conversation.updatedAt = new Date().toISOString();
  if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
  saveJSON(path.join(historyDir, `${conversation.id}.json`), conversation);
  return { ok: true };
});

ipcMain.handle('history:delete', (_, id) => {
  try { fs.unlinkSync(path.join(historyDir, `${id}.json`)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('history:rename', (_, id, title) => {
  const p = path.join(historyDir, `${id}.json`);
  const data = loadJSON(p, null);
  if (data) { data.title = title; data.updatedAt = new Date().toISOString(); saveJSON(p, data); return { ok: true }; }
  return { ok: false };
});

// ---- IPC: Workspace (Agent Working Directory) ----
ipcMain.handle('firmware:export', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, error: '用户取消' };
    const destDir = path.join(result.filePaths[0], 'CIBYP-TRNG');
    const srcDir = path.join(app.getAppPath(), 'IoT-Firmware', 'CIBYP-TRNG');
    
    // 创建目标目录
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    
    // 复制所有文件
    function copyDir(src, dest) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDir(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
    
    copyDir(srcDir, destDir);
    return { ok: true, path: destDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Workspace (Agent Working Directory) ----
ipcMain.handle('workspace:create', () => {
  const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const dir = path.join(workspacesBaseDir, ts);
  fs.mkdirSync(dir, { recursive: true });
  return { ok: true, path: dir };
});

ipcMain.handle('workspace:getBase', () => workspacesBaseDir);

ipcMain.handle('workspace:openInExplorer', (_, dirPath) => {
  shell.openPath(dirPath || workspacesBaseDir);
  return { ok: true };
});

ipcMain.handle('workspace:getFileTree', (_, dirPath) => {
  try {
    const tree = generateFileTree(dirPath, '', 0, 3); // 最多3层
    return { ok: true, tree };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function generateFileTree(dir, prefix, depth, maxDepth) {
  if (depth >= maxDepth) return '';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let result = '';
    entries.forEach((entry, i) => {
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      result += prefix + connector + entry.name + (entry.isDirectory() ? '/\n' : '\n');
      if (entry.isDirectory() && depth < maxDepth - 1) {
        result += generateFileTree(path.join(dir, entry.name), newPrefix, depth + 1, maxDepth);
      }
    });
    return result;
  } catch {
    return '';
  }
}

// ---- IPC: System Info (Enhanced) ----
ipcMain.handle('system:fullInfo', () => ({
  platform: process.platform,
  arch: process.arch,
  hostname: os.hostname(),
  username: os.userInfo().username,
  homeDir: os.homedir(),
  tempDir: os.tmpdir(),
  documentsDir: app.getPath('documents'),
  desktopDir: app.getPath('desktop'),
  downloadsDir: app.getPath('downloads'),
  cpus: os.cpus().length,
  totalMemory: os.totalmem(),
  freeMemory: os.freemem(),
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron,
  osRelease: os.release(),
  osType: os.type(),
  systemDrive: process.platform === 'win32' ? process.env.SystemDrive || 'C:' : '/',
  pathSep: path.sep
}));

// ---- IPC: File Import for Knowledge Base ----
ipcMain.handle('knowledge:importFile', async (_, filePath, workspacePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    let textContent = '';
    let images = [];
    const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;

    if (['.txt', '.csv', '.md', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.log', '.sh', '.bat', '.ps1', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.h', '.css'].includes(ext)) {
      textContent = readTextWithEncoding(filePath);
    } else if (['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'].includes(ext)) {
      // Use JSZip to extract from Office Open XML / ODF formats
      const AdmZip = requireAdmZip();
      if (!AdmZip) return { ok: false, error: '需要安装adm-zip包来处理此文件格式' };
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();

      if (ext === '.docx') {
        const docEntry = entries.find(e => e.entryName === 'word/document.xml');
        if (docEntry) {
          const xml = docEntry.getData().toString('utf-8');
          textContent = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        // Extract images
        entries.filter(e => e.entryName.startsWith('word/media/')).forEach(e => {
          const imgPath = path.join(targetDir, `import_${Date.now()}_${path.basename(e.entryName)}`);
          fs.writeFileSync(imgPath, e.getData());
          images.push(imgPath);
        });
      } else if (ext === '.xlsx' || ext === '.ods') {
        // Parse spreadsheet to CSV
        const sheetEntries = entries.filter(e => e.entryName.match(/xl\/worksheets\/sheet\d+\.xml|content\.xml/));
        for (const se of sheetEntries) {
          const xml = se.getData().toString('utf-8');
          const rows = [];
          const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
          for (const rowXml of rowMatches) {
            const cells = [];
            const cellMatches = rowXml.match(/<v>([^<]*)<\/v>/g) || [];
            for (const c of cellMatches) cells.push(c.replace(/<\/?v>/g, ''));
            if (cells.length > 0) rows.push(cells.join(','));
          }
          textContent += rows.join('\n') + '\n';
        }
      } else if (ext === '.pptx' || ext === '.odp') {
        const slideEntries = entries.filter(e => e.entryName.match(/ppt\/slides\/slide\d+\.xml|content\.xml/));
        for (const se of slideEntries) {
          const xml = se.getData().toString('utf-8');
          const txt = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          textContent += txt + '\n---\n';
        }
        entries.filter(e => e.entryName.startsWith('ppt/media/')).forEach(e => {
          const imgPath = path.join(targetDir, `import_${Date.now()}_${path.basename(e.entryName)}`);
          fs.writeFileSync(imgPath, e.getData());
          images.push(imgPath);
        });
      } else if (ext === '.odt') {
        const contentEntry = entries.find(e => e.entryName === 'content.xml');
        if (contentEntry) {
          const xml = contentEntry.getData().toString('utf-8');
          textContent = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
    } else if (['.doc', '.ppt', '.xls'].includes(ext)) {
      // Legacy binary formats - try to extract raw text
      const buf = fs.readFileSync(filePath);
      const rawText = buf.toString('utf-8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').replace(/\s+/g, ' ');
      // Extract readable portions
      const readable = rawText.match(/[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9\s,.;:!?(){}\[\]\-_+=@#$%^&*'"\/\\]+/g) || [];
      textContent = readable.join(' ').substring(0, 50000);
    } else if (ext === '.pdf') {
      // Basic PDF text extraction
      const buf = fs.readFileSync(filePath);
      const content = buf.toString('latin1');
      const textBlocks = [];
      const streamMatches = content.match(/stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g) || [];
      for (const sm of streamMatches) {
        const inner = sm.replace(/^stream[\r\n]+/, '').replace(/[\r\n]+endstream$/, '');
        // Try to extract text operators
        const tjMatches = inner.match(/\(([^)]*)\)/g) || [];
        for (const tj of tjMatches) {
          const text = tj.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\\\/g, '\\');
          if (text.length > 1 && /[a-zA-Z\u4e00-\u9fff]/.test(text)) textBlocks.push(text);
        }
      }
      textContent = textBlocks.join(' ') || '(PDF文本提取有限，建议使用OCR)';
    } else {
      // Try reading as text
      try { textContent = readTextWithEncoding(filePath); } catch { return { ok: false, error: '不支持的文件格式' }; }
    }

    return { ok: true, content: textContent.substring(0, 100000), images, fileName, ext };
  } catch (e) { return { ok: false, error: e.message }; }
});

function requireAdmZip() {
  try { return require('adm-zip'); } catch { return null; }
}

function readTextWithEncoding(filePath) {
  try {
    const chardet = require('chardet');
    const iconv = require('iconv-lite');
    const buf = fs.readFileSync(filePath);
    const detected = chardet.detect(buf) || 'utf-8';
    const encoding = detected.toLowerCase();
    if (iconv.encodingExists(encoding)) {
      return iconv.decode(buf, encoding);
    }
    return buf.toString('utf-8');
  } catch {
    return fs.readFileSync(filePath, 'utf-8');
  }
}

// ---- IPC: Read file as base64 (for images) ----
ipcMain.handle('fs:readFileBase64', (_, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    return { ok: true, data: `data:${mime};base64,${buf.toString('base64')}`, mime };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Save uploaded file ----
ipcMain.handle('fs:saveUploadedFile', (_, fileName, data) => {
  try {
    const ext = path.extname(fileName).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
    const targetDir = isImage ? imagesDir : path.join(userDataPath, 'uploads');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `${Date.now()}_${fileName}`);
    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = Buffer.from(data);
    } else {
      const base64 = data.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(base64, 'base64');
    }
    fs.writeFileSync(targetPath, buffer);
    return { ok: true, path: targetPath, isImage };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: GeoGebra ----
// GeoGebra now runs in the main window, not a separate window

ipcMain.handle('geogebra:init', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.initGeoGebra()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:evalCommand', async (_, cmd) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`window.evalGeoGebraCommand("${cmd.replace(/"/g, '\\"')}")`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:getAllObjects', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.getAllGeoGebraObjects()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:deleteObject', async (_, name) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`window.deleteGeoGebraObject("${name.replace(/"/g, '\\"')}")`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:exportPNG', async (_, workspacePath) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.exportGeoGebraPNG()');
    if (result.ok && result.data) {
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      const imgPath = path.join(targetDir, `geogebra_${Date.now()}.png`);
      fs.writeFileSync(imgPath, Buffer.from(result.data, 'base64'));
      return { ok: true, path: imgPath, url: `file://${imgPath}` };
    }
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Skills Update ----
ipcMain.handle('skills:update', (_, id, data) => {
  const p = path.join(skillsDir, `${id}.json`);
  const skill = loadJSON(p, null);
  if (skill) {
    const updated = { ...skill, ...data, updatedAt: new Date().toISOString() };
    saveJSON(p, updated);
    return { ok: true, skill: updated };
  }
  return { ok: false, error: '技能不存在' };
});

// ---- IPC: OCR (tesseract.js) ----
ipcMain.handle('ocr:recognize', async (_, imagePath) => {
  try {
    const text = await recognizeImageWithTesseract(imagePath);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ---- IPC: QR Code Scan ----
ipcMain.handle('qr:scan', async (_, imagePath) => {
  try {
    const jsQR = require('jsqr');
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(imagePath);
    if (img.isEmpty()) return { ok: false, error: '无法加载图片，请确认文件路径和格式' };
    const { width, height } = img.getSize();
    const bitmap = img.toBitmap(); // BGRA on Windows/Linux
    // Convert BGRA -> RGBA for jsQR
    const rgba = new Uint8ClampedArray(bitmap.length);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4 + 0] = bitmap[i * 4 + 2]; // R
      rgba[i * 4 + 1] = bitmap[i * 4 + 1]; // G
      rgba[i * 4 + 2] = bitmap[i * 4 + 0]; // B
      rgba[i * 4 + 3] = bitmap[i * 4 + 3]; // A
    }
    const code = jsQR(rgba, width, height);
    if (!code) return { ok: false, error: '未识别到二维码' };
    return { ok: true, data: code.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ---- IPC: QR Code Generate ----
ipcMain.handle('qr:generate', async (_, text, workspacePath, filename) => {
  try {
    const QRCode = require('qrcode');
    const fname = filename || ('qrcode_' + Date.now() + '.png');
    const outputPath = path.join(workspacePath || workspacesBaseDir, fname);
    await QRCode.toFile(outputPath, text, { width: 400, margin: 2 });
    return { ok: true, path: outputPath, filename: fname };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ---- IPC: Download File ----
ipcMain.handle('file:download', async (_, url, filename, workspacePath) => {
  try {
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');
    
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    // 确定文件名
    let targetFilename = filename;
    if (!targetFilename) {
      const urlPath = parsedUrl.pathname;
      targetFilename = path.basename(urlPath) || 'download';
    }
    
    // 获取工作区路径
    if (!workspacePath) {
      return { ok: false, error: '未设置工作区路径' };
    }
    
    const savePath = path.join(workspacePath, targetFilename);
    
    return new Promise((resolve) => {
      protocol.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          // 处理重定向
          resolve({ ok: false, error: '请使用重定向后的最终URL' });
          return;
        }
        
        if (response.statusCode !== 200) {
          resolve({ ok: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        
        const fileStream = fs.createWriteStream(savePath);
        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const progress = Math.floor((downloadedBytes / totalBytes) * 100);
            console.log(`[Download] ${progress}% (${downloadedBytes}/${totalBytes} bytes)`);
          }
        });
        
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          resolve({ ok: true, path: savePath, size: downloadedBytes });
        });
        
        fileStream.on('error', (err) => {
          fs.unlink(savePath, () => {});
          resolve({ ok: false, error: err.message });
        });
      }).on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Network Tools ----
ipcMain.handle('net:httpRequest', async (_, opts) => {
  try {
    const { URL } = require('url');
    const url = String(opts.url || '').trim();
    if (!url) return { ok: false, error: '缺少url' };
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    const timeout = Number(opts.timeout) || 30000;
    const followRedirects = opts.followRedirects !== false;
    const encoding = opts.encoding || 'utf8';
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    }
    const fetchOpts = { method, headers, redirect: followRedirects ? 'follow' : 'manual', signal: AbortSignal.timeout(timeout) };
    if (opts.body && method !== 'GET' && method !== 'HEAD') fetchOpts.body = opts.body;
    const resp = await fetch(url, fetchOpts);
    const buf = Buffer.from(await resp.arrayBuffer());
    const bodyStr = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8').substring(0, 500000);
    const respHeaders = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { ok: true, status: resp.status, statusText: resp.statusText, headers: respHeaders, body: bodyStr };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:httpFormPost', async (_, opts) => {
  try {
    const url = String(opts.url || '').trim();
    if (!url) return { ok: false, error: '缺少url' };
    const fields = opts.fields || {};
    const files = opts.files || [];
    const extraHeaders = opts.headers || {};
    if (files.length > 0) {
      // multipart/form-data
      const { Readable } = require('stream');
      const boundary = '----CIBYPFormBoundary' + Date.now().toString(36);
      const parts = [];
      for (const [k, v] of Object.entries(fields)) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
      }
      for (const f of files) {
        const fname = f.fileName || path.basename(f.filePath);
        const content = fs.readFileSync(f.filePath);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.fieldName}"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        parts.push(content);
      }
      const tail = `\r\n--${boundary}--\r\n`;
      const bodyParts = [];
      for (const p of parts) bodyParts.push(Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'));
      bodyParts.push(Buffer.from(tail, 'utf8'));
      const body = Buffer.concat(bodyParts);
      const resp = await fetch(url, {
        method: 'POST', body,
        headers: { ...extraHeaders, 'Content-Type': `multipart/form-data; boundary=${boundary}` }
      });
      const text = await resp.text();
      return { ok: true, status: resp.status, body: text.substring(0, 500000) };
    } else {
      const body = new URLSearchParams(fields).toString();
      const resp = await fetch(url, {
        method: 'POST', body,
        headers: { ...extraHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      const text = await resp.text();
      return { ok: true, status: resp.status, body: text.substring(0, 500000) };
    }
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:dnsLookup', async (_, hostname, rrtype) => {
  try {
    const dns = require('dns');
    const { promisify } = require('util');
    const rr = (rrtype || 'A').toUpperCase();
    if (rr === 'A' || rr === 'AAAA') {
      const lookup = promisify(dns.resolve4.bind(dns));
      const lookup6 = promisify(dns.resolve6.bind(dns));
      const records = await (rr === 'AAAA' ? lookup6 : lookup)(hostname);
      return { ok: true, hostname, rrtype: rr, records };
    }
    const resolve = promisify(dns.resolve.bind(dns));
    const records = await resolve(hostname, rr);
    return { ok: true, hostname, rrtype: rr, records };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:ping', async (_, host, count) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const n = Math.min(Math.max(Number(count) || 4, 1), 20);
    const isWin = process.platform === 'win32';
    const args = isWin ? ['-n', String(n), host] : ['-c', String(n), host];
    const { stdout, stderr } = await execFileAsync(isWin ? 'ping' : '/bin/ping', args, { timeout: n * 5000 + 5000 });
    return { ok: true, host, output: (stdout || stderr || '').substring(0, 10000) };
  } catch (e) {
    return { ok: true, host, output: (e.stdout || e.stderr || e.message || '').substring(0, 10000), timedOut: e.killed };
  }
});

ipcMain.handle('net:whois', async (_, domain) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    // Windows 没有内置 whois，尝试通过 PowerShell 的 Invoke-WebRequest 查询
    const isWin = process.platform === 'win32';
    if (isWin) {
      // 使用 WHOIS API 查询
      const resp = await fetch(`https://whois.freeaiapi.xyz/?name=${encodeURIComponent(domain)}&lang=cn`);
      if (!resp.ok) {
        // fallback: 通过系统 whois 命令
        const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', `Invoke-RestMethod -Uri "https://who-dat.as93.net/${encodeURIComponent(domain)}"`], { timeout: 15000 });
        return { ok: true, domain, whoisText: String(stdout).substring(0, 50000) };
      }
      const text = await resp.text();
      return { ok: true, domain, whoisText: text.substring(0, 50000) };
    } else {
      const { stdout } = await execFileAsync('whois', [domain], { timeout: 15000 });
      return { ok: true, domain, whoisText: String(stdout).substring(0, 50000) };
    }
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:urlShorten', async (_, url) => {
  try {
    const chain = [url];
    let current = url;
    for (let i = 0; i < 10; i++) {
      const resp = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
      const loc = resp.headers.get('location');
      if (!loc || (resp.status !== 301 && resp.status !== 302 && resp.status !== 303 && resp.status !== 307 && resp.status !== 308)) break;
      const next = new URL(loc, current).href;
      chain.push(next);
      current = next;
    }
    return { ok: true, originalUrl: url, finalUrl: current, redirectChain: chain };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:urlEncodeDecode', async (_, input, operation) => {
  try {
    let result;
    switch (operation) {
      case 'urlEncode': result = encodeURIComponent(input); break;
      case 'urlDecode': result = decodeURIComponent(input); break;
      case 'base64Encode': result = Buffer.from(input, 'utf8').toString('base64'); break;
      case 'base64Decode': result = Buffer.from(input, 'base64').toString('utf8'); break;
      default: return { ok: false, error: `未知操作: ${operation}` };
    }
    return { ok: true, operation, input, result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:checkSSLCert', async (_, hostname, port) => {
  try {
    const tls = require('tls');
    const p = Number(port) || 443;
    return new Promise((resolve) => {
      const sock = tls.connect({ host: hostname, port: p, servername: hostname, rejectUnauthorized: false, timeout: 10000 }, () => {
        const cert = sock.getPeerCertificate(true);
        sock.destroy();
        if (!cert || !cert.subject) return resolve({ ok: false, error: '无法获取证书' });
        resolve({
          ok: true, hostname, port: p,
          subject: cert.subject, issuer: cert.issuer,
          validFrom: cert.valid_from, validTo: cert.valid_to,
          serialNumber: cert.serialNumber,
          fingerprint: cert.fingerprint,
          fingerprint256: cert.fingerprint256,
          subjectAltName: cert.subjectaltname,
          bits: cert.bits,
          protocol: sock.getProtocol && sock.getProtocol()
        });
      });
      sock.on('error', (err) => { sock.destroy(); resolve({ ok: false, error: err.message }); });
      sock.setTimeout(10000, () => { sock.destroy(); resolve({ ok: false, error: '连接超时' }); });
    });
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:traceroute', async (_, host) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'tracert' : 'traceroute';
    const args = isWin ? ['-d', '-w', '2000', host] : ['-n', '-w', '2', host];
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 60000 });
    return { ok: true, host, output: (stdout || stderr || '').substring(0, 30000) };
  } catch (e) {
    return { ok: true, host, output: (e.stdout || e.stderr || e.message || '').substring(0, 30000), timedOut: e.killed };
  }
});

ipcMain.handle('net:portScan', async (_, host, portsStr, timeout) => {
  try {
    const net = require('net');
    const perTimeout = Math.min(Math.max(Number(timeout) || 2000, 200), 10000);
    // 解析端口: 80,443,8000-8100
    const ports = [];
    for (const part of String(portsStr).split(',')) {
      const trimmed = part.trim();
      if (trimmed.includes('-')) {
        const [a, b] = trimmed.split('-').map(Number);
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = Math.min(a, b); i <= Math.min(Math.max(a, b), Math.min(a, b) + 1000); i++) ports.push(i);
        }
      } else {
        const p = Number(trimmed);
        if (!isNaN(p) && p > 0 && p <= 65535) ports.push(p);
      }
    }
    if (ports.length === 0) return { ok: false, error: '无效端口范围' };
    if (ports.length > 1024) return { ok: false, error: '端口范围过大(最大1024个)' };
    const scanPort = (p) => new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(perTimeout);
      sock.once('connect', () => { sock.destroy(); resolve({ port: p, open: true }); });
      sock.once('timeout', () => { sock.destroy(); resolve({ port: p, open: false }); });
      sock.once('error', () => { sock.destroy(); resolve({ port: p, open: false }); });
      sock.connect(p, host);
    });
    // 并发扫描，每批 50
    const openPorts = [];
    for (let i = 0; i < ports.length; i += 50) {
      const batch = ports.slice(i, i + 50);
      const results = await Promise.all(batch.map(scanPort));
      for (const r of results) if (r.open) openPorts.push(r.port);
    }
    return { ok: true, host, scannedCount: ports.length, openPorts };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- Sanguosha Game Window ----
let sanguoshaWindow = null;
let sanguoshaConfig = { aiCount: 3 };

ipcMain.handle('sanguosha:open', async (_, aiCount) => {
  try {
    sanguoshaConfig.aiCount = aiCount || 3;
    if (sanguoshaWindow && !sanguoshaWindow.isDestroyed()) {
      sanguoshaWindow.focus();
      return { ok: true };
    }
    sanguoshaWindow = new BrowserWindow({
      width: 1100, height: 750, minWidth: 900, minHeight: 650,
      title: '三国杀',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/sanguosha-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    sanguoshaWindow.loadFile(path.join(__dirname, '../renderer/pages/sanguosha.html'));
    sanguoshaWindow.on('closed', () => { sanguoshaWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sanguosha:getConfig', () => sanguoshaConfig);
ipcMain.handle('sanguosha:close', () => {
  if (sanguoshaWindow && !sanguoshaWindow.isDestroyed()) sanguoshaWindow.close();
});

ipcMain.handle('sanguosha:aiDecision', async (_, gameState, playerInfo) => {
  // Use LLM for AI decision making
  try {
    const apiUrl = settings.llm.apiUrl;
    const apiKey = settings.llm.apiKey;
    const model = settings.llm.model;
    if (!apiUrl || !apiKey || !model) return { ok: true, action: 'auto' };

    const body = {
      model,
      messages: [
        { role: 'system', content: gameState.systemPrompt || '你是三国杀AI玩家' },
        { role: 'user', content: gameState.userPrompt || JSON.stringify(playerInfo) }
      ],
      temperature: 0.7,
      max_tokens: 300,
      stream: false
    };

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (data.error) return { ok: true, action: 'auto' };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: true, action: 'auto' };

    // Track token usage
    const usageTokens = data.usage?.total_tokens || estimateTokens(JSON.stringify(body)) + estimateTokens(content);
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    persistSettings();

    return { ok: true, action: 'llm', content };
  } catch (e) {
    return { ok: true, action: 'auto' };
  }
});

// ---- Flying Flower Game Window ----
let flyingflowerWindow = null;
let flyingflowerConfig = { aiCount: 3 };

ipcMain.handle('flyingflower:open', async (_, aiCount) => {
  try {
    flyingflowerConfig.aiCount = aiCount || 3;
    if (flyingflowerWindow && !flyingflowerWindow.isDestroyed()) {
      flyingflowerWindow.focus();
      return { ok: true };
    }
    flyingflowerWindow = new BrowserWindow({
      width: 900, height: 700, minWidth: 700, minHeight: 550,
      title: '飞花令',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/flyingflower-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    flyingflowerWindow.loadFile(path.join(__dirname, '../renderer/pages/flyingflower.html'));
    flyingflowerWindow.on('closed', () => { flyingflowerWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('flyingflower:getConfig', () => flyingflowerConfig);
ipcMain.handle('flyingflower:close', () => {
  if (flyingflowerWindow && !flyingflowerWindow.isDestroyed()) flyingflowerWindow.close();
});

// ---- Undercover Game Window ----
let undercoverWindow = null;
let undercoverConfig = { aiCount: 4 };

ipcMain.handle('undercover:open', async (_, aiCount) => {
  try {
    undercoverConfig.aiCount = aiCount || 4;
    if (undercoverWindow && !undercoverWindow.isDestroyed()) {
      undercoverWindow.focus();
      return { ok: true };
    }
    undercoverWindow = new BrowserWindow({
      width: 900, height: 700, minWidth: 700, minHeight: 550,
      title: '谁是卧底',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/undercover-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    undercoverWindow.loadFile(path.join(__dirname, '../renderer/pages/undercover.html'));
    undercoverWindow.on('closed', () => { undercoverWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('undercover:getConfig', () => undercoverConfig);
ipcMain.handle('undercover:close', () => {
  if (undercoverWindow && !undercoverWindow.isDestroyed()) undercoverWindow.close();
});

// ---- Game Result Reporting ----
ipcMain.on('game:result', (_, data) => {
  console.log('[Game] Result received:', data.game, data.result);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game:finished', data);
  }
});

const mcpServers = new Map(); // name -> { process, transport, status }

function getMcpSettings() {
  const mcp = settings.mcp || {};
  if (!Array.isArray(mcp.servers)) mcp.servers = [];
  return mcp;
}

function saveMcpSettings(mcpSettings) {
  settings.mcp = mcpSettings;
  persistSettings();
}

async function startMcpServer(serverConfig) {
  const { name, command, args, env, cwd } = serverConfig;
  try {
    const { spawn } = require('child_process');
    const childProcess = spawn(command, args || [], {
      env: { ...process.env, ...(env || {}) },
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    const serverEntry = {
      process: childProcess,
      config: serverConfig,
      status: 'connecting',
      tools: [],
      pendingRequests: new Map(),
      requestId: 1,
      buffer: '',
    };

    // JSONRPC over stdio
    childProcess.stdout.on('data', (data) => {
      serverEntry.buffer += data.toString();
      processJsonRpcBuffer(name, serverEntry);
    });

    childProcess.stderr.on('data', (data) => {
      console.error(`[MCP:${name}] stderr: ${data.toString()}`);
    });

    childProcess.on('close', (code) => {
      console.log(`[MCP:${name}] process exited with code ${code}`);
      serverEntry.status = 'disconnected';
      mcpServers.delete(name);
    });

    childProcess.on('error', (err) => {
      console.error(`[MCP:${name}] process error: ${err.message}`);
      serverEntry.status = 'error';
    });

    mcpServers.set(name, serverEntry);

    // Send initialize request
    await sendMcpRequest(name, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Could-I-Be-Your-Partner', version: APP_VERSION }
    });

    // Send initialized notification
    sendMcpNotification(name, 'notifications/initialized', {});

    // List tools
    const toolsResult = await sendMcpRequest(name, 'tools/list', {});
    if (toolsResult && toolsResult.tools) {
      serverEntry.tools = toolsResult.tools;
    }
    serverEntry.status = 'connected';

    return { ok: true, tools: serverEntry.tools };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sendMcpRequest(serverName, method, params) {
  const server = mcpServers.get(serverName);
  if (!server || !server.process || server.process.killed) {
    return Promise.reject(new Error(`MCP server "${serverName}" is not running`));
  }

  return new Promise((resolve, reject) => {
    const id = server.requestId++;
    const request = { jsonrpc: '2.0', id, method, params };

    server.pendingRequests.set(id, { resolve, reject, timeout: setTimeout(() => {
      server.pendingRequests.delete(id);
      reject(new Error(`Request ${method} timed out`));
    }, 30000) });

    try {
      const msg = JSON.stringify(request);
      server.process.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
    } catch (e) {
      server.pendingRequests.delete(id);
      reject(e);
    }
  });
}

function sendMcpNotification(serverName, method, params) {
  const server = mcpServers.get(serverName);
  if (!server || !server.process || server.process.killed) return;
  try {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    server.process.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
  } catch (e) {
    console.error(`[MCP:${serverName}] notification error: ${e.message}`);
  }
}

function processJsonRpcBuffer(serverName, serverEntry) {
  while (true) {
    const headerEnd = serverEntry.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = serverEntry.buffer.substring(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Try to find JSON directly (some servers don't send headers)
      try {
        const jsonStart = serverEntry.buffer.indexOf('{');
        if (jsonStart === -1) break;
        const jsonEnd = findJsonEnd(serverEntry.buffer, jsonStart);
        if (jsonEnd === -1) break;
        const jsonStr = serverEntry.buffer.substring(jsonStart, jsonEnd + 1);
        serverEntry.buffer = serverEntry.buffer.substring(jsonEnd + 1);
        handleMcpResponse(serverName, JSON.parse(jsonStr));
        continue;
      } catch {
        break;
      }
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (serverEntry.buffer.length < bodyStart + contentLength) break;

    const body = serverEntry.buffer.substring(bodyStart, bodyStart + contentLength);
    serverEntry.buffer = serverEntry.buffer.substring(bodyStart + contentLength);

    try {
      handleMcpResponse(serverName, JSON.parse(body));
    } catch (e) {
      console.error(`[MCP:${serverName}] parse error: ${e.message}`);
    }
  }
}

function findJsonEnd(str, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function handleMcpResponse(serverName, msg) {
  const server = mcpServers.get(serverName);
  if (!server) return;

  if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
    const pending = server.pendingRequests.get(msg.id);
    server.pendingRequests.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }
}

async function stopMcpServer(serverName) {
  const server = mcpServers.get(serverName);
  if (!server) return;
  try {
    if (server.process && !server.process.killed) {
      server.process.kill();
    }
  } catch (e) {
    console.error(`[MCP:${serverName}] stop error: ${e.message}`);
  }
  mcpServers.delete(serverName);
}

// MCP IPC handlers
ipcMain.handle('mcp:listServers', () => {
  const mcpSettings = getMcpSettings();
  return mcpSettings.servers.map(s => ({
    ...s,
    status: mcpServers.has(s.name) ? mcpServers.get(s.name).status : 'disconnected',
    toolCount: mcpServers.has(s.name) ? mcpServers.get(s.name).tools.length : 0,
  }));
});

ipcMain.handle('mcp:addServer', async (_, serverConfig) => {
  const mcpSettings = getMcpSettings();
  // Validate
  if (!serverConfig.name || !serverConfig.command) {
    return { ok: false, error: '名称和命令不能为空' };
  }
  if (mcpSettings.servers.find(s => s.name === serverConfig.name)) {
    return { ok: false, error: '同名服务器已存在' };
  }
  mcpSettings.servers.push(serverConfig);
  saveMcpSettings(mcpSettings);
  return { ok: true };
});

ipcMain.handle('mcp:removeServer', async (_, name) => {
  await stopMcpServer(name);
  const mcpSettings = getMcpSettings();
  mcpSettings.servers = mcpSettings.servers.filter(s => s.name !== name);
  saveMcpSettings(mcpSettings);
  return { ok: true };
});

ipcMain.handle('mcp:updateServer', async (_, name, updates) => {
  const mcpSettings = getMcpSettings();
  const idx = mcpSettings.servers.findIndex(s => s.name === name);
  if (idx === -1) return { ok: false, error: '服务器不存在' };
  mcpSettings.servers[idx] = { ...mcpSettings.servers[idx], ...updates };
  saveMcpSettings(mcpSettings);
  return { ok: true };
});

ipcMain.handle('mcp:connect', async (_, name) => {
  const mcpSettings = getMcpSettings();
  const config = mcpSettings.servers.find(s => s.name === name);
  if (!config) return { ok: false, error: '服务器不存在' };
  if (mcpServers.has(name)) await stopMcpServer(name);
  return await startMcpServer(config);
});

ipcMain.handle('mcp:disconnect', async (_, name) => {
  await stopMcpServer(name);
  return { ok: true };
});

ipcMain.handle('mcp:listTools', async (_, serverName) => {
  if (serverName) {
    const server = mcpServers.get(serverName);
    if (!server) return { ok: false, error: '服务器未连接' };
    return { ok: true, tools: server.tools, serverName };
  }
  // List all tools across all servers
  const allTools = [];
  for (const [name, server] of mcpServers) {
    if (server.status === 'connected') {
      for (const tool of server.tools) {
        allTools.push({ ...tool, serverName: name });
      }
    }
  }
  return { ok: true, tools: allTools };
});

ipcMain.handle('mcp:callTool', async (_, serverName, toolName, args) => {
  const server = mcpServers.get(serverName);
  if (!server || server.status !== 'connected') {
    return { ok: false, error: `MCP 服务器 "${serverName}" 未连接` };
  }
  try {
    const result = await sendMcpRequest(serverName, 'tools/call', { name: toolName, arguments: args || {} });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mcp:getStatus', () => {
  const statuses = {};
  for (const [name, server] of mcpServers) {
    statuses[name] = { status: server.status, tools: server.tools.length };
  }
  return statuses;
});

// Auto-connect configured MCP servers on startup
app.whenReady().then(async () => {
  // ---- Serial Port Agent Tools ----
  const agentSerialPorts = new Map(); // path → { port, buffer }

  ipcMain.handle('serial:listPorts', async () => {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return { ok: true, ports };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:openPort', async (_, portPath, options) => {
    try {
      if (agentSerialPorts.has(portPath)) {
        return { ok: false, error: `串口 ${portPath} 已打开` };
      }
      const { SerialPort } = require('serialport');
      const opts = {
        path: portPath,
        baudRate: options?.baudRate || 9600,
        dataBits: options?.dataBits || 8,
        stopBits: options?.stopBits || 1,
        parity: options?.parity || 'none',
      };
      const port = new SerialPort(opts);
      const entry = { port, buffer: '' };
      port.on('data', (chunk) => { entry.buffer += chunk.toString('utf8'); });
      port.on('error', (e) => { console.error(`[Serial ${portPath}] error:`, e.message); });
      agentSerialPorts.set(portPath, entry);
      return new Promise((resolve) => {
        port.once('open', () => resolve({ ok: true, message: `串口 ${portPath} 已打开 (${opts.baudRate}bps)` }));
        port.once('error', (e) => { agentSerialPorts.delete(portPath); resolve({ ok: false, error: e.message }); });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:writePort', async (_, portPath, data, encoding) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      const enc = encoding || 'utf8';
      const buf = Buffer.from(data, enc);
      return new Promise((resolve) => {
        entry.port.write(buf, (err) => {
          if (err) return resolve({ ok: false, error: err.message });
          entry.port.drain((e2) => {
            if (e2) return resolve({ ok: false, error: e2.message });
            resolve({ ok: true, bytesWritten: buf.length });
          });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:readPort', async (_, portPath, timeout, encoding) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      const ms = timeout || 1000;
      // Wait for data up to timeout
      if (!entry.buffer) {
        await new Promise((r) => setTimeout(r, ms));
      }
      const data = entry.buffer;
      entry.buffer = '';
      if (encoding === 'hex') {
        return { ok: true, data: Buffer.from(data, 'utf8').toString('hex'), length: data.length };
      }
      if (encoding === 'base64') {
        return { ok: true, data: Buffer.from(data, 'utf8').toString('base64'), length: data.length };
      }
      return { ok: true, data, length: data.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:closePort', async (_, portPath) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      return new Promise((resolve) => {
        entry.port.close((err) => {
          agentSerialPorts.delete(portPath);
          if (err) return resolve({ ok: false, error: err.message });
          resolve({ ok: true, message: `串口 ${portPath} 已关闭` });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:setSignals', async (_, portPath, signals) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      return new Promise((resolve) => {
        entry.port.set(signals, (err) => {
          if (err) return resolve({ ok: false, error: err.message });
          resolve({ ok: true, signals });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  function resolveWordDocTarget(pathOrDir) {
    const fsLocal = require('fs');
    const pathLocal = require('path');
    const AdmZip = require('adm-zip');
    const input = String(pathOrDir || '').trim();
    if (!input) throw new Error('缺少pathOrDir参数');
    if (!fsLocal.existsSync(input)) throw new Error('路径不存在: ' + input);

    const stat = fsLocal.statSync(input);
    let dir = input;
    let type = '';
    let sourcePath = input;

    if (stat.isFile()) {
      const ext = pathLocal.extname(input).toLowerCase();
      if (!['.docx', '.odt'].includes(ext)) throw new Error('仅支持 .docx/.odt');
      const parsed = pathLocal.parse(input);
      dir = pathLocal.join(parsed.dir, parsed.name + '_unpacked');
      const zip = new AdmZip(input);
      zip.extractAllTo(dir, true);
      fsLocal.writeFileSync(pathLocal.join(dir, '.__office_ext__'), ext);
      sourcePath = input;
    } else {
      sourcePath = dir;
    }

    if (fsLocal.existsSync(pathLocal.join(dir, 'word', 'document.xml'))) type = 'docx';
    else if (fsLocal.existsSync(pathLocal.join(dir, 'content.xml'))) type = 'odt';
    else throw new Error('不是可识别的Word文档目录（缺少word/document.xml或content.xml）');

    const mainFile = type === 'docx'
      ? pathLocal.join(dir, 'word', 'document.xml')
      : pathLocal.join(dir, 'content.xml');
    const stylesFile = type === 'docx'
      ? pathLocal.join(dir, 'word', 'styles.xml')
      : pathLocal.join(dir, 'styles.xml');

    return { dir, type, mainFile, stylesFile, sourcePath };
  }

  function extractDocxRuns(content, includeEmpty) {
    const paragraphs = content.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
    const items = [];
    let index = 0;
    for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
      const pXml = paragraphs[pIndex];
      const pStyle = ((pXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/) || [])[1]) || '';
      const runs = pXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) || [];
      for (let rIndex = 0; rIndex < runs.length; rIndex++) {
        const rXml = runs[rIndex];
        const tMatches = [...rXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
        if (!tMatches.length) continue;
        const rawText = tMatches.map(m => m[1]).join('');
        const text = decodeXmlEntities(rawText);
        if (!includeEmpty && !text.trim()) {
          index++;
          continue;
        }
        const color = ((rXml.match(/<w:color\b[^>]*w:val="([^"]+)"/) || [])[1]) || '';
        const sizeHalfPoint = ((rXml.match(/<w:sz\b[^>]*w:val="([^"]+)"/) || [])[1]) || '';
        items.push({
          index,
          paragraphIndex: pIndex,
          runIndex: rIndex,
          text,
          style: {
            paragraphStyle: pStyle,
            bold: /<w:b(?:\s[^>]*)?\/>|<w:b(?:\s[^>]*)?><\/w:b>/.test(rXml),
            italic: /<w:i(?:\s[^>]*)?\/>|<w:i(?:\s[^>]*)?><\/w:i>/.test(rXml),
            underline: /<w:u\b/.test(rXml),
            color,
            fontSizePt: sizeHalfPoint ? Number(sizeHalfPoint) / 2 : null
          }
        });
        index++;
      }
    }
    return items;
  }

  function applyDocxRunUpdates(content, updatesMap) {
    let index = 0;
    let updated = 0;
    const next = content.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (m, attrs) => {
      const replaceTo = updatesMap.get(index);
      const currentIndex = index;
      index++;
      if (replaceTo === undefined) return m;
      updated++;
      return `<w:t${attrs || ''}>${encodeXmlEntities(String(replaceTo))}</w:t>`;
    });
    return { content: next, updated };
  }

  function extractOdtTextNodes(content, includeEmpty) {
    const items = [];
    let index = 0;
    let pIndex = 0;
    content.replace(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g, (pMatch, pInner) => {
      pInner.replace(/>([^<>]*)</g, (m, text) => {
        const value = decodeXmlEntities(text || '');
        if (!includeEmpty && !value.trim()) {
          index++;
          return m;
        }
        items.push({ index, paragraphIndex: pIndex, runIndex: null, text: value, style: {} });
        index++;
        return m;
      });
      pIndex++;
      return pMatch;
    });
    return items;
  }

  function applyOdtTextUpdates(content, updatesMap) {
    let index = 0;
    let updated = 0;
    const next = content.replace(/>([^<>]*)</g, (m, text) => {
      const replaceTo = updatesMap.get(index);
      index++;
      if (replaceTo === undefined) return m;
      updated++;
      return `>${encodeXmlEntities(String(replaceTo))}<`;
    });
    return { content: next, updated };
  }

  function parseDocxStyles(stylesXml) {
    const styles = [];
    const blocks = stylesXml.match(/<w:style\b[\s\S]*?<\/w:style>/g) || [];
    for (const block of blocks) {
      const id = ((block.match(/w:styleId="([^"]+)"/) || [])[1]) || '';
      const type = ((block.match(/w:type="([^"]+)"/) || [])[1]) || '';
      const name = ((block.match(/<w:name\b[^>]*w:val="([^"]+)"/) || [])[1]) || id;
      styles.push({ id, name, type });
    }
    return styles;
  }

  function parseOdtStyles(stylesXml) {
    const styles = [];
    const matches = stylesXml.match(/<style:style\b[^>]*>/g) || [];
    for (const tag of matches) {
      const id = ((tag.match(/style:name="([^"]+)"/) || [])[1]) || '';
      const family = ((tag.match(/style:family="([^"]+)"/) || [])[1]) || '';
      styles.push({ id, name: id, type: family });
    }
    return styles;
  }

  function replaceWordPlaceholders(content, replacements) {
    let updated = 0;
    let next = content;
    const entries = Object.entries(replacements || {});
    for (const [key, value] of entries) {
      const safeKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const val = encodeXmlEntities(String(value ?? ''));
      const patterns = [
        new RegExp(`\\{\\{\\s*${safeKey}\\s*\\}\\}`, 'g'),
        new RegExp(`\\$\\{\\s*${safeKey}\\s*\\}`, 'g'),
        new RegExp(`<<\\s*${safeKey}\\s*>>`, 'g')
      ];
      for (const re of patterns) {
        const count = (next.match(re) || []).length;
        if (count > 0) {
          next = next.replace(re, val);
          updated += count;
        }
      }
    }
    return { content: next, updated };
  }

  // ---- Office ZIP Tools ----
  ipcMain.handle('office:unpack', async (_, filePath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const AdmZip = require('adm-zip');
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      const parsed = path.parse(filePath);
      const outDir = path.join(parsed.dir, parsed.name + '_unpacked');
      const zip = new AdmZip(filePath);
      zip.extractAllTo(outDir, true);
      // Save original extension for repack
      fs.writeFileSync(path.join(outDir, '.__office_ext__'), parsed.ext);
      return { ok: true, dir: outDir, message: `已解压到 ${outDir}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:listContents', async (_, dir) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const result = [];
      function walk(d, rel) {
        for (const f of fs.readdirSync(d)) {
          if (f === '.__office_ext__') continue;
          const fp = path.join(d, f);
          const rp = rel ? rel + '/' + f : f;
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) { result.push({ path: rp + '/', size: 0 }); walk(fp, rp); }
          else result.push({ path: rp, size: stat.size });
        }
      }
      walk(dir, '');
      return { ok: true, files: result, count: result.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:repack', async (_, dir, outputPath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const AdmZip = require('adm-zip');
      if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在: ' + dir };
      let ext = '.docx';
      const extFile = path.join(dir, '.__office_ext__');
      if (fs.existsSync(extFile)) ext = fs.readFileSync(extFile, 'utf8').trim();
      const out = outputPath || dir.replace(/_unpacked$/, '') + ext;
      const zip = new AdmZip();
      function addDir(d, zipPath) {
        for (const f of fs.readdirSync(d)) {
          if (f === '.__office_ext__') continue;
          const fp = path.join(d, f);
          const zp = zipPath ? zipPath + '/' + f : f;
          if (fs.statSync(fp).isDirectory()) { addDir(fp, zp); }
          else { zip.addFile(zp, fs.readFileSync(fp)); }
        }
      }
      addDir(dir, '');
      zip.writeZip(out);
      return { ok: true, path: out, message: `已打包为 ${out}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Office Text Helpers (for translation workflow) ----
  ipcMain.handle('office:getSlideTexts', async (_, dir, slideFile) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(dir, slideFile.replace(/\//g, path.sep));
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      const content = fs.readFileSync(filePath, 'utf8');
      const texts = [];
      let index = 0;
      content.replace(/<a:t>([^<]*)<\/a:t>/g, (match, text) => {
        if (text.trim()) texts.push({ index, text });
        index++;
        return match;
      });
      return { ok: true, slideFile, count: texts.length, texts };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:setSlideTexts', async (_, dir, slideFile, translations) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(dir, slideFile.replace(/\//g, path.sep));
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      let content = fs.readFileSync(filePath, 'utf8');
      const map = {};
      for (const t of (translations || [])) map[t.index] = t.text;
      let index = 0;
      let count = 0;
      content = content.replace(/<a:t>([^<]*)<\/a:t>/g, (match, text) => {
        const idx = index++;
        if (idx in map) { count++; return `<a:t>${map[idx]}</a:t>`; }
        return match;
      });
      fs.writeFileSync(filePath, content, 'utf8');
      return { ok: true, slideFile, updated: count, message: `已更新 ${count} 处文字` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordExtract', async (_, pathOrDir, options = {}) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const includeEmpty = !!options.includeEmpty;
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const items = target.type === 'docx'
        ? extractDocxRuns(xml, includeEmpty)
        : extractOdtTextNodes(xml, includeEmpty);
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        count: items.length,
        items
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordApplyTexts', async (_, pathOrDir, updates = []) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const updatesMap = new Map();
      for (const item of updates || []) {
        const idx = Number(item?.index);
        if (!Number.isInteger(idx) || idx < 0) continue;
        updatesMap.set(idx, String(item?.text ?? ''));
      }
      if (updatesMap.size === 0) return { ok: false, error: '缺少有效updates' };

      const applied = target.type === 'docx'
        ? applyDocxRunUpdates(xml, updatesMap)
        : applyOdtTextUpdates(xml, updatesMap);
      fsLocal.writeFileSync(target.mainFile, applied.content, 'utf8');
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        updated: applied.updated
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordGetStyles', async (_, pathOrDir) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      if (!fsLocal.existsSync(target.stylesFile)) {
        return { ok: true, type: target.type, styles: [], count: 0 };
      }
      const stylesXml = fsLocal.readFileSync(target.stylesFile, 'utf8');
      const styles = target.type === 'docx' ? parseDocxStyles(stylesXml) : parseOdtStyles(stylesXml);
      return { ok: true, type: target.type, styles, count: styles.length, stylesFile: target.stylesFile };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordFillTemplate', async (_, pathOrDir, replacements = {}) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const replaced = replaceWordPlaceholders(xml, replacements || {});
      fsLocal.writeFileSync(target.mainFile, replaced.content, 'utf8');
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        replaced: replaced.updated
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Spreadsheet File I/O ----
  ipcMain.handle('spreadsheet:importFile', async (_, filePath) => {
    try {
      return importSpreadsheetFile(filePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('spreadsheet:exportFile', async (_, filePath, cells, sheetName) => {
    try {
      return exportSpreadsheetFile(filePath, cells, sheetName);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Email Service IPC ----
  ipcMain.handle('email:generateTOTP', async () => {
    try {
      return { ok: true, ...(await emailService.generateTOTPSecret()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:saveTOTPSecret', async (_, secret) => {
    try {
      settings.email.totpSecret = secret;
      persistSettings();
      emailService.configure(settings.email);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:verifyTOTP', async (_, code) => {
    try {
      emailService.configure(settings.email);
      const valid = emailService.verifyTOTP(code);
      return { ok: true, valid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:connect', async () => {
    try {
      emailService.configure(settings.email);
      const mode = settings.email.mode || 'send-receive';
      let smtpMsg = '跳过', imapMsg = '跳过';
      if (mode === 'send-only' || mode === 'send-receive') {
        const smtp = await emailService.initSMTP();
        smtpMsg = smtp.message;
        console.log('[Email] SMTP connected');
      }
      if (mode === 'receive-only' || mode === 'send-receive') {
        const imap = await emailService.connectIMAP();
        imapMsg = imap.message;
        console.log('[Email] IMAP connected');
      }
      emailService.enabled = true;
      return { ok: true, smtp: smtpMsg, imap: imapMsg };
    } catch (e) {
      console.error('[Email] Connect error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:disconnect', async () => {
    try {
      await emailService.disconnect();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:send', async (_, to, subject, html, text) => {
    try {
      return await emailService.sendEmail(to, subject, html, text);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:fetchNew', async () => {
    try {
      const emails = await emailService.fetchNewEmails();
      return { ok: true, emails };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:startPolling', async () => {
    try {
      const mode = settings.email.mode || 'send-receive';
      if (!emailService.enabled) {
        emailService.configure(settings.email);
        if (mode === 'send-only' || mode === 'send-receive') {
          await emailService.initSMTP();
          console.log('[Email] SMTP connected for polling start');
        }
        if (mode === 'receive-only' || mode === 'send-receive') {
          await emailService.connectIMAP();
          console.log('[Email] IMAP connected for polling start');
        }
        emailService.enabled = true;
      }
      if (mode === 'send-only') {
        return { ok: true, message: '只发模式，无需轮询' };
      }
      emailService.onEmailReceived = (email) => {
        console.log('[Email] Received email from:', email.from, 'subject:', email.subject);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('email:received', email);
        }
      };
      emailService.startPolling();
      return { ok: true, message: '邮件轮询已启动' };
    } catch (e) {
      console.error('[Email] Start polling error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:stopPolling', async () => {
    try {
      emailService.stopPolling();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:requestApproval', async (_, toolName, args, chatMarkdown) => {
    try {
      const mode = settings.email.mode || 'send-receive';
      if (mode === 'receive-only') {
        console.log('[Email] Cannot send approval request in receive-only mode, rejecting');
        return { ok: false, approved: false, reason: '邮件模式为只收，无法发送审批请求，已拒绝' };
      }
      if (!emailService.enabled) {
        emailService.configure(settings.email);
        await emailService.initSMTP();
        if (mode === 'send-receive') await emailService.connectIMAP();
        emailService.enabled = true;
      }
      if (mode === 'send-only') {
        // Can send but cannot receive reply => auto-reject
        console.log('[Email] Send-only mode cannot receive approval reply, rejecting tool');
        return { ok: false, approved: false, reason: '邮件模式为只发，无法接收审批回复，已拒绝' };
      }
      return await emailService.requestApprovalViaEmail(toolName, args, chatMarkdown);
    } catch (e) {
      console.error('[Email] Request approval error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:sendConversation', async (_, messages, title) => {
    try {
      const mode = settings.email.mode || 'send-receive';
      if (mode === 'receive-only') {
        console.log('[Email] Cannot send conversation in receive-only mode');
        return { ok: false, error: '邮件模式为只收，无法发送对话摘要' };
      }
      if (!emailService.enabled) {
        emailService.configure(settings.email);
        await emailService.initSMTP();
        emailService.enabled = true;
      }
      return await emailService.sendConversationSummary(messages, title);
    } catch (e) {
      console.error('[Email] Send conversation error:', e);
      return { ok: false, error: e.message };
    }
  });

  // ---- Web Control IPC ----

  ipcMain.handle('webControl:start', async () => {
    try {
      webControlService.configure(settings.webControl);
      webControlService.workDir = workspacesBaseDir; // fallback; renderer will update when agent workspace is created
      // Wire callbacks
      webControlService.onGetHistory = async () => {
        const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
          const data = loadJSON(path.join(historyDir, f), {});
          return { id: data.id || f.replace('.json', ''), title: data.title || '未命名', date: data.updatedAt || data.createdAt || '' };
        }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      };
      webControlService.onGetConversation = async (id) => {
        const fp = path.join(historyDir, id + '.json');
        if (!fs.existsSync(fp)) return null;
        return loadJSON(fp, null);
      };
      webControlService.onDeleteConversation = async (id) => {
        const fp = path.join(historyDir, id + '.json');
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      };
      webControlService.onNewChat = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:newChat');
        }
        return Date.now().toString();
      };
      webControlService.onSendMessage = async (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:sendMessage', message);
        }
      };
      webControlService.onStopAgent = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:stopAgent');
        }
      };
      webControlService.onApprovalResponse = (approved) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:approvalResponse', approved);
        }
      };
      webControlService.onLoadConversation = (id) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:loadConversation', id);
        }
      };
      const result = await webControlService.start();
      return result;
    } catch (e) {
      console.error('[WebControl] Start error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:stop', async () => {
    try {
      return await webControlService.stop();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:getStatus', () => {
    return { ok: true, running: webControlService.running, port: webControlService.port };
  });

  ipcMain.handle('webControl:hashPassword', async (_, password) => {
    try {
      const hash = await webControlService.hashPassword(password);
      return { ok: true, hash };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:generateTOTP', async () => {
    try {
      return { ok: true, ...(await webControlService.generateTOTPSecret()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:verifyTOTP', (_, code) => {
    try {
      webControlService.configure(settings.webControl);
      const valid = webControlService.verifyTOTP(code);
      return { ok: true, valid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Forward renderer events to web control
  ipcMain.on('webControl:pushMessage', (_, role, content, extra) => {
    if (webControlService.running) webControlService.pushMessage(role, content, extra);
  });
  ipcMain.on('webControl:pushStatus', (_, status) => {
    if (webControlService.running) webControlService.pushStatus(status);
  });
  ipcMain.on('webControl:pushApproval', (_, toolName, args) => {
    if (webControlService.running) webControlService.pushApproval(toolName, args);
  });
  ipcMain.on('webControl:clearApproval', () => {
    if (webControlService.running) webControlService.clearApproval();
  });
  ipcMain.on('webControl:pushToolCall', (_, toolName, args, status, result) => {
    if (webControlService.running) webControlService.pushToolCall(toolName, args, status, result);
  });
  ipcMain.on('webControl:pushConversationSwitch', (_, conversationId) => {
    if (webControlService.running) webControlService.pushConversationSwitch(conversationId);
  });
  ipcMain.on('webControl:pushHistoryMessages', (_, messages) => {
    if (webControlService.running) webControlService.pushHistoryMessages(messages);
  });
  ipcMain.on('webControl:pushTheme', (_, vars) => {
    if (webControlService.running) webControlService.pushTheme(vars);
  });
  ipcMain.on('webControl:pushTarot', (_, card) => {
    if (webControlService.running) webControlService.pushTarot(card);
  });
  ipcMain.on('webControl:pushTitle', (_, title) => {
    if (webControlService.running) webControlService.pushTitle(title);
  });
  ipcMain.on('webControl:setWorkDir', (_, dir) => {
    if (dir) webControlService.workDir = dir;
    console.log('[WebControl] workDir updated to agent workspace:', dir);
  });
  ipcMain.on('webControl:setAvatars', (_, avatars) => {
    webControlService._currentAvatars = avatars;
    if (webControlService.running) webControlService.pushAvatars(avatars);
  });

  // Auto-start email if configured
  if (settings.email.enabled && settings.email.emailUser && settings.email.totpSecret) {
    try {
      const emailMode = settings.email.mode || 'send-receive';
      emailService.configure(settings.email);
      const initChain = async () => {
        if (emailMode === 'send-only' || emailMode === 'send-receive') {
          await emailService.initSMTP();
          console.log('[Email] Auto-start: SMTP connected');
        }
        if (emailMode === 'receive-only' || emailMode === 'send-receive') {
          await emailService.connectIMAP();
          console.log('[Email] Auto-start: IMAP connected');
        }
        emailService.enabled = true;
        if (emailMode !== 'send-only') {
          emailService.onEmailReceived = (email) => {
            console.log('[Email] Auto-poll received:', email.from, email.subject);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('email:received', email);
            }
          };
          emailService.startPolling();
        }
        console.log('[Email] Auto-started email service, mode:', emailMode);
      };
      initChain().catch(e => console.error('[Email] Auto-start failed:', e.message));
    } catch (e) {
      console.error('[Email] Auto-start config error:', e.message);
    }
  }

  // ---- MCP Auto-Connect ----
  try {
    const mcpSettings = getMcpSettings();
    for (const serverConfig of mcpSettings.servers) {
      if (serverConfig.autoConnect) {
        console.log(`[MCP] Auto-connecting to ${serverConfig.name}...`);
        try {
          await startMcpServer(serverConfig);
        } catch (e) {
          console.error(`[MCP] Failed to auto-connect ${serverConfig.name}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error('[MCP] Auto-connect error:', e.message);
  }

  // ---- Web Control Auto-Start ----
  if (settings.webControl.autoStartOnOpen && settings.webControl.passwordHash) {
    try {
      // Manually trigger the start via IPC-like path
      webControlService.configure(settings.webControl);
      webControlService.onGetHistory = async () => {
        const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
          const data = loadJSON(path.join(historyDir, f), {});
          return { id: data.id || f.replace('.json', ''), title: data.title || '未命名', date: data.updatedAt || data.createdAt || '' };
        }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      };
      webControlService.onGetConversation = async (id) => {
        const fp = path.join(historyDir, id + '.json');
        if (!fs.existsSync(fp)) return null;
        return loadJSON(fp, null);
      };
      webControlService.onDeleteConversation = async (id) => {
        const fp = path.join(historyDir, id + '.json');
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      };
      webControlService.onNewChat = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:newChat');
        return Date.now().toString();
      };
      webControlService.onSendMessage = async (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:sendMessage', message);
      };
      webControlService.onStopAgent = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:stopAgent');
      };
      webControlService.onApprovalResponse = (approved) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:approvalResponse', approved);
      };
      webControlService.onLoadConversation = (id) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:loadConversation', id);
      };
      webControlService.start().then(r => {
        console.log('[WebControl] Auto-started:', r.message);
      }).catch(e => console.error('[WebControl] Auto-start failed:', e.message));
    } catch (e) {
      console.error('[WebControl] Auto-start config error:', e.message);
    }
  }
});

// Cleanup MCP servers, serial ports, and web control on app quit
app.on('before-quit', () => {
  for (const [name] of mcpServers) {
    stopMcpServer(name);
  }
  if (webControlService.running) {
    webControlService.stop().catch(() => {});
  }
});
