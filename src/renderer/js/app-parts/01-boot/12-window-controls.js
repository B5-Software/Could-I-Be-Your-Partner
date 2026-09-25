  const isMac = window.api.platform === 'darwin';
  const titlebarEl = document.getElementById('titlebar');
  if (isMac) {
    titlebarEl?.classList.add('platform-darwin');
    document.getElementById('btn-minimize')?.classList.add('hidden');
    document.getElementById('btn-maximize')?.classList.add('hidden');
    document.getElementById('btn-close')?.classList.add('hidden');
  } else {
    document.getElementById('btn-minimize')?.addEventListener('click', () => window.api.windowMinimize());
    document.getElementById('btn-maximize')?.addEventListener('click', () => window.api.windowMaximize());
    document.getElementById('btn-close')?.addEventListener('click', () => window.api.windowClose());
  }
