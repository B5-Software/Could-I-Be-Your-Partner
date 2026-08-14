/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 自动化任务 DSL：图灵完备的提示词构造语言（词法 → 语法 → 解释执行）。
 *
 * - 完全沙箱化：AST 解释器，不暴露 require/process/fs 等宿主能力；
 *   唯一的 I/O 面是宿主注入的 async fetch() 与环境读取 hook。
 * - 执行保护：最大步数 / 调用深度 / 墙钟超时，防死循环。
 * - 语法贴近 JS 子集：let / if / while / for / fn / return / 数组 / 对象 /
 *   字符串插值 / await fetch()。
 */

'use strict';

const MAX_STEPS = 200000;
const MAX_DEPTH = 120;

class DslError extends Error {
  constructor(message, line) {
    super(line != null ? `[DSL 行 ${line}] ${message}` : message);
    this.name = 'DslError';
  }
}

// ---------- 词法 ----------
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  let line = 1;
  const push = (type, value, ln = line) => tokens.push({ type, value, line: ln });
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const start = line;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let s = '';
      while (i < n && /[0-9_]/.test(src[i])) s += src[i++];
      if (src[i] === '.') { s += src[i++]; while (i < n && /[0-9_]/.test(src[i])) s += src[i++]; }
      if (src[i] === 'e' || src[i] === 'E') {
        s += src[i++];
        if (src[i] === '+' || src[i] === '-') s += src[i++];
        while (i < n && /[0-9]/.test(src[i])) s += src[i++];
      }
      push('number', parseFloat(s.replace(/_/g, '')));
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const ln = line;
      let s = '';
      i++;
      const parts = [];
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          const esc = src[i + 1];
          s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          if (s) parts.push({ kind: 'text', value: s });
          s = '';
          i += 2;
          const start = i;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) i++;
          }
          parts.push({ kind: 'expr', value: src.slice(start, i) });
          i++; // skip closing }
          continue;
        }
        s += src[i++];
      }
      if (s || !parts.length) parts.push({ kind: 'text', value: s });
      if (src[i] !== quote) throw new DslError('字符串未闭合', ln);
      i++;
      push('string', parts.length === 1 && parts[0].kind === 'text' ? parts[0].value : { parts }, ln);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let s = '';
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) s += src[i++];
      const kw = ['let', 'if', 'else', 'while', 'for', 'fn', 'return', 'true', 'false', 'null', 'break', 'continue', 'await'].includes(s);
      push(kw ? s : 'ident', s);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '??', '+=', '-=', '=>'].includes(two)) { push(two, two); i += 2; continue; }
    if ('+-*/%<>=!?.,(){}[],;:'.includes(ch)) { push(ch, ch); i++; continue; }
    throw new DslError(`无法识别的字符 "${ch}"`, line);
  }
  push('eof', null);
  return tokens;
}

// ---------- 语法（Pratt + 语句）----------
class Parser {
  constructor(src) {
    this.tokens = tokenize(src);
    this.pos = 0;
  }
  peek(k = 0) { return this.tokens[this.pos + k]; }
  next() { return this.tokens[this.pos++]; }
  expect(type) {
    const t = this.next();
    if (t.type !== type) throw new DslError(`期望 "${type}"，得到 "${t.value ?? t.type}"`, t.line);
    return t;
  }
  match(...types) {
    if (types.includes(this.peek().type)) return this.next();
    return null;
  }

  parse() {
    const body = [];
    while (this.peek().type !== 'eof') body.push(this.statement());
    return { type: 'program', body };
  }

  statement() {
    const t = this.peek();
    if (t.type === 'let') { const s = this.letStmt(); this.match(';'); return s; }
    if (t.type === 'if') return this.ifStmt();
    if (t.type === 'while') return this.whileStmt();
    if (t.type === 'for') return this.forStmt();
    if (t.type === 'fn') return this.fnDecl();
    if (t.type === 'return') return this.returnStmt();
    if (t.type === 'break') { this.next(); this.match(';'); return { type: 'break' }; }
    if (t.type === 'continue') { this.next(); this.match(';'); return { type: 'continue' }; }
    if (t.type === '{') return this.block();
    const stmt = this.assignOrExpr();
    this.match(';');
    return stmt;
  }

  block() {
    this.expect('{');
    const body = [];
    while (this.peek().type !== '}' && this.peek().type !== 'eof') body.push(this.statement());
    this.expect('}');
    return { type: 'block', body };
  }

  letStmt() {
    const t = this.next();
    const name = this.expect('ident').value;
    if (!this.match('=')) throw new DslError('let 需要初始化', t.line);
    const value = this.expression();
    return { type: 'let', name, value };
  }

  assignOrExpr() {
    const target = this.expression();
    if (this.match('=', '+=', '-=')) {
      const op = this.tokens[this.pos - 1].type;
      const value = this.expression();
      return op === '=' ? { type: 'assign', target, value } : { type: 'assign', target, op, value };
    }
    return { type: 'expr', expr: target };
  }

  ifStmt() {
    this.next();
    this.expect('(');
    const test = this.expression();
    this.expect(')');
    const cons = this.statement();
    const alt = this.match('else') ? this.statement() : null;
    return { type: 'if', test, cons, alt };
  }

  whileStmt() {
    this.next();
    this.expect('(');
    const test = this.expression();
    this.expect(')');
    const body = this.statement();
    return { type: 'while', test, body };
  }

  forStmt() {
    this.next();
    this.expect('(');
    const init = this.peek().type === ';' ? null : (this.peek().type === 'let' ? this.letStmt() : this.statement());
    this.expect(';');
    const test = this.peek().type === ';' ? { type: 'literal', value: true } : this.expression();
    this.expect(';');
    const update = this.peek().type === ')' ? null : this.assignOrExpr();
    this.expect(')');
    const body = this.statement();
    return { type: 'for', init, test, update, body };
  }

  fnDecl() {
    this.next();
    const name = this.expect('ident').value;
    this.expect('(');
    const params = [];
    if (this.peek().type !== ')') {
      do { params.push(this.expect('ident').value); } while (this.match(','));
    }
    this.expect(')');
    const body = this.block();
    return { type: 'fn', name, params, body };
  }

  returnStmt() {
    const t = this.next();
    const value = this.peek().type === ';' || this.peek().type === '}' ? { type: 'literal', value: null } : this.expression();
    this.match(';');
    return { type: 'return', value, line: t.line };
  }

  expression() { return this.ternary(); }

  ternary() {
    const cond = this.binary(0);
    if (this.match('?')) {
      const a = this.expression();
      this.expect(':');
      const b = this.expression();
      return { type: 'ternary', cond, a, b };
    }
    return cond;
  }

  binary(minPrec) {
    const PREC = {
      '||': 1, '??': 1, '&&': 2,
      '==': 3, '!=': 3,
      '<': 4, '<=': 4, '>': 4, '>=': 4,
      '+': 5, '-': 5,
      '*': 6, '/': 6, '%': 6
    };
    let left = this.unary();
    while (true) {
      const op = this.peek().type;
      if (!(op in PREC) || PREC[op] <= minPrec) break;
      this.next();
      const right = this.binary(PREC[op]);
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  unary() {
    if (this.match('!', '-')) {
      const op = this.tokens[this.pos - 1].type;
      return { type: 'unary', op, expr: this.unary() };
    }
    if (this.match('await')) {
      return { type: 'await', expr: this.unary() };
    }
    return this.postfix();
  }

  postfix() {
    let node = this.primary();
    while (true) {
      if (this.match('(')) {
        const args = [];
        if (this.peek().type !== ')') {
          do { args.push(this.expression()); } while (this.match(','));
        }
        this.expect(')');
        node = { type: 'call', callee: node, args };
      } else if (this.match('.')) {
        node = { type: 'member', obj: node, prop: this.expect('ident').value };
      } else if (this.match('[')) {
        const key = this.expression();
        this.expect(']');
        node = { type: 'member', obj: node, key };
      } else break;
    }
    return node;
  }

  primary() {
    const t = this.next();
    if (t.type === 'number') return { type: 'literal', value: t.value };
    if (t.type === 'string') return { type: 'string', value: t.value };
    if (t.type === 'true') return { type: 'literal', value: true };
    if (t.type === 'false') return { type: 'literal', value: false };
    if (t.type === 'null') return { type: 'literal', value: null };
    if (t.type === 'ident') return { type: 'ident', name: t.value };
    if (t.type === '(') {
      const e = this.expression();
      this.expect(')');
      return e;
    }
    if (t.type === '[') {
      const items = [];
      if (this.peek().type !== ']') {
        do { items.push(this.expression()); } while (this.match(','));
      }
      this.expect(']');
      return { type: 'array', items };
    }
    if (t.type === '{') {
      const entries = [];
      while (this.peek().type !== '}') {
        let key;
        const k = this.next();
        if (k.type === 'ident') key = k.value;
        else if (k.type === 'string' && typeof k.value === 'string') key = k.value;
        else throw new DslError('对象键必须是标识符或字符串', k.line);
        this.expect(':');
        entries.push({ key, value: this.expression() });
        if (!this.match(',')) break;
      }
      this.expect('}');
      return { type: 'object', entries };
    }
    throw new DslError(`意外的 token "${t.value ?? t.type}"`, t.line);
  }
}

// ---------- 标准库 ----------
function stdlib(host) {
  const api = {
    str: {
      len: (s) => String(s).length,
      upper: (s) => String(s).toUpperCase(),
      lower: (s) => String(s).toLowerCase(),
      trim: (s) => String(s).trim(),
      replace: (s, a, b) => String(s).split(a).join(b),
      split: (s, sep) => String(s).split(sep),
      join: (arr, sep) => arr.map(String).join(sep),
      substr: (s, start, len) => String(s).substr(start, len),
      slice: (s, a, b) => String(s).slice(a, b),
      contains: (s, sub) => String(s).includes(sub),
      startsWith: (s, p) => String(s).startsWith(p),
      endsWith: (s, p) => String(s).endsWith(p),
      repeat: (s, n) => String(s).repeat(Math.max(0, n | 0))
    },
    arr: {
      len: (a) => a.length,
      push: (a, v) => { a.push(v); return a; },
      pop: (a) => a.pop(),
      shift: (a) => a.shift(),
      unshift: (a, v) => { a.unshift(v); return a; },
      join: (a, sep) => a.map(String).join(sep),
      slice: (a, s, e) => a.slice(s, e),
      reverse: (a) => a.slice().reverse(),
      sort: (a) => a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      includes: (a, v) => a.includes(v),
      indexOf: (a, v) => a.indexOf(v)
    },
    num: {
      abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
      min: (...xs) => Math.min(...xs), max: (...xs) => Math.max(...xs),
      toFixed: (x, d) => Number(x).toFixed(d)
    },
    math: {
      pow: Math.pow, sqrt: Math.sqrt, log: Math.log, exp: Math.exp,
      random: Math.random, floor: Math.floor, ceil: Math.ceil, round: Math.round
    },
    time: {
      now: () => Date.now(),
      format: (ts, pattern) => formatTime(ts, pattern)
    },
    json: {
      parse: (s) => JSON.parse(s),
      stringify: (v, space) => JSON.stringify(v, null, space === undefined ? 0 : space)
    },
    text: {
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
      base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
      urlEncode: (s) => encodeURIComponent(String(s)),
      urlDecode: (s) => decodeURIComponent(String(s)),
      capitalize: (s) => { const t = String(s); return t ? t[0].toUpperCase() + t.slice(1) : t; }
    },
    uuid: { v4: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 10)}` },
    env: {
      get: (name) => (host.getEnv ? host.getEnv(String(name)) : undefined),
      has: (name) => (host.getEnv ? host.getEnv(String(name)) !== undefined : false)
    },
    fetch: (url, options) => (host.fetch ? host.fetch(url, options) : Promise.reject(new Error('fetch 未注入'))),
    keys: (o) => Object.keys(o || {}),
    values: (o) => Object.values(o || {}),
    typeOf: (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v),
    toNumber: (v) => Number(v),
    toString: (v) => String(v)
  };
  return api;
}

function formatTime(ts, pattern) {
  const d = new Date(ts === undefined ? Date.now() : ts);
  const pad = (x) => String(x).padStart(2, '0');
  const map = {
    YYYY: d.getFullYear(), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()),
    HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds())
  };
  if (!pattern) return d.toISOString();
  return String(pattern).replace(/YYYY|MM|DD|HH|mm|ss/g, (m) => map[m]);
}

// ---------- 解释器 ----------
class ReturnSignal { constructor(value) { this.value = value; } }
class BreakSignal {}
class ContinueSignal {}

function evaluateProgram(ast, trigger, host, limits = {}) {
  const env = { vars: new Map(), fns: new Map(), parent: null, global: null };
  const api = stdlib(host);
  let steps = 0;
  const deadline = Date.now() + (limits.timeoutMs || 10000);
  const maxSteps = limits.maxSteps || MAX_STEPS;

  const tick = () => {
    steps++;
    if (steps > maxSteps) throw new DslError('超出最大执行步数（疑似死循环）');
    if ((steps & 0x3ff) === 0 && Date.now() > deadline) throw new DslError('执行超时');
  };

  const childEnv = (parent) => ({ vars: new Map(), fns: parent.fns, parent, global: parent.global || parent });

  function lookup(envScope, name) {
    if (envScope.vars.has(name)) return envScope.vars.get(name);
    if (envScope.fns && envScope.fns.has(name)) return envScope.fns.get(name);
    if (envScope.parent) return lookup(envScope.parent, name);
    if (Object.prototype.hasOwnProperty.call(api, name)) return api[name];
    throw new DslError(`未定义的变量 "${name}"`);
  }

  function setVar(envScope, name, value) {
    let s = envScope;
    while (s) {
      if (s.vars.has(name)) { s.vars.set(name, value); return; }
      s = s.parent;
    }
    envScope.vars.set(name, value);
  }

  async function evalNode(node, envScope, depth) {
    if (depth > MAX_DEPTH) throw new DslError('递归过深');
    tick();
    switch (node.type) {
      case 'literal': return node.value;
      case 'string':
        if (typeof node.value === 'string') return node.value;
        return (await Promise.all(node.value.parts.map(async (p) =>
          p.kind === 'text' ? p.value : stringify(await evalNode(parseExpr(p.value), envScope, depth + 1))))).join('');
      case 'ident': return lookup(envScope, node.name);
      case 'array': return await Promise.all(node.items.map((it) => evalNode(it, envScope, depth + 1)));
      case 'object': {
        const out = {};
        for (const e of node.entries) out[e.key] = await evalNode(e.value, envScope, depth + 1);
        return out;
      }
      case 'binary': {
        const a = await evalNode(node.left, envScope, depth + 1);
        const b = await evalNode(node.right, envScope, depth + 1);
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '==': return a === b;
          case '!=': return a !== b;
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
          case '&&': return truthy(a) ? b : a;
          case '||': return truthy(a) ? a : b;
          case '??': return a == null ? b : a;
        }
        break;
      }
      case 'unary': {
        const v = await evalNode(node.expr, envScope, depth + 1);
        return node.op === '!' ? !truthy(v) : -v;
      }
      case 'ternary': {
        const c = await evalNode(node.cond, envScope, depth + 1);
        return evalNode(truthy(c) ? node.a : node.b, envScope, depth + 1);
      }
      case 'member': {
        const obj = await evalNode(node.obj, envScope, depth + 1);
        if (obj == null) throw new DslError('对 null 取值');
        if (node.key !== undefined) {
          const k = await evalNode(node.key, envScope, depth + 1);
          return obj[k];
        }
        return obj[node.prop];
      }
      case 'call': {
        const callee = await evalNode(node.callee, envScope, depth + 1);
        if (typeof callee !== 'function') throw new DslError('尝试调用非函数');
        const args = await Promise.all(node.args.map((a) => evalNode(a, envScope, depth + 1)));
        return await callee(...args);
      }
      case 'await': {
        const v = await evalNode(node.expr, envScope, depth + 1);
        return v && typeof v.then === 'function' ? await v : v;
      }
      case 'block': return await execBody(node.body, childEnv(envScope), depth + 1);
      case 'let': {
        const v = await evalNode(node.value, envScope, depth + 1);
        envScope.vars.set(node.name, v);
        return v;
      }
      case 'assign': {
        const value = await evalNode(node.value, envScope, depth + 1);
        if (node.op) {
          const target = node.target.type === 'ident' ? envScope.vars.get(node.target.name) : await evalNode(node.target, envScope, depth + 1);
          const combined = node.op === '+=' ? target + value : target - value;
          if (node.target.type === 'ident') setVar(envScope, node.target.name, combined);
          else {
            const obj = await evalNode(node.target.obj, envScope, depth + 1);
            obj[node.target.prop ?? (await evalNode(node.target.key, envScope, depth + 1))] = combined;
          }
          return combined;
        }
        if (node.target.type === 'ident') setVar(envScope, node.target.name, value);
        else {
          const obj = await evalNode(node.target.obj, envScope, depth + 1);
          obj[node.target.prop ?? (await evalNode(node.target.key, envScope, depth + 1))] = value;
        }
        return value;
      }
      case 'if': {
        const c = await evalNode(node.test, envScope, depth + 1);
        return truthy(c) ? evalNode(node.cons, envScope, depth + 1) : (node.alt ? evalNode(node.alt, envScope, depth + 1) : null);
      }
      case 'while': {
        let last = null;
        while (truthy(await evalNode(node.test, envScope, depth + 1))) {
          tick();
          try { last = await evalNode(node.body, childEnv(envScope), depth + 1); }
          catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
        }
        return last;
      }
      case 'for': {
        const loopEnv = childEnv(envScope);
        let last = null;
        if (node.init) await evalNode(node.init, loopEnv, depth + 1);
        while (truthy(await evalNode(node.test, loopEnv, depth + 1))) {
          tick();
          try { last = await evalNode(node.body, childEnv(loopEnv), depth + 1); }
          catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
          if (node.update) await evalNode(node.update, loopEnv, depth + 1);
        }
        return last;
      }
      case 'fn': {
        const fn = async (...args) => {
          const fnEnv = childEnv(env);
          node.params.forEach((p, idx) => fnEnv.vars.set(p, args[idx]));
          try {
            return await execBody(node.body.body, fnEnv, depth + 1);
          } catch (e) {
            if (e instanceof ReturnSignal) return e.value;
            throw e;
          }
        };
        envScope.fns.set(node.name, fn);
        return fn;
      }
      case 'return': {
        const v = await evalNode(node.value, envScope, depth + 1);
        throw new ReturnSignal(v);
      }
      case 'break': throw new BreakSignal();
      case 'continue': throw new ContinueSignal();
      case 'expr': return await evalNode(node.expr, envScope, depth + 1);
      default: throw new DslError(`未知节点 ${node.type}`);
    }
  }

  async function execBody(body, envScope, depth) {
    let last = null;
    for (const stmt of body) {
      last = await evalNode(stmt, envScope, depth);
    }
    return last;
  }

  async function run() {
    env.vars.set('trigger', trigger || {});
    env.vars.set('args', (trigger && trigger.params) || {});
    let result;
    try {
      result = await execBody(ast.body, env, 0);
    } catch (e) {
      if (e instanceof ReturnSignal) result = e.value;
      else throw e;
    }
    return stringify(result);
  }

  return run();
}

function parseExpr(src) {
  return new Parser(src).expression();
}

function truthy(v) { return !!v; }
function stringify(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * 编译并执行一段 DSL。
 * @param {string} source
 * @param {object} trigger { kind, params, time, taskId }
 * @param {object} host { getEnv(name), fetch(url, options) }
 * @returns {Promise<string>} 渲染后的提示词
 */
async function runDsl(source, trigger, host) {
  if (!source || !String(source).trim()) return '';
  const ast = new Parser(String(source)).parse();
  return await evaluateProgram(ast, trigger, host || {});
}

module.exports = { runDsl, tokenize, Parser, DslError, parseExpr };
