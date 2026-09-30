  // Navigation is shared by sidebar buttons, history, commands and remote control.
  installMotionPreferences();
  const navigationLoads = new Map();
  const primaryPages = new Set(['chat', 'code', 'babe']);
  function navigatePage(name, toggle = false) {
    let page = document.getElementById('page-' + name);
    if (!page) return false;
    if (toggle && !primaryPages.has(name) && page.classList.contains('active')) {
      name = currentMode;
      page = document.getElementById('page-' + name);
    }
    const pages = [...document.querySelectorAll('#main-content > .page')];
    const changed = !page.classList.contains('active');
    if (changed) {
      const focusInOldPage = pages.some(item => item !== page && item.contains(document.activeElement));
      activatePage(page, pages);
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
      const task = Promise.resolve().then(loader).then(() => {
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
    button.addEventListener('click', () => navigatePage(button.dataset.page, true));
  });
  document.querySelectorAll('#main-content > .page').forEach(page => {
    page.inert = !page.classList.contains('active');
    page.setAttribute('aria-hidden', String(page.inert));
    const name = page.id.slice(5);
    if (primaryPages.has(name)) return;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-icon page-dismiss';
    close.title = '返回会话';
    close.setAttribute('aria-label', '返回会话');
    close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    close.addEventListener('click', () => navigatePage(currentMode));
    page.prepend(close);
  });
  document.getElementById('tools-mode-switcher')?.addEventListener('click', event => {
    const button = event.target.closest('.tools-mode-btn');
    if (!button) return;
    codeEditorModeFilter = button.dataset.toolMode;
    Promise.resolve(loadToolsPage()).then(() => WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-tools', html: document.getElementById('page-tools').innerHTML }));
  });
  const sidebarToggle = document.getElementById('btn-sidebar-toggle');
  sidebarToggle?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const expanded = sidebar.classList.toggle('expanded');
    sidebarToggle.setAttribute('aria-expanded', String(expanded));
    sidebarToggle.title = expanded ? '收起侧边栏' : '展开侧边栏';
    sidebarToggle.querySelector('i').className = 'fa-solid ' + (expanded ? 'fa-angles-left' : 'fa-angles-right');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#sidebar', attr: 'class', value: sidebar.className });
  });
