/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Waiting never signs or starts a plan. The caller rechecks all authority afterwards.
async function waitPeriod(wallet, context, input, signal) {
  const { validateContext } = require('./agent-scopes');
  validateContext(context);
  const kind = input.kind ?? 'scope',
    maxWaitMs = input.maxWaitMs ?? 86400000;
  if (
    !['scope', 'portfolio', 'wallet'].includes(kind) ||
    !Number.isSafeInteger(maxWaitMs) ||
    maxWaitMs < 1 ||
    maxWaitMs > 86400000
  )
    throw Error('WALLET_PERIOD_INVALID');
  const read = async () => {
    if (wallet.disposed) throw Error('WALLET_STOPPED');
    wallet.emergency.assert();
    signal?.throwIfAborted();
    let snapshot;
    if (kind === 'scope') {
      snapshot = await wallet.agentScopes.agentRequest(context, input.chainId, {
        action: input.id ? 'get' : 'status',
        scopeId: input.id,
      });
      if (snapshot.locallyBlocked) throw Error('WALLET_AGENT_SCOPE_FENCED');
      if (!snapshot.ready) throw Error(snapshot.reason || 'WALLET_AGENT_SCOPE_PAUSED');
    } else if (kind === 'portfolio') {
      snapshot = await wallet.portfolios.get(input.id);
      if (
        !context.nodes.every((n) => n.chains.includes(snapshot.portfolio.chainId)) ||
        !snapshot.portfolio.members.some((m) =>
          context.nodes.every((n) => !n.walletIds.length || n.walletIds.includes(m.walletId)),
        )
      )
        throw Error('WALLET_AGENT_SCOPE_FORBIDDEN');
      if (snapshot.portfolio.members.some((m) => wallet.portfolios.fences.has(m.walletId)))
        throw Error('WALLET_AUTHORIZATION_PENDING');
      if (snapshot.state !== 'active') throw Error('WALLET_PORTFOLIO_PAUSED');
      if (snapshot.portfolio.expiresAt && snapshot.portfolio.expiresAt <= Date.now())
        throw Error('WALLET_PORTFOLIO_EXPIRED');
    } else {
      if (!context.nodes.every((n) => !n.walletIds.length || n.walletIds.includes(input.id)))
        throw Error('WALLET_AGENT_SCOPE_FORBIDDEN');
      const w = wallet.wallet(input.id);
      if (w.policy.mode !== 'autonomous') throw Error('WALLET_NATIVE_AUTH_REQUIRED');
      snapshot = await wallet.request('policy.usage', { id: input.id });
      if (!snapshot || snapshot.revoked || (snapshot.expiresAt && snapshot.expiresAt <= Date.now()))
        throw Error('WALLET_NATIVE_AUTH_REQUIRED');
    }
    if (!snapshot.period) throw Error('WALLET_PERIOD_REQUIRED');
    if (snapshot.period.clockRollback) throw Error('WALLET_PERIOD_CLOCK_ROLLBACK');
    if (wallet.disposed) throw Error('WALLET_STOPPED');
    wallet.emergency.assert();
    signal?.throwIfAborted();
    return snapshot;
  };
  let observed = wallet.budgetEpoch,
    snapshot = await read();
  const original = snapshot.period,
    revision = snapshot.revision,
    deadline = performance.now() + maxWaitMs;
  while (performance.now() < deadline) {
    if (wallet.budgetWake.size >= 64) throw Error('WALLET_NATIVE_AUTH_LIMIT');
    await new Promise((resolve, reject) => {
      let timer;
      const clean = () => {
        clearTimeout(timer);
        wallet.budgetWake.delete(wake);
        signal?.removeEventListener('abort', aborted);
      };
      const wake = () => {
          clean();
          resolve();
        },
        aborted = () => {
          clean();
          reject(signal.reason || Error('WALLET_OPERATION_CANCELLED'));
        };
      wallet.budgetWake.add(wake);
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(
        wake,
        Math.max(
          1,
          Math.min(60000, deadline - performance.now(), snapshot.period.endMs - Date.now() + 10),
        ),
      );
      if (signal?.aborted) aborted();
      else if (wallet.budgetEpoch !== observed) wake();
    });
    observed = wallet.budgetEpoch;
    snapshot = await read();
    const current = snapshot.period;
    if (
      current.identity.id !== original.identity.id ||
      snapshot.revision !== revision ||
      current.originMs !== original.originMs
    )
      return { reset: false, changed: true, period: current };
    if (current.startMs > original.startMs) return { reset: true, changed: false, period: current };
  }
  return { reset: false, timedOut: true, period: snapshot.period };
}
module.exports = { waitPeriod };
