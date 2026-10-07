/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  function resolve(value, protocol = root.location?.protocol) {
    if (!value) return '';
    const source = String(value);
    if (/^(data:image\/|https?:\/\/)/i.test(source)) return source;
    if (protocol === 'http:' || protocol === 'https:')
      return '/api/avatar?' + new URLSearchParams({ source });
    if (/^file:\/\//i.test(source)) return source;
    return 'file://' + (source.startsWith('/') ? '' : '/') + source.replace(/\\/g, '/');
  }
  root.CibypAvatarSource = { resolve };
  if (typeof module === 'object' && module.exports) module.exports = { resolve };
})(typeof window === 'object' ? window : globalThis);
