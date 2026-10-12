/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { publicValue } = require('../../../packages/remote');
// Configuration values can contain credentials inside URLs or command arguments.
// Private configuration has a separate write-only endpoint.
function publicSettings(settings) {
  const result = publicValue(settings);
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        try {
          const url = new URL(value);
          if (!url.username && !url.password && !url.search && !url.hash) return value;
          url.username = '';
          url.password = '';
          url.search = '';
          url.hash = '';
          return url.href;
        } catch {
          return '';
        }
      }
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !/^(?:args|command|connectionString|credentials|bearer|auth)$/i.test(key),
        )
        .map(([key, v]) => [key, clean(v)]),
    );
  }
  return clean(result);
}
function messageView(message, index) {
  const value = publicValue(message),
    json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= 16384) return { ...value, messageIndex: index };
  return {
    messageIndex: index,
    role: value.role,
    id: value.id,
    truncated: true,
    preview: typeof value.content === 'string' ? value.content.slice(0, 4096) : '',
    readMethod: 'session.message',
  };
}
module.exports = { publicSettings, messageView };
