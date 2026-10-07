/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Editors execute in this browser. Files still use the backend's host/VM IO.
function createBrowserEditorFiles(request, picker) {
  const type = window.location.pathname.endsWith('/cipypcad.html') ? 'cipypcad' : window.location.pathname.endsWith('/pcbeda.html') ? 'pcbeda' : '';
  const actions = new Set(['saveProjectDialog', 'loadProjectDialog', 'saveImageDialog', 'saveFileDialog', 'exportDirDialog', 'importFileDialog', 'importDxfDialog', 'saveProject', 'loadProject', 'exportDxf', 'exportImage', 'getHatchPatterns']);
  const invoke = (channel, ...args) => request('ipc:invoke', channel, ...args);
  const basename = raw => String(raw).split(/[/\\]/).pop();
  const dirname = raw => String(raw).replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  async function read(file) { const result = await invoke('fs:readFile', file, 'utf-8'); if (!result.ok) throw new Error(result.error); return result.content; }
  async function write(file, data) { const result = await invoke('filePicker:write', file, data); if (!result.ok) throw new Error(result.error); return { ok: true, path: file }; }
  async function choose(save, options = {}) {
    const base = await invoke('workspace:getBase');
    const result = await picker.invoke(save ? 'dialog:saveFile' : 'dialog:openFile', { ...options, defaultPath: options.defaultPath ? base.replace(/[\\/]$/, '') + '/' + basename(options.defaultPath) : base });
    return result.ok ? { ok: true, path: result.path || result.paths[0] } : result;
  }
  return {
    handles(channel) { const [prefix, action] = channel.split(':'); return !!type && prefix === type && actions.has(action); },
    async invoke(channel, ...args) {
      const action = channel.split(':')[1];
      try {
        if (action === 'saveProjectDialog') return await choose(true, { defaultPath: type === 'cipypcad' ? 'project.cipyproj' : 'project.cipypcb' });
        if (action === 'loadProjectDialog') return await choose(false, { properties: ['openFile'] });
        if (action === 'saveImageDialog' || action === 'saveFileDialog') return await choose(true, { defaultPath: args[0] || 'export.png' });
        if (action === 'exportDirDialog') return await choose(false, { properties: ['openDirectory'] });
        if (action === 'importFileDialog' || action === 'importDxfDialog') {
          const chosen = await choose(false, { properties: ['openFile'] });
          if (!chosen.ok) return chosen;
          const content = await read(chosen.path);
          return type === 'cipypcad' ? window.cadImportDxfString(content, chosen.path) : { ...chosen, name: basename(chosen.path), content };
        }
        const file = args[0];
        if (action === 'getHatchPatterns') return window.cadGetHatchPatterns();
        if (action === 'saveProject') {
          if (type === 'pcbeda' && args[1]) {
            const result = window.pcbGetMultiFiles(basename(file).replace(/\.cibypcbproj$/i, '')); if (!result.ok) return result;
            await write(file, JSON.stringify(result.data.manifest, null, 2));
            for (const item of result.data.files) await write(dirname(file) + '/' + basename(item.name), JSON.stringify(item.data, null, 2));
            return { ok: true, path: file, files: result.data.files.length + 1 };
          }
          const result = type === 'cipypcad' ? window.cadGetProjectJSON() : window.pcbGetProjectJSON();
          return result.ok ? await write(file, JSON.stringify(result.data, null, 2)) : result;
        }
        if (action === 'loadProject') {
          const content = await read(file);
          if (type === 'cipypcad') return window.cadLoadProjectJSON(JSON.parse(content), file);
          if (/\.cibypcbproj$/i.test(file)) {
            const manifest = JSON.parse(content), contents = {};
            for (const item of manifest.files || []) contents[item.file] = JSON.parse(await read(dirname(file) + '/' + basename(item.file)));
            return window.pcbLoadMultiFiles(manifest, contents);
          }
          return /\.(kicad_pcb|kicad_net|net|csv|txt)$/i.test(file) ? window.pcbImportData(basename(file), content) : window.pcbLoadProjectJSON(JSON.parse(content));
        }
        if (action === 'exportDxf') { const result = window.cadGetDxfString(); return result.ok ? await write(file, result.dxf) : result; }
        if (action === 'exportImage') {
          if (args[1] === 'svg') { const result = window.cadGetSVGString(); return result.ok ? await write(file, result.svg) : result; }
          const result = window.cadGetPNGDataUrl(1920, 1080); if (!result.ok) return result;
          return await write(file, await (await fetch(result.dataUrl)).arrayBuffer());
        }
        throw new Error('Unsupported editor file operation');
      } catch (error) { return { ok: false, error: error.message }; }
    },
  };
}
module.exports = { createBrowserEditorFiles };
