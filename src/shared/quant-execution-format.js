/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
function executionAmount(value, decimals) {
  if (!/^\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30)
    return '—';
  if (!decimals) return value;
  const padded = value.padStart(decimals + 1, '0'),
    fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
function executionPercent(value, total) {
  if (!/^\d+$/.test(value) || !/^[1-9]\d*$/.test(total)) return 0;
  return Math.min(100, Number((BigInt(value) * 10000n) / BigInt(total)) / 100);
}
module.exports = { executionAmount, executionPercent };
