/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseEther } = require('ethers');
const policy = require('./policy');
const fail = (code) => {
  throw Error(code);
};
const validSubject = (value) => typeof value === 'string' && /^[\w:-]{1,128}$/.test(value);
const validId = (value) => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const cleanLabel = (value) =>
  String(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 80);
const frozen = (value) => {
  for (const item of Object.values(value)) if (item && typeof item === 'object') frozen(item);
  return Object.freeze(value);
};
function rootContext(workspaceId, label) {
  const subject = workspaceId ? 'quant:' + workspaceId : 'service:wallet';
  if (!validSubject(subject)) fail('WALLET_AGENT_SCOPE_INVALID');
  return frozen({
    version: 1,
    workspaceId: workspaceId ?? null,
    nodes: [
      {
        subject,
        label: cleanLabel(label || subject),
        walletIds: [],
        chains: [8453, 84532],
        limits: policy.limits({ allowReplacement: true }),
        maxFeeEth: '0',
        expiresAt: 0,
      },
    ],
  });
}
function deriveChild(parent, id, request = {}, label = id) {
  validateContext(parent);
  if (
    !parent ||
    parent.version !== 1 ||
    !Array.isArray(parent.nodes) ||
    !parent.nodes.length ||
    parent.nodes.length >= 8 ||
    !validSubject(id) ||
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (k) => !['walletIds', 'chains', 'limits', 'maxFeeEth', 'minutes'].includes(k),
    )
  )
    fail('WALLET_AGENT_SCOPE_INVALID');
  const p = parent.nodes.at(-1),
    walletIds = request.walletIds ?? p.walletIds,
    chains = request.chains ?? p.chains;
  if (
    !Array.isArray(walletIds) ||
    walletIds.length > 16 ||
    walletIds.some((v) => !validId(v)) ||
    new Set(walletIds).size !== walletIds.length ||
    !Array.isArray(chains) ||
    !chains.length ||
    chains.some((c) => !p.chains.includes(c)) ||
    new Set(chains).size !== chains.length
  )
    fail('WALLET_AGENT_SCOPE_INVALID');
  if (p.walletIds.length && (!walletIds.length || walletIds.some((v) => !p.walletIds.includes(v))))
    fail('WALLET_AGENT_SCOPE_WIDENING');
  if (
    request.limits !== undefined &&
    (!request.limits || typeof request.limits !== 'object' || Array.isArray(request.limits))
  )
    fail('WALLET_AGENT_SCOPE_INVALID');
  const merged = { ...structuredClone(p.limits), ...(request.limits ?? {}) };
  if (
    p.limits.period &&
    request.limits?.period &&
    typeof request.limits.period === 'object' &&
    !Array.isArray(request.limits.period)
  )
    merged.period = { ...structuredClone(p.limits.period), ...request.limits.period };
  const limits = policy.limits(merged),
    maxFeeEth = request.maxFeeEth ?? p.maxFeeEth;
  if (typeof maxFeeEth !== 'string' || !/^\d{1,30}(?:\.\d{1,18})?$/.test(maxFeeEth))
    fail('WALLET_AGENT_SCOPE_INVALID');
  const max = parseEther(p.maxFeeEth),
    child = parseEther(maxFeeEth);
  if (max && (child === 0n || child > max)) fail('WALLET_AGENT_SCOPE_WIDENING');
  let expiresAt = p.expiresAt;
  if (request.minutes !== undefined) {
    if (!Number.isInteger(request.minutes) || request.minutes < 1 || request.minutes > 43200)
      fail('WALLET_AGENT_SCOPE_INVALID');
    expiresAt = Date.now() + request.minutes * 60000;
    if (p.expiresAt && expiresAt > p.expiresAt) fail('WALLET_AGENT_SCOPE_WIDENING');
  }
  return frozen({
    version: 1,
    workspaceId: parent.workspaceId,
    nodes: [
      ...structuredClone(parent.nodes),
      {
        subject: id,
        label: cleanLabel(label),
        walletIds: walletIds.slice(),
        chains: chains.slice(),
        limits,
        maxFeeEth,
        expiresAt,
      },
    ],
  });
}
function validateContext(context) {
  if (
    !context ||
    context.version !== 1 ||
    !Array.isArray(context.nodes) ||
    !context.nodes.length ||
    context.nodes.length > 8
  )
    fail('WALLET_AGENT_SCOPE_INVALID');
  const expected = rootContext(context.workspaceId).nodes[0].subject;
  if (
    context.nodes[0].subject !== expected ||
    new Set(context.nodes.map((n) => n.subject)).size !== context.nodes.length
  )
    fail('WALLET_AGENT_SCOPE_FORBIDDEN');
  for (const n of context.nodes) {
    if (
      !n ||
      !validSubject(n.subject) ||
      typeof n.label !== 'string' ||
      n.label.length > 80 ||
      /[\x00-\x1f\x7f]/.test(n.label) ||
      !Array.isArray(n.walletIds) ||
      n.walletIds.length > 16 ||
      new Set(n.walletIds).size !== n.walletIds.length ||
      n.walletIds.some((id) => !validId(id)) ||
      !Array.isArray(n.chains) ||
      !n.chains.length ||
      n.chains.length > 2 ||
      new Set(n.chains).size !== n.chains.length ||
      n.chains.some((id) => ![8453, 84532].includes(id)) ||
      !Number.isSafeInteger(n.expiresAt) ||
      n.expiresAt < 0 ||
      typeof n.maxFeeEth !== 'string' ||
      !/^\d{1,30}(?:\.\d{1,18})?$/.test(n.maxFeeEth)
    )
      fail('WALLET_AGENT_SCOPE_INVALID');
    policy.limits(n.limits);
    parseEther(n.maxFeeEth);
  }
  return context;
}
class WalletAgentScopes {
  constructor(wallet, write) {
    this.wallet = wallet;
    this.write = write;
    this.file = path.join(wallet.directory, 'agent-scope-fences.json');
    this.fences = new Map();
    this.epochs = new Map();
    this.challenges = new Map();
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error();
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        value.version !== 1 ||
        !value.fences ||
        typeof value.fences !== 'object' ||
        Array.isArray(value.fences) ||
        Object.keys(value.fences).length > 1000
      )
        throw Error();
      for (const [id, epoch] of Object.entries(value.fences)) {
        if (!validId(id) || typeof epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(epoch))
          throw Error();
        this.fences.set(id, epoch);
        this.epochs.set(id, epoch);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') fail('WALLET_AGENT_SCOPE_STORE_CORRUPT');
    }
  }
  assert(binding, epochs) {
    if (!binding) return;
    if (
      !validId(binding.id) ||
      !validSubject(binding.subject) ||
      !Array.isArray(binding.path) ||
      !binding.path.length ||
      binding.path.length > 8 ||
      binding.path[0] !== binding.id ||
      binding.path.some((id) => !validId(id))
    )
      fail('WALLET_AGENT_SCOPE_INVALID');
    for (const id of binding.path) {
      if (this.fences.has(id)) fail('WALLET_AGENT_SCOPE_FENCED');
      if (epochs && (this.epochs.get(id) ?? null) !== epochs[id])
        fail('WALLET_AGENT_SCOPE_CHANGED');
    }
  }
  epoch(binding) {
    return binding
      ? Object.fromEntries(binding.path.map((id) => [id, this.epochs.get(id) ?? null]))
      : null;
  }
  persist(fences = this.fences) {
    this.write(this.file, { version: 1, fences: Object.fromEntries(fences) });
  }
  async ensure(context, chainId, allowInactive = false) {
    validateContext(context);
    if (![8453, 84532].includes(chainId)) fail('WALLET_CHAIN_UNAVAILABLE');
    let parentId = null,
      snapshot;
    for (const node of context.nodes) {
      if (!node.chains.includes(chainId)) fail('WALLET_AGENT_SCOPE_FORBIDDEN');
      if (node.limits.tokens.length && !node.limits.tokens.some((t) => t.chainId === chainId))
        fail('WALLET_AGENT_SCOPE_FORBIDDEN');
      if (
        node.limits.period?.tokens.length &&
        !node.limits.period.tokens.some((t) => t.chainId === chainId)
      )
        fail('WALLET_AGENT_SCOPE_FORBIDDEN');
      const id = createHash('sha256')
        .update(JSON.stringify(['cibyp-agent-scope-v1', chainId, node.subject, parentId]))
        .digest('hex');
      snapshot = await this.wallet.signer('scope.ensure', {
        id,
        scope: {
          id,
          subject: node.subject,
          label: node.label,
          parentId,
          chainId,
          walletIds: node.walletIds,
          limits: policy.nativeLimits({
            ...node.limits,
            tokens: node.limits.tokens.filter((t) => t.chainId === chainId),
            ...(node.limits.period
              ? {
                  period: {
                    ...node.limits.period,
                    tokens: node.limits.period.tokens.filter((t) => t.chainId === chainId),
                  },
                }
              : {}),
          }),
          maxFeeWei: parseEther(node.maxFeeEth).toString(),
          expiresAt: node.expiresAt,
        },
      });
      parentId = id;
    }
    if (
      !snapshot ||
      snapshot.scope.subject !== context.nodes.at(-1).subject ||
      snapshot.rootSubject !== context.nodes[0].subject
    )
      fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    const binding = { id: snapshot.scope.id, subject: snapshot.scope.subject, path: snapshot.path };
    if (!allowInactive) {
      this.assert(binding);
      if (!snapshot.ready) fail(snapshot.reason || 'WALLET_AGENT_SCOPE_PAUSED');
    }
    return { binding, snapshot };
  }
  async binding(context, walletId, chainId) {
    validateContext(context);
    for (const node of context.nodes)
      if (node.walletIds.length && !node.walletIds.includes(walletId))
        fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    return (await this.ensure(context, chainId)).binding;
  }
  async fromBinding(binding, chainId, workspaceId) {
    if (!binding || !validId(binding.id) || !validSubject(binding.subject))
      fail('WALLET_AGENT_SCOPE_INVALID');
    const result = await this.get(binding.id);
    if (
      result.scope.subject !== binding.subject ||
      result.scope.chainId !== chainId ||
      result.rootSubject !== rootContext(workspaceId).nodes[0].subject
    )
      fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    const canonical = { id: result.scope.id, subject: result.scope.subject, path: result.path };
    this.assert(canonical);
    if (!result.ready) fail(result.reason || 'WALLET_AGENT_SCOPE_PAUSED');
    return canonical;
  }
  async get(id) {
    if (!validId(id)) fail('WALLET_AGENT_SCOPE_INVALID');
    const result = await this.wallet.signer('scope.get', { id });
    return { ...result, locallyBlocked: result.path.some((id) => this.fences.has(id)) };
  }
  async agentRequest(context, chainId, input) {
    const { binding, snapshot } = await this.ensure(context, chainId, true);
    if (input.action === 'status')
      return { ...snapshot, locallyBlocked: binding.path.some((id) => this.fences.has(id)) };
    if (input.action === 'list') {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 5;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 10000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20
      )
        fail('WALLET_AGENT_SCOPE_INVALID');
      const page = await this.wallet.signer('scope.list', {
        id: 'scopes',
        offset,
        agentScopeId: binding.id,
      });
      return {
        ...page,
        items: page.items.slice(0, limit),
        next: offset + limit < page.total ? offset + limit : null,
      };
    }
    if (!['get', 'pause', 'period_history'].includes(input.action))
      fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    const target = await this.get(input.scopeId || binding.id);
    if (input.action === 'get' || input.action === 'period_history') {
      if (!target.path.includes(binding.id) && !binding.path.includes(target.scope.id))
        fail('WALLET_AGENT_SCOPE_FORBIDDEN');
      return input.action === 'get'
        ? target
        : this.wallet.request('period.history', {
            kind: 'scope',
            id: target.scope.id,
            offset: input.offset,
            limit: input.limit,
          });
    }
    if (!target.path.includes(binding.id)) fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    if (input.revision !== undefined && input.revision !== target.revision)
      fail('WALLET_AGENT_SCOPE_CHANGED');
    if (target.state === 'paused') return target;
    return this.change(target.scope.id, 'paused', target.revision, binding.id);
  }
  async change(id, kind, revision, actor) {
    if (
      !validId(id) ||
      !['active', 'paused'].includes(kind) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      fail('WALLET_AGENT_SCOPE_INVALID');
    if (this.fences.size >= 1000 && !this.fences.has(id)) fail('WALLET_NATIVE_AUTH_LIMIT');
    const epoch = randomUUID();
    this.epochs.set(id, epoch);
    this.fences.set(id, epoch);
    for (const operation of this.wallet.inFlight.values())
      if (operation.agentScope?.path.includes(id))
        operation.controller.abort(Error('WALLET_AGENT_SCOPE_CHANGED'));
    this.wallet.emit();
    this.persist();
    try {
      const result = await this.wallet.signer('scope.state', {
        id,
        kind,
        expectedRevision: revision,
        ...(actor ? { agentScopeId: actor } : {}),
      });
      const remaining = new Map(this.fences);
      if (this.epochs.get(id) === epoch) remaining.delete(id);
      this.persist(remaining);
      this.fences = remaining;
      this.wallet.emit();
      return result;
    } catch (error) {
      this.wallet.emit();
      throw error;
    }
  }
  async request(action, input) {
    if (action === 'list') {
      const offset = input.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
        fail('WALLET_AGENT_SCOPE_INVALID');
      return this.wallet.signer('scope.list', { id: 'scopes', offset });
    }
    if (action === 'get') return this.get(input.id);
    if (action === 'pause') return this.change(input.id, 'paused', input.revision);
    if (action === 'challenge') {
      this.wallet.emergency.assert();
      const snapshot = await this.get(input.id);
      if (snapshot.revision !== input.revision) fail('WALLET_AGENT_SCOPE_CHANGED');
      if (input.kind !== undefined && !['active', 'recover'].includes(input.kind))
        fail('WALLET_AGENT_SCOPE_INVALID');
      const id = randomUUID();
      for (const [key, c] of this.challenges)
        if (c.expiresAt <= Date.now()) this.challenges.delete(key);
      if (this.challenges.size >= 64) fail('WALLET_NATIVE_AUTH_LIMIT');
      this.challenges.set(id, {
        id: input.id,
        revision: snapshot.revision,
        kind: input.kind || 'active',
        fence: this.fences.get(input.id),
        expiresAt: Date.now() + 120000,
      });
      return { id, snapshot, kind: input.kind || 'active' };
    }
    if (action === 'confirm') {
      const c = this.challenges.get(input.challengeId);
      this.challenges.delete(input.challengeId);
      if (
        !c ||
        c.expiresAt <= Date.now() ||
        input.ack !== 'ALLOW AGENT SCOPE' ||
        input.confirmed !== true
      )
        fail('WALLET_CONFIRMATION_REQUIRED');
      this.wallet.emergency.assert();
      if (c.kind === 'recover') {
        const snapshot = await this.get(c.id);
        if (snapshot.revision !== c.revision || this.fences.get(c.id) !== c.fence)
          fail('WALLET_AGENT_SCOPE_CHANGED');
        const remaining = new Map(this.fences);
        remaining.delete(c.id);
        this.persist(remaining);
        this.fences = remaining;
        this.wallet.emit();
        return { ...snapshot, locallyBlocked: snapshot.path.some((id) => remaining.has(id)) };
      }
      return this.change(c.id, 'active', c.revision);
    }
    fail('UNKNOWN_WALLET_ACTION');
  }
}
module.exports = { WalletAgentScopes, rootContext, deriveChild, validateContext };
