/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { X509Certificate } = require('node:crypto');
const BLOCKED = new Set([
  '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B',
  'D7A7A0FB5D7E2731D771E9484EEBCDEF71D5F0C3E0A2948782BC0EEA699EF4C0',
]);
const fingerprint = (pem) => new X509Certificate(pem).fingerprint256.replaceAll(':', '');

// Node's embedded Mozilla roots are independent of the OS certificate package.
// Preserve all other default roots, including enterprise certificates. Applied
// before any sockets are opened; not a replacement for a patched Node release.
function enforceNodeTrust(tls = require('node:tls')) {
  if (
    typeof tls.getCACertificates !== 'function' ||
    typeof tls.setDefaultCACertificates !== 'function'
  ) {
    throw new Error(
      'This runtime cannot enforce certificate distrust; upgrade Node.js to 24.22.1 or later.',
    );
  }
  const roots = tls.getCACertificates('default');
  const filtered = roots.filter((pem) => !BLOCKED.has(fingerprint(pem)));
  if (filtered.length !== roots.length) tls.setDefaultCACertificates(filtered);
  return { removed: roots.length - filtered.length };
}

function containsDistrustedCertificate(certificate) {
  const seen = new Set();
  for (let cert = certificate; cert && !seen.has(cert); cert = cert.issuerCert) {
    seen.add(cert);
    if (cert.data && BLOCKED.has(fingerprint(cert.data))) return true;
  }
  return false;
}

function enforceElectronTrust(app) {
  app.on('session-created', (session) => {
    session.setCertificateVerifyProc(({ certificate, validatedCertificate }, callback) => {
      try {
        // -3 delegates all normal validation to Chromium; never grants trust.
        callback(
          containsDistrustedCertificate(validatedCertificate) ||
            containsDistrustedCertificate(certificate)
            ? -2
            : -3,
        );
      } catch {
        callback(-2);
      }
    });
  });
}

module.exports = { enforceNodeTrust, enforceElectronTrust, containsDistrustedCertificate };
