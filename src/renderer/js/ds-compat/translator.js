/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * DeepSeek Harness → CIBYP 名称/参数/结果翻译器。
 * 纯函数、双环境（渲染进程作为全局脚本加载；主进程 require）。
 *
 * 设计原则（防"夺舍"）：
 * - CIBYP 工具名是模型表面的唯一规范名；dsh 名只在 executeTool 入口解析为别名。
 * - 适配器只做参数/结果形状转换，执行逻辑仍走 CIBYP 自己的实现。
 */

/* global window, module */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DSCompatTranslator = api;
    // 兼容全局函数风格（与 tools-def.js 一致）
    root.resolveDsToolName = api.resolveDsToolName;
    root.adaptDsArgs = api.adaptDsArgs;
    root.adaptDsResult = api.adaptDsResult;
    root.getDsCompatTier = api.getDsCompatTier;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // dsh 标准工具名 → CIBYP 实现名（translated 档）
  const DS_TO_CIBYP_TOOL = {
    read_file: 'readFile',
    write: 'editFile',
    edit: 'editFile',
    bash: 'runShellScriptCode',
    web_search: 'webSearch',
    web_fetch: 'webFetch',
    glob: 'localSearch',
    grep: 'searchInFiles'
  };

  // 参数适配器（dsName → { toCibyp(args), fromCibyp(result) }）
  const ADAPTERS = {
    read_file: {
      toCibyp: (a) => ({ path: a?.path }),
      fromCibyp: (r) => ({ content: r?.content ?? r?.result ?? '' })
    },
    write: {
      toCibyp: (a) => ({ path: a?.path, content: a?.content }),
      fromCibyp: (r) => ({ ok: !!r?.ok })
    },
    edit: {
      toCibyp: (a) => ({
        path: a?.path,
        old_string: a?.old_string,
        new_string: a?.new_string,
        replace_all: a?.replace_all
      }),
      fromCibyp: (r) => ({ ok: !!r?.ok })
    },
    bash: {
      toCibyp: (a) => ({ script: typeof a?.command === 'string' ? a.command : a?.script }),
      fromCibyp: (r) => ({ stdout: r?.output ?? '', stderr: r?.stderr ?? '', ok: !!r?.ok })
    },
    web_search: {
      toCibyp: (a) => ({ query: a?.query }),
      fromCibyp: (r) => ({ results: r?.results ?? r?.result ?? [] })
    },
    web_fetch: {
      toCibyp: (a) => ({ url: a?.url }),
      fromCibyp: (r) => ({ content: r?.content ?? r?.result ?? '' })
    },
    glob: {
      toCibyp: (a) => ({ directory: a?.directory || '.', pattern: a?.pattern, options: a?.options }),
      fromCibyp: (r) => ({ files: r?.files ?? r?.result ?? [] })
    },
    grep: {
      toCibyp: (a) => ({
        paths: Array.isArray(a?.paths) ? a.paths : (a?.path ? [a.path] : [a?.directory || '.']),
        pattern: a?.pattern,
        isRegex: a?.isRegex,
        ignoreCase: a?.ignoreCase
      }),
      fromCibyp: (r) => ({ matches: r?.matches ?? r?.result ?? [] })
    }
  };

  // dsh 已知但无直接 CIBYP 等价实现的工具（declared 档：仅声明 schema，执行报不支持）
  const DS_DECLARED_ONLY = new Set([
    'todo_write', 'task', 'subagent', 'skill', 'plan', 'code_edit',
    'notebook_edit', 'web_read', 'ask_followup_question'
  ]);

  /**
   * 解析 dsh 工具名 → CIBYP 规范名（无映射则原样返回）。
   */
  function resolveDsToolName(name) {
    if (typeof name !== 'string') return name;
    return DS_TO_CIBYP_TOOL[name] || name;
  }

  /** dsh → CIBYP 参数转换；无适配器时原样返回 */
  function adaptDsArgs(dsName, args) {
    const adapter = ADAPTERS[dsName];
    if (!adapter || !adapter.toCibyp) return args;
    try { return adapter.toCibyp(args || {}); } catch { return args; }
  }

  /** CIBYP 结果 → dsh 规范形状；无适配器时原样返回 */
  function adaptDsResult(dsName, cibypResult) {
    const adapter = ADAPTERS[dsName];
    if (!adapter || !adapter.fromCibyp) return cibypResult;
    try { return adapter.fromCibyp(cibypResult || {}); } catch { return cibypResult; }
  }

  /**
   * 兼容档位：translated（有 CIBYP 等价实现）/ declared（仅声明）。
   */
  function getDsCompatTier(dsName) {
    if (DS_TO_CIBYP_TOOL[dsName]) return 'translated';
    if (DS_DECLARED_ONLY.has(dsName)) return 'declared';
    return 'native';
  }

  return {
    DS_TO_CIBYP_TOOL,
    ADAPTERS,
    DS_DECLARED_ONLY,
    resolveDsToolName,
    adaptDsArgs,
    adaptDsResult,
    getDsCompatTier
  };
});
