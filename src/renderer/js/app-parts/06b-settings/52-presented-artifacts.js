  (() => {
    const section = document.getElementById('settings-presented-artifacts');
    const panel = section.closest('.settings-panel');
    const form = section.querySelector('form');
    const results = section.querySelector('ul');
    const status = section.querySelector('[role="status"]');
    const more = section.querySelector('[data-artifact-more]');
    let query = '', next = null, revision = 0;
    const label = (key, fallback) => t('ui.artifacts.' + key, fallback);
    async function load(append = false) {
      const current = ++revision;
      if (!append) { results.replaceChildren(); next = null; }
      status.textContent = label('loading', '正在读取产物…');
      more.hidden = true;
      try {
        const page = await window.api.backendRequest('artifacts:list', { query, before: append ? next : undefined });
        if (current !== revision) return;
        next = page.next;
        for (const artifact of page.items) {
          const item = document.createElement('li');
          const name = document.createElement('strong');
          name.textContent = artifact.title;
          const meta = document.createElement('small');
          meta.textContent = [
            artifact.filename,
            artifact.location === 'vm' ? 'VM' : label('host', '本机'),
            artifact.conversationTitle,
            new Date(artifact.createdAt).toLocaleString(),
          ].filter(Boolean).join(' · ');
          const file = document.createElement('code');
          file.textContent = artifact.path;
          item.append(name, meta, file);
          if (artifact.description) {
            const description = document.createElement('p');
            description.textContent = artifact.description;
            item.append(description);
          }
          results.append(item);
        }
        status.textContent = results.childElementCount ? '' : label('none', '未找到已呈递的文件');
        more.hidden = !next;
      } catch {
        if (current === revision) {
          status.textContent = label('failed', '无法读取产物');
          more.hidden = !next;
        }
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      query = document.getElementById('artifact-query').value;
      void load();
    });
    more.addEventListener('click', () => { if (next) void load(true); });
    new MutationObserver(() => {
      if (panel.classList.contains('active')) void load();
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  })();
