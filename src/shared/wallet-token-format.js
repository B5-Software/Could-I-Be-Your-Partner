/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const maximum = (1n << 256n) - 1n;
function tokenAtoms(value, decimals) {
  if (
    typeof value !== 'string' ||
    value.length > 335 ||
    !/^\d{1,78}(?:\.\d{1,255})?$/.test(value) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw Error('WALLET_POLICY_SCOPE_INVALID');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw Error('WALLET_POLICY_SCOPE_INVALID');
  const atoms = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (atoms > maximum) throw Error('WALLET_POLICY_SCOPE_INVALID');
  return atoms.toString();
}
function tokenAmount(value, decimals) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,78}$/.test(value) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    return '—';
  if (!decimals) return value.replace(/^0+(?=\d)/, '');
  const padded = value.padStart(decimals + 1, '0'),
    fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
module.exports = { tokenAtoms, tokenAmount };
