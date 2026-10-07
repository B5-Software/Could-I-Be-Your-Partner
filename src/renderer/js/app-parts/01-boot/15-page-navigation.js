  // Navigation is shared by sidebar buttons, history, commands and remote control.
  installMotionPreferences();
  const navigationLoads = new Map();
  const primaryPages = new Set(['chat', 'code', 'babe']);
  function navigatePage(name) {
    let page = document.getElementById('page-' + name);
    if (!page) return false;
    const pages = [...document.querySelectorAll('#main-content > .page')];
    const changed = !page.classList.contains('active');
    if (changed) {
      document.getElementById('session-tab-popover')?.classList.add('hidden');
      const focusInOldPage = pages.some(item => item !== page && item.contains(document.activeElement));
      activatePage(page, pages);
      page.scrollTop = 0;
      page.querySelectorAll('.settings-panel, [data-page-scroll]').forEach(element => { element.scrollTop = 0; });
      if (focusInOldPage) document.querySelector(`.nav-item[data-page="${name}"]`)?.focus();
    }
    document.querySelectorAll('.nav-item[data-page]').forEach(button => {
      const active = button.dataset.page === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
      if (!primaryPages.has(button.dataset.page)) button.setAttribute('aria-expanded', String(active));
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: `.nav-item[data-page="${button.dataset.page}"]`, attr: 'class', value: button.className });
    });
    pages.forEach(item => {
      ['class', 'aria-hidden'].forEach(attr => WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + item.id, attr, value: item.getAttribute(attr) || '' }));
    });
    const loaders = {
      tools: () => { codeEditorModeFilter = currentMode || 'chat'; return loadToolsPage(); },
      skills: () => loadSkillsPage(), knowledge: () => loadKnowledgePage(), memory: () => loadMemoryPage(),
      automation: () => loadAutomationPage(), settings: () => loadSettingsPage(), history: () => loadHistoryPage(),
      code: async () => { await loadCodePage(); await ensureCodeFirstSession(); },
      'code-history': () => loadCodeHistoryPage(), babe: () => initBabeAgent(), 'babe-history': () => loadBabeHistoryPage()
    };
    const loader = loaders[name];
    if (loader && !navigationLoads.has(name)) {
      const destination = name;
      const loadedPage = page;
      // The bundle can yield during Agent initialization before later modules exist.
      const task = appReady.then(loader).then(() => {
        // Serialize form state correctly for mirrored clients.
        loadedPage.querySelectorAll('input, textarea, select').forEach(element => {
          if (element.tagName === 'TEXTAREA') element.textContent = element.value;
          else if (element.tagName === 'SELECT') [...element.options].forEach(option => option.toggleAttribute('selected', option.selected));
          else if (element.type === 'checkbox' || element.type === 'radio') element.toggleAttribute('checked', element.checked);
          else element.setAttribute('value', element.value);
        });
        if (typeof i18nApplyToDOM === 'function') i18nApplyToDOM(loadedPage);
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-' + destination, html: loadedPage.innerHTML });
      }).catch(error => {
        console.error('[navigation] Failed to load ' + destination, error);
        if (loadedPage.classList.contains('active')) showToast('页面加载失败，请重新打开重试', 'error');
      }).finally(() => navigationLoads.delete(destination));
      navigationLoads.set(name, task);
    }
    return true;
  }
  window.navigatePage = name => navigatePage(name);
  document.querySelectorAll('.nav-item[data-page]').forEach(button => {
    button.setAttribute('aria-controls', 'page-' + button.dataset.page);
    button.addEventListener('click', () => navigatePage(button.dataset.page));
  });
  document.querySelectorAll('#main-content > .page').forEach(page => {
    page.inert = !page.classList.contains('active');
    page.setAttribute('aria-hidden', String(page.inert));
  });
  document.getElementById('tools-mode-switcher')?.addEventListener('click', event => {
    const button = event.target.closest('.tools-mode-btn');
    if (!button) return;
    void appReady.then(() => {
      codeEditorModeFilter = button.dataset.toolMode;
      return loadToolsPage();
    }).then(() => WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-tools', html: document.getElementById('page-tools').innerHTML }))
      .catch(error => console.error('[navigation] Failed to load tools', error));
  });
