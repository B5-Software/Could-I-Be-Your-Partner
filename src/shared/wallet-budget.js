/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { tokenAmount } = require('./wallet-token-format');
function walletBudget(snapshot) {
  if (!snapshot) return [];
  const { limits, usage } = snapshot;
  const rows = [
    {
      label: 'usedValue',
      used: usage.valueWei,
      limit: limits.maxTotalValueWei,
      decimals: 18,
      asset: 'ETH',
    },
    {
      label: 'usedFee',
      used: usage.feeWei,
      limit: limits.maxTotalFeeWei,
      decimals: 18,
      asset: 'ETH',
    },
    {
      label: 'usedCount',
      used: String(usage.transactions),
      limit: String(limits.maxTransactions),
      decimals: 0,
      asset: '',
    },
  ];
  for (const token of limits.tokens ?? []) {
    const id = `eip155:${token.chainId}/erc20:${token.address.toLowerCase()}`,
      used = usage.tokens?.[id] ?? { transferAtoms: '0', approvalAtoms: '0' };
    const asset = `${token.symbol || token.address} · ${token.chainId === 8453 ? 'Base' : 'Base Sepolia'}`;
    for (const [label, amount] of [
      ['usedTotal', String(BigInt(used.transferAtoms) + BigInt(used.approvalAtoms))],
      ['usedTransfer', used.transferAtoms],
      ['usedApproval', used.approvalAtoms],
    ])
      rows.push({
        label,
        used: amount,
        limit: label === 'usedTotal' ? token.maxSignedAtoms : '0',
        decimals: token.decimals,
        asset,
        contract: token.address,
        breakdown: label !== 'usedTotal',
      });
  }
  const formatted = rows.map((row) => ({
    ...row,
    usedText: tokenAmount(row.used, row.decimals),
    limitText: row.limit === '0' ? null : tokenAmount(row.limit, row.decimals),
  }));
  if (snapshot.period)
    formatted.push(
      ...walletBudget({ limits: snapshot.period.limits, usage: snapshot.period.usage }).map(
        (row) => ({
          ...row,
          label: 'period' + row.label[0].toUpperCase() + row.label.slice(1),
          period: true,
        }),
      ),
    );
  return formatted;
}
function walletScopeValues(limits) {
  return {
    maxValueEth: tokenAmount(limits.maxValueWei, 18),
    maxTotalValueEth: tokenAmount(limits.maxTotalValueWei, 18),
    maxTotalFeeEth: tokenAmount(limits.maxTotalFeeWei, 18),
    maxTransactions: limits.maxTransactions,
    targets: limits.targets,
    selectors: limits.selectors,
    allowCalldata: limits.allowCalldata,
    allowReplacement: limits.allowReplacement,
    tokens: (limits.tokens ?? []).map((t) => ({
      chainId: t.chainId,
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      maxAmount: tokenAmount(t.maxAmountAtoms, t.decimals),
      maxSignedAmount: tokenAmount(t.maxSignedAtoms, t.decimals),
      maxApprovalAmount: tokenAmount(t.maxApprovalAtoms, t.decimals),
      allowApprovals: t.allowApprovals,
      recipients: t.recipients,
      spenders: t.spenders,
    })),
    ...(limits.period
      ? {
          period: {
            seconds: limits.period.seconds,
            maxTotalValueEth: tokenAmount(limits.period.maxTotalValueWei, 18),
            maxTotalFeeEth: tokenAmount(limits.period.maxTotalFeeWei, 18),
            maxTransactions: limits.period.maxTransactions,
            tokens: walletScopeValues({
              maxValueWei: '0',
              maxTotalValueWei: '0',
              maxTotalFeeWei: '0',
              maxTransactions: 0,
              tokens: limits.period.tokens,
            }).tokens,
          },
        }
      : {}),
  };
}
module.exports = { walletBudget, walletScopeValues };
