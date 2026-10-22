/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// Keep gateway refusals distinct from authentication and transient transport
// failures. These decisions belong to the provider and cannot be repaired by
// sanitizing a conversation or repeating it as a non-streaming request.
function providerFailure(raw, defaults = {}) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Gateways also return plain text with non-JSON content types.
    }
  }
  const detail = value?.response?.error || value?.error || value;
  const message =
    (typeof detail === 'string' ? detail : detail?.message) ||
    value?.message ||
    (typeof value?.detail === 'string' ? value.detail : value?.detail?.[0]?.msg) ||
    detail?.code ||
    defaults.error ||
    `HTTP ${defaults.status || 'error'}`;
  const status = defaults.status ?? value?.status ?? detail?.status;
  const code = detail?.code || detail?.type || value?.code;
  const error = String(message);
  let reason;
  if (
    /abusive traffic.*\bIP\b|\bIP address\b.*(?:blocked|flagged)|free model gateway detect abuse traffic/i.test(
      error,
    )
  )
    reason = 'ip_blocked';
  else if (
    code === 'FreeTierError' ||
    /free tier can only be used from within OpenCode/i.test(error)
  )
    reason = 'client_restricted';
  else if (code === 'RegionError' || /model is not available in your country/i.test(error))
    reason = 'region_restricted';

  return {
    ok: false,
    error,
    ...(status != null ? { status } : {}),
    ...(code ? { code } : {}),
    ...(reason
      ? { kind: 'provider-policy', reason, retryable: false }
      : code === 'CIBYP_PRIVACY_UNAVAILABLE' ||
          /Network privacy is enabled but Tor is not connected/i.test(error)
        ? { kind: 'privacy', retryable: false }
        : defaults.kind
          ? { kind: defaults.kind }
          : status === 401 || status === 403
            ? { kind: 'auth', retryable: false }
            : {}),
  };
}

module.exports = { providerFailure };
