  (() => {
    const section = document.getElementById('settings-history-management');
    const panel = section.closest('.settings-panel');
    const list = section.querySelector('.history-management-list');
    const status = section.querySelector('[role="status"]');
    const count = section.querySelector('[data-history-count]');
    const search = section.querySelector('#history-management-query');
    const restore = section.querySelector('[data-history-restore]');
    const password = restore.elements.namedItem('password');
    const file = restore.elements.namedItem('file');
    const more = section.querySelector('[data-history-more]');
    const selected = new Map();
    const fields = new Map();
    const label = (key, fallback, vars) => t('ui.archive.' + key, fallback, vars);
    const request = (action, data) => window.api.backendRequest('history:manage', action, data);
    const key = row => JSON.stringify([row.mode, row.workspacePath, row.id]);
    let next = null, busy = false, query = '';

    function update() {
      count.textContent = label('selected', '已选 {count} 个', { count: selected.size });
      section.querySelectorAll('[data-history-action]').forEach(button => {
        const action = button.dataset.historyAction;
        button.disabled = busy || (action === 'select' ? !fields.size : !selected.size);
      });
      restore.querySelector('button').disabled = busy;
      more.disabled = busy;
      more.hidden = next === null;
    }
    async function load(append = false) {
      if (!append) { list.replaceChildren(); fields.clear(); next = null; }
      const page = await request('list', { query, offset: append ? next : 0 });
      next = page.next;
      for (const row of page.rows) {
        const id = key(row);
        if (fields.has(id)) continue;
        const item = document.createElement('li');
        const field = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = selected.has(id);
        box.addEventListener('change', () => {
          if (box.checked) selected.set(id, row);
          else selected.delete(id);
          update();
        });
        const content = document.createElement('span');
        content.textContent = row.title || label('unknown', '未命名会话');
        const meta = document.createElement('small');
        meta.textContent = [row.mode, row.ts ? new Date(row.ts).toLocaleString() : '', row.workspacePath].filter(Boolean).join(' · ');
        field.append(box, content, meta);
        item.append(field);
        list.append(item);
        fields.set(id, { box, row });
      }
      status.textContent = fields.size ? '' : label('empty', '没有匹配的聊天记录');
      update();
    }
    async function work(task) {
      if (busy) return;
      busy = true;
      status.textContent = label('working', '正在处理聊天记录…');
      update();
      try { await task(); }
      catch (error) {
        const code = String(error.message || error);
        status.textContent =
          code.includes('CONVERSATION_ARCHIVE_AUTH') ? label('auth', '密码错误或备份文件已损坏') :
          code.includes('ARCHIVE_PASSWORD_LENGTH') ? label('passwordHelp', '请输入至少 8 个字符的备份密码') :
          code.includes('CONVERSATION_ARCHIVE_SIZE') ? label('tooLarge', '单次最多处理 8 MiB 的会话，请减少选择') :
          label('failed', '聊天记录操作失败') + ' · ' + code;
      } finally {
        busy = false;
        update();
      }
    }
    function download(text, extension) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'CIBYP-' + new Date().toISOString().slice(0, 10) + '.' + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    section.querySelector('[data-history-search]').addEventListener('submit', event => {
      event.preventDefault();
      void work(async () => { query = search.value; await load(); });
    });
    more.addEventListener('click', () => { if (next !== null) void work(() => load(true)); });
    section.addEventListener('click', event => {
      const action = event.target.closest('[data-history-action]')?.dataset.historyAction;
      if (!action) return;
      if (action === 'select' || action === 'clear') {
        if (action === 'clear') selected.clear();
        for (const [id, { box, row }] of fields) {
          box.checked = action === 'select';
          if (box.checked) selected.set(id, row);
        }
        update();
        return;
      }
      const rows = [...selected.values()];
      void work(async () => {
        if (action === 'delete') {
          if (!await window.confirmDialog(label('confirm', '永久删除选中的 {count} 个会话及其上下文？', { count: rows.length }))) {
            status.textContent = '';
            return;
          }
          const result = await request('delete', { rows });
          result.deleted.forEach((row, index) => { if (row.ok) selected.delete(key(rows[index])); });
          await load();
          status.textContent = label('deleted', '已删除 {count} 个会话', { count: result.deleted.filter(row => row.ok).length });
          if (result.deleted.some(row => !row.ok)) status.textContent += ' · ' + label('partial', '部分操作失败');
          return;
        }
        const format = { Markdown: 'md', JSON: 'json', SQL: 'sql', TXT: 'txt' }[section.querySelector('select').value];
        const encrypted = action === 'encrypted';
        const response = await request(action === 'export' ? 'export' : 'backup', {
          rows, format, password: encrypted ? password.value : undefined,
        });
        if (encrypted) password.value = '';
        download(response.text, action === 'export' ? format : 'cibyp-backup');
        status.textContent = label('saved', '文件已交给下载管理器');
      });
    });
    restore.addEventListener('submit', event => {
      event.preventDefault();
      if (!file.files.length) return;
      void work(async () => {
        const backup = file.files[0];
        if (backup.size > 12 * 1024 * 1024) throw new Error('CONVERSATION_ARCHIVE_SIZE');
        const value = await request('restore', {
          text: await backup.text(), password: password.value || undefined,
        });
        if (!value.failed?.length) file.value = '';
        password.value = '';
        await load();
        status.textContent = label('restored', '已还原 {count} 个会话副本', { count: value.restored.length });
        if (value.failed?.length) {
          status.textContent += ' · ' + label('restoreFailed', '{count} 个会话还原失败', { count: value.failed.length });
        }
      });
    });
    new MutationObserver(() => {
      if (panel.classList.contains('active')) void work(() => load());
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    update();
  })();
