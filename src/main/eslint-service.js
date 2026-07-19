/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * ESLint service: 内置 ESLint 调用，用于 Code 模式实时显示项目 lint 状态
 * - 自动检测工作区是否为 ESLint 支持的项目（JS/TS/Vue/JSX/TSX 等）
 * - 支持 ESLint v9+ flat config 与 v8 legacy config
 * - 返回结构化诊断结果（文件路径、行号、列号、消息、严重性、规则）
 */

const fs = require('fs');
const path = require('path');

// ESLint 支持的文件扩展名（按 ESLint 默认约定 + TS/JSX 扩展）
const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.vue', '.svelte'
]);

// 判断工作区是否为 ESLint 可检测的项目
// 判定标准：
// 1. 存在 ESLint 配置文件（flat 或 legacy）→ 直接通过
// 2. 否则，存在 package.json 且 devDeps/deps 中含 eslint → 通过
// 3. 否则，工作区内有支持扩展名的源文件 → 通过（使用内置默认规则）
function isProjectLintable(workspacePath) {
  if (!workspacePath) return false;
  try {
    if (!fs.existsSync(workspacePath)) return false;
    const stat = fs.statSync(workspacePath);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }

  // 1. ESLint 配置文件
  const flatConfigs = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];
  const legacyConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];
  for (const f of [...flatConfigs, ...legacyConfigs]) {
    if (fs.existsSync(path.join(workspacePath, f))) return true;
  }

  // 2. package.json 含 eslint 依赖
  try {
    const pj = path.join(workspacePath, 'package.json');
    if (fs.existsSync(pj)) {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.eslint) return true;
    }
  } catch {
    /* ignore */
  }

  // 3. 顶层有支持扩展名的源文件
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        // 排除明显的构建产物
        if (e.name.endsWith('.min.js') || e.name.endsWith('.bundle.js')) continue;
        return true;
      }
    }
  } catch {
    /* ignore */
  }

  return false;
}

// 收集工作区内支持的源文件（限制深度与数量，避免大项目卡死）
// - maxDepth: 递归最大深度（默认 6）
// - maxFiles: 单次扫描上限（默认 500）
// - ignoreDir: 目录名黑名单（node_modules / .git / dist / build / out 等）
function collectLintableFiles(workspacePath, { maxDepth = 6, maxFiles = 500 } = {}) {
  const ignoreDir = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
    '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache',
    'coverage', '.nyc_output', '.vscode', '.idea'
  ]);
  const results = [];

  function walk(dir, depth) {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDir.has(e.name)) continue;
        // 跳过点开头的目录（除了 src 这种？这里统一跳过）
        if (e.name.startsWith('.') && e.name !== '.') continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          if (e.name.endsWith('.min.js') || e.name.endsWith('.bundle.js')) continue;
          results.push(full);
        }
      }
    }
  }

  walk(workspacePath, 0);
  return results;
}

// 将 ESLint 结果转为前端友好的结构
function serializeResults(eslintResults) {
  const out = [];
  for (const r of (eslintResults || [])) {
    for (const m of (r.messages || [])) {
      out.push({
        filePath: r.filePath,
        file: path.basename(r.filePath),
        line: m.line || 0,
        column: m.column || 0,
        endLine: m.endLine || m.line || 0,
        endColumn: m.endColumn || m.column || 0,
        severity: m.severity === 2 ? 'error' : (m.severity === 1 ? 'warning' : 'info'),
        message: m.message || '',
        ruleId: m.ruleId || null,
        source: m.source || null,
      });
    }
  }
  // 排序：error > warning > info，同 severity 按文件+行号
  const sevRank = { error: 0, warning: 1, info: 2 };
  out.sort((a, b) => {
    const s = sevRank[a.severity] - sevRank[b.severity];
    if (s !== 0) return s;
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    return (a.line || 0) - (b.line || 0);
  });
  return out;
}

// ESLint 实例缓存（按工作区路径缓存）
// - 不复用同一 ESLint 实例跨工作区，避免 config load 冲突
const eslintInstanceCache = new Map();

// ESLint 主版本号（用于 API 兼容判断：v9+ 使用 flat config 默认）
const ESLINT_MAJOR = (() => {
  try {
    const pkg = require('eslint/package.json');
    return parseInt(String(pkg.version || '0').split('.')[0]) || 0;
  } catch {
    return 0;
  }
})();

// 内置兜底配置文件路径（无配置文件的 JS/TS 项目使用此配置避免 "Could not find config file" 错误）
// - 使用 ESM 格式（eslint.config.mjs），ESLint v9+ flat config 兼容
// - 写在 Electron userData 目录下（应用专属可写位置，生产环境也能用）
// - 不依赖外部 import（自包含规则集），避免 node_modules 解析路径问题
// - 对 TS/Vue/Svelte 文件需用户工作区自带配置才能正确解析
let _defaultConfigPath = null;
function getDefaultConfigPath() {
  if (_defaultConfigPath) return _defaultConfigPath;
  // 写在 Electron userData 下（生产环境可写）
  let cfgDir;
  try {
    const { app } = require('electron');
    cfgDir = path.join(app.getPath('userData'), 'cibyp-cache');
  } catch {
    // 非 Electron 环境（CLI 测试）— 退回到 cwd 下的临时目录
    cfgDir = path.join(process.cwd(), '.cibyp-cache');
  }
  try { fs.mkdirSync(cfgDir, { recursive: true }); } catch { /* ignore */ }
  const cfgPath = path.join(cfgDir, 'eslint-default.config.mjs');
  // 不 import 任何外部包，避免 ESM 解析失败
  // 提供 @eslint/js recommended 中最常用的规则子集
  const cfgContent = `// Auto-generated by Could I Be Your Partner (CIBYP)
// Default self-contained ESLint flat config — no external imports.
// Used when the workspace has no eslint.config.* to avoid "Could not find config file".
export default [
  {
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        console: 'readonly', process: 'readonly', module: 'readonly',
        require: 'readonly', exports: 'readonly', __dirname: 'readonly',
        __filename: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        WebSocket: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
        HTMLElement: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
        Promise: 'readonly', Set: 'readonly', Map: 'readonly', Symbol: 'readonly',
        globalThis: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly',
      }
    },
    rules: {
      // 错误级
      'no-cond-assign': 'error',
      'no-constant-condition': 'error',
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty-character-class': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-func-assign': 'error',
      'no-inner-declarations': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-regex-spaces': 'error',
      'no-sparse-arrays': 'error',
      'no-undef': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      // 警告级
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-redeclare': 'warn',
      'no-unused-labels': 'warn',
      'no-useless-catch': 'warn',
      'no-with': 'warn',
    }
  }
];
`;
  try {
    fs.writeFileSync(cfgPath, cfgContent, 'utf-8');
  } catch (e) {
    console.warn('[ESLint] Failed to write default config:', e.message);
  }
  _defaultConfigPath = cfgPath;
  return cfgPath;
}

// 检查工作区是否有 ESLint 配置文件
function hasWorkspaceConfig(workspacePath) {
  const flatConfigs = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];
  const legacyConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];
  for (const f of [...flatConfigs, ...legacyConfigs]) {
    if (fs.existsSync(path.join(workspacePath, f))) return true;
  }
  return false;
}

async function getESLintInstance(workspacePath) {
  if (eslintInstanceCache.has(workspacePath)) {
    return eslintInstanceCache.get(workspacePath);
  }
  // 动态 require，避免主进程启动时的开销；ESLint v9+ 导出为 { ESLint }
  const { ESLint } = require('eslint');
  // ESLint v9+ 使用 flat config；v10 移除了顶层 reportUnusedDisableDirectives 选项
  const opts = {
    cwd: workspacePath,
    // 不自动 fix（仅诊断）
    fix: false,
    // 允许无配置文件时使用默认规则集（JS/TS 基础语法）
    errorOnUnmatchedPattern: false,
  };
  if (ESLINT_MAJOR >= 9) {
    // v9+ 中报告未使用禁用指令通过 overrideConfig.linterOptions 配置
    opts.overrideConfig = {
      linterOptions: { reportUnusedDisableDirectives: false },
    };
    // 工作区无配置文件时，使用内置兜底配置（避免 "Could not find config file" 错误）
    if (!hasWorkspaceConfig(workspacePath)) {
      opts.overrideConfigFile = getDefaultConfigPath();
    }
  } else {
    // v8 legacy 选项
    opts.reportUnusedDisableDirectives = false;
    if (!hasWorkspaceConfig(workspacePath)) {
      opts.useEslintrc = false;
      opts.baseConfig = {
        parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        env: { browser: true, node: true, es2022: true },
        rules: {
          'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
          'no-undef': 'warn',
          'no-empty': ['warn', { allowEmptyCatch: true }],
          'no-debugger': 'warn',
          'no-redeclare': 'warn',
        }
      };
    }
  }
  const eslint = new ESLint(opts);
  eslintInstanceCache.set(workspacePath, eslint);
  return eslint;
}

/**
 * 对工作区执行 ESLint 检测
 * @param {string} workspacePath 工作区路径
 * @param {Object} opts
 * @param {string[]} [opts.files] 指定文件列表（可选，默认扫描整个工作区支持文件）
 * @param {number} [opts.maxFiles=500] 单次扫描上限
 * @returns {Promise<{ok, results, summary, error}>}
 */
async function lintWorkspace(workspacePath, opts = {}) {
  if (!workspacePath) {
    return { ok: false, error: '工作区路径为空' };
  }
  if (!isProjectLintable(workspacePath)) {
    return {
      ok: false,
      notLintable: true,
      error: '当前工作区不是 ESLint 支持的项目（无配置文件、无 eslint 依赖、无 JS/TS 源文件）'
    };
  }

  try {
    const eslint = await getESLintInstance(workspacePath);
    let files = Array.isArray(opts.files) && opts.files.length > 0
      ? opts.files
      : collectLintableFiles(workspacePath, { maxFiles: opts.maxFiles || 500 });

    if (files.length === 0) {
      return { ok: true, results: [], summary: { total: 0, errors: 0, warnings: 0, infos: 0, fileCount: 0 } };
    }

    // 如果是单个文件，传字符串；否则传数组
    const results = await eslint.lintFiles(files.length === 1 ? files[0] : files);
    const serialized = serializeResults(results);

    const summary = {
      total: serialized.length,
      errors: serialized.filter(d => d.severity === 'error').length,
      warnings: serialized.filter(d => d.severity === 'warning').length,
      infos: serialized.filter(d => d.severity === 'info').length,
      fileCount: new Set(serialized.map(d => d.filePath)).size,
      scannedFiles: files.length,
    };

    return { ok: true, results: serialized, summary };
  } catch (e) {
    console.error('[ESLint] lint error:', e.message, e.stack);
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * 检测单个文件的 lint 结果（用于编辑器实时显示）
 */
async function lintSingleFile(filePath) {
  if (!filePath) return { ok: false, error: '路径为空' };
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { ok: true, results: [], summary: { total: 0, errors: 0, warnings: 0, infos: 0, fileCount: 0 } };
  }
  const workspacePath = guessWorkspaceRoot(filePath);
  if (!workspacePath) {
    return { ok: false, error: '无法确定工作区根目录' };
  }
  return lintWorkspace(workspacePath, { files: [filePath] });
}

// 猜测文件所属的工作区根目录（向上查找 package.json / eslint.config.*）
function guessWorkspaceRoot(filePath) {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 10; i++) {
    try {
      const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
      const hasEslintConfig = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
        '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json']
        .some(f => fs.existsSync(path.join(dir, f)));
      if (hasPkg || hasEslintConfig) return dir;
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(filePath);
}

// 清除工作区缓存（在工作区切换或配置变更时调用）
function clearCache(workspacePath) {
  if (workspacePath) {
    eslintInstanceCache.delete(workspacePath);
  } else {
    eslintInstanceCache.clear();
  }
}

module.exports = {
  isProjectLintable,
  lintWorkspace,
  lintSingleFile,
  collectLintableFiles,
  clearCache,
  SUPPORTED_EXTENSIONS,
};
