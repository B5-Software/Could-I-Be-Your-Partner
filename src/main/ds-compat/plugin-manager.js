/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * DeepSeek 插件管理器：安装/卸载/启停/配置 + 清单存储（plugins.json）。
 * 插件目录：<dataDir>/plugins/<id>/
 *   - 本地目录安装：拷贝源码（跳过 node_modules/.git）
 *   - npm/GitHub/tgz：npm CLI 安装（需要网络）
 * 依赖 shim：把 CIBYP 自研的 @deepseek-ai/dsh-tools / cordis shim 与
 * 真实 schemastery 以 symlink 放进插件的 node_modules，实现零配置离线兼容。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { PluginHost } = require('./plugin-host');

const SHIMS = {
  '@deepseek-ai/dsh-tools': path.join(__dirname, 'shims', 'dsh-tools'),
  '@deepseek-ai/cordis': path.join(__dirname, 'shims', 'cordis'),
  '@deepseek-ai/schemastery': path.join(__dirname, '..', '..', '..', 'node_modules', '@deepseek-ai', 'schemastery')
};

// ---- dsh.bundle.patch 解析 ----
// 受限 !!js 求值：只支持 process.env.X / process.platform / process.cwd() /
// 字面量 / ?? / ?: / + 拼接（官方补丁文件里的全部形态）。
function evalJsPatchExpr(src) {
  const s = String(src).trim();
  let i = 0;
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const parsePrimary = () => {
    skipWs();
    if (s.startsWith('process.env.', i)) {
      i += 'process.env.'.length;
      let name = '';
      while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) name += s[i++];
      return process.env[name];
    }
    if (s.startsWith('process.platform', i)) { i += 'process.platform'.length; return process.platform; }
    if (s.startsWith('process.cwd()', i)) { i += 'process.cwd()'.length; return process.cwd(); }
    if (s.startsWith('undefined', i)) { i += 9; return undefined; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      let out = '';
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && s[i + 1] === q) { out += q; i += 2; } else out += s[i++];
      }
      i++;
      return out;
    }
    if (/[-0-9]/.test(s[i] || '')) {
      let num = '';
      if (s[i] === '-') num += s[i++];
      while (i < s.length && /[0-9.]/.test(s[i])) num += s[i++];
      return parseFloat(num);
    }
    if (s[i] === '(') {
      i++;
      const v = parseExpr();
      skipWs();
      if (s[i] === ')') i++;
      return v;
    }
    throw new Error(`不支持的 !!js 片段: ${src}`);
  };
  const parseConcat = () => {
    let v = parsePrimary();
    skipWs();
    while (s[i] === '+') {
      i++;
      v = String(v) + String(parsePrimary());
      skipWs();
    }
    return v;
  };
  const parseOr = () => {
    let v = parseConcat();
    skipWs();
    while (s.startsWith('??', i)) {
      i += 2;
      const r = parseConcat();
      v = v == null ? r : v;
      skipWs();
    }
    return v;
  };
  const parseExpr = () => {
    let v = parseOr();
    skipWs();
    if (s.startsWith('===', i) || s.startsWith('==', i)) {
      const op = s.startsWith('===', i) ? 3 : 2;
      i += op;
      const r = parseOr();
      v = op === 3 ? v === r : v == r;
      skipWs();
    }
    if (s[i] === '?') {
      i++;
      const a = parseExpr();
      skipWs();
      if (s[i] === ':') i++;
      const b = parseExpr();
      return v ? a : b;
    }
    return v;
  };
  const out = parseExpr();
  skipWs();
  if (i !== s.length) throw new Error(`无法完整解析 !!js: ${src}`);
  return out;
}

const JS_EXPR_TYPE = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => ({ __jsExpr: data })
});
const BUNDLE_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPR_TYPE]);

function evaluatePatchValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '__jsExpr')) {
    return evalJsPatchExpr(value.__jsExpr);
  }
  if (Array.isArray(value)) return value.map(evaluatePatchValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = evaluatePatchValue(v);
    return out;
  }
  return value;
}

/** 读取并解析插件的 dsh.bundle.patch（YAML 组合补丁）。 */
function readBundlePatch(installDir, pkg) {
  const patchRel = pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  if (typeof patchRel !== 'string') return { rows: [] };
  const patchFile = path.resolve(installDir, patchRel);
  if (!fs.existsSync(patchFile)) return { file: patchRel, rows: [] };
  const doc = yaml.load(fs.readFileSync(patchFile, 'utf8'), { schema: BUNDLE_YAML_SCHEMA });
  const rows = [];
  for (const item of Array.isArray(doc) ? doc : []) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.insert)) {
      for (const row of item.insert) {
        if (row && row.id) rows.push({
          id: row.id,
          name: row.name || row.id,
          config: evaluatePatchValue(row.config || {}),
          disabled: false
        });
      }
    } else if (item.id) {
      rows.push({
        id: item.id,
        name: item.name || item.id,
        config: evaluatePatchValue(item.config || {}),
        disabled: !!item.disabled
      });
    }
  }
  return { file: patchRel, rows };
}

/**
 * 修复旧版安装器造成的 react 覆盖坏状态：
 * 旧合并逻辑曾把平铺的 react@18 覆盖进插件根目录，导致 Ink 的
 * `react/compiler-runtime` 子路径丢失。这里用 npm pack 直接解压
 * react 19.2.x 到插件根，不经过 npm 重解析（避免连带剪掉 peer 依赖）。
 */
function repairReactRuntime(installDir, pkg) {
  const reactDir = path.join(installDir, 'node_modules', 'react');
  const reactJson = path.join(reactDir, 'package.json');
  if (!fs.existsSync(reactJson)) return false;
  let reactPkg;
  try { reactPkg = JSON.parse(fs.readFileSync(reactJson, 'utf8')); } catch { return false; }
  const hasCompilerRuntime = reactPkg.exports && reactPkg.exports['./compiler-runtime'];
  if (hasCompilerRuntime) return false;
  const want = pkg && pkg.dependencies && pkg.dependencies.react;
  if (typeof want !== 'string' || !/^[\^~]?19(\.|$)/.test(want)) return false;
  const packDir = fs.mkdtempSync(path.join(installDir, '.react-repair-'));
  try {
    const r = spawnSync('npm', ['pack', 'react@' + want, '--pack-destination', packDir], {
      encoding: 'utf8', timeout: 120000, shell: process.platform === 'win32', windowsHide: true
    });
    const m = String(r.stdout || '').match(/react-\d+\.\d+\.\d+\.tgz/);
    if (r.status !== 0 || !m) return false;
    const tgz = path.join(packDir, m[0]);
    fs.rmSync(reactDir, { recursive: true, force: true });
    fs.mkdirSync(reactDir, { recursive: true });
    const x = spawnSync('tar', ['-xzf', tgz, '-C', reactDir, '--strip-components=1'], {
      encoding: 'utf8', timeout: 60000, windowsHide: true
    });
    if (x.status !== 0) return false;
    const fixed = JSON.parse(fs.readFileSync(reactJson, 'utf8'));
    return !!(fixed.exports && fixed.exports['./compiler-runtime']);
  } catch (e) {
    console.warn('[DS Plugins] react 修复失败:', e.message);
    return false;
  } finally {
    try { fs.rmSync(packDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * 交互式终端插件（TUI 前端门）检测：入口树中出现
 * process.stdout.isTTY 守卫 + render/ink 痕迹即判定。
 * CIBYP 是 GUI 宿主，跳过 apply：既不在用户终端渲染 ANSI，
 * 也不会因常驻事件循环触发挂起超时。
 */
function isInteractiveTuiPlugin(dir) {
  try {
    let hasTty = false;
    let hasRender = false;
    const walk = (d, depth) => {
      if (depth > 3 || (hasTty && hasRender)) return;
      for (const name of fs.readdirSync(d)) {
        if (hasTty && hasRender) return;
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (/\.(js|mjs|cjs)$/.test(name)) {
          const s = fs.readFileSync(p, 'utf8');
          if (s.includes('process.stdout.isTTY')) hasTty = true;
          if (s.includes('render(') || s.includes('ink')) hasRender = true;
        }
      }
    };
    walk(dir, 0);
    return hasTty && hasRender;
  } catch {
    return false;
  }
}

/**
 * 异步执行 npm（不再使用 spawnSync：安装可能耗时数分钟，同步等待会
 * 阻塞主进程事件循环，导致整个窗口无响应）。
 * @returns {Promise<{status: number|null, error: Error|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function runNpmAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(opts.cmd || 'npm', args, {
      env: opts.env || process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const emit = (chunk, isErr) => {
      const text = String(chunk || '');
      if (isErr) stderr += text; else stdout += text;
      if (typeof opts.onOutput === 'function') {
        const line = text.replace(/\r?\n$/, '').trim();
        if (line) opts.onOutput({ type: 'npm', line });
      }
    };
    child.stdout.on('data', (c) => emit(c, false));
    child.stderr.on('data', (c) => emit(c, true));
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, Math.max(5000, opts.timeout || 300000));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, error: e, stdout, stderr, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, error: null, stdout, stderr, timedOut });
    });
  });
}

class PluginManager {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.pluginsDir = path.join(dataDir, 'plugins');
    this.manifestPath = path.join(dataDir, 'plugins.json');
    this.host = new PluginHost({
      skills: options.skills || null,
      transport: options.transport || null,
      getSettings: options.getSettings || null,
      applyTimeoutMs: options.applyTimeoutMs || null
    });
    this.plugins = [];
  }

  /** 渲染进程会话元数据同步到宿主 agents/sessions seam。 */
  async syncAgents(entries) {
    await this.host.init();
    if (this.host.agentsService) {
      this.host.agentsService.sync(Array.isArray(entries) ? entries : []);
    }
  }

  init() {
    try { fs.mkdirSync(this.pluginsDir, { recursive: true }); } catch { /* ignore */ }
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8')); } catch { /* ignore */ }
    this.plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
    return this;
  }

  save() {
    try {
      fs.writeFileSync(this.manifestPath, JSON.stringify({ plugins: this.plugins }, null, 2), 'utf-8');
    } catch (e) {
      throw new Error(`保存插件清单失败: ${e.message}`);
    }
  }

  _slug(name) {
    return String(name || 'plugin')
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/[/\\]+/g, '-')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'plugin';
  }

  _readPackage(dir) {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) throw new Error('插件目录缺少 package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (!pkg.name) throw new Error('package.json 缺少 name');
    return pkg;
  }

  _resolveEntry(dir, pkg) {
    const candidates = [];
    if (typeof pkg.main === 'string') candidates.push(pkg.main);
    if (pkg.exports && typeof pkg.exports === 'object' && pkg.exports['.']) {
      const exp = pkg.exports['.'];
      if (typeof exp === 'string') candidates.push(exp);
      else if (exp && (typeof exp.import === 'string' || typeof exp.default === 'string' || typeof exp.require === 'string')) {
        candidates.push(exp.import || exp.default || exp.require);
      }
    }
    candidates.push('lib/index.js', 'lib/index.mjs', 'dist/index.js', 'index.js', 'index.mjs');
    for (const c of candidates) {
      const full = path.resolve(dir, c);
      if (fs.existsSync(full)) return full;
    }
    throw new Error('找不到插件入口（main/exports/index）');
  }

  _ensureShims(installDir) {
    const nm = path.join(installDir, 'node_modules');
    const scope = path.join(nm, '@deepseek-ai');
    try { fs.mkdirSync(scope, { recursive: true }); } catch { /* ignore */ }
    for (const [name, target] of Object.entries(SHIMS)) {
      const dest = path.join(scope, name.replace('@deepseek-ai/', ''));
      try {
        // cordis 必须强制指向 CIBYP shim：npm 安装会顺带装真实的 cordis peer，
        // 若任其存在，插件的 Context/Service 会与宿主不同实例，class extends Service
        // 的 instanceof 判断即失效。其余包（dsh-tools/schemastery）优先用真实实现，
        // 覆盖范围更广。
        if (name === '@deepseek-ai/cordis' && fs.existsSync(dest)) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
        if (!fs.existsSync(dest)) this._linkOrCopy(target, dest);
      } catch { /* ignore：权限或平台限制 */ }
    }
  }

  _linkOrCopy(target, dest) {
    try {
      fs.symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir');
      return;
    } catch { /* Windows 无 symlink 权限时回退复制 */ }
    try {
      fs.cpSync(target, dest, { recursive: true, dereference: true });
    } catch { /* ignore */ }
  }

  /** 从安装 spec 中提取包名（npm/github/tgz/git URL 均适用）。 */
  _parseSpecName(spec) {
    let s = String(spec || '').trim()
      .replace(/^npm:/, '')
      .replace(/^github:/, '')
      .replace(/^git\+?/, '')
      .replace(/\.git(#.*)?$/, (m, hash) => hash || '');
    s = s.split(/[?#]/)[0];
    if (s.startsWith('@')) {
      const parts = s.split('/');
      if (parts.length >= 2) return `${parts[0]}/${parts[1].split('@')[0]}`;
    }
    return s.split('/').pop().split('@')[0] || s;
  }

  /**
   * 在 npm 安装产物中定位真正的插件包目录。
   * 优先读取 npm --save 写入 tmpDir/package.json 的根依赖名（GitHub 仓库名
   * 与包名不一致时也准确）；其次按 spec 名做大小写不敏感匹配；最后退化为
   * “唯一候选”。
   */
  _findInstalledPkg(tmpDir, spec) {
    const nm = path.join(tmpDir, 'node_modules');
    if (!fs.existsSync(nm)) return null;
    const candidates = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (!st.isDirectory()) continue;
        if (name.startsWith('@')) { walk(full); continue; }
        if (name === '.bin') continue;
        if (fs.existsSync(path.join(full, 'package.json'))) candidates.push(full);
      }
    };
    walk(nm);
    if (!candidates.length) return null;
    const byName = new Map();
    for (const c of candidates) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8'));
        if (p && p.name) byName.set(p.name, c);
      } catch { /* ignore */ }
    }
    try {
      const rootPkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
      const deps = rootPkg.dependencies || {};
      for (const key of Object.keys(deps)) {
        if (byName.has(key)) return byName.get(key);
      }
    } catch { /* ignore */ }
    const wanted = this._parseSpecName(spec);
    const named = candidates.filter((c) => {
      try {
        return String(JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8')).name || '').toLowerCase() === wanted.toLowerCase();
      } catch { return false; }
    });
    if (named.length) return named[0];
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * 安装插件。source: { type: 'local'|'npm'|'github'|'tgz', ref }
   */
  async install(source, hooks = {}) {
    const type = source?.type || 'local';
    const ref = String(source?.ref || '').trim();
    if (!ref) throw new Error('缺少安装来源');
    const progress = (payload) => {
      if (typeof hooks.onProgress === 'function') {
        try { hooks.onProgress(payload); } catch { /* ignore */ }
      }
    };
    progress({ stage: 'start', source: type, ref });
    let installDir = null;
    let pkg = null;

    if (type === 'local') {
      progress({ stage: 'copy', source: type });
      const srcDir = path.resolve(ref);
      if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) throw new Error('本地插件目录不存在');
      pkg = this._readPackage(srcDir);
      const id = this._slug(pkg.name);
      if (this.plugins.some(p => p.id === id)) throw new Error(`插件已安装：${id}`);
      installDir = path.join(this.pluginsDir, id);
      fs.mkdirSync(installDir, { recursive: true });
      this._copyDir(srcDir, installDir);
    } else {
      // npm / github / tgz：先装到一个临时定位目录再解析
      progress({ stage: 'npm', source: type });
      const tmpDir = fs.mkdtempSync(path.join(this.pluginsDir, '.tmp-'));
      const spec = type === 'npm' ? ref : (type === 'github' ? `github:${ref.replace(/^github:/, '')}` : ref);
      // 清洗环境：宿主可能携带 npm_config_allow_scripts（例如从 opencode 启动），
      // 在项目级（--prefix）安装中会触发 EALLOWSCRIPTS 硬错误。
      const npmEnv = { ...process.env };
      delete npmEnv.npm_config_allow_scripts;
      delete npmEnv.npm_config_allow_scripts_pending;
      delete npmEnv.npm_config_strict_allow_scripts;
      // 使用默认 --save：npm 会把根依赖名写入 tmpDir/package.json，
      // 供 _findInstalledPkg 精确定位（GitHub 仓库名 ≠ 包名时同样可靠）。
      const baseArgs = ['install', '--prefix', tmpDir, '--ignore-scripts', '--no-audit', '--no-fund'];
      const runNpm = (extra) => runNpmAsync([...baseArgs, ...extra, spec], {
        env: npmEnv, timeout: 300000, onOutput: (p) => progress({ stage: 'npm-line', source: type, ...p })
      });
      let r = runNpm([]);
      r = await r;
      // npm ≥12 默认禁用 git 依赖（allow-git=none）。放开“根依赖”的 git 抓取
      // 后重试；传递性 git 依赖仍被禁止，保持安全默认。
      if (r.status !== 0 && /EALLOWGIT/.test(String(r.stderr || r.stdout || ''))) {
        progress({ stage: 'npm', source: type, line: 'npm ≥12 默认禁用 git 依赖，放开根依赖后重试…' });
        r = await runNpm(['--allow-git=root']);
      }
      if (r.status !== 0) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        const detail = r.error
          ? `${r.error.message}${r.timedOut ? '（超时）' : ''}`
          : (r.timedOut ? '安装超时' : String(r.stderr || r.stdout || ''));
        throw new Error(`npm 安装失败: ${detail.slice(-600)}`);
      }
      // 找到实际包目录
      progress({ stage: 'locate', source: type });
      const found = this._findInstalledPkg(tmpDir, spec);
      if (!found || !fs.existsSync(path.join(found, 'package.json'))) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error('npm 安装后未找到插件包');
      }
      pkg = this._readPackage(found);
      const id = this._slug(pkg.name);
      if (this.plugins.some(p => p.id === id)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(`插件已安装：${id}`);
      }
      installDir = path.join(this.pluginsDir, id);
      progress({ stage: 'finalize', source: type, line: `安装依赖与 shim（${id}）…` });
      fs.renameSync(found, installDir);
      // 把 npm 装好的依赖（peerDependencies 等）一并搬进插件目录，
      // 否则插件移动后 @deepseek-ai/dsh-llm 等运行期依赖会随 tmpDir 一起被删。
      const tmpNm = path.join(tmpDir, 'node_modules');
      if (fs.existsSync(tmpNm)) {
        // 合并策略：插件目录可能自带嵌套 node_modules（npm 为它嵌套的
        // 版本敏感依赖，如 react），绝不能被 peer 平铺覆盖，否则会出现
        // react/compiler-runtime 这类子路径丢失。这里只补充缺失的依赖。
        const destNm = path.join(installDir, 'node_modules');
        fs.mkdirSync(destNm, { recursive: true });
        const moveIn = (src, dest) => {
          try { fs.renameSync(src, dest); }
          catch { try { fs.cpSync(src, dest, { recursive: true }); } catch { /* ignore */ } }
        };
        for (const name of fs.readdirSync(tmpNm)) {
          const s = path.join(tmpNm, name);
          const d = path.join(destNm, name);
          if (name === '@deepseek-ai') {
            if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); }
            for (const inner of fs.readdirSync(s)) {
              const si = path.join(s, inner);
              const di = path.join(d, inner);
              if (!fs.existsSync(di)) moveIn(si, di);
            }
            continue;
          }
          if (!fs.existsSync(d)) moveIn(s, d);
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    const entry = this._resolveEntry(installDir, pkg);
    this._ensureShims(installDir);
    // dsh.bundle.patch 流程：解析官方组合补丁（rows/config/disabled + 受限 !!js
    // 求值），作为 CIBYP 的组合元数据；依赖解析维持 npm 默认（真实 peer 自动安装，
    // 实测 react 等嵌套版本在官方仓库中已自洽，无需 legacy-peer-deps）。
    const bundlePatch = readBundlePatch(installDir, pkg);
    // 自修复旧安装器覆盖 react 的坏状态（compiler-runtime 子路径丢失）
    if (repairReactRuntime(installDir, pkg)) {
      progress({ stage: 'finalize', source: type, line: '已修复 react 版本漂移（compiler-runtime）' });
    }
    // 补丁中属于本插件自身的行 → 作为默认配置种子
    let config = {};
    const selfRow = bundlePatch.rows.find(r => r.name === pkg.name || r.id === this._slug(pkg.name));
    if (selfRow && selfRow.config && typeof selfRow.config === 'object') config = selfRow.config;
    const record = {
      id: this._slug(pkg.name),
      name: pkg.name,
      version: pkg.version || '0.0.0',
      description: pkg.description || '',
      source: { type, ref },
      installDir,
      entry,
      config,
      bundlePatch: { file: bundlePatch.file || null, rows: bundlePatch.rows },
      enabled: false, // 默认禁用，需用户显式启用（安全）
      compatTier: 'native',
      compatIssues: [],
      toolCount: 0
    };
    this.plugins.push(record);
    this.save();
    return this._public(record);
  }

  _copyDir(src, dest) {
    for (const name of fs.readdirSync(src)) {
      if (name === 'node_modules' || name === '.git') continue;
      const s = path.join(src, name);
      const d = path.join(dest, name);
      const st = fs.statSync(s);
      if (st.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        this._copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  async refreshPlugin(id) {
    const rec = this.plugins.find(p => p.id === id);
    if (!rec) return { ok: false, error: `插件不存在：${id}` };
    try {
      if (isInteractiveTuiPlugin(rec.installDir)) {
        await this.host.unloadPlugin(id);
        rec.tools = [];
        rec.toolCount = 0;
        rec.compatIssues = ['交互式终端插件（TUI 前端门）：CIBYP GUI 不渲染其终端界面，已跳过加载'];
        this.save();
        return { ok: true, plugin: this._public(rec) };
      }
      if (rec.enabled) {
        const res = await this.host.loadPlugin(id, rec.entry, { name: rec.name, config: rec.config });
        rec.tools = res.tools;
        rec.toolCount = res.tools.length;
        rec.compatIssues = res.issues || [];
      } else {
        await this.host.unloadPlugin(id);
        rec.tools = [];
        rec.toolCount = 0;
      }
      this.save();
      return { ok: true, plugin: this._public(rec) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setEnabled(id, enabled) {
    const rec = this.plugins.find(p => p.id === id);
    if (!rec) return { ok: false, error: `插件不存在：${id}` };
    rec.enabled = !!enabled;
    return await this.refreshPlugin(id);
  }

  async uninstall(id) {
    const rec = this.plugins.find(p => p.id === id);
    if (!rec) return { ok: false, error: `插件不存在：${id}` };
    await this.host.unloadPlugin(id);
    this.plugins = this.plugins.filter(p => p.id !== id);
    try { fs.rmSync(rec.installDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.save();
    return { ok: true };
  }

  async setConfig(id, patch) {
    const rec = this.plugins.find(p => p.id === id);
    if (!rec) return { ok: false, error: `插件不存在：${id}` };
    rec.config = { ...(rec.config || {}), ...(patch || {}) };
    this.save();
    return await this.refreshPlugin(id);
  }

  async callTool(pluginId, toolName, args, execCtx = {}) {
    return await this.host.callTool(pluginId, toolName, args || {}, execCtx);
  }

  list() {
    return this.plugins.map(p => this._public(p));
  }

  /** 启动时加载所有已启用插件（失败仅记录，不阻断应用启动） */
  async loadEnabled() {
    for (const rec of this.plugins) {
      if (!rec.enabled) continue;
      try {
        await this.refreshPlugin(rec.id);
      } catch (e) {
        rec.compatIssues = [...(rec.compatIssues || []), `启动加载失败: ${e.message}`];
      }
    }
    this.save();
    return this.list();
  }

  /**
   * 启动时全量兼容性重审：已启用的正常加载；禁用的做一次“加载→记录→立即卸载”
   * 探测，清除旧版本遗留的 compatIssues（如早期缺少 agents seam 的记录），
   * 让插件卡显示当前宿主能力的真实结论。
   */
  async refreshAll() {
    for (const rec of this.plugins) {
      try {
        let pkg = null;
        try { pkg = this._readPackage(rec.installDir); } catch { /* ignore */ }
        if (pkg && repairReactRuntime(rec.installDir, pkg)) {
          console.log(`[DS Plugins] 已修复 ${rec.name} 的 react 版本漂移`);
        }
        if (isInteractiveTuiPlugin(rec.installDir)) {
          rec.compatIssues = ['交互式终端插件（TUI 前端门）：CIBYP GUI 不渲染其终端界面，已跳过加载'];
          rec.tools = [];
          rec.toolCount = 0;
          await this.host.unloadPlugin(rec.id);
          continue;
        }
        if (rec.enabled) {
          await this.refreshPlugin(rec.id);
          continue;
        }
        // 禁用插件的重审探测用短超时（交互式 TUI 类插件深探测会挂 30s）
        const res = await this.host.loadPlugin(rec.id, rec.entry, {
          name: rec.name,
          config: rec.config || {},
          probe: true,
          applyTimeoutMs: 6000
        });
        rec.compatIssues = res.issues || [];
        rec.tools = [];
        rec.toolCount = 0;
        await this.host.unloadPlugin(rec.id);
      } catch (e) {
        rec.compatIssues = [...(rec.compatIssues || []), `启动重审失败: ${e.message}`];
    }
  }
    this.save();
    return this.list();
  }

  _public(rec) {
    return {
      id: rec.id,
      name: rec.name,
      version: rec.version,
      description: rec.description,
      source: rec.source,
      enabled: !!rec.enabled,
      config: rec.config || {},
      bundlePatch: rec.bundlePatch || { file: null, rows: [] },
      compatTier: rec.compatTier,
      compatIssues: rec.compatIssues || [],
      toolCount: rec.toolCount || 0,
      tools: (rec.tools || []).map(t => ({ name: t.name, description: t.description, schema: t.schema, compatTier: t.compatTier }))
    };
  }

  async dispose() {
    try { await this.host.dispose(); } catch { /* ignore */ }
  }
}

module.exports = { PluginManager, readBundlePatch, repairReactRuntime, isInteractiveTuiPlugin };
