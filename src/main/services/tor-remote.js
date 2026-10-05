/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const quoted = (value) => '"' + String(value).replace(/\\/g, '/').replace(/"/g, '\\"') + '"';
function bridgeLines(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 32) throw new Error('Enter 1–32 bridge lines');
  return lines.map((line) => {
    line = line.replace(/^Bridge\s+/i, '');
    if (
      line.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(line) ||
      !/^(?:(?:obfs4|webtunnel|snowflake)\s+)?(?:\[[0-9a-f:]+\]|[\d.]+):\d+\s+[a-f0-9]{40}(?:\s+[^\r\n]*)?$/i.test(
        line,
      )
    )
      throw new Error('Invalid Tor bridge line');
    return 'Bridge ' + line;
  });
}
class TorRemote {
  constructor({ app, web, settings, publish, prepare }) {
    Object.assign(this, { app, web, settings, publish });
    this.prepare = prepare;
    this.directory = path.join(app.getPath('userData'), 'remote-tor');
    this.state = { phase: 'stopped', progress: 0 };
  }
  status() {
    return { ...this.state };
  }
  change(value) {
    Object.assign(this.state, value);
    this.publish('remoteTor:state', this.status());
  }
  async start() {
    if (this.operation || this.child) return this.status();
    this.change({ phase: 'preparing', progress: 0, error: '', onion: '' });
    const generation = (this.generation = (this.generation || 0) + 1);
    this.operation = this.startServer(generation)
      .catch((error) => {
        if (generation !== this.generation) return;
        this.child?.kill();
        this.child = null;
        this.change({ phase: 'error', error: error.message });
      })
      .finally(() => {
        this.operation = null;
      });
    return this.status();
  }
  async startServer(generation) {
    const cfg = this.settings().remote?.tor || {};
    const bridges = cfg.useBridges ? bridgeLines(cfg.bridges) : [];
    if (!this.web.config?.passwordHash && !this.web.config?.password)
      throw new Error('Set a WebUI password before enabling remote access');
    if (!this.web.running) await this.web.start();
    const bundled = path.join(process.resourcesPath || '', 'tor');
    const name = process.platform === 'win32' ? 'tor.exe' : 'tor';
    let runtime;
    if (await fs.stat(path.join(bundled, 'tor', name)).catch(() => null)) runtime = bundled;
    else
      runtime = await (this.prepare || require('../../../scripts/lib/tor-runtime.cjs').prepareTor)(
        process.platform,
        process.arch,
        path.join(this.directory, 'runtime'),
      );
    await fs.mkdir(path.join(this.directory, 'data'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.directory, 'onion'), { recursive: true, mode: 0o700 });
    const transport = path.join(
      runtime,
      'tor/pluggable_transports',
      process.platform === 'win32' ? 'lyrebird.exe' : 'lyrebird',
    );
    const torrc = [
      'SocksPort 0',
      'RunAsDaemon 0',
      'Log notice stdout',
      'DataDirectory ' + quoted(path.join(this.directory, 'data')),
      'HiddenServiceDir ' + quoted(path.join(this.directory, 'onion')),
      'HiddenServiceVersion 3',
      'HiddenServicePort 80 127.0.0.1:' + this.web.port,
    ];
    if (bridges.length)
      torrc.push(
        'UseBridges 1',
        'ClientTransportPlugin obfs4,snowflake,webtunnel exec ' + quoted(transport),
        ...bridges,
      );
    for (const file of ['geoip', 'geoip6']) {
      const location = path.join(runtime, 'data', file);
      if (await fs.stat(location).catch(() => null))
        torrc.push((file === 'geoip' ? 'GeoIPFile ' : 'GeoIPv6File ') + quoted(location));
    }
    const config = path.join(this.directory, 'torrc');
    await fs.writeFile(config, torrc.join('\n') + '\n', { mode: 0o600 });
    if (this.generation !== generation) return;
    this.change({ phase: 'connecting' });
    const child = spawn(path.join(runtime, 'tor', name), ['-f', config], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: path.join(runtime, 'tor') },
    });
    this.child = child;
    await new Promise((resolve, reject) => {
      let output = '',
        settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Tor bootstrap timed out; check the network or use a working bridge'));
        }
      }, 180000);
      const accept = (chunk) => {
        output = (output + String(chunk)).slice(-16384);
        const match = /Bootstrapped (\d+)%[^\r\n]*/g;
        let current;
        while ((current = match.exec(output))) {
          if (generation !== this.generation || Number(current[1]) <= this.state.progress) continue;
          this.change({ progress: Number(current[1]), detail: current[0] });
          if (Number(current[1]) === 100 && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        }
      };
      child.stdout.on('data', accept);
      child.stderr.on('data', accept);
      child.once('error', (error) => {
        clearTimeout(timer);
        settled = true;
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          reject(
            new Error(
              'Tor exited (' +
                code +
                '): ' +
                output.replace(/Bridge[^\r\n]*/g, 'Bridge [redacted]'),
            ),
          );
        } else if (generation === this.generation && this.state.phase !== 'stopped')
          this.change({ phase: 'error', error: 'Tor connection closed (' + code + ')' });
      });
    });
    if (this.generation !== generation) return;
    const hostname = (
      await fs.readFile(path.join(this.directory, 'onion/hostname'), 'utf8')
    ).trim();
    if (!/^[a-z2-7]{56}\.onion$/.test(hostname)) throw new Error('Invalid Tor onion address');
    this.change({ phase: 'ready', progress: 100, onion: 'http://' + hostname });
  }
  stop() {
    this.generation = (this.generation || 0) + 1;
    this.change({ phase: 'stopped', progress: 0, onion: '' });
    this.child?.kill();
    this.child = null;
    return this.status();
  }
}
module.exports = { TorRemote, bridgeLines };
