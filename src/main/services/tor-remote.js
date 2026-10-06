/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse: parseBridges } = require('../../shared/tor-bridges');
const { startTransport } = require('./tor-transport');
const quoted = (value) => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function bridgeLines(text) {
  return parseBridges(text).map((bridge) => 'Bridge ' + bridge.line);
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
        this.transport?.stop();
        this.transport = null;
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
    if (bridges.length) {
      const requested = parseBridges(cfg.bridges)
        .map((bridge) => bridge.transport)
        .filter(Boolean);
      if (requested.length) {
        const managed = await startTransport(
          transport,
          path.join(this.directory, 'transports'),
          requested,
        );
        if (this.generation !== generation) {
          managed.stop();
          return;
        }
        this.transport = managed;
        for (const [name, port] of Object.entries(managed.ports))
          torrc.push('ClientTransportPlugin ' + name + ' socks5 127.0.0.1:' + port);
      }
      torrc.push('UseBridges 1', ...bridges);
    }
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
    const managed = this.transport;
    managed?.child.once('exit', () => {
      if (generation === this.generation && this.child === child) child.kill();
    });
    await new Promise((resolve, reject) => {
      let output = '',
        settled = false;
      const stalled = () => {
        if (!settled) {
          settled = true;
          clearTimeout(maxTimer);
          reject(new Error('Tor bootstrap timed out; check the network or use a working bridge'));
        }
      };
      let timer = setTimeout(stalled, 180000);
      const maxTimer = setTimeout(stalled, 600000);
      const accept = (chunk) => {
        output = (output + String(chunk)).slice(-16384);
        const match = /Bootstrapped (\d+)%[^\r\n]*/g;
        let current;
        while ((current = match.exec(output))) {
          if (generation !== this.generation || Number(current[1]) <= this.state.progress) continue;
          clearTimeout(timer);
          timer = setTimeout(stalled, 180000);
          this.change({ progress: Number(current[1]), detail: current[0] });
          if (Number(current[1]) === 100 && !settled) {
            settled = true;
            clearTimeout(timer);
            clearTimeout(maxTimer);
            resolve();
          }
        }
      };
      child.stdout.on('data', accept);
      child.stderr.on('data', accept);
      child.once('error', (error) => {
        clearTimeout(timer);
        clearTimeout(maxTimer);
        settled = true;
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        clearTimeout(maxTimer);
        if (this.child === child) this.child = null;
        managed?.stop();
        if (this.transport === managed) this.transport = null;
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
    this.transport?.stop();
    this.transport = null;
    return this.status();
  }
}
module.exports = { TorRemote, bridgeLines };
