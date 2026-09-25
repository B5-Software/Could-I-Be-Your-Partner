  // ---- FediKitten Settings Helpers ----
  function fedikittenEscapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function refreshFediKittenStatus() {
    const card = document.getElementById('fedikitten-status-card');
    const titleEl = document.getElementById('fedikitten-status-title');
    const subEl = document.getElementById('fedikitten-status-sub');
    const statusEl = document.getElementById('fedikitten-status');
    const loginBtn = document.getElementById('btn-fedikitten-login');
    const logoutBtn = document.getElementById('btn-fedikitten-logout');
    if (!card || !titleEl || !subEl) return;
    let result;
    try {
      result = await window.api.fedikittenGetState();
    } catch (e) {
      card.classList.remove('fedikitten-connected');
      card.classList.add('fedikitten-disconnected');
      titleEl.textContent = '状态未知';
      subEl.textContent = '无法读取登录状态';
      if (statusEl) statusEl.textContent = '';
      return;
    }
    if (result && result.ok && result.loggedIn) {
      card.classList.add('fedikitten-connected');
      card.classList.remove('fedikitten-disconnected');
      titleEl.textContent = `已连接 · ${fedikittenEscapeHtml(result.username || '')}`;
      subEl.textContent = fedikittenEscapeHtml(result.url);
      if (loginBtn) loginBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = '';
      const urlEl = document.getElementById('setting-fedikitten-url');
      const userEl = document.getElementById('setting-fedikitten-username');
      if (urlEl && !urlEl.value) urlEl.value = result.url;
      if (userEl && !userEl.value) userEl.value = result.username || '';
      if (statusEl) statusEl.textContent = '';
    } else {
      card.classList.remove('fedikitten-connected');
      card.classList.add('fedikitten-disconnected');
      titleEl.textContent = '未连接';
      subEl.textContent = '登录后即可让 AI 伙伴使用 FediKitten 能力';
      if (loginBtn) loginBtn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (statusEl) statusEl.textContent = '';
    }
  }

  function setupFediKittenEvents() {
    const loginBtn = document.getElementById('btn-fedikitten-login');
    const logoutBtn = document.getElementById('btn-fedikitten-logout');
    // 事件委托：即使初始化时 DOM 未挂载，点击 FediKitten 设置 tab 时也刷新连接状态
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.settings-tab[data-tab="fedikitten"]') : null;
      if (btn) refreshFediKittenStatus();
    });
    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        const url = document.getElementById('setting-fedikitten-url')?.value?.trim() || '';
        const username = document.getElementById('setting-fedikitten-username')?.value?.trim() || '';
        const password = document.getElementById('setting-fedikitten-password')?.value || '';
        const statusEl = document.getElementById('fedikitten-status');
        if (!url || !username || !password) {
          if (statusEl) { statusEl.innerHTML = '<span style="color:var(--error-color,#f44336)">请填写实例地址、用户名和密码</span>'; }
          return;
        }
        if (statusEl) { statusEl.textContent = '正在登录...'; statusEl.style.color = 'var(--text-secondary)'; }
        const result = await window.api.fedikittenLogin(url, username, password);
        if (result && result.ok) {
          const passEl = document.getElementById('setting-fedikitten-password');
          if (passEl) passEl.value = '';
          await refreshFediKittenStatus();
          if (statusEl) { statusEl.style.color = ''; }
        } else {
          if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--error-color,#f44336)"><i class="fa-solid fa-circle-xmark"></i> ${fedikittenEscapeHtml((result && result.error) || '登录失败')}</span>`;
          }
        }
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await window.api.fedikittenLogout();
        await refreshFediKittenStatus();
        const passEl = document.getElementById('setting-fedikitten-password');
        if (passEl) passEl.value = '';
      });
    }
  }
