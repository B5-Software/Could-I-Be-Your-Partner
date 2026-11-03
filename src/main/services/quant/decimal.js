/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// Research/paper money is fixed point. Never round a reservation down to zero.
const SCALE = 100000000n;
function atoms(value, positive = false) {
  const text = String(value);
  if (!/^\d{1,16}(?:\.\d{1,8})?$/.test(text)) throw new Error('INVALID_DECIMAL');
  const [whole, fraction = ''] = text.split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
  if (positive && result <= 0n) throw new Error('POSITIVE_AMOUNT_REQUIRED');
  return result;
}
function decimal(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fraction = String(abs % SCALE)
    .padStart(8, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / SCALE}${fraction ? '.' + fraction : ''}`;
}
const ceilDiv = (a, b) => (a + b - 1n) / b;
const notional = (price, quantity) => ceilDiv(price * quantity, SCALE);
const fee = (amount, bps) => ceilDiv(amount * BigInt(bps), 10000n);
module.exports = { SCALE, atoms, decimal, ceilDiv, notional, fee };
