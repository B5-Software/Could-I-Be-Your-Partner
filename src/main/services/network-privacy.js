/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { TorRemote } = require('./tor-remote');

class NetworkPrivacy {
  constructor({ app, settings, publish, proxy = require('../net-proxy'), prepare, allocatePort }) {
    Object.assign(this, { settings, proxy });
    this.tor = new TorRemote({
      app,
      settings,
      publish,
      purpose: 'privacy',
      allocatePort,
      prepare:
        prepare ||
        ((platform, arch, directory) =>
          require('../../../scripts/lib/tor-runtime.cjs').prepareTor(platform, arch, directory, {
            fetchFile: proxy.fetchTorRuntime,
          })),
      onState: (state) => this.sync(state),
    });
    this.configure();
  }
  sync(state = this.tor.status()) {
    this.proxy.setPrivacy({
      ...state,
      enabled: this.settings().networkPrivacy?.tor?.enabled === true,
    });
  }
  configure() {
    this.sync();
    if (this.settings().networkPrivacy?.tor?.enabled !== true) this.tor.stop();
  }
  status() {
    return { ...this.tor.status(), enabled: this.settings().networkPrivacy?.tor?.enabled === true };
  }
  async start() {
    if (!this.status().enabled)
      return { ...this.status(), error: 'Enable Tor network privacy before connecting' };
    if (this.tor.operation && !this.tor.child) await this.tor.operation;
    await this.tor.start();
    return this.status();
  }
  stop() {
    this.tor.stop();
    return this.status();
  }
  autoStart() {
    if (this.status().enabled && this.settings().networkPrivacy?.tor?.autoStart)
      return this.start();
  }
}

module.exports = { NetworkPrivacy };
