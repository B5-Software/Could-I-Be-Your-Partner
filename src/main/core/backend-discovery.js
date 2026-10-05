/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { instanceIdentity } = require('./instance-lock');
const fileFor = (userData) =>
  path.join(
    os.tmpdir(),
    'cibyp-backend-' +
      crypto.createHash('sha256').update(instanceIdentity(userData)).digest('hex').slice(0, 24) +
      '.json',
  );
function publishBackend(userData, address, token) {
  const file = fileFor(userData);
  const content = JSON.stringify({
    ...address,
    token,
    pid: process.pid,
    protocol: 1,
    native: !!process.versions.electron,
  });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
    } catch {
      /* Already replaced or removed. */
    }
  };
}
function readBackend(userData) {
  try {
    const value = JSON.parse(fs.readFileSync(fileFor(userData), 'utf8'));
    const url = new URL(value.url);
    if (value.protocol !== 1 || url.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(value.token))
      return null;
    process.kill(value.pid, 0);
    return value;
  } catch {
    return null;
  }
}
module.exports = { publishBackend, readBackend, fileFor };
