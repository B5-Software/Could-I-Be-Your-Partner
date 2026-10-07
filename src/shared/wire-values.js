/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const MAX_BYTES = 12 * 1024 * 1024;
function replacer(_key, value) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (value?.type === 'Buffer' && Array.isArray(value.data)) bytes = Uint8Array.from(value.data);
  if (!bytes) return value;
  if (bytes.length > MAX_BYTES) throw new Error('Binary payload is too large');
  let data;
  if (typeof Buffer === 'function') data = Buffer.from(bytes).toString('base64');
  else { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); data = btoa(text); }
  return { $cibypBinary: data };
}
function reviver(_key, value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, '$cibypBinary')) return value;
  const data = value.$cibypBinary;
  if (Object.keys(value).length !== 1 || typeof data !== 'string' || data.length > MAX_BYTES * 4 / 3 + 4 || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data) || !/^[^=]*={0,2}$/.test(data)) throw new Error('Invalid binary payload');
  const bytes = typeof Buffer === 'function' ? Buffer.from(data, 'base64') : Uint8Array.from(atob(data), char => char.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
module.exports = { replacer, reviver };
