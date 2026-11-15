/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getAddress, ZeroAddress } = require('ethers');
const { boundedRpc, CHAINS, formatUnits } = require('../quant/market-data');
const { PERMIT2 } = require('../quant/permit2');
const { write, read, digest, page } = require('../quant/event-files');

const MAX_PAIRS = 256;
const MAX_REPORTS = 256;
const reportPattern = /^\d{13}-[\da-f]{64}$/;
const min = (a, b) => (a < b ? a : b);
const keyOf = ({ walletId, token, spender, protocol }) =>
  `${walletId}:${token}:${spender}:${protocol}`;
const fail = (code) => {
  throw Error(code);
};
const cleanError = (error) =>
  /^[A-Z][A-Z_0-9]{1,80}$/.test(error?.message || '')
    ? error.message
    : 'WALLET_ALLOWANCE_READ_FAILED';
const nonzero = (value) => {
  const address = getAddress(value);
  if (address === ZeroAddress) fail('INVALID_ADDRESS');
  return address;
};
const isPermit2 = (value) => value.toLowerCase() === PERMIT2.toLowerCase();
function nextUnscanned(ranges) {
  if (!ranges.length) return null;
  const sorted = [...ranges].sort((a, b) =>
    BigInt(a.toBlock) > BigInt(b.toBlock) ? -1 : BigInt(a.toBlock) < BigInt(b.toBlock) ? 1 : 0,
  );
  let cursor = BigInt(sorted[0].toBlock) + 1n;
  for (const range of sorted) {
    if (BigInt(range.toBlock) + 1n < cursor) break;
    cursor = min(cursor, BigInt(range.fromBlock));
  }
  return cursor ? String(cursor - 1n) : null;
}

function display(value, decimals) {
  return {
    atomic: value === null ? null : String(value),
    amount: value === null || decimals === null ? null : formatUnits(value, decimals),
  };
}

function evaluate(balance, direct, ordered, upstream) {
  if (balance === null) return { measured: null, includingPermit2: null };
  const routed = upstream === null ? 0n : min(upstream, ordered);
  return {
    measured: min(balance, direct + routed),
    includingPermit2: upstream === null ? null : min(balance, direct + upstream),
  };
}

class PortfolioAllowances {
  constructor(portfolios) {
    this.portfolios = portfolios;
    this.wallet = portfolios.wallet;
    this.directory = path.join(this.wallet.directory, 'portfolio-allowances');
    this.active = new Set();
  }
  folder(id) {
    return path.join(this.directory, id);
  }
  files(id) {
    try {
      return fs
        .readdirSync(this.folder(id))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .filter((name) => reportPattern.test(name))
        .sort()
        .reverse();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  load(id, reportId) {
    if (typeof reportId !== 'string' || !reportPattern.test(reportId))
      fail('WALLET_ALLOWANCE_REPORT_INVALID');
    const file = path.join(this.folder(id), reportId + '.json');
    let data;
    try {
      if (fs.lstatSync(file).size > 2 * 1024 * 1024) fail('WALLET_ALLOWANCE_REPORT_INVALID');
      data = read(file);
    } catch {
      fail('WALLET_ALLOWANCE_REPORT_INVALID');
    }
    if (
      data?.version !== 1 ||
      data.portfolioId !== id ||
      reportId !== `${data.observedAt}-${digest(data)}`
    )
      fail('WALLET_ALLOWANCE_REPORT_INVALID');
    return { reportId, ...data };
  }
  summary(report) {
    const { reportId, chainId, observedAt, block, blockHash, coverage, totals } = report;
    return { reportId, chainId, observedAt, block, blockHash, coverage, totals };
  }
  view(report, input) {
    if (input.filter !== undefined && !['all', 'review'].includes(input.filter))
      fail('WALLET_ALLOWANCE_REPORT_INVALID');
    const rows =
      input.filter === 'review'
        ? report.rows.filter((row) => row.status !== 'inactive')
        : report.rows;
    return { ...this.summary(report), ...page(rows, input) };
  }
  async request(action, input, context) {
    context.signal?.throwIfAborted();
    const initial = await this.portfolios.get(input.id);
    const id = initial.portfolio.id;
    if (action === 'list') {
      const result = page(this.files(id), input);
      return {
        ...result,
        items: result.items.map((reportId) => this.summary(this.load(id, reportId))),
      };
    }
    if (action === 'get') return this.view(this.load(id, input.reportId), input);
    if (action !== 'scan') fail('UNKNOWN_WALLET_ACTION');
    if (this.files(id).length >= MAX_REPORTS) fail('WALLET_ALLOWANCE_REPORT_LIMIT');
    page([], input);
    if (input.filter !== undefined && !['all', 'review'].includes(input.filter))
      fail('WALLET_ALLOWANCE_REPORT_INVALID');
    return this.view(await this.run(initial, input, context.signal), input);
  }
  async run(initial, input, requestSignal, checkpoint) {
    const id = initial.portfolio.id;
    if (this.active.has(id) || this.active.size >= 2) fail('WALLET_ALLOWANCE_REPORT_BUSY');
    this.active.add(id);
    const timeout = AbortSignal.timeout(60000);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
    try {
      return await this.scan(initial, input, signal, checkpoint);
    } finally {
      this.active.delete(id);
    }
  }
  async scan(initial, input, signal, checkpoint) {
    signal.throwIfAborted();
    const p = initial.portfolio;
    const network = this.wallet.networks.byId(p.chainId, true);
    const config = { venue: network.key };
    const chain = CHAINS[network.key];
    if (!chain || !['base', 'base-sepolia'].includes(network.key))
      fail('WALLET_ALLOWANCE_REPORT_CHAIN');
    const members = p.members.map((member) => ({
      ...member,
      name: this.wallet.wallet(member.walletId).name,
    }));
    const memberIds = members.map(({ walletId }) => walletId).sort();
    const configured = [...(p.limits.tokens || []), ...(p.limits.period?.tokens || [])];
    const scope = [
      ...new Set(
        [chain.weth, chain.usdc, ...configured.map((token) => token.address)].map(nonzero),
      ),
    ].sort();
    const tokens = input.token === undefined ? scope : [nonzero(input.token)];
    const mode = checkpoint ? 'advance' : (input.mode ?? 'recent');
    let blocks = input.blocks ?? 1000;
    const previous =
      checkpoint ?? (input.previousReportId ? this.load(p.id, input.previousReportId) : null);
    const manual = input.candidates ?? [];
    if (
      (!checkpoint && !['recent', 'older', 'refresh'].includes(mode)) ||
      !Number.isInteger(blocks) ||
      blocks < 1 ||
      blocks > 2000 ||
      (mode !== 'recent' && !previous) ||
      !Array.isArray(manual) ||
      manual.length > 32
    )
      fail('WALLET_ALLOWANCE_REPORT_INVALID');
    if (members.length * tokens.length > 128) fail('WALLET_ALLOWANCE_REPORT_LIMIT');
    if (
      previous &&
      (previous.chainId !== p.chainId ||
        digest(previous.coverage.tokens) !== digest(tokens) ||
        digest(previous.coverage.memberIds) !== digest(memberIds))
    )
      fail('WALLET_ALLOWANCE_REPORT_SCOPE');
    if (mode === 'older' && previous.coverage.nextEndBlock === null)
      fail('WALLET_ALLOWANCE_REPORT_RANGE_END');
    const pairs = new Map();
    let omitted = 0;
    const put = (candidate) => {
      const key = keyOf(candidate);
      const existing = pairs.get(key);
      if (existing) {
        if (
          candidate.event &&
          (!existing.event || BigInt(candidate.event.block) >= BigInt(existing.event.block))
        )
          pairs.set(key, candidate);
        return;
      }
      if (pairs.size >= MAX_PAIRS) {
        omitted++;
        return;
      }
      pairs.set(key, candidate);
    };
    for (const row of manual) {
      const protocol = row?.protocol ?? 'erc20';
      if (
        !members.some(({ walletId }) => walletId === row?.walletId) ||
        !['erc20', 'permit2'].includes(protocol)
      )
        fail('WALLET_ALLOWANCE_REPORT_INVALID');
      const token = nonzero(row.token),
        spender = nonzero(row.spender);
      if (!tokens.includes(token)) fail('WALLET_ALLOWANCE_REPORT_SCOPE');
      put({ walletId: row.walletId, token, spender, protocol, source: 'manual' });
    }
    for (const old of previous?.rows ?? []) {
      const { walletId, token, spender, protocol, source, event } = old;
      if (source !== 'upstream')
        put({ walletId, token, spender, protocol, source, ...(event && { event }) });
    }
    for (const member of members) {
      for (const rule of configured) {
        const token = nonzero(rule.address);
        if (!tokens.includes(token)) continue;
        for (const spender of (rule.spenders || []).map(nonzero))
          put({
            walletId: member.walletId,
            token,
            spender,
            protocol: 'erc20',
            source: 'configured',
          });
      }
    }
    const rawConnection = await this.wallet.market.connect(config, { signal });
    const rpc = boundedRpc(rawConnection.rpc);
    const cache = new Map();
    let connection = {
      ...rawConnection,
      rpc: (method, params) => {
        if (method !== 'eth_call') return rpc(method, params);
        const key = JSON.stringify(params);
        if (!cache.has(key)) cache.set(key, rpc(method, params));
        return cache.get(key);
      },
    };
    const canonical = async (number, hash) => {
      const block = await rpc('eth_getBlockByNumber', ['0x' + BigInt(number).toString(16), false]);
      if (block?.hash !== hash) fail('BLOCK_REORG');
    };
    if (previous) {
      if (checkpoint && connection.height < BigInt(previous.block))
        fail('WALLET_ALLOWANCE_MONITOR_NODE_BEHIND');
      try {
        await canonical(previous.block, previous.blockHash);
      } catch (error) {
        if (checkpoint && error.message === 'BLOCK_REORG') fail('WALLET_ALLOWANCE_MONITOR_REBASE');
        throw error;
      }
    }
    if (checkpoint) {
      const elapsed = connection.height - BigInt(checkpoint.block);
      if (!elapsed) return checkpoint;
      blocks = Number(min(BigInt(blocks), elapsed));
      if (BigInt(blocks) < elapsed) {
        const height = BigInt(checkpoint.block) + BigInt(blocks);
        const block = await rpc('eth_getBlockByNumber', ['0x' + height.toString(16), false]);
        if (!/^0x[\da-f]{64}$/i.test(block?.hash || '') || BigInt(block.number) !== height)
          fail('INVALID_BLOCK');
        connection = { ...connection, block, height, timestamp: BigInt(block.timestamp) };
      }
    }
    const scanErrors = [];
    let window = null,
      truncatedSources = 0;
    let nextEndBlock = previous?.coverage.nextEndBlock ?? null;
    const scannedRanges = (previous?.coverage.scannedRanges ?? []).slice();
    if (mode !== 'refresh') {
      const end = mode === 'older' ? BigInt(previous.coverage.nextEndBlock) : connection.height;
      const start = end >= BigInt(blocks) ? end - BigInt(blocks) + 1n : 0n;
      const anchor =
        end === connection.height
          ? connection.block
          : await rpc('eth_getBlockByNumber', ['0x' + end.toString(16), false]);
      if (!/^0x[\da-f]{64}$/i.test(anchor?.hash || '')) fail('INVALID_BLOCK');
      window = { fromBlock: String(start), toBlock: String(end), anchorHash: anchor.hash };
      const sources = await Promise.all(
        members.flatMap(({ walletId, address }) =>
          ['erc20', 'permit2'].map(async (protocol) => {
            try {
              return {
                walletId,
                protocol,
                data: await this.wallet.market.discoverTokenApprovals(
                  config,
                  {
                    address,
                    protocol,
                    blocks,
                    endBlock: String(end),
                    anchorHash: anchor.hash,
                    limit: 50,
                  },
                  { signal, connection, tokens },
                ),
              };
            } catch (error) {
              signal.throwIfAborted();
              if (error.message === 'BLOCK_REORG') throw error;
              return { walletId, protocol, error: cleanError(error) };
            }
          }),
        ),
      );
      for (const { walletId, protocol, data, error } of sources) {
        if (error) {
          scanErrors.push({ walletId, protocol, error });
          continue;
        }
        if (data.nextOffset !== null) truncatedSources++;
        for (const { token, spender, ...event } of data.items)
          put({ walletId, token, spender, protocol, source: 'events', event });
      }
      await canonical(end, anchor.hash);
      if (!checkpoint && !scanErrors.length && !truncatedSources && !omitted) {
        if (scannedRanges.length >= MAX_REPORTS) fail('WALLET_ALLOWANCE_REPORT_LIMIT');
        if (
          !scannedRanges.some(
            (range) => range.anchorHash === anchor.hash && range.fromBlock === window.fromBlock,
          )
        )
          scannedRanges.push(window);
        nextEndBlock = nextUnscanned(scannedRanges);
      } else if (!checkpoint) nextEndBlock = String(end);
    }
    const memberMap = new Map(members.map((member) => [member.walletId, member]));
    const allPairs = [...pairs.values()];
    for (const { walletId } of members)
      for (const token of tokens) {
        const pair = { walletId, token, spender: PERMIT2, protocol: 'erc20' };
        if (!pairs.has(keyOf(pair))) allPairs.push({ ...pair, source: 'upstream' });
      }
    const [holdings, observations] = await Promise.all([
      this.wallet.market.portfolioHoldings(
        config,
        {
          members,
          tokens: tokens.filter((token) => ![chain.weth, chain.usdc].includes(token.toLowerCase())),
        },
        { signal, connection },
      ),
      Promise.all(
        allPairs.map(async (row) => {
          const member = memberMap.get(row.walletId);
          try {
            return {
              ...row,
              ...(await this.wallet.market.tokenAllowance(
                config,
                { ...row, address: member.address },
                { signal, connection },
              )),
            };
          } catch (error) {
            signal.throwIfAborted();
            if (error.message === 'BLOCK_REORG') throw error;
            return { ...row, address: member.address, error: cleanError(error) };
          }
        }),
      ),
    ]);
    if (previous) await canonical(previous.block, previous.blockHash);
    const current = await this.portfolios.get(p.id);
    await canonical(connection.height, connection.block.hash);
    signal.throwIfAborted();
    if (current.revision !== initial.revision || current.state !== initial.state)
      fail('WALLET_PORTFOLIO_CHANGED');
    this.wallet.networks.assert(network.key, network.revision);
    const { rows, totals, unknownBalances } = this.summarize(
      tokens,
      holdings.members,
      observations,
      previous,
    );
    const report = {
      version: 1,
      portfolioId: p.id,
      portfolioRevision: initial.revision,
      chainId: p.chainId,
      block: String(connection.height),
      blockHash: connection.block.hash,
      blockTimestamp: Number(connection.timestamp),
      observedAt: Date.now(),
      previousReportId: previous?.reportId ?? null,
      coverage: {
        mode,
        tokens,
        memberIds,
        window,
        scannedRanges,
        ...(checkpoint && {
          monitoredRange: {
            fromBlock: previous.coverage.monitoredRange?.fromBlock ?? window.fromBlock,
            toBlock: window.toBlock,
            anchorHash: window.anchorHash,
          },
          monitorLagBlocks: String(rawConnection.height - connection.height),
        }),
        nextEndBlock,
        omitted,
        truncatedSources,
        scanErrors,
        scanIncomplete:
          mode === 'refresh'
            ? previous.coverage.scanIncomplete
            : Boolean(omitted || truncatedSources || scanErrors.length),
        unreadablePairs: rows.filter((row) => row.status === 'unavailable').length,
        unknownBalances,
      },
      rows,
      totals,
    };
    const reportId = `${report.observedAt}-${digest(report)}`;
    if (!checkpoint) write(path.join(this.folder(p.id), reportId + '.json'), report);
    return { reportId, ...report };
  }
  summarize(tokens, members, observations, previous) {
    const rows = [];
    const totals = [];
    let unknownBalances = 0;
    const old = new Map((previous?.rows ?? []).map((row) => [keyOf(row), row.effectiveAtoms]));
    for (const token of tokens) {
      let known = 0n,
        capacity = 0n,
        balanceTotal = 0n;
      let complete = true,
        capacityComplete = true,
        balanceComplete = true;
      let metadata;
      for (const member of members) {
        const asset = member.assets.find((row) => row.address === token);
        const balance = asset?.amountAtomic == null ? null : BigInt(asset.amountAtomic);
        metadata ??= asset;
        if (balance === null) {
          unknownBalances++;
          balanceComplete = false;
        } else balanceTotal += balance;
        let direct = 0n,
          ordered = 0n,
          upstream = null;
        const memberRows = observations.filter(
          (row) => row.walletId === member.walletId && row.token === token,
        );
        for (const row of memberRows) {
          const outer = row.protocol === 'erc20' && isPermit2(row.spender);
          const amount = row.error
            ? null
            : BigInt(
                row.protocol === 'permit2' ? row.permit2.effectiveAmountAtomic : row.amountAtomic,
              );
          if (amount === null) complete = false;
          else if (outer) upstream = amount;
          else if (row.protocol === 'permit2') ordered += amount;
          else direct += amount;
          const previousAmount = old.get(keyOf(row));
          rows.push({
            walletId: row.walletId,
            walletName: member.name,
            address: row.address,
            token,
            spender: row.spender,
            protocol: row.protocol,
            source: row.source,
            upstream: outer,
            symbol: asset?.symbol,
            decimals: asset?.decimals ?? null,
            status:
              amount === null
                ? 'unavailable'
                : amount
                  ? 'active'
                  : row.permit2 && !row.permit2.expired && BigInt(row.amountAtomic)
                    ? 'latent'
                    : 'inactive',
            effectiveAtoms: amount === null ? null : String(amount),
            spendable: display(
              amount === null || balance === null ? null : min(amount, balance),
              asset?.decimals ?? null,
            ),
            allowance: row.amountAtomic ?? null,
            unlimited: row.unlimited ?? false,
            ...(row.permit2 && { expiresAt: row.permit2.expiration, expired: row.permit2.expired }),
            ...(row.error && { error: row.error }),
            ...(row.event && { event: row.event }),
            ...(previousAmount != null &&
              amount !== null && { changedAtoms: String(amount - BigInt(previousAmount)) }),
          });
        }
        const value = evaluate(balance, direct, ordered, upstream);
        if (value.measured === null) complete = false;
        else known += value.measured;
        if (value.includingPermit2 === null) capacityComplete = false;
        else capacity += value.includingPermit2;
        if (memberRows.some((row) => row.protocol === 'erc20' && row.error))
          capacityComplete = false;
      }
      const decimals = metadata?.decimals ?? null;
      totals.push({
        token,
        symbol: metadata?.symbol ?? null,
        decimals,
        complete,
        capacityComplete,
        balanceComplete,
        balance: display(balanceComplete ? balanceTotal : null, decimals),
        measured: display(known, decimals),
        includingPermit2: display(capacityComplete ? capacity : null, decimals),
      });
    }
    return { rows, totals, unknownBalances };
  }
}

module.exports = { PortfolioAllowances };
