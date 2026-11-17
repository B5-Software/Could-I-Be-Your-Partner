/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseEther } = require('ethers');
const rules = require('./policy');
const { portfolioCapital, fingerprint } = require('./capital');
const { equityFloor, assessEquity } = require('./portfolio-equity');
const { PortfolioAllowances } = require('./portfolio-allowances');
const { PortfolioAllowanceMonitor } = require('./portfolio-allowance-monitor');
const { ceilingFromSnapshot } = require('./portfolio-allowance-ceiling');
const {
  portfolioPerformance,
  performanceRecords,
  feeEvidence,
  feeQuote,
} = require('./portfolio-performance');
const { page } = require('../quant/event-files');
const fail = (code) => {
  throw Error(code);
};
class WalletPortfolios {
  constructor(wallet, writeAtomic) {
    this.wallet = wallet;
    this.allowances = new PortfolioAllowances(this);
    this.allowanceMonitor = new PortfolioAllowanceMonitor(this);
    this.pricingFees = false;
    this.write = writeAtomic;
    this.file = path.join(wallet.directory, 'portfolio-fences.json');
    this.fences = new Map();
    this.epochs = new Map();
    this.challenges = new Map();
    this.members = new Map();
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
        if (
          !wallet.state.wallets.some((w) => w.id === id) ||
          typeof epoch !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(epoch)
        )
          throw Error();
        this.fences.set(id, epoch);
        this.epochs.set(id, epoch);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') fail('WALLET_PORTFOLIO_STORE_CORRUPT');
    }
  }
  assert(id, epoch) {
    if (this.fences.has(id)) fail('WALLET_PORTFOLIO_FENCED');
    if (epoch !== undefined && (this.epochs.get(id) ?? null) !== epoch)
      fail('WALLET_PORTFOLIO_CHANGED');
  }
  persist(fences = this.fences) {
    this.write(this.file, { version: 1, fences: Object.fromEntries(fences) });
  }
  async change(ids, action, input) {
    const epoch = randomUUID();
    const previousFences = new Map(this.fences);
    let awaitingNative = false;
    for (const id of ids) {
      this.wallet.signingWallet(id);
      this.fences.set(id, epoch);
      this.epochs.set(id, epoch);
      this.wallet.abortWallet(id, 'WALLET_PORTFOLIO_CHANGED');
    }
    this.wallet.emit();
    try {
      this.persist();
      awaitingNative = true;
      const result =
        action === 'portfolio.recover'
          ? await this.wallet
              .signer('portfolio.list', { id: 'portfolios', offset: 0 })
              .then(() => ({
                portfolio: { id: 'local-recovery', members: ids.map((id) => ({ walletId: id })) },
                state: 'recovered',
                revision: 0,
              }))
          : await this.wallet.signer(action, input);
      awaitingNative = false;
      const remaining = new Map(this.fences);
      for (const id of ids) if (this.epochs.get(id) === epoch) remaining.delete(id);
      this.persist(remaining);
      this.fences = remaining;
      this.members.set(
        result.portfolio.id,
        result.portfolio.members.map((m) => m.walletId),
      );
      await this.wallet.mutate((state) => {
        state.audit.push({
          time: Date.now(),
          type: action,
          id: result.portfolio.id,
          state: result.state,
          revision: result.revision,
        });
      });
      this.wallet.emit();
      return result;
    } catch (error) {
      // These create rejections occur before native writes. Restore only this
      // attempt's temporary fence, never an older unknown operation's fence.
      if (
        awaitingNative &&
        ['portfolio.create', 'portfolio.update'].includes(action) &&
        [
          'WALLET_PORTFOLIO_INVALID',
          'WALLET_PORTFOLIO_EQUITY_INVALID',
          'WALLET_PORTFOLIO_MEMBER_BUSY',
          'WALLET_NATIVE_AUTH_INVALID',
          'WALLET_NATIVE_AUTH_LIMIT',
          'WALLET_PERIOD_INVALID',
          'WALLET_PERIOD_SCHEDULE_CHANGED',
          'WALLET_BUDGET_ASSETS_FIXED',
          'WALLET_PORTFOLIO_MEMBER_CHANGED',
          'WALLET_PORTFOLIO_CHANGED',
        ].includes(error.message)
      ) {
        const remaining = new Map(this.fences);
        for (const id of ids)
          if (this.epochs.get(id) === epoch) {
            if (previousFences.has(id)) remaining.set(id, previousFences.get(id));
            else remaining.delete(id);
          }
        this.persist(remaining);
        this.fences = remaining;
      }
      this.wallet.emit();
      throw error;
    }
  }
  async get(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))
      fail('WALLET_PORTFOLIO_INVALID');
    const value = await this.wallet.signer('portfolio.get', { id });
    this.members.set(
      id,
      value.portfolio.members.map((m) => m.walletId),
    );
    return value;
  }
  async request(action, input, context = {}) {
    if (action.startsWith('allowanceMonitor.'))
      return this.allowanceMonitor.request(action.slice('allowanceMonitor.'.length), input);
    if (action.startsWith('allowances.'))
      return this.allowances.request(action.slice(11), input, context);
    if (action === 'list') {
      const offset = input.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000)
        fail('WALLET_PORTFOLIO_INVALID');
      const result = await this.wallet.signer('portfolio.list', { id: 'portfolios', offset });
      for (const p of result.items)
        this.members.set(
          p.id,
          p.members.map((m) => m.walletId),
        );
      return result;
    }
    if (action === 'get') return this.get(input.id);
    if (action === 'performance') {
      context.signal?.throwIfAborted();
      const { portfolio, revision } = await this.get(input.id);
      context.signal?.throwIfAborted();
      return portfolioPerformance(portfolio, revision, this.wallet.state.intents, input);
    }
    if (action === 'performance.priceFees') return this.pricePerformanceFees(input, context.signal);
    if (action === 'equity') {
      context.signal?.throwIfAborted();
      const initial = await this.get(input.id),
        p = initial.portfolio;
      const floor = p.equityFloorUsdAtomic;
      if (!floor || initial.state === 'removed') return { status: 'disabled', portfolioId: p.id };
      const network = this.wallet.networks.byId(p.chainId, true);
      const intents = this.wallet.state.intents;
      const version = fingerprint(intents, p.members, p.chainId);
      let result;
      try {
        result = await assessEquity(
          this.wallet.market,
          { venue: network.key },
          {
            id: p.id,
            revision: initial.revision,
            members: p.members,
            floorUsdAtomic: floor,
          },
          intents,
          context.signal,
        );
      } catch (error) {
        context.signal?.throwIfAborted();
        result = {
          status: 'unavailable',
          portfolioId: p.id,
          floorUsdAtomic: floor,
          error: error.message,
        };
      }
      const current = await this.get(p.id);
      context.signal?.throwIfAborted();
      if (current.revision !== initial.revision || current.state !== initial.state)
        fail('WALLET_PORTFOLIO_CHANGED');
      this.wallet.networks.assert(network.key, network.revision);
      if (fingerprint(this.wallet.state.intents, p.members, p.chainId) !== version)
        fail('WALLET_CAPITAL_CHANGED');
      return { ...result, portfolioState: current.state };
    }
    if (action === 'holdings') {
      context.signal?.throwIfAborted();
      const initial = await this.get(input.id),
        p = initial.portfolio;
      const network = this.wallet.networks.byId(p.chainId),
        venue = network.key;
      const tokens = [
        ...new Set(
          [...(p.limits.tokens ?? []), ...(p.limits.period?.tokens ?? [])].map(
            (token) => token.address,
          ),
        ),
      ];
      const members = p.members.map((member) => ({
        ...member,
        name:
          this.wallet.state.wallets.find((w) => w.id === member.walletId)?.name ?? member.walletId,
      }));
      const intents = this.wallet.state.intents;
      const capitalVersion = fingerprint(intents, members, p.chainId);
      let holdings;
      try {
        holdings = await this.wallet.market.portfolioHoldings(
          { venue },
          { members, tokens, valuation: input.valuation === true },
          { signal: context.signal },
        );
      } catch (error) {
        if (error.name === 'TimeoutError') fail('WALLET_ASSET_TIMEOUT');
        throw error;
      }
      const current = await this.get(input.id);
      context.signal?.throwIfAborted();
      if (current.revision !== initial.revision || current.state !== initial.state)
        fail('WALLET_PORTFOLIO_CHANGED');
      if (this.wallet.networks.profile(venue).revision !== network.revision)
        fail('WALLET_NETWORK_CHANGED');
      if (fingerprint(this.wallet.state.intents, members, p.chainId) !== capitalVersion)
        fail('WALLET_CAPITAL_CHANGED');
      return {
        ...portfolioCapital(holdings, intents),
        portfolioId: p.id,
        name: p.name,
        revision: initial.revision,
        state: initial.state,
      };
    }
    if (action === 'revisions' || action === 'revision') {
      await this.get(input.id);
      const offset = input.offset ?? 0;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 200000 ||
        (action === 'revision' && (!Number.isSafeInteger(input.revision) || input.revision < 1))
      )
        fail('WALLET_PORTFOLIO_INVALID');
      return this.wallet.signer('portfolio.' + action, {
        id: input.id,
        offset,
        ...(action === 'revision' ? { expectedRevision: input.revision } : {}),
      });
    }
    if (action === 'pause') {
      const ids =
        this.members.get(input.id) ??
        (await this.get(input.id)).portfolio.members.map((m) => m.walletId);
      if (!Number.isSafeInteger(input.revision) || input.revision < 1)
        fail('WALLET_PORTFOLIO_CHANGED');
      return this.change(ids, 'portfolio.state', {
        id: input.id,
        kind: 'paused',
        expectedRevision: input.revision,
      });
    }
    if (action === 'challenge') {
      this.wallet.emergency.assert();
      let command, ids;
      if (input.operation === 'create') {
        if (
          typeof input.name !== 'string' ||
          !input.name.trim() ||
          input.name.length > 80 ||
          /[\x00-\x1f\x7f]/.test(input.name) ||
          !Array.isArray(input.walletIds) ||
          !input.walletIds.length ||
          input.walletIds.length > 16 ||
          new Set(input.walletIds).size !== input.walletIds.length
        )
          fail('WALLET_PORTFOLIO_INVALID');
        const network = this.wallet.networks.byId(input.chainId, true);
        if (!network.supportsType2) fail('WALLET_NETWORK_TYPE');
        const limits = rules.limits(input.limits),
          hours = input.hours ?? 24,
          maxFeeEth = input.maxFeeEth ?? '0.01';
        if (
          !Number.isInteger(hours) ||
          hours < 0 ||
          hours > 720 ||
          typeof maxFeeEth !== 'string' ||
          !/^\d{1,30}(?:\.\d{1,18})?$/.test(maxFeeEth) ||
          [...limits.tokens, ...(limits.period?.tokens ?? [])].some(
            (t) => t.chainId !== input.chainId,
          )
        )
          fail('WALLET_PORTFOLIO_INVALID');
        ids = input.walletIds.slice();
        const floor = equityFloor(input.equityFloorUsd ?? null, input.chainId);
        const id = randomUUID(),
          portfolio = {
            id,
            name: input.name.trim(),
            chainId: input.chainId,
            members: ids.map((id) => {
              const w = this.wallet.signingWallet(id);
              return { walletId: w.id, address: w.address };
            }),
            limits: rules.nativeLimits(limits),
            maxFeeWei: parseEther(maxFeeEth).toString(),
            expiresAt: hours ? Date.now() + hours * 3600000 : 0,
            ...(floor && { equityFloorUsdAtomic: floor }),
          };
        command = { action: 'portfolio.create', input: { id, portfolio } };
      } else if (input.operation === 'edit') {
        const current = await this.get(input.id);
        if (current.state === 'removed' || current.revision !== input.revision)
          fail('WALLET_PORTFOLIO_CHANGED');
        const name = input.name ?? current.portfolio.name,
          limits = rules.limits(input.limits),
          maxFeeEth = input.maxFeeEth ?? '0.01',
          hours = input.hours;
        if (
          typeof name !== 'string' ||
          !name.trim() ||
          name.length > 80 ||
          /[\x00-\x1f\x7f]/.test(name) ||
          typeof maxFeeEth !== 'string' ||
          !/^\d{1,30}(?:\.\d{1,18})?$/.test(maxFeeEth) ||
          (hours !== undefined && (!Number.isInteger(hours) || hours < 0 || hours > 720)) ||
          [...limits.tokens, ...(limits.period?.tokens ?? [])].some(
            (t) => t.chainId !== current.portfolio.chainId,
          )
        )
          fail('WALLET_PORTFOLIO_INVALID');
        ids = current.portfolio.members.map((m) => m.walletId);
        const portfolio = {
          ...current.portfolio,
          name: name.trim(),
          limits: rules.nativeLimits(limits),
          maxFeeWei: parseEther(maxFeeEth).toString(),
          expiresAt:
            hours === undefined
              ? current.portfolio.expiresAt
              : hours
                ? Date.now() + hours * 3600000
                : 0,
        };
        if (input.equityFloorUsd !== undefined) {
          const floor = equityFloor(input.equityFloorUsd, portfolio.chainId);
          if (floor) portfolio.equityFloorUsdAtomic = floor;
          else delete portfolio.equityFloorUsdAtomic;
        }
        command = {
          action: 'portfolio.update',
          input: { id: input.id, portfolio, expectedRevision: current.revision },
        };
      } else if (input.operation === 'allowance-ceiling') {
        const current = await this.get(input.id);
        if (current.state === 'removed' || current.revision !== input.revision)
          fail('WALLET_PORTFOLIO_CHANGED');
        const portfolio = { ...current.portfolio };
        ids = portfolio.members.map((m) => m.walletId);
        if (input.ceiling === null) delete portfolio.allowanceCeiling;
        else {
          if (!input.ceiling) fail('WALLET_PORTFOLIO_ALLOWANCE_INVALID');
          const report = this.allowances.load(portfolio.id, input.ceiling.reportId);
          portfolio.allowanceCeiling = ceilingFromSnapshot(input.ceiling, report, current);
        }
        command = {
          action: 'portfolio.update',
          input: { id: input.id, portfolio, expectedRevision: current.revision },
        };
      } else if (input.operation === 'recover') {
        if (
          !Array.isArray(input.walletIds) ||
          !input.walletIds.length ||
          input.walletIds.length > 16 ||
          new Set(input.walletIds).size !== input.walletIds.length
        )
          fail('WALLET_PORTFOLIO_INVALID');
        ids = input.walletIds.slice();
        for (const id of ids) this.wallet.wallet(id);
        command = { action: 'portfolio.recover', input: { id: 'local-recovery' } };
      } else if (['active', 'removed'].includes(input.operation)) {
        const current = await this.get(input.id);
        if (current.state === 'removed' || current.revision !== input.revision)
          fail('WALLET_PORTFOLIO_CHANGED');
        ids = current.portfolio.members.map((m) => m.walletId);
        command = {
          action: 'portfolio.state',
          input: { id: input.id, kind: input.operation, expectedRevision: current.revision },
        };
      } else fail('WALLET_PORTFOLIO_INVALID');
      let network;
      if (
        ['portfolio.create', 'portfolio.update'].includes(command.action) ||
        input.operation === 'active'
      ) {
        const chainId =
          command.input.portfolio?.chainId ?? (await this.get(input.id)).portfolio.chainId;
        const profile = this.wallet.networks.byId(chainId, true);
        if (!profile.supportsType2) fail('WALLET_NETWORK_TYPE');
        network = { key: profile.key, revision: profile.revision };
      }
      const id = randomUUID();
      for (const [key, value] of this.challenges)
        if (value.expiresAt <= Date.now()) this.challenges.delete(key);
      if (this.challenges.size >= 64) fail('WALLET_NATIVE_AUTH_LIMIT');
      this.challenges.set(id, { command, ids, network, expiresAt: Date.now() + 120000 });
      return {
        id,
        expiresAt: Date.now() + 120000,
        operation: input.operation,
        portfolio:
          command.input.portfolio ??
          (input.operation === 'recover'
            ? {
                members: ids.map((id) => ({
                  walletId: id,
                  address: this.wallet.wallet(id).address,
                })),
              }
            : (await this.get(input.id)).portfolio),
      };
    }
    if (action === 'confirm') {
      const challenge = this.challenges.get(input.challengeId);
      this.challenges.delete(input.challengeId);
      if (
        !challenge ||
        challenge.expiresAt <= Date.now() ||
        input.ack !== 'ALLOW PORTFOLIO' ||
        input.confirmed !== true
      )
        fail('WALLET_CONFIRMATION_REQUIRED');
      this.wallet.emergency.assert();
      if (challenge.network)
        this.wallet.networks.assert(challenge.network.key, challenge.network.revision);
      return this.change(challenge.ids, challenge.command.action, challenge.command.input);
    }
    fail('UNKNOWN_WALLET_ACTION');
  }
  async pricePerformanceFees(input, signal) {
    signal?.throwIfAborted();
    if (this.pricingFees) fail('WALLET_FEE_PRICE_BUSY');
    this.pricingFees = true;
    try {
      const { portfolio, revision } = await this.get(input.id);
      if (portfolio.chainId !== 8453) fail('WALLET_PRICE_NETWORK');
      const byWallet = performanceRecords(portfolio, this.wallet.state.intents, input);
      const records = [...byWallet.values()].flatMap(({ records }) => records.filter(feeEvidence));
      const network = this.wallet.networks.byId(8453, true);
      const limit = input.limit ?? 6;
      if (!Number.isInteger(limit) || limit > 8) fail('INVALID_PAGINATION');
      const { items, next, total } = page(records, { offset: input.offset, limit });
      const verifiedBlocks = new Map(),
        refreshed = new Map(),
        errors = new Set();
      let unavailable = 0;
      for (const intent of items) {
        signal?.throwIfAborted();
        if (feeQuote(intent)) continue;
        const evidence = feeEvidence(intent);
        const key = `${intent.block}:${evidence.blockHash}`;
        if (!verifiedBlocks.has(key)) {
          const timeout = AbortSignal.timeout(5000);
          const quoteSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          try {
            const value = await this.wallet.market.baseFeeQuote(
              { venue: network.key },
              intent.block,
              evidence.blockHash,
              quoteSignal,
            );
            verifiedBlocks.set(key, { value });
          } catch (error) {
            signal?.throwIfAborted();
            const code = /^(WALLET_PRICE_[A-Z_]+|BLOCK_REORG|CHAIN_ID_MISMATCH)$/.test(
              error?.message,
            )
              ? error.message
              : 'WALLET_PRICE_UNAVAILABLE';
            verifiedBlocks.set(key, { code });
          }
        }
        const { code, value } = verifiedBlocks.get(key);
        if (code) {
          errors.add(code);
          unavailable++;
        } else refreshed.set(intent.id, { txHash: evidence.txHash, quote: value });
      }
      const current = await this.get(input.id);
      if (current.revision !== revision || current.portfolio.chainId !== portfolio.chainId)
        fail('WALLET_PORTFOLIO_CHANGED');
      const guard = () => {
        signal?.throwIfAborted();
        this.wallet.networks.assert(network.key, network.revision);
      };
      guard();
      const saved = refreshed.size
        ? await this.wallet.mutate((state) => {
            let applied = 0;
            for (const intent of state.intents) {
              const entry = refreshed.get(intent.id);
              if (!entry) continue;
              const evidence = feeEvidence(intent);
              if (
                !evidence ||
                evidence.txHash !== entry.txHash ||
                evidence.blockHash !== entry.quote.blockHash ||
                intent.block !== entry.quote.blockNumber
              )
                continue;
              if (!feeQuote(intent)) {
                evidence.feeQuote = entry.quote;
                applied++;
              }
            }
            return applied;
          }, guard)
        : 0;
      return {
        next,
        total,
        saved,
        unavailable: unavailable + refreshed.size - saved,
        errors: [...errors],
      };
    } finally {
      this.pricingFees = false;
    }
  }
}
module.exports = { WalletPortfolios };
