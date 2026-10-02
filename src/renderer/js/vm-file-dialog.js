'use strict';
window.initializeVMFilePicker = async (container, filePicker) => {
  const config = await filePicker.config();
  const byId = (id) => container.querySelector('#' + id);
  const error = (message) => {
    byId('status').textContent = message || '';
  };
  let current = config.initial;
  let selected = null;
  if (config.theme.mode === 'dark') {
    for (const [name, value] of Object.entries({
      bg: '#232839',
      fg: '#edf1f5',
      surface: '#30384b',
      line: '#475064',
    }))
      container.style.setProperty('--' + name, value);
    container.style.colorScheme = 'dark';
  }
  if (/^#[0-9a-f]{6}$/i.test(config.theme.accentColor || ''))
    container.style.setProperty('--accent', config.theme.accentColor);
  if (/^#[0-9a-f]{6}$/i.test(config.theme.backgroundColor || ''))
    container.style.setProperty('--bg', config.theme.backgroundColor);
  byId('title').textContent = config.title;
  byId('filename').value = config.filename;
  byId('filename').disabled = config.directory;
  byId('choose').textContent = config.save ? '保存' : config.directory ? '选择文件夹' : '打开';
  async function browse(directory) {
    const result = await filePicker.browse(directory);
    if (!result.ok) return error(result.error);
    current = result.path;
    selected = null;
    byId('directory').value = current;
    byId('entries').replaceChildren();
    const entries = result.entries.sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN'),
    );
    for (const entry of entries) {
      if (config.directory && !entry.isDirectory) continue;
      const extensions = config.filters.flatMap((filter) => filter.extensions || []);
      if (
        !entry.isDirectory &&
        extensions.length &&
        !extensions.includes('*') &&
        !extensions.some((extension) =>
          entry.name.toLowerCase().endsWith('.' + extension.toLowerCase()),
        )
      )
        continue;
      const button = document.createElement('button');
      button.className = 'entry';
      button.setAttribute('aria-selected', 'false');
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = entry.isDirectory ? '📁' : '📄';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;
      button.append(icon, name);
      button.onclick = () => {
        for (const row of byId('entries').children) row.setAttribute('aria-selected', 'false');
        button.setAttribute('aria-selected', 'true');
        selected = entry;
        if (!entry.isDirectory) byId('filename').value = entry.name;
      };
      button.ondblclick = () =>
        entry.isDirectory ? browse(current.replace(/\/$/, '') + '/' + entry.name) : choose();
      byId('entries').append(button);
    }
    error('');
  }
  async function choose() {
    const name = byId('filename').value.trim();
    if (!config.directory && !name) return error('请输入或选择文件名');
    if (!config.directory && /[/\\]/.test(name)) return error('文件名不能包含目录分隔符');
    const target = config.directory
      ? selected?.isDirectory
        ? current.replace(/\/$/, '') + '/' + selected.name
        : current
      : current.replace(/\/$/, '') + '/' + name;
    let result = await filePicker.choose(target, false);
    if (result.overwrite && window.confirm(result.error))
      result = await filePicker.choose(target, true);
    if (!result.ok) error(result.error);
  }
  byId('choose').onclick = () => choose().catch((e) => error(e.message));
  byId('go').onclick = () => browse(byId('directory').value).catch((e) => error(e.message));
  byId('directory').onkeydown = (e) => {
    if (e.key === 'Enter') byId('go').click();
  };
  byId('filename').onkeydown = (e) => {
    if (e.key === 'Enter') byId('choose').click();
  };
  byId('up').onclick = () => browse(current.split('/').slice(0, -1).join('/') || '/');
  byId('newFolder').onclick = () => {
    byId('folderForm').hidden = false;
    byId('folderName').focus();
  };
  byId('cancelFolder').onclick = () => {
    byId('folderForm').hidden = true;
  };
  byId('createFolder').onclick = async () => {
    const name = byId('folderName').value.trim();
    if (!name) return;
    if (/[/\\]/.test(name) || name === '..') return error('请输入有效的文件夹名称');
    const result = await filePicker.mkdir(current.replace(/\/$/, '') + '/' + name);
    if (!result.ok) return error(result.error);
    byId('folderForm').hidden = true;
    byId('folderName').value = '';
    await browse(current);
  };
  byId('folderName').onkeydown = (event) => {
    if (event.key === 'Enter') byId('createFolder').click();
  };
  byId('cancel').onclick = () => filePicker.cancel();
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') filePicker.cancel();
  });
  await browse(current);
};
