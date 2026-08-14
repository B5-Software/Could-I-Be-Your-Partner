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
const { spawnSync } = require('child_process');
const { PluginHost } = require('./plugin-host');

const SHIMS = {
  '@deepseek-ai/dsh-tools': path.join(__dirname, 'shims', 'dsh-tools'),
  '@deepseek-ai/cordis': path.join(__dirname, 'shims', 'cordis'),
  '@deepseek-ai/schemastery': path.join(__dirname, '..', '..', '..', 'node_modules', '@deepseek-ai', 'schemastery')
};

class PluginManager {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.pluginsDir = path.join(dataDir, 'plugins');
    this.manifestPath = path.join(dataDir, 'plugins.json');
    this.host = new PluginHost({ skills: options.skills || null });
    this.plugins = [];
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
   * npm 12 在 --no-save 下不会写 package.json，因此不能依赖
   * tmpDir/package.json 的 dependencies；直接扫描 node_modules，
   * 用包名匹配，名字不符时退化为“唯一候选”。
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
    const wanted = this._parseSpecName(spec);
    const named = candidates.filter((c) => {
      try { return JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8')).name === wanted; } catch { return false; }
    });
    if (named.length) return named[0];
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * 安装插件。source: { type: 'local'|'npm'|'github'|'tgz', ref }
   */
  async install(source) {
    const type = source?.type || 'local';
    const ref = String(source?.ref || '').trim();
    if (!ref) throw new Error('缺少安装来源');
    let installDir = null;
    let pkg = null;

    if (type === 'local') {
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
      const tmpDir = fs.mkdtempSync(path.join(this.pluginsDir, '.tmp-'));
      const spec = type === 'npm' ? ref : (type === 'github' ? `github:${ref.replace(/^github:/, '')}` : ref);
      const r = spawnSync('npm', ['install', '--prefix', tmpDir, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', spec], {
        encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32'
      });
      if (r.status !== 0) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(`npm 安装失败: ${(r.stderr || r.stdout || '').slice(-600)}`);
      }
      // 找到实际包目录（不再依赖 --no-save 生成的 package.json）
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
      fs.renameSync(found, installDir);
      // 把 npm 装好的依赖（peerDependencies 等）一并搬进插件目录，
      // 否则插件移动后 @deepseek-ai/dsh-llm 等运行期依赖会随 tmpDir 一起被删。
      const tmpNm = path.join(tmpDir, 'node_modules');
      if (fs.existsSync(tmpNm)) {
        try {
          fs.renameSync(tmpNm, path.join(installDir, 'node_modules'));
        } catch {
          // 跨设备回退：复制
          try { fs.cpSync(tmpNm, path.join(installDir, 'node_modules'), { recursive: true }); } catch { /* ignore */ }
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    const entry = this._resolveEntry(installDir, pkg);
    this._ensureShims(installDir);
    const record = {
      id: this._slug(pkg.name),
      name: pkg.name,
      version: pkg.version || '0.0.0',
      description: pkg.description || '',
      source: { type, ref },
      installDir,
      entry,
      config: {},
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

  _public(rec) {
    return {
      id: rec.id,
      name: rec.name,
      version: rec.version,
      description: rec.description,
      source: rec.source,
      enabled: !!rec.enabled,
      config: rec.config || {},
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

module.exports = { PluginManager };
