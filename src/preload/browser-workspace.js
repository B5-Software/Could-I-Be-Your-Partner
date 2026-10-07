/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

function createBrowserWorkspace(request) {
  let active;
  return async function openWorkspace(raw) {
    const settings = await request('getSettings');
    const copy = {
      en: ['Workspace files', 'Browse files on the connected computer', 'Up', 'Go', 'Refresh', 'Close', 'Download', 'Loading…', 'Empty directory', 'Downloading…', 'Download started'],
      de: ['Arbeitsbereich', 'Dateien auf dem verbundenen Computer durchsuchen', 'Nach oben', 'Öffnen', 'Aktualisieren', 'Schließen', 'Herunterladen', 'Wird geladen…', 'Leerer Ordner', 'Wird heruntergeladen…', 'Download gestartet'],
      zh: ['工作区文件', '浏览已连接电脑或虚拟机中的文件', '上一级', '前往', '刷新', '关闭', '下载', '正在加载…', '文件夹为空', '正在下载…', '已开始下载'],
    }[String(settings.language || 'zh').split('-')[0]] || ['工作区文件', '浏览已连接电脑或虚拟机中的文件', '上一级', '前往', '刷新', '关闭', '下载', '正在加载…', '文件夹为空', '正在下载…', '已开始下载'];
    const config = await request('ipc:invoke', 'filePicker:prepare', false, { defaultPath: raw, properties: ['openDirectory'] });
    active?.close(); active?.remove();
    const dialog = document.createElement('dialog'); dialog.className = 'workspace-browser';
    dialog.setAttribute('aria-label', copy[0]);
    dialog.innerHTML = '<header><div><h2></h2><p></p></div><button class="btn-icon" data-close><i class="fa-solid fa-xmark"></i></button></header><form><button class="btn btn-secondary" type="button" data-up><i class="fa-solid fa-arrow-up"></i></button><input class="form-input" aria-label="Path"><button class="btn btn-secondary" type="submit" data-go></button><button class="btn-icon" type="button" data-refresh><i class="fa-solid fa-rotate-right"></i></button></form><div class="workspace-browser-list"></div><footer role="status" aria-live="polite"></footer>';
    dialog.querySelector('h2').textContent = copy[0]; dialog.querySelector('p').textContent = copy[1];
    const input = dialog.querySelector('input'), list = dialog.querySelector('.workspace-browser-list'), status = dialog.querySelector('footer');
    for (const [selector, text] of [['[data-close]', copy[5]], ['[data-up]', copy[2]], ['[data-refresh]', copy[4]]]) dialog.querySelector(selector).setAttribute('aria-label', text);
    dialog.querySelector('[data-go]').textContent = copy[3];
    let directory = config.initial, generation = 0;
    function close() { generation++; dialog.close(); dialog.remove(); if (active === dialog) active = null; }
    async function browse(rawPath) {
      const current = ++generation; input.value = rawPath; status.textContent = copy[7]; list.setAttribute('aria-busy', 'true');
      try {
        const result = await request('ipc:invoke', 'filePicker:browse', rawPath);
        if (current !== generation || !dialog.isConnected) return;
        if (!result.ok) throw new Error(result.error);
        directory = result.path; input.value = directory; list.replaceChildren();
        const entries = result.entries.slice().sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
        for (const entry of entries) {
          const row = document.createElement('button'); row.type = 'button'; row.className = 'workspace-browser-file';
          row.innerHTML = '<i></i><span></span><i></i>'; row.children[0].className = 'fa-solid ' + (entry.isDirectory ? 'fa-folder' : 'fa-file');
          row.children[1].textContent = entry.name;
          row.children[2].className = 'fa-solid ' + (entry.isDirectory ? 'fa-chevron-right' : 'fa-download');
          if (!entry.isDirectory) row.setAttribute('aria-label', copy[6] + ': ' + entry.name);
          row.addEventListener('click', async () => {
            const file = directory.replace(/\/$/, '') + '/' + entry.name;
            if (entry.isDirectory) return browse(file);
            row.disabled = true; status.textContent = copy[9];
            try {
              const response = await fetch('/api/files/download?' + new URLSearchParams({ path: file }));
              if (!response.ok) throw new Error((await response.json()).error || 'Download failed');
              const url = URL.createObjectURL(await response.blob());
              const link = document.createElement('a'); link.href = url; link.download = entry.name; document.body.append(link); link.click(); link.remove();
              setTimeout(() => URL.revokeObjectURL(url), 60000); status.textContent = copy[10];
            } catch (error) { status.textContent = error.message; }
            finally { row.disabled = false; }
          });
          list.append(row);
        }
        status.textContent = entries.length ? String(entries.length) : copy[8];
      } catch (error) { if (current === generation) status.textContent = error.message; }
      finally { if (current === generation) list.removeAttribute('aria-busy'); }
    }
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void browse(input.value); });
    dialog.querySelector('[data-refresh]').onclick = () => browse(directory);
    dialog.querySelector('[data-up]').onclick = () => {
      if (/^[A-Za-z]:\/$/.test(directory)) return;
      let parent = directory.replace(/\/$/, '').replace(/\/[^/]*$/, '') || '/';
      if (/^[A-Za-z]:$/.test(parent)) parent += '/';
      void browse(parent);
    };
    dialog.querySelector('[data-close]').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(dialog); active = dialog; dialog.showModal(); await browse(directory);
    return { ok: true };
  };
}
module.exports = { createBrowserWorkspace };
