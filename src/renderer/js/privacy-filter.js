/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 隐私信息保护过滤模块（浏览器全局 script）。
 * 在工具调用流程中过滤手机号、证件号、社保号、API Key、SSH 私钥、
 * .env 密钥行、Tor Hidden Service（地址 + ED25519-V3 私钥）、git key
 * 以及配置文件中的密码 K:V，防止隐私信息进入 AI 上下文与历史记录。
 * 所有类别均可独立开关（categories 配置），并支持可选的“变换逃逸检测”
 *（evasion，默认关闭）：先归一化全角/零宽字符/URL 编码/分隔符变化/Base64
 * 编码等绕过手段，再在归一化文本上重跑基础模式并映射回原文替换。
 *
 * 依赖：无（纯逻辑，可独立加载与测试）。
 */

(function () {
  'use strict';

  // 敏感键名（用于 .env 行、配置 K:V 过滤与工具参数脱敏）
  // 注意用 lookaround 而非 \b：\b 会把 DB_PASSWORD / MY_SECRET 这类
  // 下划线前缀键名排除（下划线是单词字符），导致漏过滤。
  const SENSITIVE_KEY_RE = /(?<![A-Za-z0-9])(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|access[-_]?key|client[-_]?secret|refresh[-_]?token|slack[-_]?token|webhook)(?![A-Za-z0-9])/i;

  // 终端类工具：其命令/脚本文本需要额外做全文隐私扫描（如 curl -H "Authorization: Bearer sk-xxx"）
  const TERMINAL_TEXT_TOOLS = ['runTerminalCommand', 'awaitTerminalCommand', 'runShellScriptCode', 'terminalSendInput', 'terminalAnswerPrompt'];
  const TERMINAL_TEXT_KEYS = ['command', 'script', 'text', 'answer', 'prompt'];

  // 可配置的过滤类别（设置页勾选开关，与 CATEGORY_PATTERNS 的 key 一一对应）
  const CATEGORY_KEYS = ['phone', 'idCard', 'ssn', 'apiKey', 'sshKey', 'env', 'tor', 'gitKey', 'configPassword', 'evasion'];

  // 类别默认开关：categories 中缺失的键按此默认值处理。
  // evasion（变换逃逸检测）默认关闭，其余类别默认全开。
  const DEFAULT_CATEGORIES = {
    phone: true,
    idCard: true,
    ssn: true,
    apiKey: true,
    sshKey: true,
    env: true,
    tor: true,
    gitKey: true,
    configPassword: true,
    evasion: false
  };

  // 各类别过滤模式（按优先级排列：先替换大块内容，再替换小块，避免局部替换破坏后续匹配）
  const CATEGORY_PATTERNS = {
    // SSH / PGP 私钥块（整块替换）
    sshKey: [
      {
        label: 'SSH私钥',
        re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g
      }
    ],
    // .env 密钥行（KEY=value，键名命中敏感词时替换整行）
    env: [
      {
        label: '.env密钥',
        re: /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*?)[ \t]*$/gm,
        keyIndex: 1,
        keyTest: (k) => SENSITIVE_KEY_RE.test(k)
      }
    ],
    // 配置文件 K:V（json / yaml / config / ini 等）：键名命中敏感词时替换整段
    configPassword: [
      {
        label: '密码配置',
        re: /("|')?([A-Za-z_][A-Za-z0-9_-]*)(\1)?[ \t]*[:=][ \t]*["']?([^"'\r\n,}]{1,200})["']?/gi,
        keyIndex: 2,
        keyTest: (k) => SENSITIVE_KEY_RE.test(k)
      }
    ],
    // Tor Hidden Service：.onion 地址 + ED25519-V3 私钥（v3 onion 服务私钥）
    tor: [
      {
        label: 'Tor地址',
        re: /(?<![a-z2-7])[a-z2-7]{16,56}\.onion(?![a-z2-7])/gi
      },
      {
        label: 'Tor私钥',
        re: /(?<![A-Za-z0-9])ED25519-V3:[a-z2-7]{50,60}(?![a-z2-7])/gi
      }
    ],
    // 中国居民身份证号（18 位，含出生日期与校验位校验；15 位旧版）
    idCard: [
      {
        label: '身份证号',
        re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)|(?<!\d)[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g
      }
    ],
    // 社保号 / 社会安全码：美国 SSN + 中国社保卡号（18 位非身份证、A 开头 8 位卡号）
    ssn: [
      {
        label: '社保号',
        re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g
      },
      {
        label: '社保号',
        // 中国社保卡号（18 位数字，非身份证）：前 6 位地区 + 12 位，
        // 负向前瞻排除合法身份证（7-14 位为出生日期的形式）
        re: /(?<!\d)[1-9]\d{5}(?!((19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]))\d{11}[\dXx](?!\d)/g
      },
      {
        label: '社保卡号',
        re: /(?<![A-Za-z0-9])[A-Z]\d{8}(?![A-Za-z0-9])/g
      }
    ],
    // API Key：sk/pk 前缀、AWS、Google（AIzaSy）、Django secret
    apiKey: [
      {
        label: 'API密钥',
        re: /(?<![A-Za-z0-9])(?:sk|pk|rk|ak|vk|whk)-[A-Za-z0-9_-]{10,}|(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Za-z0-9])|(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}(?![A-Za-z0-9])|django-insecure-[A-Za-z0-9_!@#$%^&*()+\-]{20,}/g
      }
    ],
    // git key：GitHub / GitLab / Slack token
    gitKey: [
      {
        label: 'Git密钥',
        re: /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{15,}|glptt-[A-Za-z0-9_-]{15,}|xox[baprs]-[A-Za-z0-9-]{10,}/g
      }
    ],
    // 手机号：中国大陆 11 位、美式带区号、国际 E.164（+区号）、通用分隔式
    phone: [
      {
        label: '手机号',
        re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)|(?<!\d)(?:\+?1[- ]?)?\(?[2-9]\d{2}\)?[- ]\d{3}[- ]\d{4}(?!\d)|(?<!\d)\+\d{8,15}(?!\d)|(?<!\d)\d{3}[- .]\d{3,4}[- .]\d{4}(?!\d)/g
      }
    ],
    // 变换逃逸检测（可选，默认关闭）：归一化后重跑基础模式并映射回原文
    evasion: [
      {
        label: '变换逃逸',
        type: 'evasion'
      }
    ]
  };

  // 补齐 categories 缺失键：显式 false 关闭，显式 true 开启，缺失按默认值
  function normalizeCategories(categories) {
    if (!categories || typeof categories !== 'object') return { ...DEFAULT_CATEGORIES };
    const out = {};
    for (const key of CATEGORY_KEYS) {
      out[key] = categories[key] === false ? false : (categories[key] === true ? true : DEFAULT_CATEGORIES[key]);
    }
    return out;
  }

  // 展平后的全量模式列表（默认开启的类别）
  let ALL_PATTERNS = null;
  function getAllPatterns() {
    if (!ALL_PATTERNS) {
      ALL_PATTERNS = [];
      for (const key of CATEGORY_KEYS) {
        if (DEFAULT_CATEGORIES[key] === false) continue;
        for (const pat of CATEGORY_PATTERNS[key] || []) ALL_PATTERNS.push(pat);
      }
    }
    return ALL_PATTERNS;
  }

  /**
   * 根据启用的类别返回模式列表。
   * categories 为 null/undefined 或缺失键时按 DEFAULT_CATEGORIES 处理。
   * 类别对象中显式 false 的类别被关闭，其余默认开启。
   * @param {Object|null} categories 类别开关 { phone: true, ... }
   * @returns {Array} 模式列表
   */
  function getActivePatterns(categories) {
    const cats = normalizeCategories(categories);
    const out = [];
    for (const key of CATEGORY_KEYS) {
      if (!cats[key]) continue;
      for (const pat of CATEGORY_PATTERNS[key] || []) out.push(pat);
    }
    return out;
  }

  /**
   * 过滤文本中的隐私信息，替换为占位符。
   * @param {string} text 原始文本
   * @param {Object|null} [categories] 启用的类别（默认全开；evasion 默认关）
   * @returns {string} 过滤后的文本（非字符串原样返回）
   */
  function filterPrivacyInfo(text, categories) {
    if (typeof text !== 'string' || !text) return text;
    const patterns = getActivePatterns(categories);
    let result = text;
    for (const pat of patterns) {
      if (pat.type === 'evasion') {
        result = applyEvasionPass(result, categories);
        continue;
      }
      result = result.replace(pat.re, (...m) => {
        const key = m[pat.keyIndex || 0];
        if (pat.keyTest && !pat.keyTest(key)) return m[0];
        return pat.label ? `[已过滤:${pat.label}]` : '[已过滤]';
      });
    }
    return result;
  }

  // ============ 变换逃逸检测（可选，默认关闭） ============
  // 针对全角字符、零宽字符插入、URL 编码、数字间分隔符变化、Base64 编码等
  // 绕过手段：先把文本归一化（全角→半角、去除零宽字符、URL 解码、去除数字间
  // 分隔符），在归一化文本上重跑基础模式，再把匹配区间映射回原文替换；
  // Base64 串则单独解码后按手机号/证件号/社保号校验。

  const EVASION_SEPARATOR_SET = new Set(['-', '_', '.', ' ', '/', '\\', '(', ')', ',', ';', '|']);
  // 至少 12 位 base64 字符（约 9 字节解码内容），可带 0-2 个填充 =；
  // 更短的串由 decoded.length 守卫兜底跳过
  const BASE64_TOKEN_RE = /(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g;

  function isZeroWidthChar(ch) {
    return ch === '\u200B' || ch === '\u200C' || ch === '\u200D' || ch === '\u2060' || ch === '\uFEFF' || ch === '\u00AD';
  }

  // 构建归一化文本与“归一化索引 → 原文索引”映射
  function buildNormalizedMap(text) {
    const t1 = [];
    const m1 = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const code = ch.charCodeAt(0);
      if (isZeroWidthChar(ch)) continue;
      if (ch === '%' && i + 2 < text.length && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        t1.push(String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)));
        m1.push(i);
        i += 2;
        continue;
      }
      if (code >= 0xFF01 && code <= 0xFF5E) {
        t1.push(String.fromCharCode(code - 0xFEE0));
        m1.push(i);
        continue;
      }
      if (code === 0x3000) {
        t1.push(' ');
        m1.push(i);
        continue;
      }
      t1.push(ch);
      m1.push(i);
    }
    const s1 = t1.join('');
    const t2 = [];
    const m2 = [];
    for (let i = 0; i < s1.length; i++) {
      const ch = s1[i];
      if (EVASION_SEPARATOR_SET.has(ch)) {
        const prev = i > 0 ? s1[i - 1] : '';
        const next = i + 1 < s1.length ? s1[i + 1] : '';
        if (/\d/.test(prev) || /\d/.test(next)) continue;
      }
      t2.push(ch);
      m2.push(m1[i]);
    }
    return { normalized: t2.join(''), map: m2 };
  }

  function decodeBase64Strict(token) {
    try {
      if (typeof atob === 'function') return atob(token);
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let out = '';
      let buffer = 0;
      let bits = 0;
      for (let i = 0; i < token.length; i++) {
        const c = token[i];
        if (c === '=') break;
        const idx = chars.indexOf(c);
        if (idx < 0) return null;
        buffer = (buffer << 6) | idx;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out += String.fromCharCode((buffer >> bits) & 0xff);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  function isPrintableAscii(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))) return false;
    }
    return true;
  }

  // Base64 编码的敏感数字串（手机号/证件号/社保号）整段替换
  function maskBase64Tokens(text, categories) {
    const cats = normalizeCategories(categories);
    return text.replace(BASE64_TOKEN_RE, (...m) => {
      const token = m[0];
      const offset = m[2];
      const prefix = text.slice(Math.max(0, offset - 16), offset);
      if (/base64,\s*$/i.test(prefix)) return token;
      if (token.length % 4 !== 0) return token;
      const decoded = decodeBase64Strict(token);
      if (!decoded || !isPrintableAscii(decoded) || decoded.length < 6) return token;
      for (const key of ['phone', 'idCard', 'ssn']) {
        if (cats[key] === false) continue;
        const only = {
          phone: false, idCard: false, ssn: false, apiKey: false,
          sshKey: false, env: false, tor: false, gitKey: false,
          configPassword: false, [key]: true
        };
        if (filterPrivacyInfo(decoded, only) !== decoded) {
          return `[已过滤:${CATEGORY_PATTERNS[key][0].label}]`;
        }
      }
      return token;
    });
  }

  // 在归一化文本上收集所有启用类别匹配的区间（归一化坐标）
  function collectSensitiveSpans(normalized, categories) {
    const cats = normalizeCategories(categories);
    const spans = [];
    for (const key of CATEGORY_KEYS) {
      if (key === 'evasion' || cats[key] === false) continue;
      for (const pat of CATEGORY_PATTERNS[key] || []) {
        if (pat.type === 'evasion' || !pat.re) continue;
        const re = pat.re;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(normalized)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          const k = m[pat.keyIndex || 0];
          if (pat.keyTest && !pat.keyTest(k)) continue;
          spans.push({ start: m.index, end: m.index + m[0].length, label: pat.label || '敏感信息' });
        }
      }
    }
    return spans;
  }

  // 逃逸检测主流程：先 Base64 整段替换，再归一化扫描并映射回原文替换
  function applyEvasionPass(text, categories) {
    let out = maskBase64Tokens(text, categories);
    const { normalized, map } = buildNormalizedMap(out);
    if (normalized === out) return out;
    const spans = collectSensitiveSpans(normalized, categories);
    if (!spans.length) return out;
    spans.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of spans) {
      if (merged.length && s.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
      } else {
        merged.push({ start: s.start, end: s.end, label: s.label });
      }
    }
    for (let i = merged.length - 1; i >= 0; i--) {
      const { start, end, label } = merged[i];
      const oStart = map[start];
      const oEnd = map[Math.min(end - 1, map.length - 1)] + 1;
      out = out.slice(0, oStart) + `[已过滤:${label}]` + out.slice(oEnd);
    }
    return out;
  }

  /**
   * 递归脱敏工具参数对象：键名命中敏感词的字符串值替换为占位符。
   * 返回全新对象，不影响原始参数（真实执行仍用原始 args）。
   * @param {*} args 工具参数
   * @returns {*} 脱敏后的参数副本
   */
  function filterSensitiveArgs(args) {
    if (Array.isArray(args)) return args.map(filterSensitiveArgs);
    if (!args || typeof args !== 'object') return args;
    const out = {};
    for (const k of Object.keys(args)) {
      const v = args[k];
      if (typeof v === 'string' && SENSITIVE_KEY_RE.test(k)) {
        out[k] = v ? '[已过滤]' : v;
      } else if (typeof v === 'object' && v !== null) {
        out[k] = filterSensitiveArgs(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /**
   * 递归过滤工具结果用于 UI 展示：字符串值做隐私过滤，保留结构。
   * 多模态图片 data URL（imageUrl 字段 / data: 开头）跳过，避免破坏图片数据。
   * @param {*} result 工具原始返回
   * @param {Object|null} [categories] 启用的类别
   * @returns {*} 过滤后的展示副本
   */
  function filterToolResult(result, categories) {
    if (typeof result === 'string') return filterPrivacyInfo(result, categories);
    if (Array.isArray(result)) return result.map(v => filterToolResult(v, categories));
    if (!result || typeof result !== 'object') return result;
    const out = {};
    for (const k of Object.keys(result)) {
      const v = result[k];
      if (k === 'imageUrl' || (typeof v === 'string' && v.startsWith('data:'))) {
        out[k] = v; // 多模态 base64 图片跳过（过滤会破坏图片数据且无隐私文本）
      } else if (typeof v === 'string') {
        out[k] = filterPrivacyInfo(v, categories);
      } else if (typeof v === 'object' && v !== null) {
        out[k] = filterToolResult(v, categories);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /**
   * 构造用于写入 AI 上下文的 tool_calls 脱敏副本。
   * 不修改原始 tool_calls（真实执行仍用原始参数）。
   * @param {Array} toolCalls LLM 返回的 tool_calls 数组
   * @param {Object} [options]
   * @param {boolean} [options.maskArgs=true] 敏感键值脱敏
   * @param {boolean} [options.scanTerminal=false] 终端类工具的命令/脚本全文隐私扫描
   * @param {Object|null} [options.categories] 启用的过滤类别
   * @returns {Array} 脱敏后的副本
   */
  function sanitizeToolCallsForContext(toolCalls, options = {}) {
    const maskArgs = options.maskArgs !== false;
    const scanTerminal = options.scanTerminal === true;
    if (!Array.isArray(toolCalls)) return toolCalls;
    return toolCalls.map(tc => {
      if (!tc || !tc.function) return tc;
      let args;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      let clean = maskArgs ? filterSensitiveArgs(args) : args;
      if (scanTerminal && TERMINAL_TEXT_TOOLS.includes(tc.function.name) && clean && typeof clean === 'object') {
        for (const k of TERMINAL_TEXT_KEYS) {
          if (typeof clean[k] === 'string' && clean[k]) clean[k] = filterPrivacyInfo(clean[k], options.categories || null);
        }
      }
      return { ...tc, function: { ...tc.function, arguments: JSON.stringify(clean) } };
    });
  }

  const PrivacyFilter = {
    CATEGORY_KEYS,
    DEFAULT_CATEGORIES,
    filterPrivacyInfo,
    filterSensitiveArgs,
    filterToolResult,
    sanitizeToolCallsForContext,
    SENSITIVE_KEY_RE,
    TERMINAL_TEXT_TOOLS
  };

  if (typeof window !== 'undefined') window.PrivacyFilter = PrivacyFilter;
  if (typeof globalThis !== 'undefined') globalThis.PrivacyFilter = PrivacyFilter;
  if (typeof module !== 'undefined' && module.exports) module.exports = PrivacyFilter;
})();
