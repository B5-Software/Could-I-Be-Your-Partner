/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const zenCosts = new Map();
const zenLimits = new Map();
const unavailable = new Map();

function updateOpenCodeCatalog(catalog) {
  const models = catalog?.opencode?.models;
  if (!models) return;
  zenCosts.clear();
  zenLimits.clear();
  for (const [id, model] of Object.entries(models)) {
    if (model?.cost) zenCosts.set(id, model.cost);
    if (model?.limit) zenLimits.set(id, model.limit);
  }
}

function getOpenCodeLimits(llm) {
  if (!isOpenCodeFreeModel(llm)) return null;
  const limit = zenLimits.get(llm.model) || {};
  return require('../shared/provider-limits').resolve({ ...llm,
    providerLimits: { free: true, context: limit.context, input: limit.input, output: limit.output,
      source: Object.keys(limit).length ? 'models.dev:opencode' : 'conservative-free-channel' } });
}

function markOpenCodeAvailability(model, result) {
  if (result.ok) unavailable.delete(model);
  else if (result.status === 404 || /model.*(unavailable|not found|does not exist|deprecated)|模型.*(不可用|不存在)/i.test(result.error || ''))
    unavailable.set(model, { error: result.error, until: Date.now() + 15 * 60 * 1000 });
}

function isOpenCodeFreeModel(llm) {
  // A public key does not imply a free model. Go and custom providers must
  // retain their original tool definitions, even when the model name matches.
  if (llm?.provider !== 'opencode-zen') return false;
  const id = String(llm.model || '');
  const cost = zenCosts.get(id);
  if (cost) return cost.input === 0 && cost.output === 0;
  return /(?:^|-)free$/.test(id) || id === 'big-pickle';
}

// Only enrich models advertised by the live endpoint; stale catalog entries
// must never make a removed or paid model appear available for free.
function enrichOpenCodeModels(models, catalog, channel = 'zen') {
  updateOpenCodeCatalog(catalog);
  const provider = catalog?.[channel === 'go' ? 'opencode-go' : 'opencode'];
  return (Array.isArray(models) ? models : []).filter((m) => typeof m?.id === 'string' &&
    (!unavailable.has(m.id) || unavailable.get(m.id).until < Date.now()) && !/^jev-/.test(m.id)).map((model) => {
    const metadata = provider?.models?.[model.id];
    const cost = model.cost || metadata?.cost;
    const free = channel === 'zen' && (cost
      ? cost.input === 0 && cost.output === 0
      : /(?:^|-)free$/.test(model.id) || model.id === 'big-pickle');
    const providerLimits = free ? getOpenCodeLimits({ provider: 'opencode-zen', model: model.id }) : null;
    return {
      ...model, name: model.name || metadata?.name || model.id, free,
      contextLength: providerLimits?.context || model.contextLength || metadata?.limit?.context || null,
      providerLimits,
      vision: model.vision ?? metadata?.modalities?.input?.includes('image') ?? false,
      cost: cost || null,
    };
  }).sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name));
}

module.exports = { enrichOpenCodeModels, updateOpenCodeCatalog, isOpenCodeFreeModel, getOpenCodeLimits, markOpenCodeAvailability };
