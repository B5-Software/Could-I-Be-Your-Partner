/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const trust = require('../../src/main/services/tls-trust');
// Public certificate, pinned by fingerprint; never depends on an old host store.
const compromised = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../fixtures/security/emsign-ecc-g3.pem'),
  'utf8',
);
assert.equal(
  new X509Certificate(compromised).fingerprint256.replaceAll(':', ''),
  '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B',
);

test('host TLS default store excludes compromised roots while retaining other defaults', () => {
  const before = tls.getCACertificates('default');
  try {
    tls.setDefaultCACertificates([...before, compromised]);
    trust.enforceNodeTrust();
    const after = new Set(
      tls.getCACertificates('default').map((pem) => new X509Certificate(pem).fingerprint256),
    );
    assert.equal(after.has(new X509Certificate(compromised).fingerprint256), false);
    for (const pem of before) {
      if (trust.containsDistrustedCertificate({ data: pem }))
        assert.equal(after.has(new X509Certificate(pem).fingerprint256), false);
      else assert.equal(after.has(new X509Certificate(pem).fingerprint256), true);
    }
    assert.equal(trust.enforceNodeTrust().removed, 0, 'Idempotent on subsequent calls');
  } finally {
    tls.setDefaultCACertificates(before);
  }
});

test(
  'Chromium rejects compromised issuers and delegates normal verification without granting trust',
  { skip: !compromised },
  () => {
    const app = new EventEmitter();
    trust.enforceElectronTrust(app);
    let verify;
    app.emit('session-created', {
      setCertificateVerifyProc: (fn) => {
        verify = fn;
      },
    });
    const normal = tls.rootCertificates.find(
      (pem) => !trust.containsDistrustedCertificate({ data: pem }),
    );
    const check = (certificate, validatedCertificate) => {
      let value;
      verify({ certificate, validatedCertificate }, (v) => {
        value = v;
      });
      return value;
    };
    assert.equal(check({ data: normal, issuerCert: { data: compromised } }), -2);
    assert.equal(check({ data: normal }, { data: normal, issuerCert: { data: compromised } }), -2);
    const root = { data: normal };
    root.issuerCert = root;
    assert.equal(check(root), -3);
    assert.equal(check({ data: 'invalid certificate' }), -2);
  },
);

test('IMAP credentials require a verified TLS peer by default', () => {
  const { EmailService } = require('../../src/main/email-service');
  const service = new EmailService();
  service.configure({ imapHost: 'imap.example.invalid' });
  assert.equal(service.config.imap.imap.tlsOptions.rejectUnauthorized, true);
});
