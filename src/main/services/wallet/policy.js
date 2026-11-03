/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { parseEther, formatEther, getAddress } = require('ethers');
const { tokenAtoms, tokenAmount } = require('../../../shared/wallet-token-format');
const tokenFields = require('../../../shared/wallet-token-fields.json');
const invalid = () => {
  throw Error('WALLET_POLICY_SCOPE_INVALID');
};
const amount = (value) => {
  if (typeof value !== 'string' || !/^\d{1,30}(?:\.\d{1,18})?$/.test(value)) invalid();
  return formatEther(parseEther(value));
};
const list = (value) => {
  if (typeof value === 'string') value = value.split(/[\s,;]+/).filter(Boolean);
  if (!Array.isArray(value) || value.length > 64 || value.some((v) => typeof v !== 'string'))
    invalid();
  return value;
};
function limits(value = {}) {
  if (
    value?.period !== undefined &&
    value.period !== null &&
    (!value.period || typeof value.period !== 'object' || Array.isArray(value.period))
  )
    invalid();
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'maxValueEth',
          'maxTotalValueEth',
          'maxTotalFeeEth',
          'maxTransactions',
          'targets',
          'selectors',
          'allowCalldata',
          'allowReplacement',
          'tokens',
          'period',
        ].includes(k),
    )
  )
    invalid();
  if (
    value.maxTransactions !== undefined &&
    typeof value.maxTransactions !== 'number' &&
    (typeof value.maxTransactions !== 'string' || !/^\d{1,7}$/.test(value.maxTransactions))
  )
    invalid();
  const maxTransactions = value.maxTransactions === undefined ? 0 : Number(value.maxTransactions);
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 0 || maxTransactions > 1000000)
    invalid();
  for (const name of ['allowCalldata', 'allowReplacement'])
    if (value[name] !== undefined && typeof value[name] !== 'boolean') invalid();
  let targets;
  try {
    targets = list(value.targets ?? []).map((v) => getAddress(v).toLowerCase());
  } catch {
    invalid();
  }
  const selectors = list(value.selectors ?? []).map((v) => v.toLowerCase());
  if (selectors.some((v) => !/^0x[a-f0-9]{8}$/.test(v))) invalid();
  return {
    maxValueEth: amount(value.maxValueEth ?? '0'),
    maxTotalValueEth: amount(value.maxTotalValueEth ?? '0'),
    maxTotalFeeEth: amount(value.maxTotalFeeEth ?? '0'),
    maxTransactions,
    targets: [...new Set(targets)],
    selectors: [...new Set(selectors)],
    allowCalldata: value.allowCalldata ?? true,
    allowReplacement: value.allowReplacement ?? false,
    tokens: tokens(value.tokens ?? []),
    ...(value.period ? { period: period(value.period) } : {}),
  };
}
function nativeLimits(value) {
  return {
    ...(value.period
      ? {
          period: {
            seconds: value.period.seconds,
            maxTotalValueWei: parseEther(value.period.maxTotalValueEth).toString(),
            maxTotalFeeWei: parseEther(value.period.maxTotalFeeEth).toString(),
            maxTransactions: value.period.maxTransactions,
            tokens: nativeLimits({
              maxValueEth: '0',
              maxTotalValueEth: '0',
              maxTotalFeeEth: '0',
              maxTransactions: 0,
              targets: [],
              selectors: [],
              tokens: value.period.tokens,
            }).tokens,
          },
        }
      : {}),
    maxValueWei: parseEther(value.maxValueEth).toString(),
    maxTotalValueWei: parseEther(value.maxTotalValueEth).toString(),
    maxTotalFeeWei: parseEther(value.maxTotalFeeEth).toString(),
    maxTransactions: value.maxTransactions,
    targets: value.targets,
    selectors: value.selectors,
    allowCalldata: value.allowCalldata,
    allowReplacement: value.allowReplacement,
    tokens: (value.tokens ?? []).map((token) => ({
      chainId: token.chainId,
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      maxAmountAtoms: tokenAtoms(token.maxAmount, token.decimals),
      maxSignedAtoms: tokenAtoms(token.maxSignedAmount, token.decimals),
      maxApprovalAtoms: tokenAtoms(token.maxApprovalAmount, token.decimals),
      allowApprovals: token.allowApprovals,
      recipients: token.recipients,
      spenders: token.spenders,
    })),
  };
}
function tokens(rows) {
  if (!Array.isArray(rows) || rows.length > 16) invalid();
  const seen = new Set();
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some((k) => !tokenFields.some((f) => f.name === k))
    )
      invalid();
    if (
      ![8453, 84532].includes(row.chainId) ||
      !Number.isInteger(row.decimals) ||
      row.decimals < 0 ||
      row.decimals > 255 ||
      typeof row.symbol !== 'string' ||
      row.symbol.length > 24 ||
      /[\x00-\x1f\x7f]/.test(row.symbol) ||
      (row.allowApprovals !== undefined && typeof row.allowApprovals !== 'boolean')
    )
      invalid();
    let address, recipients, spenders;
    try {
      address = getAddress(row.address).toLowerCase();
      recipients = [...new Set(list(row.recipients ?? []).map((v) => getAddress(v).toLowerCase()))];
      spenders = [...new Set(list(row.spenders ?? []).map((v) => getAddress(v).toLowerCase()))];
    } catch {
      invalid();
    }
    if (recipients.length > 16 || spenders.length > 16) invalid();
    const id = row.chainId + ':' + address;
    if (seen.has(id)) invalid();
    seen.add(id);
    const result = {
      chainId: row.chainId,
      address,
      symbol: row.symbol.trim(),
      decimals: row.decimals,
      allowApprovals: row.allowApprovals ?? true,
      recipients,
      spenders,
    };
    for (const name of ['maxAmount', 'maxSignedAmount', 'maxApprovalAmount'])
      result[name] = tokenAmount(tokenAtoms(row[name] ?? '0', row.decimals), row.decimals);
    return result;
  });
}
function period(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        !['seconds', 'maxTotalValueEth', 'maxTotalFeeEth', 'maxTransactions', 'tokens'].includes(k),
    ) ||
    !Number.isInteger(value.seconds) ||
    value.seconds < 1 ||
    value.seconds > 2592000
  )
    invalid();
  const parsed = limits({
    maxTotalValueEth: value.maxTotalValueEth,
    maxTotalFeeEth: value.maxTotalFeeEth,
    maxTransactions: value.maxTransactions,
    tokens: value.tokens,
  });
  return {
    seconds: value.seconds,
    maxTotalValueEth: parsed.maxTotalValueEth,
    maxTotalFeeEth: parsed.maxTotalFeeEth,
    maxTransactions: parsed.maxTransactions,
    tokens: parsed.tokens,
  };
}
module.exports = { limits, nativeLimits, tokens, period };
