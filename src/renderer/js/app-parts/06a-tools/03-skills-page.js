  // ---- Skills Page ----
  async function importStandardSkillFile(skillMdPath) {
    const readResult = await window.api.readFile(skillMdPath);
    if (!readResult?.ok) return { ok: false, error: readResult?.error || '读取 SKILL.md 失败' };

    const rootDir = getPathDirname(skillMdPath);
    const scripts = await collectSkillScripts(rootDir);
    const skillPayload = buildStandardSkillFromMarkdown(skillMdPath, readResult.content || '', scripts);

    const existing = await window.api.listSkills();
    const matched = (Array.isArray(existing) ? existing : []).find(s => String(s?.sourcePath || '') === String(skillMdPath));
    if (matched?.id) {
      const updated = await window.api.updateSkill(matched.id, skillPayload);
      if (updated?.ok === false) return { ok: false, error: updated.error || '更新技能失败' };
      return { ok: true, mode: 'updated', name: skillPayload.name };
    }
    const created = await window.api.createSkill(skillPayload);
    if (!created) return { ok: false, error: '创建技能失败' };
    return { ok: true, mode: 'created', name: skillPayload.name };
  }

  async function loadSkillsPage() {
    const list = document.getElementById('skills-list');
    const userSkills = await window.api.listSkills();
    // Merge bundled (built-in) skills with user skills.
    // User skills with the same name override bundled skills (matching agent behavior).
    let bundled = [];
    try {
      if (typeof BUNDLED_SKILLS !== 'undefined') bundled = BUNDLED_SKILLS || [];
    } catch { /* bundled-skills.js not loaded */ }
    const overriddenNames = new Set(userSkills.map(s => s.name));
    const visibleBundled = bundled.filter(s => !overriddenNames.has(s.name));
    const allSkills = [...visibleBundled, ...userSkills];

    if (allSkills.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-lightbulb"></i><p>暂无技能，点击上方按钮添加或导入 SKILL.md</p></div>';
      return;
    }
    list.innerHTML = allSkills.map(s => {
      const isBundled = !!s.bundled;
      const isOverriding = !isBundled && bundled.some(b => b.name === s.name);
      const iconClass = isBundled ? 'fa-shield-halved' : 'fa-lightbulb';
      const badgeHtml = isBundled
        ? '<span class="skill-badge skill-badge-builtin">内置</span>'
        : (isOverriding ? '<span class="skill-badge skill-badge-override">覆盖内置</span>' : '');
      const actionsHtml = isBundled
        ? `<button class="btn-icon skill-view" data-id="${escapeHtml(s.id || '')}" title="查看（只读）"><i class="fa-solid fa-eye"></i></button>`
        : `<button class="btn-icon skill-edit" data-id="${escapeHtml(s.id || '')}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
           <button class="btn-icon skill-delete" data-id="${s.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>`;
      return `
      <div class="skill-card${isBundled ? ' skill-card-builtin' : ''}" data-id="${s.id}">
        <div class="skill-icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="skill-info">
          <div class="skill-name">${escapeHtml(s.name || '')} ${badgeHtml}</div>
          <div class="skill-desc">${escapeHtml(s.description || '')}</div>
          <div class="skill-meta">${escapeHtml(getSkillSummaryMeta(s))}</div>
        </div>
        <div class="skill-actions">${actionsHtml}</div>
      </div>`;
    }).join('');

    list.querySelectorAll('.skill-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.deleteSkill(btn.dataset.id);
        if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        loadSkillsPage();
      });
    });

    list.querySelectorAll('.skill-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        window.api.openSkillEditor({ id: btn.dataset.id });
      });
    });

    list.querySelectorAll('.skill-view').forEach(btn => {
      btn.addEventListener('click', () => {
        window.api.openSkillEditor({ id: btn.dataset.id, readonly: true });
      });
    });
  }

  // Skill Modal
  function _resetSkillModalEditable() {
    ['skill-name', 'skill-desc', 'skill-prompt'].forEach(fid => {
      const el = document.getElementById(fid);
      if (el) el.removeAttribute('readonly');
    });
    const saveBtn = document.getElementById('btn-save-skill');
    if (saveBtn) saveBtn.style.display = '';
  }
  document.getElementById('btn-add-skill').addEventListener('click', () => {
    window.api.openSkillEditor({});
  });

  document.getElementById('btn-close-skill-modal').addEventListener('click', () => {
    _resetSkillModalEditable();
    fadeOutHide(document.getElementById('skill-modal'));
  });

  document.getElementById('btn-cancel-skill').addEventListener('click', () => {
    _resetSkillModalEditable();
    fadeOutHide(document.getElementById('skill-modal'));
  });

  document.getElementById('btn-save-skill').addEventListener('click', async () => {
    const editId = document.getElementById('skill-edit-id').value;
    const name = document.getElementById('skill-name').value.trim();
    const description = document.getElementById('skill-desc').value.trim();
    const prompt = document.getElementById('skill-prompt').value.trim();
    if (!name) return;
    if (editId) {
      await window.api.updateSkill(editId, { name, description, prompt });
    } else {
      await window.api.createSkill({ name, description, prompt });
    }
    if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    _resetSkillModalEditable();
    fadeOutHide(document.getElementById('skill-modal'));
    document.getElementById('skill-name').value = '';
    document.getElementById('skill-desc').value = '';
    document.getElementById('skill-prompt').value = '';
    document.getElementById('skill-edit-id').value = '';
    loadSkillsPage();
  });

  const btnImportStandardSkill = document.getElementById('btn-import-standard-skill');
  if (btnImportStandardSkill) {
    btnImportStandardSkill.addEventListener('click', async () => {
      const selectResult = await window.api.openFileDialog({
        title: '选择标准 Skill 文件（SKILL.md）',
        multiple: true,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
      });
      if (!selectResult?.ok || !Array.isArray(selectResult.paths) || selectResult.paths.length === 0) return;

      const resultLines = [];
      for (const skillPath of selectResult.paths) {
        try {
          const imported = await importStandardSkillFile(skillPath);
          if (imported.ok) {
            resultLines.push(`${imported.mode === 'updated' ? '更新' : '导入'}成功：${imported.name}`);
          } else {
            resultLines.push(`导入失败：${getPathBasename(skillPath)} (${imported.error || '未知错误'})`);
          }
        } catch (e) {
          resultLines.push(`导入失败：${getPathBasename(skillPath)} (${e.message})`);
        }
      }

      if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      loadSkillsPage();
      addMessage('system', `技能导入结果：\n- ${resultLines.join('\n- ')}`);
    });
  }
