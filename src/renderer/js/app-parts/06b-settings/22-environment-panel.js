  // ---- 环境检测面板（Python / Node+npm 或 Bun 任选其一 / Git）----
  const ENV_META = {
    python: { label: 'Python', icon: 'fa-brands fa-python', hint: 'Python 3 解释器（含 pip）' },
    git: { label: 'Git', icon: 'fa-brands fa-git-alt', hint: '分布式版本控制' }
  };
  const RUNTIME_CHOICES = {
    node: { label: 'Node.js（含 npm）', icon: 'fa-brands fa-node-js', verify: 'node --version 和 npm --version', hint: '推荐 LTS 长期支持版，自带 npm' },
    bun: { label: 'Bun', icon: 'fa-solid fa-bolt', verify: 'bun --version', hint: '自带 bun install 包管理器' }
  };
  const KIND_DESCRIPTIONS = {
    python: { name: 'Python', detail: 'Python 3 解释器（含 pip）', verify: 'python3 --version' },
    git: { name: 'Git', detail: '分布式版本控制', verify: 'git --version' },
    node: { name: 'Node.js（含 npm）', detail: '推荐 LTS 长期支持版，自带 npm 包管理器', verify: 'node --version 和 npm --version' },
    bun: { name: 'Bun', detail: '自带 bun install 包管理器', verify: 'bun --version' },
    runtime: { name: 'JavaScript 运行时（Node.js 含 npm 或 Bun 任选其一）', detail: '二选一即可，推荐 Node.js LTS', verify: 'node --version 或 bun --version' }
  };
  let envDetectCache = null;

  function buildEnvironmentRows() {
    const d = envDetectCache || {};
    const node = d.node || {};
    const npm = d.npm || {};
    const bun = d.bun || {};
    const rows = Object.entries(ENV_META).map(([kind, meta]) => {
      const item = d[kind] || {};
      return {
        kind,
        label: meta.label,
        icon: meta.icon,
        hint: meta.hint,
        found: !!item.found,
        text: item.version || null,
        path: item.path || null,
        choices: null
      };
    });
    const runtime = node.found
      ? {
          kind: 'runtime', label: 'Node.js 运行时', icon: 'fa-brands fa-node-js',
          hint: 'Node+npm 或 Bun 任选其一', found: true,
          text: `Node.js ${node.version || ''}${npm.found ? ` · npm ${npm.version}` : ''}`,
          path: node.path || null, choices: null
        }
      : bun.found
        ? {
            kind: 'runtime', label: 'Bun 运行时', icon: 'fa-solid fa-bolt',
            hint: 'Node+npm 或 Bun 任选其一', found: true,
            text: `Bun ${bun.version || ''}`, path: bun.path || null, choices: null
          }
        : {
            kind: 'runtime', label: 'JavaScript 运行时', icon: 'fa-brands fa-js',
            hint: 'Node+npm 或 Bun 任选其一', found: false,
            text: null, path: null, choices: ['node', 'bun']
          };
    rows.splice(1, 0, runtime);
    return rows;
  }

  function renderEnvironmentPanel(result) {
    const list = document.getElementById('env-detect-list');
    const actions = document.getElementById('env-detect-actions');
    const status = document.getElementById('env-detect-status');
    if (!list) return;
    if (!result || !result.ok) {
      if (status) status.textContent = '检测失败：' + ((result && result.error) || '未知错误');
      list.innerHTML = '';
      if (actions) actions.innerHTML = '';
      return;
    }
    envDetectCache = result.results || {};
    const platformLabel = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[result.platform] || (result.platform || '');
    if (status) status.textContent = `检测完成${platformLabel ? `（${platformLabel}）` : ''}`;
    const rows = buildEnvironmentRows();
    const missing = rows.filter(r => !r.found).map(r => r.kind);
    list.innerHTML = rows.map(row => {
      const badge = row.found
        ? `<span class="env-badge ok"><i class="fa-solid fa-circle-check"></i> ${escapeHtml(row.text || '已安装')}</span>`
        : `<span class="env-badge missing"><i class="fa-solid fa-triangle-exclamation"></i> 未检测到</span>`;
      const pathLine = (row.found && row.path) ? `<div class="env-path" title="${escapeHtml(row.path)}">${escapeHtml(row.path)}</div>` : '';
      const disabled = isRemoteMode ? 'disabled title="Remote 模式下不可用"' : '';
      let installBtns = '';
      if (!row.found) {
        if (Array.isArray(row.choices)) {
          installBtns = `<div class="env-actions">${row.choices.map(c => `<button class="btn-primary btn-sm env-install-btn" data-install="${c}" ${disabled}>安装 ${escapeHtml(RUNTIME_CHOICES[c].label)}</button>`).join('')}</div>`;
        } else {
          installBtns = `<button class="btn-primary btn-sm env-install-btn" data-install="${row.kind}" ${disabled}>让 Agent 安装</button>`;
        }
      }
      return `
        <div class="env-detect-row">
          <div class="env-icon"><i class="${row.icon}"></i></div>
          <div class="env-main">
            <div class="env-name">${row.label}<span class="env-hint">${escapeHtml(row.hint)}</span></div>
            ${pathLine}
          </div>
          ${badge}
          ${installBtns}
        </div>`;
    }).join('');
    if (actions) {
      actions.innerHTML = (missing.length && !isRemoteMode)
        ? `<button class="btn-primary btn-sm" id="btn-env-install-all"><i class="fa-solid fa-wrench"></i> 一键让 Agent 安装全部缺失项（${missing.length}）</button>`
        : '';
      const allBtn = document.getElementById('btn-env-install-all');
      if (allBtn) allBtn.addEventListener('click', () => askAgentInstallMissing(missing));
    }
    list.querySelectorAll('.env-install-btn').forEach(btn => {
      btn.addEventListener('click', () => askAgentToInstall(btn.dataset.install));
    });
  }

  function buildInstallPrompt(kinds) {
    const descs = kinds.map(k => KIND_DESCRIPTIONS[k]).filter(Boolean);
    if (!descs.length) return '';
    const names = descs.map(d => d.name).join('、');
    const lines = descs.map(d => `- ${d.name}（${d.detail}）：未检测到，或不在 PATH 中`);
    return [
      `请帮我在本机安装并验证开发环境组件：${names}。`,
      '',
      '当前检测结果：',
      ...lines,
      '',
      '请按以下步骤处理：',
      '1. 先判断操作系统和已装的包管理器（macOS 可用 Homebrew，Windows 可用 winget，Linux 用对应系统包管理器），选择对用户最稳妥的官方安装方式；',
      `2. 逐个安装 ${names}，如需把程序加入 PATH 请明确处理；若包含 JavaScript 运行时，Node.js（含 npm）与 Bun 二选一即可，不要两个都装；`,
      `3. 安装完成后分别运行版本命令验证（${descs.map(d => d.verify).join('、')}），并把版本号汇报给我；`,
      '4. 如果某个组件其实已安装但检测不到，优先排查 PATH 配置，而不是重复安装。'
    ].join('\n');
  }

  async function openChatSessionAndSend(prompt) {
    if (typeof createNewSession !== 'function') throw new Error('会话模块未就绪');
    await createNewSession('chat');
    // 等待会话激活完成（跨模式切换是异步的）
    await new Promise(r => setTimeout(r, 80));
    // 确保导航到聊天页（用户可能停留在设置页，而当前模式已是 chat）
    document.querySelector('.nav-item[data-page="chat"]')?.click();
    const sm = window.__sessionManager;
    const session = sm ? sm.getActive('chat') : null;
    const ag = (session && session.agent) || agent;
    if (!ag) throw new Error('无法获取 Chat Agent');
    if (typeof addMessageToChat === 'function') addMessageToChat('user', prompt);
    if (typeof addThinkingIndicator === 'function') addThinkingIndicator();
    try {
      await ag.sendMessage(prompt, []);
    } finally {
      if (typeof removeThinkingIndicator === 'function') removeThinkingIndicator();
    }
  }

  async function askAgentToInstall(kind) {
    if (!KIND_DESCRIPTIONS[kind]) return;
    const btn = document.querySelector(`.env-install-btn[data-install="${kind}"]`);
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在打开会话…'; }
    try {
      await openChatSessionAndSend(buildInstallPrompt([kind]));
    } catch (e) {
      console.error('让 Agent 安装失败:', e);
      if (btn) { btn.disabled = false; btn.textContent = original || '让 Agent 安装'; }
    }
  }

  async function askAgentInstallMissing(kinds) {
    if (!kinds || !kinds.length) return;
    const btn = document.getElementById('btn-env-install-all');
    if (btn) { btn.disabled = true; btn.textContent = '正在打开会话…'; }
    try {
      await openChatSessionAndSend(buildInstallPrompt(kinds));
    } catch (e) {
      console.error('让 Agent 安装失败:', e);
      if (btn) { btn.disabled = false; btn.textContent = `一键让 Agent 安装全部缺失项（${kinds.length}）`; }
    }
  }

  async function refreshEnvironmentPanel() {
    const status = document.getElementById('env-detect-status');
    if (status) status.textContent = '检测中…';
    const list = document.getElementById('env-detect-list');
    if (list) list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>正在检测运行环境…</p></div>';
    try {
      const result = await window.api.detectEnvironment();
      renderEnvironmentPanel(result);
    } catch (e) {
      renderEnvironmentPanel({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  document.getElementById('btn-env-refresh')?.addEventListener('click', refreshEnvironmentPanel);
