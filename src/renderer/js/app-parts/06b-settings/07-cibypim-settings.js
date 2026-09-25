  // ---- CIBYP-IM Settings Helpers ----
  function cibypImEscapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function refreshCibypImStatus() {
    const card = document.getElementById('cibypim-status-card');
    const titleEl = document.getElementById('cibypim-status-title');
    const subEl = document.getElementById('cibypim-status-sub');
    const statusEl = document.getElementById('cibypim-status');
    const loginBtn = document.getElementById('btn-cibypim-login');
    const logoutBtn = document.getElementById('btn-cibypim-logout');
    if (!card || !titleEl || !subEl) return;
    let result;
    try {
      result = await window.api.cibypImGetState();
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
      titleEl.textContent = `已连接 · ${cibypImEscapeHtml(result.displayName || result.username || '')}`;
      subEl.textContent = cibypImEscapeHtml(result.url);
      if (loginBtn) loginBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = '';
      const urlEl = document.getElementById('setting-cibypim-url');
      const userEl = document.getElementById('setting-cibypim-username');
      if (urlEl && !urlEl.value) urlEl.value = result.url;
      if (userEl && !userEl.value) userEl.value = result.username || '';
      if (statusEl) statusEl.textContent = '';
    } else {
      card.classList.remove('fedikitten-connected');
      card.classList.add('fedikitten-disconnected');
      titleEl.textContent = '未连接';
      subEl.textContent = '登录后即可让 AI 伙伴使用 CIBYP-IM 能力';
      if (loginBtn) loginBtn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (statusEl) statusEl.textContent = '';
    }
    // 回填主人来信配置
    if (result && result.ok && result.owner) {
      const oEl = document.getElementById('setting-cibypim-owner');
      if (oEl && !oEl.value) oEl.value = result.owner.ownerUsername || '';
      const mEl = document.getElementById('setting-cibypim-owner-mode');
      if (mEl) mEl.value = result.owner.ownerMode || 'none';
      const pEl = document.getElementById('setting-cibypim-poll-interval');
      if (pEl) pEl.value = String(result.owner.pollIntervalSec || 300);
    }
  }

  function setupCibypImEvents() {
    const loginBtn = document.getElementById('btn-cibypim-login');
    const logoutBtn = document.getElementById('btn-cibypim-logout');
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.settings-tab[data-tab="cibypim"]') : null;
      if (btn) refreshCibypImStatus();
    });
    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        const url = document.getElementById('setting-cibypim-url')?.value?.trim() || '';
        const username = document.getElementById('setting-cibypim-username')?.value?.trim() || '';
        const password = document.getElementById('setting-cibypim-password')?.value || '';
        const statusEl = document.getElementById('cibypim-status');
        const takeoverRow = document.getElementById('cibypim-takeover-row');
        const takeoverEl = document.getElementById('cibypim-takeover');
        if (!url || !username || !password) {
          if (statusEl) { statusEl.innerHTML = '<span style="color:var(--error-color,#f44336)">请填写服务器地址、用户名和密码</span>'; }
          return;
        }
        if (statusEl) { statusEl.textContent = '正在登录...'; statusEl.style.color = 'var(--text-secondary)'; }
        const result = await window.api.cibypImLogin(url, username, password, !!(takeoverEl && takeoverEl.checked));
        if (result && result.ok) {
          const passEl = document.getElementById('setting-cibypim-password');
          if (passEl) passEl.value = '';
          if (takeoverRow) takeoverRow.style.display = 'none';
          if (takeoverEl) takeoverEl.checked = false;
          await refreshCibypImStatus();
          if (statusEl) { statusEl.style.color = ''; }
        } else {
          // 多设备身份冲突：显示“接管身份”选项，由用户显式确认后才允许覆盖
          const needTakeover = result && (result.code === 'TAKEOVER_REQUIRED' || result.code === 'IDENTITY_MISMATCH'
            || (result.error || '').includes('其他设备') || (result.error || '').includes('接管'));
          if (takeoverRow) takeoverRow.style.display = needTakeover ? '' : 'none';
          if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--error-color,#f44336)"><i class="fa-solid fa-circle-xmark"></i> ${cibypImEscapeHtml((result && result.error) || '登录失败')}</span>`;
          }
        }
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await window.api.cibypImLogout();
        await refreshCibypImStatus();
        const passEl = document.getElementById('setting-cibypim-password');
        if (passEl) passEl.value = '';
      });
    }
    const saveOwnerBtn = document.getElementById('btn-cibypim-save-owner');
    if (saveOwnerBtn) {
      saveOwnerBtn.addEventListener('click', async () => {
        const ownerEl = document.getElementById('setting-cibypim-owner');
        const modeEl = document.getElementById('setting-cibypim-owner-mode');
        const pollEl = document.getElementById('setting-cibypim-poll-interval');
        const ownerStatus = document.getElementById('cibypim-owner-status');
        const patch = {
          ownerUsername: ownerEl ? ownerEl.value.trim() : '',
          ownerMode: modeEl ? modeEl.value : 'none',
          pollIntervalSec: pollEl ? Math.max(10, Number(pollEl.value) || 300) : 300,
        };
        const res = await window.api.cibypImSaveConfig(patch);
        if (ownerStatus) {
          if (res && res.ok) {
            const modeText = { none: '无反应', create: '创建新 Chat 会话并发送', continue: '继续当前 Chat 会话' }[patch.ownerMode] || patch.ownerMode;
            ownerStatus.innerHTML = `<span style="color:var(--success-color,#4caf50)">已保存：主人 ${cibypImEscapeHtml(patch.ownerUsername ? '@' + patch.ownerUsername : '未配置')} · ${cibypImEscapeHtml(modeText)} · 每 ${patch.pollIntervalSec} 秒轮询</span>`;
          } else {
            ownerStatus.innerHTML = `<span style="color:var(--error-color,#f44336)">保存失败：${cibypImEscapeHtml((res && res.error) || '未知错误')}</span>`;
          }
        }
      });
    }
  }
