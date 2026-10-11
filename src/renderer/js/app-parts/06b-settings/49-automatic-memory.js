/* SPDX-License-Identifier: GPL-3.0-or-later */
  let automaticMemoryState = { revision: 0, items: [] };
  let automaticMemoryLoad = 0;
  let automaticMemoryEditing = false;
  const automaticMemoryList = document.getElementById('automatic-memory-list');
  const automaticMemoryStatus = document.getElementById('automatic-memory-status');
  const automaticMemorySearch = document.getElementById('automatic-memory-search');
  const autoMemoryText = value => typeof chatGPTText === 'function' ? chatGPTText(value) : value;

  function loadAutomaticMemorySettings(settings) {
    document.querySelectorAll('[data-auto-memory]').forEach(input => {
      input.checked = settings.automaticMemory?.[input.dataset.autoMemory] !== false;
    });
  }

  async function refreshAutomaticMemory() {
    if (!automaticMemoryList || automaticMemoryEditing) return;
    const request = ++automaticMemoryLoad;
    try {
      const data = await window.api.automaticMemoryList(automaticMemorySearch.value);
      if (request !== automaticMemoryLoad || automaticMemoryEditing) return;
      automaticMemoryState = data;
      automaticMemoryStatus.textContent = autoMemoryText(data.error ? '自动记忆暂不可用，请稍后重试' : data.busy ? '正在整理记忆…' : '记忆已同步');
      automaticMemoryList.replaceChildren();
      document.getElementById('automatic-memory-clear').disabled = !data.error && !data.items.length && !automaticMemorySearch.value;
      if (!data.items.length) {
        const empty = document.createElement('div'); empty.className = 'automatic-memory-empty';
        const icon = document.createElement('i'); icon.className = 'fa-solid fa-seedling'; icon.setAttribute('aria-hidden', 'true');
        const title = document.createElement('strong'); title.textContent = autoMemoryText(automaticMemorySearch.value ? '没有匹配的记忆' : '了解，从对话开始');
        const hint = document.createElement('p'); hint.textContent = autoMemoryText('聊聊你的偏好或正在推进的事情，值得延续的信息会出现在这里。');
        empty.append(icon, title, hint); automaticMemoryList.append(empty); return;
      }
      for (const item of data.items) {
        const card = document.createElement('article'); card.className = 'automatic-memory-item';
        const heading = document.createElement('div'); heading.className = 'automatic-memory-heading';
        const title = document.createElement('strong'); title.textContent = item.topic;
        const badge = document.createElement('span'); badge.className = 'automatic-memory-badge'; badge.textContent = autoMemoryText(item.scope === 'babe' ? 'Babe 独立记忆' : item.scope === 'global' ? '个人记忆' : '工作区记忆');
        heading.append(title, badge);
        const content = document.createElement('p'); content.textContent = item.content;
        const footer = document.createElement('footer');
        const meta = document.createElement('span'); meta.textContent = [item.edited ? autoMemoryText('手动编辑 · 自动更新已锁定') : autoMemoryText('从对话中记住'), new Date(item.updatedAt).toLocaleDateString(i18nGetLanguage())].join(' · ');
        meta.title = [item.workspace, item.evidence].filter(Boolean).join('\n');
        const actions = document.createElement('div');
        const edit = document.createElement('button'); edit.className = 'btn-icon'; edit.type = 'button'; edit.title = autoMemoryText('编辑'); edit.setAttribute('aria-label', edit.title); edit.innerHTML = '<i class="fa-solid fa-pen"></i>';
        const remove = document.createElement('button'); remove.className = 'btn-icon'; remove.type = 'button'; remove.title = autoMemoryText('删除'); remove.setAttribute('aria-label', remove.title); remove.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        edit.addEventListener('click', () => {
          if (automaticMemoryEditing) return;
          automaticMemoryEditing = true;
          const textarea = document.createElement('textarea'); textarea.value = item.content; textarea.rows = 4; textarea.maxLength = 600; textarea.setAttribute('aria-label', autoMemoryText('编辑自动记忆'));
          content.replaceWith(textarea); actions.replaceChildren();
          const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-primary'; save.textContent = autoMemoryText('保存');
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = autoMemoryText('取消');
          const close = () => { automaticMemoryEditing = false; refreshAutomaticMemory(); };
          cancel.addEventListener('click', close);
          save.addEventListener('click', async () => {
            if (!textarea.value.trim()) { textarea.focus(); return; }
            save.disabled = true;
            try {
              const result = await window.api.automaticMemoryEdit({ id: item.id, content: textarea.value, revision: automaticMemoryState.revision });
              if (result.ok) { close(); return; }
              if (result.conflict) automaticMemoryState.revision = (await window.api.automaticMemoryList()).revision;
              automaticMemoryStatus.textContent = autoMemoryText(result.conflict ? '记忆已在其他界面更新，请核对后再次保存' : '无法保存，请检查内容中是否包含敏感信息');
            } catch { automaticMemoryStatus.textContent = autoMemoryText('自动记忆暂不可用，请稍后重试'); }
            finally { save.disabled = false; }
          });
          textarea.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
          actions.append(cancel, save); textarea.focus();
        });
        remove.addEventListener('click', async () => {
          if (!await window.api.confirmSensitive(autoMemoryText('删除这条自动记忆？聊天记录将保留。'))) return;
          remove.disabled = true;
          try {
            const result = await window.api.automaticMemoryRemove({ id: item.id, revision: automaticMemoryState.revision });
            await refreshAutomaticMemory();
            if (!result.ok) automaticMemoryStatus.textContent = autoMemoryText('记忆已在其他界面更新，请核对后再次保存');
          } catch { automaticMemoryStatus.textContent = autoMemoryText('自动记忆暂不可用，请稍后重试'); }
          finally { remove.disabled = false; }
        });
        actions.append(edit, remove); footer.append(meta, actions); card.append(heading, content, footer); automaticMemoryList.append(card);
      }
    } catch { automaticMemoryStatus.textContent = autoMemoryText('自动记忆暂不可用，请稍后重试'); }
  }

  document.querySelectorAll('[data-auto-memory]').forEach(input => input.addEventListener('change', async () => {
    try { loadAutomaticMemorySettings(await saveSettings({ automaticMemory: { [input.dataset.autoMemory]: input.checked } })); }
    catch { input.checked = !input.checked; automaticMemoryStatus.textContent = autoMemoryText('自动记忆暂不可用，请稍后重试'); }
  }));
  automaticMemorySearch?.addEventListener('input', () => refreshAutomaticMemory());
  document.getElementById('automatic-memory-refresh')?.addEventListener('click', () => refreshAutomaticMemory());
  document.getElementById('automatic-memory-clear')?.addEventListener('click', async () => {
    if (!await window.api.confirmSensitive(autoMemoryText('清空所有自动记忆？长期记忆和聊天记录将保留。'))) return;
    try {
      const result = await window.api.automaticMemoryRemove({ all: true, revision: automaticMemoryState.revision });
      await refreshAutomaticMemory();
      if (!result.ok) automaticMemoryStatus.textContent = autoMemoryText('记忆已在其他界面更新，请核对后再次保存');
    } catch { automaticMemoryStatus.textContent = autoMemoryText('自动记忆暂不可用，请稍后重试'); }
  });
  window.api.onAutomaticMemoryChanged?.(() => {
    if (document.querySelector('.settings-panel[data-tab="automatic-memory"].active')) refreshAutomaticMemory();
  });
  window.api.onSettingsChanged?.(() => readSettings().then(loadAutomaticMemorySettings).catch(() => {}));
  window.addEventListener('languagechange', () => {
    if (document.querySelector('.settings-panel[data-tab="automatic-memory"].active')) refreshAutomaticMemory();
  });
