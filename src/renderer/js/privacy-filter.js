/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 隐私信息保护过滤模块（浏览器全局 script）。
 * 在工具调用流程中过滤手机号、证件号、社保号、API Key、SSH 私钥、
 * .env 密钥行、Tor Hidden Service 地址、git key 以及配置文件中的密码 K:V，
 * 防止隐私信息进入 AI 上下文与历史记录。
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

  // 过滤模式（按优先级排列：先替换大块内容，再替换小块，避免局部替换破坏后续匹配）
  const PATTERNS = [
    // SSH / PGP 私钥块（整块替换）
    {
      label: 'SSH私钥',
      re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g
    },
    // 配置文件 K:V（json / yaml / config / ini 等）：键名命中敏感词时替换整段
    {
      label: '密码配置',
      re: /("|')?([A-Za-z_][A-Za-z0-9_-]*)(\1)?[ \t]*[:=][ \t]*["']?([^"'\r\n,}]{1,200})["']?/gi,
      keyIndex: 2,
      keyTest: (k) => SENSITIVE_KEY_RE.test(k)
    },
    // .env 密钥行（KEY=value，键名命中敏感词时替换整行）
    {
      label: '.env密钥',
      re: /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*?)[ \t]*$/gm,
      keyIndex: 1,
      keyTest: (k) => SENSITIVE_KEY_RE.test(k)
    },
    // 带前缀的 API Key / git key（OpenAI、Anthropic、GitHub、GitLab、Slack、AWS 等）
    {
      label: 'API密钥',
      re: /(?<![A-Za-z0-9])(?:sk|pk|rk|ak|vk|whk)-[A-Za-z0-9_-]{10,}|(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{15,}|glptt-[A-Za-z0-9_-]{15,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Za-z0-9])/g
    },
    // 中国居民身份证号（18 位，含出生日期与校验位校验；15 位旧版）
    {
      label: '身份证号',
      re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)|(?<!\d)[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g
    },
    // 美国社保号（SSN）
    {
      label: '社保号',
      re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g
    },
    // Tor Hidden Service (.onion 地址)
    {
      label: 'Tor地址',
      re: /(?<![a-z2-7])[a-z2-7]{16,56}\.onion(?![a-z2-7])/gi
    },
    // 手机号：中国大陆 11 位、美式带区号、国际 E.164（+区号）、通用分隔式
    {
      label: '手机号',
      re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)|(?<!\d)(?:\+?1[- ]?)?\(?[2-9]\d{2}\)?[- ]\d{3}[- ]\d{4}(?!\d)|(?<!\d)\+\d{8,15}(?!\d)|(?<!\d)\d{3}[- .]\d{3,4}[- .]\d{4}(?!\d)/g
    }
  ];

  /**
   * 过滤文本中的隐私信息，替换为占位符。
   * @param {string} text 原始文本
   * @returns {string} 过滤后的文本（非字符串原样返回）
   */
  function filterPrivacyInfo(text) {
    if (typeof text !== 'string' || !text) return text;
    let result = text;
    for (const pat of PATTERNS) {
      result = result.replace(pat.re, (...m) => {
        const key = m[pat.keyIndex || 0];
        if (pat.keyTest && !pat.keyTest(key)) return m[0];
        return pat.label ? `[已过滤:${pat.label}]` : '[已过滤]';
      });
    }
    return result;
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
   * 构造用于写入 AI 上下文的 tool_calls 脱敏副本。
   * 不修改原始 tool_calls（真实执行仍用原始参数）。
   * @param {Array} toolCalls LLM 返回的 tool_calls 数组
   * @param {Object} [options]
   * @param {boolean} [options.maskArgs=true] 敏感键值脱敏
   * @param {boolean} [options.scanTerminal=false] 终端类工具的命令/脚本全文隐私扫描
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
          if (typeof clean[k] === 'string' && clean[k]) clean[k] = filterPrivacyInfo(clean[k]);
        }
      }
      return { ...tc, function: { ...tc.function, arguments: JSON.stringify(clean) } };
    });
  }

  const PrivacyFilter = {
    filterPrivacyInfo,
    filterSensitiveArgs,
    sanitizeToolCallsForContext,
    SENSITIVE_KEY_RE,
    TERMINAL_TEXT_TOOLS
  };

  if (typeof window !== 'undefined') window.PrivacyFilter = PrivacyFilter;
  if (typeof globalThis !== 'undefined') globalThis.PrivacyFilter = PrivacyFilter;
  if (typeof module !== 'undefined' && module.exports) module.exports = PrivacyFilter;
})();
