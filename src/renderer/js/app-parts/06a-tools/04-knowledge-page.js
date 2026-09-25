  // ---- Knowledge Page ----
  async function loadKnowledgePage(query = '') {
    const list = document.getElementById('knowledge-list');
    const items = await window.api.knowledgeSearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-database"></i><p>知识库为空</p></div>';
      return;
    }
    list.innerHTML = items.map(k => `
      <div class="knowledge-item" data-id="${k.id}">
        <div class="item-title">${escapeHtml(k.title || '未命名')}</div>
        <div class="item-content">${escapeHtml(k.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(k.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-actions">
            <button class="btn-icon knowledge-delete" data-id="${k.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.knowledge-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条知识吗？');
        if (!confirmed) return;
        await window.api.knowledgeDelete(btn.dataset.id);
        loadKnowledgePage(query);
      });
    });
  }

  document.getElementById('knowledge-search').addEventListener('input', (e) => {
    loadKnowledgePage(e.target.value);
  });

  // Knowledge import button
  const btnImportKnowledge = document.getElementById('btn-import-knowledge');
  if (btnImportKnowledge) {
    btnImportKnowledge.addEventListener('click', async () => {
      try {
        // 先选择文件
        const selectResult = await window.api.openFileDialog();
        if (!selectResult.ok || !selectResult.paths || selectResult.paths.length === 0) return;

        // 对每个文件进行导入
        for (const filePath of selectResult.paths) {
          const result = await window.api.knowledgeImportFile(filePath, agent.workspacePath);
          if (result.ok) {
            const title = result.fileName || '导入文件';
            await window.api.knowledgeAdd({ title, content: result.content });

            // 如果有提取的图片，也添加到消息中作为引用
            if (result.images && result.images.length > 0) {
              await window.api.knowledgeAdd({
                title: `${title} - 图片`,
                content: `图片文件：${result.images.join(', ')}`
              });
            }
          } else {
            const errMsg = result.error || '导入失败';
            if (typeof window.showToast === 'function') {
              window.showToast(`${result.fileName || '文件'}: ${errMsg}`, 'error', 6000);
            } else {
              console.error('Knowledge import failed:', errMsg);
            }
          }
        }
        loadKnowledgePage();
      } catch (e) {
        console.error('Import knowledge error:', e);
      }
    });
  }
