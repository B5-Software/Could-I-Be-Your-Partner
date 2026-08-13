/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 纯函数数学/统计工具集：高精度计算、进制转换、复数、矩阵/向量、
 * 方程求解、分布、组合数学与分数进制转换。无主进程状态依赖。
 */

'use strict';

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


module.exports = {
  gcdBigInt, normalizeRational, parseExactNumber, addRational, subRational, mulRational,
  divRational, powRational, modRational, toExactFractionString, toDecimalString,
  normalizeCalcExpression, tokenizeCalcExpression, toRpn, evaluateCalcExpression,
  parseStrictInteger, absBigInt, gcdBigIntAbs, factorInteger, calcGcdLcm,
  parseBaseBigInt, convertBase, calcFactorial, ensureFiniteNumber, parseComplex,
  cAdd, cSub, cMul, cDiv, cAbs, cArg, cConj, cPowInt, complexMath,
  normalizeMatrix, matrixAddSub, matrixMul, matrixTranspose, matrixDeterminant,
  matrixInverse, matrixRank, matrixMath, normalizeVector, assertSameDim, vectorDot,
  vectorCross, vectorMath, formatInterval, solveInequality, solveLinearSystem,
  polyEvalComplex, solvePolynomial, erfApprox, combBigInt, distributionCalc,
  combinatorics, parseBaseDigit, bigIntToBase, parseBaseFractionToRational,
  rationalToBaseString, fractionBaseConvert
};
