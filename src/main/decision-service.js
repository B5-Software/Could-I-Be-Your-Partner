/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 决策模型服务（System One）：
 *   - 支持云服务预设与任意兼容的本地 / 自定义 System One 接口
 *   - 三种原语：choice（从选项里选）/ score（按档位打分）/ noul（是否概率）
 *   - 低置信一律返回 null，调用方回退原有 LLM / 启发式逻辑（绝不阻塞主流程）
 *   - LRU 缓存 + 每日调用上限 + 用量记账（settings.decision.usage）
 */

'use strict';

const crypto = require('crypto');
const ocHeaders = require('./opencode-headers');
const { ts, maskUrl } = require('./req-log');
const { PROVIDERS, TYPES, resolveConnection, validateQuestions, unwrapResponse, validateAnswers, parseModels } = require('./services/system-one-protocol');

/** 把 answers 压成一行摘要（choice/score/noul） */
function summarizeAnswers(answers) {
  const parts = [];
  for (const [k, v] of Object.entries(answers || {})) {
    if (!v || typeof v !== 'object') { parts.push(`${k}=?`); continue; }
    if (v.type === 'choice') parts.push(`${k}=${v.choice}(${Number(v.probabilities?.[v.choice] ?? 0).toFixed(2)},c=${Number(v.confidence ?? 0).toFixed(2)})`);
    else if (v.type === 'score') parts.push(`${k}=${Number(v.score).toFixed(2)}(c=${Number(v.confidence ?? 0).toFixed(2)})`);
    else if (v.type === 'noul') parts.push(`${k}=${Number(v.noul).toFixed(3)}`);
    else parts.push(`${k}=?`);
  }
  return parts.join(' ');
}

const ZEN_SYSTEMONE_URL = 'https://opencode.ai/zen/v1/systemone';
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = Object.fromEntries(Object.entries(PROVIDERS).map(([key, value]) => [key, value.model]));
const CACHE_MAX = 500;

/** 默认配置（写入 settings.decision） */
const DEFAULT_DECISION_SETTINGS = {
  enabled: false,
  provider: 'zen',                    // Built-in provider or compatible custom endpoint
  apiUrl: '',                         // 空 = 按 provider 用默认地址
  apiKey: '',                         // zen 免费可留空（用 public）
  model: '',                          // 空 = 默认（zen: jev-1.13-free / typesafe: jev-latest）
  modelsUrl: '',                      // Optional complete model discovery URL
  capabilities: { noul: true, choice: true, score: true },
  confidenceThreshold: 0.5,           // choice/score 置信阈值；低于则返回 null
  guardThreshold: 0.85,               // noul 高置信阈值（危险判断等保守场景）
  timeoutMs: 8000,
  dailyMaxCalls: 0,                   // 0 = 不限
  cache: true,
  usages: {
    modelRouting: true,               // 会话创建时选择模型（模型池策略=System One）
    reasoningRouting: true,           // 会话创建时选择 Reasoning Effort（策略=System One）
    toolSelection: true,              // 工具自动选择
    commandGuard: true,               // 危险命令护栏
    gameDecisions: true,              // 游戏决策（猜人物/卧底/三国杀/成语/飞花令）
    llmTool: true,                    // LLM 主动调用（decisionModel 工具）
    emailIntent: false,               // 邮件/热消息意图分类
    contextRetention: false,          // 上下文保留打分
  },
  usage: { date: '', calls: 0 },
};

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 合并默认配置（含旧数据兜底） */
function normalizeDecisionSettings(raw) {
  const out = { ...DEFAULT_DECISION_SETTINGS, ...(raw || {}) };
  out.usages = { ...DEFAULT_DECISION_SETTINGS.usages, ...((raw && raw.usages) || {}) };
  out.usage = { ...DEFAULT_DECISION_SETTINGS.usage, ...((raw && raw.usage) || {}) };
  out.provider = Object.hasOwn(PROVIDERS, out.provider) ? out.provider : 'compatible';
  out.capabilities = { ...DEFAULT_DECISION_SETTINGS.capabilities, ...raw?.capabilities };
  for (const key of ['apiUrl', 'apiKey', 'model', 'modelsUrl']) out[key] = typeof out[key] === 'string' ? out[key].trim() : '';
  out.confidenceThreshold = Math.min(0.99, Math.max(0.05, Number(out.confidenceThreshold) || 0.5));
  out.guardThreshold = Math.min(0.99, Math.max(0.5, Number(out.guardThreshold) || 0.85));
  out.timeoutMs = Math.min(60000, Math.max(1000, Number(out.timeoutMs) || 8000));
  out.dailyMaxCalls = Math.max(0, parseInt(out.dailyMaxCalls, 10) || 0);
  out.cache = out.cache !== false;
  return out;
}

// Used by the shared settings backend, including TUI and remote patches.
function prepareDecisionPatch(previous, patch) {
  if (!patch || !patch.provider || patch.provider === (previous?.provider || 'zen')) return patch;
  const out = { apiUrl: '', apiKey: '', model: '', modelsUrl: '', capabilities: { ...DEFAULT_DECISION_SETTINGS.capabilities }, ...patch };
  for (const key of ['apiKey', 'apiUrl', 'model', 'modelsUrl']) {
    if (out[key] === previous?.[key]) out[key] = '';
  }
  return out;
}

class DecisionService {
  /**
   * @param {object} opts { getSettings: () => settings, persistSettings?: () => void, getDayKey?: () => string }
   */
  constructor(opts) {
    this.getSettings = opts.getSettings || (() => ({}));
    this.getDayKey = opts.getDayKey || todayStamp;
    this.persistSettings = opts.persistSettings || (() => {});
    this.fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null;
    this._cache = new Map(); // key -> answers
    this._persistTimer = null;
    this._lastPersistAt = 0;
  }

  _schedulePersist() {
    if (this._persistTimer) return;
    const wait = Math.max(0, 15000 - (Date.now() - this._lastPersistAt));
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._lastPersistAt = Date.now();
      try { this.persistSettings(); } catch (_) { /* ignore */ }
    }, wait);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  flushPersist() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._lastPersistAt = Date.now();
    try { this.persistSettings(); } catch (_) { /* ignore */ }
  }

  get config() {
    return normalizeDecisionSettings(this.getSettings().decision);
  }

  /** 某个用途是否启用（且总开关打开） */
  enabledFor(usageKey) {
    const cfg = this.config;
    if (!cfg.enabled) return false;
    if (usageKey && cfg.usages[usageKey] === false) return false;
    return true;
  }

  _usageGate(cfg) {
    const stamp = this.getDayKey();
    const usage = { ...cfg.usage };
    if (usage.date !== stamp) { usage.date = stamp; usage.calls = 0; }
    if (cfg.dailyMaxCalls > 0 && usage.calls >= cfg.dailyMaxCalls) {
      return { ok: false, error: `decision model daily call cap reached (${cfg.dailyMaxCalls})` };
    }
    return { ok: true, usage };
  }

  _bumpUsage(usage) {
    try {
      const s = this.getSettings();
      const stamp = this.getDayKey();
      const prev = (s.decision && s.decision.usage) || {};
      const next = prev.date === stamp ? { date: stamp, calls: Math.max(0, Number(prev.calls) || 0) + 1 } : { date: stamp, calls: 1 };
      s.decision = { ...(s.decision || {}), usage: next };
      // 用量记账去抖持久化：settings.json 可达十几 MB，每次决策同步全量写盘会卡顿主进程
      this._schedulePersist();
    } catch (_) { /* ignore */ }
  }

  _cacheKey(cfg, state, questions) {
    return crypto.createHash('sha1')
      .update(JSON.stringify([cfg.provider, cfg.url, cfg.model, cfg.apiKey, questions, state]))
      .digest('hex');
  }

  _cacheGet(key, cfg) {
    if (!cfg.cache) return null;
    const hit = this._cache.get(key);
    if (!hit) return null;
    // LRU 触达
    this._cache.delete(key);
    this._cache.set(key, hit);
    return structuredClone(hit);
  }

  _cacheSet(key, value, cfg) {
    if (!cfg.cache) return;
    this._cache.set(key, structuredClone(value));
    while (this._cache.size > CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  /**
   * 原始调用：state + questions → { ok, answers, usage, cached }
   */
  async call(state, questions, opts = {}) {
    const cfg = this.config;
    if (!cfg.enabled) {
      console.log(`[System One ${ts()}] · skip request: decision model disabled`);
      return { ok: false, error: 'decision model disabled' };
    }
    let connection;
    try {
      validateQuestions(state, questions, cfg.capabilities);
      connection = resolveConnection(cfg);
    } catch (e) { return { ok: false, error: e.message }; }

    const provider = cfg.provider;
    const { model, url } = connection;
    const cacheKey = this._cacheKey({ ...cfg, model, url }, state, questions);
    const cached = this._cacheGet(cacheKey, cfg);
    if (cached) {
      console.log(`[System One ${ts()}] ← cache hit model=${model} answers=[${summarizeAnswers(cached)}]`);
      return { ok: true, answers: cached, usage: null, cached: true };
    }

    const gate = this._usageGate(cfg);
    if (!gate.ok) {
      console.error(`[System One ${ts()}] ✗ skip model=${model}: ${gate.error}`);
      return { ok: false, error: gate.error };
    }

    const finalHeaders = this._headers(cfg, url, opts.sessionKey);

    const qSummary = Object.entries(questions).map(([k, v]) => `${k}:${v?.type || '?'}`).join(',');
    console.log(`[System One ${ts()}] → POST ${maskUrl(url)} provider=${provider} model=${model} state=${JSON.stringify(state).length}chars q=[${qSummary}] usage=${opts.usage || '-'}`);
    const startedAt = Date.now();
    let resp;
    // Count dispatched requests, including failures; synchronously reserve the daily slot.
    this._bumpUsage(gate.usage);
    try {
      const fetchFn = this.fetchImpl || fetch;
      resp = await fetchFn(url, {
        method: 'POST',
        headers: finalHeaders,
        body: JSON.stringify({ ...(model ? { model } : {}), state, questions }),
        redirect: 'error',
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      const error = this._redact(e.message, cfg);
      console.error(`[System One ${ts()}] ✗ request failed (${Date.now() - startedAt}ms) model=${model}: ${error}`);
      return { ok: false, error: `System One request failed: ${error}` };
    }
    const dur = Date.now() - startedAt;

    let data;
    try {
      data = await resp.json();
    } catch (_) {
      console.error(`[System One ${ts()}] ✗ response not JSON (${dur}ms) HTTP ${resp.status} model=${model}`);
      return { ok: false, error: `decision model response not JSON (HTTP ${resp.status})` };
    }
    if (!resp.ok) {
      const msg = this._redact(data?.error?.message || data?.message || data?.error || `HTTP ${resp.status}`, cfg);
      console.error(`[System One ${ts()}] ✗ HTTP ${resp.status} (${dur}ms) model=${model}: ${String(msg).slice(0, 200)}`);
      return { ok: false, error: `decision model HTTP ${resp.status}: ${String(msg).slice(0, 200)}` };
    }
    let answers;
    try {
      data = unwrapResponse(data);
      answers = validateAnswers(data.answers, questions);
    } catch (e) { return { ok: false, error: this._redact(e.message, cfg) }; }
    console.log(`[System One ${ts()}] ✓ ${resp.status} (${dur}ms) model=${model} answers=[${summarizeAnswers(answers)}] in:${data.usage?.input_tokens ?? '-'} out:${data.usage?.output_tokens ?? '-'}`);
    this._cacheSet(cacheKey, answers, cfg);
    return { ok: true, answers, usage: data.usage || null };
  }

  _redact(value, cfg) {
    const text = String(value);
    return cfg.apiKey ? text.split(cfg.apiKey).join('[redacted]') : text;
  }

  _headers(cfg, url, sessionKey = 'decision') {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    // Only OpenCode receives OpenCode-specific identity headers.
    if (cfg.provider === 'zen' && new URL(url).hostname === 'opencode.ai') {
      return ocHeaders.applyProviderHeaders({ url, headers, llm: { zenApiKey: cfg.apiKey || 'public', customHeaders: [], autoOpencodeHeaders: true }, sessionKey });
    }
    return headers;
  }

  async models() {
    const cfg = this.config;
    try {
      const { modelsUrl, url } = resolveConnection(cfg, { discovery: true });
      if (!modelsUrl) return { ok: false, error: 'Set a model list URL or enter a model ID manually' };
      // A list on another origin is public; credentials belong to the inference origin.
      const headers = new URL(modelsUrl).origin === new URL(url).origin ? this._headers(cfg, modelsUrl) : { 'Content-Type': 'application/json' };
      const resp = await (this.fetchImpl || fetch)(modelsUrl, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs) });
      if (!resp.ok) return { ok: false, error: `Model list HTTP ${resp.status}` };
      return { ok: true, models: parseModels(await resp.json(), cfg.provider) };
    } catch (e) { return { ok: false, error: this._redact(e.message, cfg) }; }
  }

  /**
   * noul：是/否概率。threshold 为"判定为 true 所需的最低概率"。
   * p >= threshold → true；p <= 1-threshold → false；否则 null（低置信回退）。
   */
  async noul(state, instructions, opts = {}) {
    const key = opts.key || 'q';
    const threshold = Math.min(0.99, Math.max(0.5, Number(opts.threshold) || this.config.confidenceThreshold));
    const res = await this.call(state, { [key]: { type: 'noul', instructions } }, opts);
    if (!res.ok) return { value: null, error: res.error, raw: null };
    const p = Number(res.answers?.[key]?.noul);
    if (!Number.isFinite(p)) return { value: null, error: 'noul response missing probability', raw: res.answers?.[key] };
    const value = p >= threshold ? true : (p <= 1 - threshold ? false : null);
    if (value === null) console.log(`[System One ${ts()}] · noul uncertain p=${p.toFixed(3)} (threshold ${threshold}) -> fallback`);
    return { value, probability: p, raw: res.answers?.[key], usage: res.usage, cached: res.cached };
  }

  /** choice：从 criteria（{value: description}）里选一个；低置信 → null */
  async choice(state, instructions, criteria, opts = {}) {
    const key = opts.key || 'q';
    const threshold = Number(opts.threshold) || this.config.confidenceThreshold;
    const res = await this.call(state, { [key]: { type: 'choice', instructions, criteria } }, opts);
    if (!res.ok) return { value: null, error: res.error, raw: null };
    const ans = res.answers?.[key];
    if (!ans || typeof ans.choice !== 'string') return { value: null, error: 'choice response missing choice', raw: ans };
    if (Number(ans.confidence) < threshold) {
      console.log(`[System One ${ts()}] · choice low confidence ${ans.choice}(c=${Number(ans.confidence).toFixed(2)}<${threshold}) -> fallback (suggested=${ans.choice})`);
      return { value: null, confidence: Number(ans.confidence), lowConfidence: true, raw: ans, usage: res.usage };
    }
    return { value: ans.choice, probabilities: ans.probabilities, confidence: Number(ans.confidence), raw: ans, usage: res.usage, cached: res.cached };
  }

  /** score：按 criteria（有序档位数组）打分；低置信 → null */
  async score(state, instructions, criteria, opts = {}) {
    const key = opts.key || 'q';
    const threshold = Number(opts.threshold) || this.config.confidenceThreshold;
    const res = await this.call(state, { [key]: { type: 'score', instructions, criteria } }, opts);
    if (!res.ok) return { value: null, error: res.error, raw: null };
    const ans = res.answers?.[key];
    if (!ans || !Number.isFinite(Number(ans.score))) return { value: null, error: 'score response missing score', raw: ans };
    if (Number(ans.confidence) < threshold) {
      console.log(`[System One ${ts()}] · score low confidence ${Number(ans.score).toFixed(2)}(c=${Number(ans.confidence).toFixed(2)}<${threshold}) -> fallback`);
      return { value: null, confidence: Number(ans.confidence), lowConfidence: true, raw: ans, usage: res.usage };
    }
    return { value: Number(ans.score), legend: ans.legend, confidence: Number(ans.confidence), raw: ans, usage: res.usage, cached: res.cached };
  }

  /** 连通性测试 */
  async test() {
    const type = TYPES.find((key) => this.config.capabilities[key] !== false);
    if (!type) return { ok: false, error: 'Enable at least one System One decision type' };
    const q = { type, instructions: 'Connectivity test: is the server available?', ...(type === 'choice' ? { criteria: { yes: 'Available', no: 'Unavailable' } } : type === 'score' ? { criteria: ['Unavailable', 'Available'] } : {}) };
    const result = await this.call('ping', { alive: q });
    return result.ok ? { ok: true, type, answer: result.answers.alive, probability: result.answers.alive.noul } : result;
  }

  /** 清空缓存（设置变更时调用） */
  clearCache() {
    this._cache.clear();
  }
}

module.exports = { DecisionService, DEFAULT_DECISION_SETTINGS, normalizeDecisionSettings, prepareDecisionPatch, ZEN_SYSTEMONE_URL, TYPESAFE_URL, DEFAULT_MODEL };
