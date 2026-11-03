/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs'),
  path = require('node:path');
const runtime = require('./native-binary');
const LIMIT = 131072;
class NativeSigner extends EventEmitter {
  constructor(directory) {
    super();
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    const resources = process.resourcesPath || process.env.CIBYP_PACKAGED_RESOURCES;
    let binary;
    if (resources && fs.existsSync(path.join(resources, 'wallet-signer'))) {
      binary = runtime.resolveManaged(resources, path.join(directory, 'signer-cache')).binary;
    } else {
      if (
        process.env.CIBYP_PACKAGED_RESOURCES ||
        (resources && fs.existsSync(path.join(resources, 'app.asar')))
      )
        throw Error('WALLET_SIGNER_UNAVAILABLE');
      const root =
        path.basename(__dirname) === 'node-core'
          ? path.resolve(__dirname, '../..')
          : path.resolve(__dirname, '../../../..');
      const spec = runtime.target(),
        prepared = path.join(
          root,
          'native/wallet-signer/target',
          spec.rust,
          'release',
          spec.binary,
        );
      binary =
        process.env.CIBYP_WALLET_SIGNER_BIN ||
        (fs.existsSync(prepared)
          ? prepared
          : path.join(root, 'native/wallet-signer/target/release', spec.binary));
      if (!path.isAbsolute(binary)) throw Error('WALLET_SIGNER_INTEGRITY');
      runtime.executable(
        runtime.readRegular(binary, runtime.MAX_BINARY),
        process.platform,
        process.arch,
      );
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_.*)$/i.test(name),
      ),
    );
    this.process = spawn(binary, ['--store', path.resolve(directory, 'signer-receipts')], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
    });
    this.exited = new Promise((resolve) => this.process.once('close', resolve));
    this.process.stdout.on('data', (chunk) => {
      if (this.closed) return;
      if (this.buffer.length + chunk.length > LIMIT) {
        this.kill();
        return;
      }
      const before = this.buffer;
      this.buffer = Buffer.concat([before, chunk]);
      before.fill(0);
      let newline;
      while ((newline = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, newline);
        let value;
        try {
          value = JSON.parse(line.toString('utf8'));
        } catch {
          this.kill();
          return;
        }
        line.fill(0);
        this.buffer = Buffer.from(this.buffer.subarray(newline + 1));
        if (!this.ready) {
          if (value.type === 'startup-error') {
            this.emit(
              'error',
              Error(
                /^WALLET_RECEIPT_STORE_(FAILED|BUSY)$/.test(value.error)
                  ? value.error
                  : 'WALLET_SIGNER_UNAVAILABLE',
              ),
            );
            this.kill();
            return;
          }
          if (
            value.type !== 'ready' ||
            value.protocol !== runtime.lock.protocol ||
            value.version !== runtime.lock.engineVersion ||
            value.receipts !== 1 ||
            value.authority !== 2 ||
            value.portfolios !== 1 ||
            value.agentScopes !== 1 ||
            value.periodBudgets !== 1 ||
            value.vault !== 'CIBYP-WALLET/1'
          ) {
            this.kill();
            return;
          }
          this.ready = true;
        } else this.emit('message', value);
      }
    });
    this.process.stdin.on('error', () => this.kill());
    this.process.once('error', () => {
      this.closed = true;
      this.buffer.fill(0);
      this.emit('error', Error('WALLET_SIGNER_UNAVAILABLE'));
    });
    this.process.once('exit', () => {
      this.closed = true;
      this.buffer.fill(0);
      this.emit('exit');
    });
  }
  send(message, callback) {
    if (this.closed) {
      callback(Error('WALLET_SIGNER_UNAVAILABLE'));
      return;
    }
    const bytes = Buffer.from(
      JSON.stringify({ protocol: runtime.lock.protocol, ...message }) + '\n',
    );
    if (bytes.length > LIMIT) {
      bytes.fill(0);
      callback(Error('WALLET_SIGNER_FRAME_LIMIT'));
      return;
    }
    this.process.stdin.write(bytes, (error) => {
      bytes.fill(0);
      callback(error);
    });
  }
  kill() {
    this.closed = true;
    this.buffer.fill(0);
    this.process?.kill();
  }
}
module.exports = { NativeSigner };
