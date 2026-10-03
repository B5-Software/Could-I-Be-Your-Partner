  function mcpEscape(value) {
    return String(value ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadMcpServerList() {
    const listEl = document.getElementById('mcp-servers-list');
    const toolsEl = document.getElementById('mcp-connected-tools');
    if (!listEl) return;
    const sequence = Number(listEl.dataset.sequence || 0) + 1;
    listEl.dataset.sequence = sequence;
    try {
      const servers = await window.api.mcpListServers();
      if (Number(listEl.dataset.sequence) !== sequence) return;
      listEl.innerHTML = servers.length ? servers.map(s => {
        const statusDot = s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : '';
        const status = s.status === 'connected' ? t('ui.mcp.connected', '已连接') : s.status === 'connecting' ? t('ui.mcp.connecting', '连接中...') : s.status === 'error' ? t('ui.mcp.failed', '连接失败') : t('ui.mcp.disconnected', '未连接');
        const stages = { starting: t('ui.mcp.stageStarting', '启动连接'), initialize: t('ui.mcp.stageInitialize', '协商协议'), initialized: t('ui.mcp.stageInitialized', '确认初始化'), tools: t('ui.mcp.stageTools', '加载工具') };
        const summary = s.type === 'http' ? s.url : [s.command, ...(s.args || [])].join(' ');
        return `<div class="mcp-server-card" data-name="${mcpEscape(s.name)}">
          <div class="mcp-server-icon"><i class="fa-solid fa-server"></i></div>
          <div class="mcp-server-info" data-i18n-skip><h4>${mcpEscape(s.name)}</h4><p>${mcpEscape(summary)}</p></div>
          <div class="mcp-server-status"><span class="dot ${statusDot}"></span><span>${mcpEscape(status)}${s.toolCount ? ` (${s.toolCount})` : ''}</span></div>
          <div class="mcp-server-actions">
            <button class="btn-icon btn-mcp-edit" data-name="${mcpEscape(s.name)}" title="${mcpEscape(t('ui.mcp.edit', '编辑配置'))}"><i class="fa-solid fa-pen"></i></button>
            ${s.status === 'connected' || s.status === 'connecting'
              ? `<button class="btn-icon btn-mcp-disconnect" data-name="${mcpEscape(s.name)}" title="${mcpEscape(t('ui.mcp.disconnect', '断开'))}"><i class="fa-solid fa-plug-circle-xmark"></i></button>`
              : `<button class="btn-icon btn-mcp-connect" data-name="${mcpEscape(s.name)}" title="${mcpEscape(t('ui.mcp.connect', '连接'))}"><i class="fa-solid fa-plug-circle-check"></i></button>`}
            <button class="btn-icon btn-mcp-remove" data-name="${mcpEscape(s.name)}" title="${mcpEscape(t('ui.mcp.remove', '删除'))}"><i class="fa-solid fa-trash"></i></button>
          </div>
          ${s.status === 'connecting' ? `<div class="mcp-connection-details" role="status"><span>${mcpEscape(stages[s.stage] || status)}</span><progress max="100" value="${Number(s.progress) || 0}" aria-label="${mcpEscape(status)}"></progress></div>` : ''}
          ${s.error ? `<div class="mcp-connection-details mcp-connection-error" role="alert"><strong>${mcpEscape(s.error)}</strong>${s.errorDetail ? `<details><summary>${mcpEscape(t('ui.mcp.details', '诊断详情'))}</summary><pre>${mcpEscape(s.errorDetail)}</pre></details>` : ''}</div>` : ''}
          ${s.warning ? `<div class="mcp-connection-details" role="status">${mcpEscape(s.warning)}</div>` : ''}
          </div>`;
      }).join('') : `<p class="setting-hint">${mcpEscape(t('ui.mcp.empty', '暂无 MCP 服务器配置'))}</p>`;
      listEl.querySelectorAll('.btn-mcp-edit').forEach(btn => btn.addEventListener('click', () => { if (!document.getElementById('btn-mcp-save').disabled) openMcpForm(servers.find(s => s.name === btn.dataset.name)); }));
      for (const [selector, method] of [['.btn-mcp-connect', 'mcpConnect'], ['.btn-mcp-disconnect', 'mcpDisconnect'], ['.btn-mcp-remove', 'mcpRemoveServer']]) {
        listEl.querySelectorAll(selector).forEach(btn => btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const result = await window.api[method](btn.dataset.name);
            if (!result.ok && method !== 'mcpConnect') throw new Error(result.error);
            await loadMcpServerList();
          } catch (error) { alert(error.message); }
          finally { btn.disabled = false; }
        }));
      }
      const result = await window.api.mcpListTools();
      if (Number(listEl.dataset.sequence) !== sequence) return;
      toolsEl.innerHTML = result.ok && result.tools.length ? result.tools.map(tool =>
        `<div style="margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border)"><strong>${mcpEscape(tool.name)}</strong> <span style="color:var(--text-secondary);font-size:11px">[${mcpEscape(tool.serverName)}]</span><br><span style="font-size:12px">${mcpEscape(tool.description)}</span></div>`
      ).join('') : mcpEscape(t('ui.mcp.noTools', '暂无已连接的工具'));
    } catch (error) { listEl.textContent = error.message; }
  }

  function updateMcpTransportFields() {
    const http = document.getElementById('mcp-new-type').value === 'http';
    document.querySelectorAll('[data-mcp-transport]').forEach(el => {
      el.classList.toggle('hidden', el.dataset.mcpTransport !== (http ? 'http' : 'stdio'));
    });
  }

  function openMcpForm(server) {
    const form = document.getElementById('mcp-add-form');
    form.dataset.editingName = server?.name || '';
    for (const field of ['name', 'command', 'url', 'cwd']) document.getElementById('mcp-new-' + field).value = server?.[field] || '';
    for (const field of ['args', 'env', 'headers']) document.getElementById('mcp-new-' + field).value = server?.[field] ? JSON.stringify(server[field]) : '';
    for (const field of ['autoconnect', 'inherit-env']) document.getElementById('mcp-new-' + field).checked = !!server?.[field === 'autoconnect' ? 'autoConnect' : 'inheritEnv'];
    document.getElementById('mcp-new-type').value = server?.type || 'stdio';
    document.getElementById('mcp-form-title').textContent = server ? t('ui.mcp.edit', '编辑配置') : t('ui.mcp.add', '添加 MCP 服务器');
    updateMcpTransportFields();
    form.classList.remove('hidden');
    form.scrollIntoView({ block: 'nearest' });
    document.getElementById('mcp-new-name').focus();
  }

  function closeMcpForm() {
    const form = document.getElementById('mcp-add-form');
    form.classList.add('hidden');
    delete form.dataset.editingName;
    form.querySelectorAll('input').forEach(el => { if (el.type === 'checkbox') el.checked = false; else el.value = ''; });
  }

  function setupMcpEvents() {
    if (mcpEventsSetup) return;
    mcpEventsSetup = true;
    const form = document.getElementById('mcp-add-form');
    let refreshTimer;
    window.api.onMcpChanged?.(() => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (document.querySelector('.settings-panel[data-tab="mcp"]').classList.contains('active')) loadMcpServerList(); }, 40);
    });
    document.getElementById('btn-mcp-add')?.addEventListener('click', () => openMcpForm());
    document.getElementById('btn-mcp-cancel')?.addEventListener('click', closeMcpForm);
    document.getElementById('mcp-new-type')?.addEventListener('change', updateMcpTransportFields);
    document.getElementById('btn-mcp-save')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      document.getElementById('btn-mcp-add').disabled = true;
      form.querySelectorAll('input, select').forEach(el => { el.disabled = true; });
      document.getElementById('btn-mcp-cancel').disabled = true;
      try {
        const value = field => document.getElementById('mcp-new-' + field).value.trim();
        const json = (field, fallback) => value(field) ? JSON.parse(value(field)) : fallback;
        const config = {
          name: value('name'), type: value('type'), command: value('command'), url: value('url'),
          args: json('args', []), env: json('env', {}), headers: json('headers', {}), cwd: value('cwd'),
          autoConnect: document.getElementById('mcp-new-autoconnect').checked,
          inheritEnv: document.getElementById('mcp-new-inherit-env').checked
        };
        if (!config.name || (config.type === 'stdio' && !config.command) || (config.type === 'http' && !config.url)) throw new Error(t('ui.mcp.required', '请填写名称和连接参数'));
        if (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')) throw new Error(t('ui.mcp.argsInvalid', '参数必须是字符串的 JSON 数组'));
        for (const field of ['env', 'headers']) if (!config[field] || Array.isArray(config[field]) || typeof config[field] !== 'object' || Object.values(config[field]).some(v => typeof v !== 'string')) throw new Error(t('ui.mcp.objectInvalid', '环境变量和请求头必须是值为字符串的 JSON 对象'));
        const result = form.dataset.editingName
          ? await window.api.mcpUpdateServer(form.dataset.editingName, config)
          : await window.api.mcpAddServer(config);
        if (!result.ok) throw new Error(result.error || t('ui.mcp.saveFailed', '保存失败'));
        closeMcpForm();
        await loadMcpServerList();
        if (result.connectionError) alert(t('ui.mcp.reconnectFailed', '配置已保存，但重新连接失败：{error}', { error: result.connectionError }));
      } catch (error) { alert(error.message); }
      finally { button.disabled = false; document.getElementById('btn-mcp-add').disabled = false; document.getElementById('btn-mcp-cancel').disabled = false; form.querySelectorAll('input, select').forEach(el => { el.disabled = false; }); }
    });
  }
