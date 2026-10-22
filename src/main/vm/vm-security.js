/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// DSA-6572-1 / DLA-4845-1, 2026-10-20. Never turn off TLS or APT signatures
// to bootstrap trust updates. The local distrust step also works offline.
const TRUST_UPDATE_SCRIPT = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$VERSION_CODENAME" in
  trixie) minimum='20250419+deb13u1';;
  bookworm) minimum='20250419~deb12u2';;
  *) echo 'Unsupported VM distribution for certificate maintenance' >&2; exit 1;;
esac
install -d -m 0755 /etc/apt/sources.list.d
printf 'Types: deb\nURIs: http://security.debian.org/debian-security\nSuites: %s-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "$VERSION_CODENAME" > /etc/apt/sources.list.d/cibyp-security.sources
# APT authenticates this bootstrap source using Debian's archive signatures,
# independently of the old TLS trust store. No AllowUnauthenticated/Trusted flag.
printf 'Unattended-Upgrade::Origins-Pattern { "origin=Debian,codename=%s-security,label=Debian-Security"; };\n' "$VERSION_CODENAME" > /etc/apt/apt.conf.d/50unattended-upgrades-cibyp
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
distrust() {
  python3 - "$1" <<'CIBYP_CA_PY'
import hashlib, pathlib, re, ssl, sys
blocked = {
    '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
    'd7a7a0fb5d7e2731d771e9484eebcdef71d5f0c3e0a2948782bc0eea699ef4c0',
}
def compromised(text):
    return any(hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest() in blocked
               for pem in re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', text, re.S))
if sys.argv[1] == 'disable':
    config = pathlib.Path('/etc/ca-certificates.conf')
    lines = config.read_text().splitlines()
    changed = False
    for i, line in enumerate(lines):
        name = line.strip()
        if not name or name.startswith(('#', '!')):
            continue
        cert = pathlib.Path('/usr/share/ca-certificates') / name
        if cert.is_file() and compromised(cert.read_text()):
            lines[i] = '!' + name
            changed = True
    if changed:
        config.write_text('\n'.join(lines) + '\n')
else:
    bundle = pathlib.Path('/etc/ssl/certs/ca-certificates.crt')
    text = bundle.read_text()
    if '-----BEGIN CERTIFICATE-----' not in text or compromised(text):
        raise SystemExit('VM trust bundle is empty or still contains a distrusted CA')
CIBYP_CA_PY
}
distrust disable
if ! distrust verify >/dev/null 2>&1; then update-ca-certificates --fresh >/dev/null; fi
distrust verify
version=$(dpkg-query -W ca-certificates | awk '{print $2}')
updated=true
if ! dpkg --compare-versions "$version" ge "$minimum"; then
  # A failed/offline package refresh must not undo the verified local distrust.
  if ! (timeout 50s apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=15 update -qq &&
        timeout 60s apt-get -o DPkg::Lock::Timeout=15 -o Acquire::Retries=1 -o Acquire::https::Timeout=15 install -y -qq --only-upgrade ca-certificates); then
    updated=false
  fi
  distrust disable
  if ! distrust verify >/dev/null 2>&1; then update-ca-certificates --fresh >/dev/null; fi
  distrust verify
  version=$(dpkg-query -W ca-certificates | awk '{print $2}')
  dpkg --compare-versions "$version" ge "$minimum" || updated=false
fi
# Enabling alone does not start timers in an already booted/resumed guest.
systemctl start apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
printf 'CIBYP_SECURITY:{"caVersion":"%s","minimum":"%s","updated":%s,"distrusted":true}\n' "$version" "$minimum" "$updated"
`;

async function updateGuestTrust(ssh) {
  const result = await ssh.exec(
    "sudo -n sh -s <<'CIBYP_TRUST_EOF'\n" + TRUST_UPDATE_SCRIPT + '\nCIBYP_TRUST_EOF',
    {
      timeoutMs: 150000,
    },
  );
  const line = String(result.stdout || '')
    .split('\n')
    .findLast((row) => row.startsWith('CIBYP_SECURITY:'));
  if (!result.ok || !line)
    throw new Error(
      'VM certificate maintenance failed: ' +
        String(result.stderr || 'missing verification result').slice(-1200),
    );
  const status = JSON.parse(line.slice('CIBYP_SECURITY:'.length));
  if (status.distrusted !== true) throw new Error('VM certificate distrust was not verified');
  return status;
}

module.exports = { TRUST_UPDATE_SCRIPT, updateGuestTrust };
