/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Reuse the GUI modal and its keyboard/focus behavior in every remote frontend.
// Modal lifetime and responses belong to the requesting client, never a GUI window.
function createClientFilePicker(request, publish) {
  const pending = new Map(); let queue = Promise.resolve(), closed = false;
  function finish(id, value) { const item = pending.get(id); if (!item) return; pending.delete(id); publish('vmFileDialog:close', { id }); item.resolve(value || { ok: false, canceled: true, paths: [] }); }
  return {
    handles: channel => ['dialog:openFile','dialog:saveFile','vmFileDialog:config','vmFileDialog:browse','vmFileDialog:mkdir','vmFileDialog:choose','vmFileDialog:cancel'].includes(channel),
    async invoke(channel, ...args) {
      if (channel.startsWith('dialog:')) {
        const operation = queue.then(async () => {
          if (closed) return { ok: false, canceled: true, paths: [] };
          const config = await request('filePicker:prepare', channel === 'dialog:saveFile', args[0]);
          if (closed) return { ok: false, canceled: true, paths: [] };
          const id = globalThis.crypto.randomUUID();
          return new Promise(resolve => { pending.set(id, { resolve, config }); publish('vmFileDialog:open', { id, config }); });
        });
        queue = operation.catch(() => {}); return operation;
      }
      const [id, raw, overwrite] = args, item = pending.get(id);
      if (!item) throw new Error('File picker is closed');
      if (channel === 'vmFileDialog:config') return item.config;
      if (channel === 'vmFileDialog:browse') return request('filePicker:browse', raw);
      if (channel === 'vmFileDialog:mkdir') return request('filePicker:mkdir', raw);
      if (channel === 'vmFileDialog:cancel') { finish(id); return { ok: true }; }
      const result = await request('filePicker:validate', raw, item.config, overwrite);
      if (result.ok) finish(id, item.config.save ? { ok: true, path: result.path } : { ok: true, paths: [result.path] });
      return result;
    },
    close() { closed = true; for (const id of pending.keys()) finish(id); },
  };
}
module.exports = { createClientFilePicker };
