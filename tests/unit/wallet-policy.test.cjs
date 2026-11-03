/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const { limits, nativeLimits } = require('../../src/main/services/wallet/policy');
const { tokenAtoms, tokenAmount } = require('../../src/shared/wallet-token-format');
const { walletBudget } = require('../../src/shared/wallet-budget');

test('periodic policy preserves precision, rejects recursive or ambiguous rules, and renders separate lifetime/window counters', () => {
  const native = nativeLimits(
    limits({
      maxTransactions: 10,
      period: { seconds: 3600, maxTotalValueEth: '0.000000000000000001', maxTransactions: '3' },
    }),
  );
  assert.equal(native.period.seconds, 3600);
  assert.equal(native.period.maxTotalValueWei, '1');
  assert.equal(native.period.maxTransactions, 3);
  assert.ok(!('period' in nativeLimits(limits())));
  const rows = walletBudget({
    limits: native,
    usage: { transactions: 7, valueWei: '0', feeWei: '0', tokens: {} },
    period: {
      limits: native.period,
      usage: { transactions: 2, valueWei: '0', feeWei: '0', tokens: {} },
    },
  });
  assert.equal(rows.find((r) => r.label === 'usedCount').usedText, '7');
  assert.equal(rows.find((r) => r.label === 'periodUsedCount').usedText, '2');
  for (const period of [
    false,
    0,
    '',
    [],
    { seconds: 0 },
    { seconds: 2592001 },
    { seconds: 1.5 },
    { seconds: '0x10' },
    { seconds: 3600, period: {} },
    { seconds: 3600, secret: 'private input' },
  ])
    assert.throws(() => limits({ period }), /WALLET_POLICY_SCOPE_INVALID/);
});
test('wallet scope preserves exact ETH amounts and canonicalizes bounded lists', () => {
  const address = '0x' + '1'.repeat(40);
  const value = limits({
    maxTotalValueEth: '1.000000000000000001',
    targets: address + ',\n' + address,
    selectors: '0xA9059CBB',
    maxTransactions: '20',
    allowReplacement: true,
  });
  const native = nativeLimits(value);
  assert.equal(native.maxTotalValueWei, '1000000000000000001');
  assert.deepEqual(native.targets, [address]);
  assert.deepEqual(native.selectors, ['0xa9059cbb']);
  assert.equal(native.maxTransactions, 20);
  assert.equal(native.allowReplacement, true);
  assert.equal(nativeLimits(limits()).allowReplacement, false);
});
test('scope validation rejects ambiguous permissions and invalid amounts without echoing input', () => {
  for (const input of [
    null,
    { maxValueEth: '-1' },
    { maxValueEth: '1e3' },
    { maxTransactions: 0.5 },
    { maxTransactions: null },
    { maxTransactions: '0x10' },
    { maxTransactions: 1000001 },
    { targets: ['secret-not-an-address'] },
    { selectors: '0xwrong' },
    { allowReplacement: 'true' },
    { unexpectedSecret: 'private input' },
  ]) {
    assert.throws(() => limits(input), { message: 'WALLET_POLICY_SCOPE_INVALID' });
  }
});
test('token precision stays exact from human approval to native counters, including uint8 decimals', () => {
  const row = {
    chainId: 8453,
    address: '0x' + 'a'.repeat(40),
    symbol: 'USDC',
    decimals: 6,
    maxAmount: '12.000001',
    maxSignedAmount: '100',
    maxApprovalAmount: '12',
  };
  const policy = limits({ tokens: [row] });
  const native = nativeLimits(policy);
  assert.equal(native.tokens[0].maxAmountAtoms, '12000001');
  assert.equal(tokenAtoms('0.' + '0'.repeat(254) + '1', 255), '1');
  assert.equal(tokenAmount('1', 255), '0.' + '0'.repeat(254) + '1');
  const rows = walletBudget({
    limits: native,
    usage: {
      valueWei: '0',
      feeWei: '21000',
      transactions: 2,
      tokens: {
        ['eip155:8453/erc20:' + row.address]: {
          transferAtoms: '1234567',
          approvalAtoms: '2000000',
        },
      },
    },
  });
  assert.equal(rows.find((r) => r.label === 'usedTotal').usedText, '3.234567');
  assert.equal(rows.find((r) => r.label === 'usedTotal').limitText, '100');
  for (const value of [
    null,
    {},
    { ...row, decimals: 256 },
    { ...row, decimals: -1 },
    { ...row, decimals: 0, maxAmount: '1.1' },
    { ...row, maxAmount: '1e6' },
    { ...row, maxSignedAmount: 12 },
    { ...row, maxAmount: '9'.repeat(78) },
    { ...row, allowApprovals: 'true' },
    { ...row, spenders: ['private input'] },
    { ...row, secret: 'private input' },
  ])
    assert.throws(() => limits({ tokens: [value] }), /WALLET_POLICY_SCOPE_INVALID/);
  assert.throws(
    () =>
      limits({ tokens: [row, { ...row, address: row.address.toUpperCase().replace('0X', '0x') }] }),
    /WALLET_POLICY_SCOPE_INVALID/,
  );
});
