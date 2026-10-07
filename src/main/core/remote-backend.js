/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { BackendClient } = require('../../shared/backend-client');

function createRemoteBackend() {
  const clients = new Map();
  const localChannel = (channel) =>
    /^(window:|tray:|app:renderer-(?:ready|failed)|app:startup-(?:retry|close)|backend:remote|codeoss:layout)/.test(
      channel,
    );
  return {
    has(sender) {
      return clients.has(sender?.id);
    },
    async connect(sender, { url, password, code } = {}) {
      const client = new BackendClient({
        url,
        socketFactory: (address, token) =>
          new (require('ws'))(address, { headers: { Authorization: 'Bearer ' + token } }),
      });
      try {
        await client.login(password, code);
        const snapshot = await client.connect();
        if (sender.isDestroyed()) {
          client.close();
          throw new Error('Window closed');
        }
        clients.get(sender.id)?.picker.close();
        clients.get(sender.id)?.client.close();
        const picker = require('../../shared/client-file-picker').createClientFilePicker(
          (channel, ...args) => client.request('ipc:invoke', channel, ...args),
          (channel, payload) => {
            if (!sender.isDestroyed()) sender.send(channel, payload);
          },
        );
        clients.set(sender.id, { client, snapshot, picker });
        client.onEvent((event) => {
          if (sender.isDestroyed()) {
            client.close();
            return;
          }
          if (event.channel) sender.send(event.channel, event.payload);
          else if (event.type === 'snapshot') sender.send('backend:reconnected', event.snapshot);
          else if (event.type === 'connection') sender.send('backend:connection', event);
          else if (event.type === 'authentication-required') {
            sender.send('backend:connection', { connected: false, authenticationRequired: true });
            this.disconnect(sender);
          }
        });
        sender.once('destroyed', () => {
          picker.close();
          client.close();
          if (clients.get(sender.id)?.client === client) clients.delete(sender.id);
        });
        return { ok: true, url: client.url, pid: snapshot.pid };
      } catch (error) {
        client.close();
        return { ok: false, error: error.message };
      }
    },
    disconnect(sender) {
      const entry = clients.get(sender.id);
      entry?.picker.close();
      entry?.client.close();
      clients.delete(sender.id);
      return { ok: true };
    },
    status(sender) {
      const entry = clients.get(sender.id);
      return { connected: !!entry, url: entry?.client.url || '' };
    },
    route(channel, handler, { send = false } = {}) {
      return (event, ...args) => {
        const remote = clients.get(event.sender?.id)?.client;
        if (!remote || localChannel(channel)) return handler(event, ...args);
        const picker = clients.get(event.sender.id).picker;
        if (picker.handles(channel)) return picker.invoke(channel, ...args);
        if (channel === 'codeoss:open')
          return remote.request('ipc:invoke', 'codeoss:open-web', ...args).then((result) => ({
            ...result,
            webUrl: result.webUrl ? new URL(result.webUrl, remote.url).href : undefined,
          }));
        return channel === 'backend:request'
          ? remote.request(...args)
          : remote.request(send ? 'ipc:send' : 'ipc:invoke', channel, ...args);
      };
    },
    close() {
      for (const entry of clients.values()) {
        entry.picker.close();
        entry.client.close();
      }
      clients.clear();
    },
  };
}
module.exports = { createRemoteBackend };
