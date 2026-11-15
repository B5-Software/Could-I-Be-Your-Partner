/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Interface, MaxUint256, Wallet, getAddress, toBeHex } = require('ethers');
const { WalletService } = require('../../src/main/services/wallet');
const {
  PortfolioAllowanceMonitor,
} = require('../../src/main/services/wallet/portfolio-allowance-monitor');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { PERMIT2, permit2 } = require('../../src/main/services/quant/permit2');

const token = getAddress(CHAINS.base.usdc);
const erc20 = new Interface([
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'function allowance(address,address) view returns(uint256)',
  'function balanceOf(address) view returns(uint256)',
]);
const address = (number) => getAddress(toBeHex(number, 20));
const word = (value) => toBeHex(value, 32);
const units = (value) => BigInt(value) * 1000000n;

test('portfolio allowance evidence pins reads, caps shared Permit2 routes and balances, and persists historical coverage', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-allowance-evidence-'));
  const key = (number) => word(number);
  const first = new Wallet(key(1)).address,
    second = new Wallet(key(2)).address;
  const [direct, oldDirect, innerA, innerB, expired, manual] = [10, 11, 12, 13, 14, 15].map(
    address,
  );
  const allowances = new Map([
    [`${first}:${direct}`, units(40)],
    [`${first}:${oldDirect}`, units(20)],
    [`${first}:${PERMIT2}`, units(25)],
    [`${second}:${direct}`, MaxUint256],
    [`${first}:${manual}`, 0n],
  ]);
  const timestamp = 1700000000;
  const inner = new Map([
    [innerA, [5, timestamp + 500]],
    [innerB, [10, timestamp + 500]],
    [expired, [30, timestamp - 1]],
  ]);
  let height = 100,
    reorgHeight = null,
    selectedHeight = null,
    failLogs = false;
  const hash = (number) => word(BigInt(number) + (Number(number) === reorgHeight ? 1000n : 0n));
  const log = (at, index, contract, event) => ({
    ...event,
    address: contract,
    blockHash: hash(at),
    transactionHash: word(at * 100 + index),
    blockNumber: toBeHex(at),
    logIndex: toBeHex(index),
  });
  const logs = [
    log(98, 0, token, erc20.encodeEventLog('Approval', [first, direct, units(40)])),
    log(99, 0, token, erc20.encodeEventLog('Approval', [second, direct, MaxUint256])),
    log(85, 0, token, erc20.encodeEventLog('Approval', [first, oldDirect, units(20)])),
    ...[...inner].map(([spender, [amount, expiry]], i) =>
      log(
        97,
        i,
        PERMIT2,
        permit2.encodeEventLog('Approval', [first, token, spender, units(amount), expiry]),
      ),
    ),
  ];
  const calls = [],
    windows = [],
    events = [];
  const fetcher = async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    calls.push(method);
    let result;
    if (method === 'eth_chainId') result = '0x2105';
    else if (method === 'eth_getBlockByNumber') {
      const block = params[0] === 'latest' ? height : Number(params[0]);
      result = { number: toBeHex(block), hash: hash(block), timestamp: toBeHex(timestamp) };
    } else if (method === 'eth_getLogs') {
      const [{ address: target, fromBlock, toBlock, topics }] = params;
      windows.push([Number(fromBlock), Number(toBlock)]);
      if (failLogs && target === PERMIT2) throw Error('fixture temporary RPC failure');
      const matches = (allowed, value) => [allowed].flat().includes(value);
      result = logs.filter(
        (event) =>
          matches(target, event.address) &&
          matches(topics[0], event.topics[0]) &&
          topics[1] === event.topics[1] &&
          Number(event.blockNumber) >= Number(fromBlock) &&
          Number(event.blockNumber) <= Number(toBlock),
      );
    } else if (
      method === 'eth_call' ||
      method === 'eth_getBalance' ||
      method === 'eth_getTransactionCount'
    ) {
      assert.deepEqual(params[1], {
        blockHash: hash(selectedHeight ?? height),
        requireCanonical: true,
      });
      result = '0x0';
      if (method === 'eth_call') {
        const [{ to, data }] = params;
        if (to === PERMIT2) {
          const [, , spender] = permit2.decodeFunctionData('allowance', data);
          const [amount, expiry] = inner.get(spender);
          result = permit2.encodeFunctionResult('allowance', [units(amount), expiry, 0]);
        } else {
          const {
            name,
            args: [owner, spender],
          } = erc20.parseTransaction({ data });
          result = word(
            to.toLowerCase() !== token.toLowerCase()
              ? 0n
              : name === 'balanceOf'
                ? units(owner === first ? 80 : 30)
                : (allowances.get(`${owner}:${spender}`) ?? 0n),
          );
        }
      }
    } else assert.fail(`Unexpected RPC ${method}`);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  const open = () =>
    new WalletService({ directory, fetcher, publish: (event) => events.push(event) });
  let service = open();
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const wallet = await service.request('import', {
    kind: 'privateKey',
    name: 'First wallet',
    secret: key(1),
    password: 'fixture-password-only',
  });
  const other = await service.request('import', {
    kind: 'privateKey',
    name: 'Second wallet',
    secret: key(2),
    password: 'fixture-password-only',
  });
  const create = async (walletIds) => {
    const challenge = await service.request('portfolio.challenge', {
      operation: 'create',
      name: 'Fixture budget',
      chainId: 8453,
      walletIds,
      limits: { maxTotalValueEth: '0.01', maxTransactions: 4 },
    });
    return service.request('portfolio.confirm', {
      challengeId: challenge.id,
      ack: 'ALLOW PORTFOLIO',
      confirmed: true,
    });
  };
  const group = await create([wallet.id, other.id]);
  const id = group.portfolio.id;
  const request = (action, input) =>
    service.request(`portfolio.allowances.${action}`, { id, ...input });
  const scan = (input) => request('scan', { token, blocks: 10, ...input });
  const amounts = (report) => [
    report.totals[0].balance.amount,
    report.totals[0].measured.amount,
    report.totals[0].includingPermit2.amount,
  ];
  const recent = await scan({ candidates: [{ walletId: wallet.id, token, spender: manual }] });
  assert.deepEqual(amounts(recent), ['110', '85', '95']);
  assert.equal(recent.coverage.nextEndBlock, '90');
  assert.equal(recent.items.find((row) => row.spender === expired).status, 'inactive');
  assert.equal(recent.items.find((row) => row.spender === manual).source, 'manual');
  assert.equal(
    recent.items.find((row) => row.walletId === other.id && row.spender === direct).spendable
      .amount,
    '30',
  );
  assert.deepEqual(
    recent.coverage.scannedRanges.map((r) => [r.fromBlock, r.toBlock]),
    [['91', '100']],
  );
  allowances.set(`${first}:${PERMIT2}`, units(12));
  const older = await scan({ mode: 'older', previousReportId: recent.reportId });
  assert.deepEqual(amounts(older), ['110', '102', '102']);
  assert.equal(older.coverage.nextEndBlock, '80');
  assert.equal(older.items.find((row) => row.spender === oldDirect).event.block, '85');

  height = 101;
  allowances.set(`${first}:${direct}`, 0n);
  allowances.set(`${first}:${PERMIT2}`, 0n);
  const logCount = calls.filter((method) => method === 'eth_getLogs').length;
  const updated = await scan({ mode: 'refresh', previousReportId: older.reportId });
  assert.equal(calls.filter((method) => method === 'eth_getLogs').length, logCount);
  assert.deepEqual(amounts(updated), ['110', '50', '50']);
  assert.equal(updated.items.find((row) => row.spender === innerA).status, 'latent');
  assert.equal(
    updated.items.find((row) => row.walletId === wallet.id && row.spender === direct).changedAtoms,
    '-40000000',
  );
  const review = await request('get', { reportId: updated.reportId, filter: 'review', limit: 1 });
  assert.ok(review.next > 0);
  assert.ok(review.items.every((row) => row.status !== 'inactive'));

  failLogs = true;
  const partial = await scan({ previousReportId: updated.reportId });
  assert.equal(partial.coverage.scanIncomplete, true);
  assert.equal(partial.coverage.scanErrors.length, 2);
  assert.equal(partial.coverage.nextEndBlock, '101');
  const partialRefresh = await scan({ mode: 'refresh', previousReportId: partial.reportId });
  assert.equal(partialRefresh.coverage.scanIncomplete, true);
  reorgHeight = 100;
  await assert.rejects(scan({ mode: 'older', previousReportId: older.reportId }), /BLOCK_REORG/);
  reorgHeight = null;
  await service.dispose();
  service = open();
  assert.equal((await request('list', {})).total, 5);
  assert.deepEqual(amounts(await request('get', { reportId: older.reportId })), [
    '110',
    '102',
    '102',
  ]);
  await assert.rejects(
    request('get', { reportId: '1000000000000-' + '0'.repeat(64) }),
    /^Error: WALLET_ALLOWANCE_REPORT_INVALID$/,
  );
  const file = path.join(directory, 'portfolio-allowances', id, `${recent.reportId}.json`);
  const tampered = JSON.parse(fs.readFileSync(file));
  tampered.block = '1';
  fs.writeFileSync(file, JSON.stringify(tampered));
  await assert.rejects(
    request('get', { reportId: recent.reportId }),
    /^Error: WALLET_ALLOWANCE_REPORT_INVALID$/,
  );

  const watch = (action, input = {}) =>
    service.request(`portfolio.allowanceMonitor.${action}`, { id, ...input });
  const tick = () => service.portfolios.allowanceMonitor.tick(Number.MAX_SAFE_INTEGER);
  await assert.rejects(
    watch('start', { reportId: partial.reportId, expectedRevision: 0 }),
    /WALLET_ALLOWANCE_MONITOR_BASELINE/,
  );
  failLogs = false;
  const baseline = await scan({ previousReportId: updated.reportId });
  const started = await watch('start', {
    reportId: baseline.reportId,
    expectedRevision: 0,
    intervalSeconds: 60,
  });
  assert.equal(started.status, 'pending');
  assert.equal(PortfolioAllowanceMonitor.shouldStart(directory), true);
  await tick();
  assert.equal((await watch('get')).status, 'watching');
  await assert.rejects(watch('stop', { expectedRevision: 0 }), /WALLET_ALLOWANCE_MONITOR_CHANGED/);

  height = 2500;
  selectedHeight = 2101;
  const newSpender = address(16);
  allowances.set(`${first}:${newSpender}`, units(15));
  logs.push(log(110, 0, token, erc20.encodeEventLog('Approval', [first, newSpender, units(15)])));
  await tick();
  const catchingUp = await watch('get');
  assert.equal(catchingUp.status, 'catchingUp');
  assert.equal(catchingUp.lastBlock, '2101');
  assert.deepEqual(
    catchingUp.notices[0].pairs.map((pair) => pair.spender),
    [newSpender],
  );
  assert.equal(catchingUp.notices[0].increases[0].after.amount, '65');
  assert.deepEqual(windows.at(-1), [102, 2101]);
  assert.equal(events.filter((event) => event.type === 'wallet-allowance-monitor').length, 1);
  await service.dispose();
  service = open();
  selectedHeight = null;
  failLogs = true;
  await tick();
  const retry = await watch('get');
  assert.equal(retry.status, 'retrying');
  assert.equal(retry.lastBlock, '2101');
  assert.equal(retry.total, 1);
  failLogs = false;
  await tick();
  const done = await watch('get');
  assert.equal(done.status, 'watching');
  assert.equal(done.lastBlock, '2500');
  assert.equal(done.total, 1);
  assert.deepEqual(windows.at(-1), [2102, 2500]);
  const latest = await watch('get', { includeReport: true, limit: 2 });
  assert.equal(latest.report.coverage.monitoredRange.fromBlock, '102');
  assert.equal(latest.report.coverage.monitoredRange.toBlock, '2500');
  assert.equal((await request('list', { limit: 1 })).total, 6);
  reorgHeight = 2500;
  await tick();
  const alert = await watch('get');
  assert.equal(alert.status, 'attention');
  assert.equal(alert.error, 'WALLET_ALLOWANCE_MONITOR_REBASE');
  assert.equal(alert.nextAt, null);
  assert.equal(PortfolioAllowanceMonitor.shouldStart(directory), false);
  assert.equal((await watch('stop', { expectedRevision: alert.revision })).status, 'off');
  assert.equal((await watch('get')).total, 1);

  reorgHeight = null;
  const newBaseline = await scan();
  const restarted = await watch('start', {
    reportId: newBaseline.reportId,
    expectedRevision: alert.revision + 1,
  });
  height += 1;
  let enter;
  const entered = new Promise((resolve) => (enter = resolve));
  service.market.discoverTokenApprovals = async (_config, _input, { signal }) => {
    enter();
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  };
  const running = tick();
  await entered;
  assert.equal(tick(), running);
  await watch('stop', { expectedRevision: restarted.revision });
  await running;
  const cancelled = await watch('get');
  assert.equal(cancelled.status, 'off');
  assert.equal(cancelled.lastBlock, newBaseline.block);
  assert.equal(cancelled.total, 1);
});
