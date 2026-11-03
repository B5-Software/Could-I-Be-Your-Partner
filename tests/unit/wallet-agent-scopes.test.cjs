/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { keccak256 } = require('ethers');
const { Interface } = require('ethers');
const { WalletService } = require('../../src/main/services/wallet');
const {
  rootContext,
  deriveChild,
  validateContext,
} = require('../../src/main/services/wallet/agent-scopes');
const password = 'public-agent-scope-fixture-password';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-agent-scope-')),
    writes = [];
  let nonce = 0,
    service;
  const fetcher = async (_url, options) => {
    const b = JSON.parse(options.body);
    let result;
    if (b.method === 'eth_sendRawTransaction') {
      writes.push(b);
      nonce++;
      result = keccak256(b.params[0]);
    } else
      result = {
        eth_chainId: '0x2105',
        eth_getTransactionCount: '0x' + nonce.toString(16),
        eth_gasPrice: '0x989680',
        eth_maxPriorityFeePerGas: '0xf4240',
        eth_getBalance: '0x8ac7230489e80000',
        eth_estimateGas: '0x5208',
        eth_call: '0x' + '0'.repeat(64),
        eth_getTransactionReceipt: null,
        eth_getBlockByNumber: {
          number: '0x100',
          hash: '0x' + 'a'.repeat(64),
          timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        },
      }[b.method];
    assert.notEqual(result, undefined, b.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  service = new WalletService({ directory, fetcher });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const wallet = await service.request('import', {
    name: 'Public test wallet',
    kind: 'privateKey',
    secret: '0x' + '01'.padStart(64, '0'),
    password,
  });
  const unlock = async () => service.request('unlock', { id: wallet.id, password, minutes: 0 });
  const grant = async () => {
    const c = await service.request('policy.challenge', { id: wallet.id, chains: [8453] });
    return service.request('policy.grant', {
      challengeId: c.id,
      ack: 'ALLOW LIVE',
      confirmed: true,
    });
  };
  await unlock();
  await grant();
  const parent = deriveChild(rootContext('project-a'), 'native-sub-parent', {
    walletIds: [wallet.id],
    limits: { maxTransactions: 2, maxTotalValueEth: '0.002' },
  });
  const pay = (context, commandId) =>
    service.transact(
      { venue: 'base' },
      { walletId: wallet.id, commandId, to: '0x' + '2'.repeat(40), value: '0.001' },
      { actor: 'agent', workspaceId: 'project-a', agentContext: context },
    );
  return {
    get service() {
      return service;
    },
    wallet,
    parent,
    pay,
    writes,
    grant,
    unlock,
    async reopen() {
      await service.dispose();
      service = new WalletService({ directory, fetcher });
    },
  };
}
test('children share native ancestor counters across restart and reauthorization; replay does not charge twice', async (t) => {
  const f = await fixture(t),
    one = deriveChild(f.parent, 'native-sub-one', { limits: { maxTransactions: 1 } }),
    two = deriveChild(f.parent, 'native-sub-two', { limits: { maxTransactions: 1 } });
  const first = await f.pay(one, 'child-one');
  assert.equal(first.status, 'submitted');
  assert.equal((await f.pay(one, 'child-one')).id, first.id);
  const parent = (await f.service.agentScopes.ensure(f.parent, 8453)).binding;
  assert.equal((await f.service.request('scope.get', { id: parent.id })).usage.transactions, 1);
  await f.reopen();
  await f.unlock();
  await f.grant();
  assert.equal((await f.pay(two, 'child-two')).status, 'submitted');
  const three = deriveChild(f.parent, 'native-sub-three', { limits: { maxTransactions: 1 } });
  const denied = await f.pay(three, 'child-three');
  assert.equal(denied.status, 'signing-unknown');
  assert.match(denied.error, /AGENT_SCOPE_LIMIT/);
  const reconciled = await f.service.reconcile(denied.id);
  assert.equal(reconciled.status, 'expired');
  assert.equal(reconciled.submissionMayHaveOccurred, false);
  assert.equal(f.writes.length, 2);
  assert.equal((await f.service.request('scope.get', { id: parent.id })).usage.transactions, 2);
  assert.equal((await f.service.agentScopes.ensure(three, 8453)).snapshot.usage.transactions, 0);
  const scope = await f.service.request('scope.get', { id: parent.id });
  await assert.rejects(
    f.service.request('scope.ensure', { scope: scope.scope }),
    /UNKNOWN_WALLET_ACTION/,
  );
});
test('native delegation refuses widening, reparenting and mutation; Agent visibility is confined to its lineage', async (t) => {
  const f = await fixture(t),
    scopes = f.service.agentScopes;
  await scopes.ensure(f.parent, 8453);
  for (const limits of [{ maxTransactions: 0 }, { maxTotalValueEth: '1' }])
    await assert.rejects(
      scopes.ensure(deriveChild(f.parent, 'widen-' + Object.keys(limits)[0], { limits }), 8453),
      /WIDENING/,
    );
  const child = deriveChild(f.parent, 'native-sub-stable', { limits: { maxTransactions: 1 } });
  const binding = (await scopes.ensure(child, 8453)).binding;
  await assert.rejects(
    scopes.ensure(
      deriveChild(f.parent, 'native-sub-stable', { limits: { maxTransactions: 2 } }),
      8453,
    ),
    /CHANGED/,
  );
  await assert.rejects(
    scopes.ensure(deriveChild(rootContext('project-a'), 'native-sub-stable'), 8453),
    /CHANGED/,
  );
  const other = (await scopes.ensure(rootContext('foreign-project'), 8453)).binding;
  await assert.rejects(
    scopes.agentRequest(child, 8453, { action: 'get', scopeId: other.id }),
    /FORBIDDEN/,
  );
  const page = await scopes.agentRequest(f.parent, 8453, { action: 'list' });
  assert.equal(page.total, 2);
  assert.ok(page.items.some((s) => s.id === binding.id));
  await assert.rejects(scopes.fromBinding(binding, 8453, 'foreign-project'), /FORBIDDEN/);
  await assert.rejects(scopes.binding(child, 'foreign-wallet', 8453), /FORBIDDEN/);
  for (const limits of [null, [], 3])
    assert.throws(() => deriveChild(child, 'bad', { limits }), /INVALID/);
  assert.throws(
    () => validateContext({ ...child, nodes: [{ ...child.nodes[0], maxFeeEth: 'NaN' }] }),
    /INVALID/,
  );
});
test('ancestor pause fences a delayed real signature before network write; only a fresh human confirmation resumes', async (t) => {
  const f = await fixture(t),
    scopes = f.service.agentScopes;
  const child = deriveChild(f.parent, 'native-sub-late'),
    parent = (await scopes.ensure(f.parent, 8453)).binding;
  const original = f.service.signer.bind(f.service);
  let release, arrived;
  const ready = new Promise((r) => (arrived = r));
  const held = new Promise((r) => (release = r));
  t.after(() => release());
  f.service.signer = async (action, input) => {
    const result = await original(action, input);
    if (action === 'sign') {
      arrived();
      await held;
    }
    return result;
  };
  const payment = f.pay(child, 'late');
  await Promise.race([
    ready,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('Signature timeout')), 15000);
      timer.unref();
    }),
  ]);
  const current = await scopes.get(parent.id);
  await scopes.agentRequest(f.parent, 8453, { action: 'pause', revision: current.revision });
  release();
  const result = await payment;
  assert.notEqual(result.status, 'submitted');
  assert.equal(f.writes.length, 0);
  assert.equal(
    (await scopes.get(parent.id)).usage.transactions,
    1,
    'A committed signature remains charged even if stopped before submission',
  );
  await assert.rejects(f.pay(child, 'paused'), /PAUSED/);
  await assert.rejects(scopes.agentRequest(child, 8453, { action: 'active' }), /FORBIDDEN/);
  const paused = await scopes.get(parent.id),
    challenge = await f.service.request('scope.challenge', {
      id: parent.id,
      revision: paused.revision,
    });
  await f.service.request('scope.confirm', {
    challengeId: challenge.id,
    ack: 'ALLOW AGENT SCOPE',
    confirmed: true,
  });
  assert.equal((await scopes.get(parent.id)).ready, true);
  await assert.rejects(
    f.service.request('scope.confirm', {
      challengeId: challenge.id,
      ack: 'ALLOW AGENT SCOPE',
      confirmed: true,
    }),
    /CONFIRMATION_REQUIRED/,
  );
});

test('an unconfirmed scope mutation remains fenced across restart and requires separate human recovery', async (t) => {
  const f = await fixture(t),
    s = f.service,
    root = (await s.agentScopes.ensure(f.parent, 8453)).binding;
  const original = s.signer.bind(s);
  s.signer = (action, input) =>
    action === 'scope.state'
      ? Promise.reject(Error('WALLET_RECEIPT_STORE_FAILED'))
      : original(action, input);
  await assert.rejects(
    s.request('scope.pause', { id: root.id, revision: 1 }),
    /RECEIPT_STORE_FAILED/,
  );
  await f.reopen();
  const current = await f.service.request('scope.get', { id: root.id });
  assert.equal(current.locallyBlocked, true);
  assert.equal(current.state, 'active');
  await assert.rejects(f.pay(f.parent, 'blocked'), /FENCED/);
  assert.equal(f.writes.length, 0);
  for (const id of [undefined, {}, 'bad id', 'a'.repeat(81)])
    await assert.rejects(f.service.request('scope.get', { id }), /INVALID/);
  const child = f.service.child;
  await f.service.signer('receipt.status', { id: f.wallet.id });
  assert.equal(f.service.child, child);
  const c = await f.service.request('scope.challenge', {
    id: root.id,
    revision: 1,
    kind: 'recover',
  });
  await f.service.request('scope.confirm', {
    challengeId: c.id,
    ack: 'ALLOW AGENT SCOPE',
    confirmed: true,
  });
  assert.equal((await f.service.request('scope.get', { id: root.id })).locallyBlocked, false);
  assert.equal(f.service.isUnlocked(f.wallet.id), false);
});

test('native ancestor token budget aggregates sibling approvals and transfers without committing a denied signature', async (t) => {
  const f = await fixture(t),
    token = '0x' + '3'.repeat(40),
    recipient = '0x' + '2'.repeat(40),
    spender = '0x' + '4'.repeat(40);
  const rules = {
    chainId: 8453,
    address: token,
    symbol: 'TEST',
    decimals: 6,
    maxSignedAmount: '20',
    recipients: [recipient],
    spenders: [spender],
  };
  const parent = deriveChild(rootContext('project-a'), 'native-sub-token-parent', {
    chains: [8453],
    limits: { tokens: [rules] },
  });
  const one = deriveChild(parent, 'native-sub-token-one'),
    two = deriveChild(parent, 'native-sub-token-two');
  const abi = new Interface([
    'function approve(address,uint256) returns(bool)',
    'function transfer(address,uint256) returns(bool)',
  ]);
  const send = (context, commandId, method, args) =>
    f.service.transact(
      { venue: 'base' },
      {
        walletId: f.wallet.id,
        commandId,
        to: token,
        value: '0',
        data: abi.encodeFunctionData(method, args),
      },
      { actor: 'agent', workspaceId: 'project-a', agentContext: context },
    );
  assert.equal((await send(one, 'approve', 'approve', [spender, 15000000])).status, 'submitted');
  const denied = await send(two, 'transfer', 'transfer', [recipient, 6000000]);
  assert.match(denied.error, /TOKEN_LIMIT/);
  assert.equal(f.writes.length, 1);
  const used = (await f.service.agentScopes.ensure(parent, 8453)).snapshot.usage;
  assert.equal(used.transactions, 1);
  assert.equal(used.tokens['eip155:8453/erc20:' + token].approvalAtoms, '15000000');
  assert.equal((await f.service.agentScopes.ensure(two, 8453)).snapshot.usage.transactions, 0);
  await assert.rejects(
    f.service.agentScopes.ensure(
      deriveChild(parent, 'native-sub-token-widen', {
        limits: { tokens: [{ ...rules, maxSignedAmount: '30' }] },
      }),
      8453,
    ),
    /WIDENING/,
  );
});

test('real signer periodic quotas share the ancestor schedule, roll over without resetting lifetime history, and can be awaited without signing', async (t) => {
  const f = await fixture(t),
    parent = deriveChild(rootContext('project-a'), 'native-sub-period-parent', {
      limits: { period: { seconds: 2, maxTransactions: 1 } },
    }),
    one = deriveChild(parent, 'native-sub-period-one'),
    two = deriveChild(parent, 'native-sub-period-two');
  assert.equal((await f.pay(one, 'first-window')).status, 'submitted');
  const denied = await f.pay(two, 'over-quota');
  assert.match(denied.error, /PERIOD_LIMIT/);
  await f.service.reconcile(denied.id);
  const before = (await f.service.agentScopes.ensure(parent, 8453)).snapshot,
    leaf = (await f.service.agentScopes.ensure(one, 8453)).snapshot;
  assert.equal(before.period.originMs, leaf.period.originMs);
  const waiting = await require('../../src/main/services/wallet/budget-wait').waitPeriod(
    f.service,
    parent,
    { chainId: 8453, maxWaitMs: 4000 },
    new AbortController().signal,
  );
  assert.equal(waiting.reset, true);
  assert.equal(f.writes.length, 1);
  assert.equal((await f.pay(two, 'second-window')).status, 'submitted');
  const after = (await f.service.agentScopes.ensure(parent, 8453)).snapshot;
  assert.equal(after.usage.transactions, 2);
  assert.equal(after.period.usage.transactions, 1);
  const history = await f.service.request('period.history', { kind: 'scope', id: after.scope.id });
  assert.equal(history.total, 2);
  assert.equal(history.items.length, 2);
  await f.reopen();
  const recovered = (await f.service.agentScopes.ensure(parent, 8453)).snapshot;
  assert.equal(recovered.usage.transactions, 2);
  assert.equal(recovered.period.originMs, before.period.originMs);
});
test('budget waiting responds to an ancestor pause and cancellation rather than waiting for the full window', async (t) => {
  const f = await fixture(t),
    context = deriveChild(rootContext('project-a'), 'native-sub-period-wait', {
      limits: { period: { seconds: 3600, maxTransactions: 1 } },
    });
  const snapshot = (await f.service.agentScopes.ensure(context, 8453)).snapshot;
  const controller = new AbortController();
  const wait = require('../../src/main/services/wallet/budget-wait').waitPeriod;
  const cancelled = wait(f.service, context, { chainId: 8453, maxWaitMs: 5000 }, controller.signal);
  controller.abort(Error('explicit-stop'));
  await assert.rejects(cancelled, /explicit-stop/);
  const parked = wait(
    f.service,
    context,
    { chainId: 8453, maxWaitMs: 5000 },
    new AbortController().signal,
  );
  const stopped = assert.rejects(parked, /PAUSED|FENCED/);
  await f.service.agentScopes.change(snapshot.scope.id, 'paused', snapshot.revision);
  await stopped;
  assert.equal(f.service.budgetWake.size, 0);
  assert.equal(f.writes.length, 0);
});
