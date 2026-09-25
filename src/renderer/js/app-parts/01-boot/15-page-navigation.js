  // ---- Page Navigation ----
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const page = document.getElementById(`page-${btn.dataset.page}`);
      if (page) page.classList.add('active');

      // 推送 nav-item active 状态变化到 WebUI（用 data-page 属性选择器，兼容无 id 的 nav-item）
      document.querySelectorAll('.nav-item[data-page]').forEach(b => {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: `.nav-item[data-page="${b.dataset.page}"]`, attr: 'class', value: b.className });
      });
      // 推送所有 page 的 active 状态变化到 WebUI（必须推送全部，否则旧页面 active 不会被移除）
      document.querySelectorAll('.page').forEach(p => {
        if (p.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + p.id, attr: 'class', value: p.className });
      });

      // Load page data
      // 异步加载后推送整个 page 内容到 WebUI/Remote（懒加载页面内容初始 mirror_body 不包含）
      // 注意：input/textarea 的 .value 是 JS property，innerHTML 序列化只含 attribute，
      // 故推送前需将表单值同步到 attribute，否则远端设置页等表单值为空。
      const pushPageAfterLoad = async (loader) => {
        try { await loader(); } catch (_) {}
        // 同步表单元素 value/checked 到 attribute，确保 innerHTML 序列化包含当前值
        page.querySelectorAll('input, textarea, select').forEach(el => {
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (el.checked) el.setAttribute('checked', 'checked');
            else el.removeAttribute('checked');
          } else {
            el.setAttribute('value', el.value);
          }
        });
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-' + btn.dataset.page, html: page.innerHTML });
      };
      if (btn.dataset.page === 'tools') {
        // 进入工具页时按当前模式自动定位到对应选项卡
        codeEditorModeFilter = currentMode || 'chat';
        pushPageAfterLoad(loadToolsPage);
        // Wire up mode switcher buttons (Chat/Code) — only once
        if (!document.getElementById('tools-mode-switcher').dataset.wired) {
          document.getElementById('tools-mode-switcher').dataset.wired = '1';
          document.querySelectorAll('.tools-mode-btn').forEach(mb => {
            mb.addEventListener('click', () => {
              codeEditorModeFilter = mb.dataset.toolMode;
              loadToolsPage();
              // 推送工具页内容到 WebUI/Remote
              WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-tools', html: document.getElementById('page-tools').innerHTML });
            });
          });
        }
      }
      if (btn.dataset.page === 'skills') pushPageAfterLoad(loadSkillsPage);
      if (btn.dataset.page === 'knowledge') pushPageAfterLoad(() => loadKnowledgePage());
      if (btn.dataset.page === 'memory') pushPageAfterLoad(() => loadMemoryPage());
      if (btn.dataset.page === 'automation') pushPageAfterLoad(loadAutomationPage);
      if (btn.dataset.page === 'settings') pushPageAfterLoad(loadSettingsPage);
      if (btn.dataset.page === 'history') pushPageAfterLoad(loadHistoryPage);
      if (btn.dataset.page === 'code') {
        // 对齐 Babe（进入页面即 initBabeAgent）：首次进入 Code 页面时
        // 自动创建第一个会话标签，避免标签栏长时间只剩"+"按钮。
        pushPageAfterLoad(async () => {
          await loadCodePage();
          if (typeof ensureCodeFirstSession === 'function') {
            await ensureCodeFirstSession();
          }
        });
      }
      if (btn.dataset.page === 'code-history') pushPageAfterLoad(loadCodeHistoryPage);
      if (btn.dataset.page === 'babe') pushPageAfterLoad(() => initBabeAgent());
      if (btn.dataset.page === 'babe-history') pushPageAfterLoad(loadBabeHistoryPage);
      // i18n: re-apply translations to the newly activated page (after dynamic content loads)
      if (typeof i18nApplyToDOM === 'function') {
        setTimeout(() => i18nApplyToDOM(page), 100);
      }
    });
  });
