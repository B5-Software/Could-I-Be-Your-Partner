  // ---- Memory Page ----
  async function loadMemoryPage(query = '') {
    const list = document.getElementById('memory-list');
    const items = await window.api.memorySearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-brain"></i><p>暂无长期记忆</p></div>';
      return;
    }
    list.innerHTML = items.map(m => `
      <div class="memory-item" data-id="${m.id}">
        <div class="item-content">${escapeHtml(m.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(m.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-tags">${(m.tags || []).map(t => `<span class="item-tag">${escapeHtml(t)}</span>`).join('')}</div>
          <div class="item-actions">
            <button class="btn-icon memory-edit" data-id="${m.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
            <button class="btn-icon memory-delete" data-id="${m.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.memory-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条记忆吗？');
        if (!confirmed) return;
        await window.api.memoryDelete(btn.dataset.id);
        loadMemoryPage(query);
      });
    });

    list.querySelectorAll('.memory-edit').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const current = items.find(i => String(i.id) === String(id));
        const result = await openMemoryEditDialog(current);
        if (!result) return;
        await window.api.memoryUpdate(id, { content: result.content, tags: result.tags });
        loadMemoryPage(query);
      });
    });
  }

  document.getElementById('memory-search').addEventListener('input', (e) => {
    loadMemoryPage(e.target.value);
  });

  // ---- Memory Edit Modal ----
  let memoryEditResolve = null;
  function openMemoryEditDialog(item) {
    return new Promise((resolve) => {
      const modal = document.getElementById('memory-edit-modal');
      const contentEl = document.getElementById('memory-edit-content');
      const tagsEl = document.getElementById('memory-edit-tags');
      if (!modal || !contentEl || !tagsEl) {
        resolve(null);
        return;
      }
      memoryEditResolve = resolve;
      contentEl.value = item?.content || '';
      tagsEl.value = (item?.tags || []).join(', ');
      modal.classList.remove('hidden');
      contentEl.focus();
    });
  }

  function closeMemoryEditDialog(result) {
    const modal = document.getElementById('memory-edit-modal');
    fadeOutHide(modal);
    if (memoryEditResolve) {
      memoryEditResolve(result);
      memoryEditResolve = null;
    }
  }

  document.getElementById('btn-close-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-cancel-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-save-memory-edit')?.addEventListener('click', () => {
    const contentEl = document.getElementById('memory-edit-content');
    const tagsEl = document.getElementById('memory-edit-tags');
    const content = contentEl?.value.trim() || '';
    const tags = (tagsEl?.value || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!content) return;
    closeMemoryEditDialog({ content, tags });
  });
