/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// Presets select the typed decision endpoint, never a chat-completions endpoint.
// A custom endpoint supports any server implementing state + questions -> answers.
const PROVIDERS = Object.freeze({
  zen: {
    url: 'https://opencode.ai/zen/v1/systemone',
    modelsUrl: 'https://opencode.ai/zen/v1/models',
    model: 'jev-1.13-free',
    keyRequired: false,
  },
  typesafe: {
    url: 'https://api.typesafe.ai/v1/systemone',
    modelsUrl: 'https://api.typesafe.ai/v1/models',
    model: 'jev-latest',
    keyRequired: true,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/alpha/decisions',
    modelsUrl: 'https://openrouter.ai/api/v1/models?output_modalities=decisions',
    model: '',
    keyRequired: true,
  },
  perplexity: {
    url: 'https://api.perplexity.ai/v1/decisions',
    modelsUrl: '',
    model: 'pplx-decider-v1-27b',
    keyRequired: true,
  },
  fastino: {
    url: 'https://api.fastino.ai/v1/systemone',
    modelsUrl: '',
    model: 'fastino/GLiDE',
    keyRequired: true,
  },
  cloudflare: { url: '', modelsUrl: '', model: 'clef', keyRequired: true },
  compatible: { url: '', modelsUrl: '', model: '', keyRequired: false },
});
const TYPES = ['noul', 'choice', 'score'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const probability = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function httpUrl(value, label) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error(`${label} must be an HTTP(S) URL without embedded credentials`);
  url.hash = '';
  return url.toString();
}

function resolveConnection(cfg, { discovery = false } = {}) {
  const preset = PROVIDERS[cfg.provider] || PROVIDERS.compatible;
  let url = String(cfg.apiUrl || preset.url).trim();
  if (!url) throw new Error('Set the complete System One API URL');
  url = httpUrl(url, 'API URL');
  let model = String(cfg.model || preset.model).trim();
  if (cfg.provider === 'cloudflare') {
    const path = new URL(url).pathname;
    const match = path.match(/\/ai\/run\/@cf\/cloudflare\/(clef(?:-flash)?)(?:\/)?$/);
    if (match && !cfg.model) model = match[1];
    model = model.replace(/^@cf\/cloudflare\//, '');
  }
  if (cfg.provider === 'openrouter' && !model && !discovery)
    throw new Error('Select a System One model');
  if (preset.keyRequired && !cfg.apiKey && !discovery)
    throw new Error('This System One provider requires an API key');
  let modelsUrl = String(cfg.modelsUrl || (!cfg.apiUrl ? preset.modelsUrl : '')).trim();
  // Discovery at a custom host stays at that host; do not send its key to the preset host.
  if (!modelsUrl && (cfg.provider === 'compatible' || cfg.apiUrl)) {
    const parsed = new URL(url);
    if (/\/v1\/(?:systemone|decisions)\/?$/.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/(?:systemone|decisions)\/?$/, '/models');
      parsed.search = '';
      modelsUrl = parsed.toString();
    }
  }
  if (modelsUrl) modelsUrl = httpUrl(modelsUrl, 'Model list URL');
  return { url, model, modelsUrl };
}

function validateQuestions(state, questions, capabilities) {
  if (!['string', 'object', 'number', 'boolean'].includes(typeof state))
    throw new Error('state must be JSON data');
  if (state == null || (typeof state === 'string' && !state.trim()))
    throw new Error('state must contain context');
  if (!isObject(questions) || !Object.keys(questions).length) throw new Error('missing questions');
  // JSON state is passed intact, without stringifying it as [object Object] or truncating it.
  if (typeof state === 'number' && !Number.isFinite(state))
    throw new Error('state must be finite JSON data');
  JSON.stringify({ state, questions });
  for (const [id, q] of Object.entries(questions)) {
    if (['__proto__', 'constructor', 'prototype'].includes(id))
      throw new Error(`Invalid question ID: ${id}`);
    if (
      !isObject(q) ||
      !TYPES.includes(q.type) ||
      typeof q.instructions !== 'string' ||
      !q.instructions.trim()
    )
      throw new Error(`Invalid System One question: ${id}`);
    if (capabilities[q.type] === false)
      throw new Error(`This System One model has ${q.type} disabled`);
    if (
      q.type === 'choice' &&
      (!isObject(q.criteria) ||
        !Object.keys(q.criteria).length ||
        Object.values(q.criteria).some((v) => typeof v !== 'string'))
    )
      throw new Error(`choice requires named criteria: ${id}`);
    if (
      q.type === 'score' &&
      (!Array.isArray(q.criteria) ||
        q.criteria.length < 2 ||
        q.criteria.some((v) => typeof v !== 'string'))
    )
      throw new Error(`score requires at least two ordered criteria: ${id}`);
  }
}

function unwrapResponse(data) {
  if (data?.success === false || data?.error || (typeof data?.code === 'number' && data.code !== 0))
    throw new Error(
      data?.error?.message ||
        data?.message ||
        data?.errors?.[0]?.message ||
        'System One provider rejected the request',
    );
  const result = data?.answers
    ? data
    : data?.result?.answers
      ? data.result
      : data?.data?.result?.answers
        ? data.data.result
        : data?.data?.answers
          ? data.data
          : null;
  if (!result || !isObject(result.answers)) throw new Error('System One response missing answers');
  return result;
}

function validateAnswers(answers, questions) {
  const selected = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!isObject(a) || a.type !== q.type)
      throw new Error(`Missing or mismatched System One answer: ${id}`);
    if (q.type === 'noul' && !probability(a.noul))
      throw new Error(`Invalid noul probability: ${id}`);
    if (
      q.type === 'choice' &&
      (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice))
    )
      throw new Error(`Unknown choice: ${id}`);
    if (
      q.type === 'score' &&
      (typeof a.score !== 'number' ||
        !Number.isFinite(a.score) ||
        a.score < 0 ||
        a.score > q.criteria.length - 1)
    )
      throw new Error(`Score outside its criteria: ${id}`);
    // Do not invent confidence from probabilities: vendors use different calibration.
    if (q.type !== 'noul' && !probability(a.confidence))
      throw new Error(`Missing or invalid confidence: ${id}`);
    if (a.probabilities != null) {
      if (!isObject(a.probabilities) || Object.values(a.probabilities).some((v) => !probability(v)))
        throw new Error(`Invalid probability distribution: ${id}`);
    }
    selected[id] = a;
  }
  return selected;
}

function parseModels(data, provider) {
  if (data?.success === false || data?.error) throw new Error('System One model discovery failed');
  const entries = Array.isArray(data) ? data : data?.data || data?.models || data?.result;
  if (!Array.isArray(entries)) throw new Error('Model list response has no models');
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id || entry?.name || entry?.model;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (
      provider === 'zen' &&
      !/^jev-|systemone|decid|clef|laya/i.test(id) &&
      !entry?.architecture?.output_modalities?.includes('decisions')
    )
      continue;
    if (
      provider === 'openrouter' &&
      entry?.architecture?.output_modalities &&
      !entry.architecture.output_modalities.includes('decisions')
    )
      continue;
    seen.add(id);
    result.push({ id, name: typeof entry?.name === 'string' ? entry.name : id });
  }
  return result;
}

module.exports = {
  PROVIDERS,
  TYPES,
  resolveConnection,
  validateQuestions,
  unwrapResponse,
  validateAnswers,
  parseModels,
};
