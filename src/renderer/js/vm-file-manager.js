/* SPDX-License-Identifier: GPL-3.0-or-later */
(async () => {
  const api = window.vmFiles;
  const panes = Object.fromEntries(['host', 'vm'].map(side => [side, { element: document.querySelector(`[data-side="${side}"]`), selected: new Set(), entries: [], path: '', parent: '', sequence: 0 }]));
  let busy = false;
  const status = document.getElementById('status');
  function theme(data) {
    const value = data.theme || {}, dark = value.mode === 'dark' || value.mode !== 'light' && data.shouldUseDarkColors;
    const root = document.documentElement;
    root.dataset.focusOutlines = value.focusOutlines === false ? 'off' : 'on';
    root.style.colorScheme = dark ? 'dark' : 'light';
    for (const [key, color] of Object.entries({ bg: value.backgroundColor || (dark ? '#17181d' : '#f5f7fa'), panel: dark ? '#22252c' : '#fff', fg: dark ? '#edf0f5' : '#20242e', muted: dark ? '#b0b8c9' : '#626b7d', border: dark ? '#3b414e' : '#dce1ea', accent: value.accentColor || '#4f8cff' })) root.style.setProperty('--' + key, color);
  }
  function bytes(value) { return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B'; }
  function selection(side) {
    const pane = panes[side];
    pane.element.querySelectorAll('.file').forEach((row, index) => row.setAttribute('aria-selected', String(pane.selected.has(pane.entries[index].path))));
    pane.element.querySelector('.selection-count').textContent = t('ui.vmFiles.selected', '已选择 {count} 项', { count: pane.selected.size });
  }
  function draw(side) {
    const pane = panes[side], list = pane.element.querySelector('.files');
    list.replaceChildren();
    for (const entry of pane.entries) {
      const row = document.createElement('button'); row.className = 'file'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(pane.selected.has(entry.path)));
      const icon = document.createElement('i'); icon.className = 'fa-solid ' + (entry.link ? 'fa-link' : entry.directory ? 'fa-folder' : 'fa-file');
      const name = document.createElement('span'); name.className = 'file-name'; name.textContent = entry.name; row.title = entry.name;
      const size = document.createElement('span'); size.className = 'file-size'; size.textContent = entry.directory ? '' : bytes(entry.size);
      row.append(icon, name, size);
      row.onclick = event => {
        const index = pane.entries.indexOf(entry);
        if (event.shiftKey && pane.anchor != null) {
          for (let i = Math.min(index, pane.anchor); i <= Math.max(index, pane.anchor); i++) pane.selected.add(pane.entries[i].path);
        } else {
          if (!event.ctrlKey && !event.metaKey) pane.selected.clear();
          if (pane.selected.has(entry.path)) pane.selected.delete(entry.path); else pane.selected.add(entry.path);
          pane.anchor = index;
        }
        selection(side);
      };
      row.ondblclick = () => { if (entry.directory) load(side, entry.path); };
      row.onkeydown = event => { if (event.key === 'Enter' && entry.directory) { event.preventDefault(); load(side, entry.path); } };
      list.append(row);
    }
    if (!pane.entries.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = t('ui.vmFiles.empty', '此文件夹为空'); list.append(empty); }
    pane.element.querySelector('.selection-count').textContent = t('ui.vmFiles.selected', '已选择 {count} 项', { count: pane.selected.size });
  }
  async function load(side, directory) {
    const pane = panes[side], sequence = ++pane.sequence;
    status.textContent = t('ui.vmFiles.loading', '正在读取文件夹…');
    const result = await api.list(side, directory);
    if (sequence !== pane.sequence) return;
    if (!result.ok) { status.textContent = result.error; return; }
    Object.assign(pane, { path: result.path, parent: result.parent, entries: result.entries, anchor: null }); pane.selected.clear();
    pane.element.querySelector('.path').value = pane.path; draw(side); status.textContent = '';
  }
  for (const [side, pane] of Object.entries(panes)) {
    pane.element.querySelectorAll('button[data-action]').forEach(button => { button.onclick = async () => {
      const action = button.dataset.action;
      if (action === 'parent') return load(side, pane.parent);
      if (action === 'refresh') return load(side, pane.path);
      if (action === 'go') return load(side, pane.element.querySelector('.path').value);
      if (action === 'mkdir') {
        const dialog = document.getElementById('folder-dialog'), input = document.getElementById('folder-name'); input.value = ''; dialog.showModal(); input.focus();
        dialog.onclose = async () => { if (dialog.returnValue !== 'create') return; const result = await api.mkdir(side, pane.path, input.value); if (!result.ok) status.textContent = result.error; else await load(side, pane.path); };
      }
    }; });
    pane.element.querySelector('.path').onkeydown = event => { if (event.key === 'Enter') load(side, event.target.value); };
    pane.element.querySelector('.files').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'a') { event.preventDefault(); pane.entries.forEach(entry => pane.selected.add(entry.path)); selection(side); } });
  }
  async function transfer(from) {
    if (busy) return;
    const source = panes[from], destination = panes[from === 'host' ? 'vm' : 'host'];
    if (!source.selected.size) { status.textContent = t('ui.vmFiles.selectFirst', '请先选择文件或文件夹'); return; }
    busy = true; document.getElementById('upload').disabled = document.getElementById('download').disabled = true; document.getElementById('cancel').hidden = false;
    try {
      const result = await api.transfer({ from, paths: [...source.selected], destination: destination.path, overwrite: document.getElementById('overwrite').checked });
      if (result.ok) {
        await load(from === 'host' ? 'vm' : 'host', destination.path);
        status.textContent = t('ui.vmFiles.complete', '完成：{files} 个文件，{bytes}；跳过 {skipped} 个同名文件', { files: result.files, bytes: bytes(result.bytes), skipped: result.skipped.length });
      } else status.textContent = result.error;
    } finally { busy = false; document.getElementById('upload').disabled = document.getElementById('download').disabled = false; document.getElementById('cancel').hidden = true; }
  }
  document.getElementById('upload').onclick = () => transfer('host'); document.getElementById('download').onclick = () => transfer('vm');
  document.getElementById('cancel').onclick = () => api.cancel();
  document.querySelectorAll('.window-controls button').forEach(button => { button.onclick = () => api.window(button.dataset.action); });
  api.onProgress(progress => { status.textContent = t('ui.vmFiles.progress', '{files} 个文件 · {bytes} · {path}', { files: progress.files, bytes: bytes(progress.bytes), path: progress.current }); });
  api.onTheme(theme);
  api.onSettings(settings => { if (settings.language) { i18nSetLanguage(settings.language); i18nApplyToDOM(); draw('host'); draw('vm'); } });
  const initial = await api.initial(); theme(initial); i18nInit(initial.language); i18nApplyToDOM();
  await Promise.all([load('host', initial.host), load('vm', initial.vm)]);
})().catch(error => { document.getElementById('status').textContent = error.message; });
