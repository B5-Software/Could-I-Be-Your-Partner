  async function loadMcpServerList() {
    const listEl = document.getElementById('mcp-servers-list');
    const toolsEl = document.getElementById('mcp-connected-tools');
    if (!listEl) return;

    try {
      const servers = await window.api.mcpListServers();
      if (!servers || servers.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">暂无 MCP 服务器配置</p>';
        toolsEl.innerHTML = '暂无已连接的 MCP 服务器';
        return;
      }

      listEl.innerHTML = servers.map(s => {
        const statusDot = s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : '';
        const statusText = s.status === 'connected' ? '已连接' : s.status === 'connecting' ? '连接中...' : s.status === 'error' ? '错误' : '未连接';
        return `
          <div class="mcp-server-card" data-name="${s.name}">
            <div class="mcp-server-icon"><i class="fa-solid fa-server"></i></div>
            <div class="mcp-server-info">
              <h4>${s.name}</h4>
              <p>${s.command || ''} ${(s.args || []).join(' ')}</p>
            </div>
            <div class="mcp-server-status">
              <span class="dot ${statusDot}"></span>
              <span>${statusText}${s.toolCount ? ` (${s.toolCount} 工具)` : ''}</span>
            </div>
            <div class="mcp-server-actions">
              ${s.status === 'connected'
                ? `<button class="btn-icon btn-mcp-disconnect" data-name="${s.name}" title="断开"><i class="fa-solid fa-plug-circle-xmark"></i></button>`
                : `<button class="btn-icon btn-mcp-connect" data-name="${s.name}" title="连接"><i class="fa-solid fa-plug-circle-check"></i></button>`
              }
              <button class="btn-icon btn-mcp-remove" data-name="${s.name}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>`;
      }).join('');

      // Bind buttons
      listEl.querySelectorAll('.btn-mcp-connect').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          btn.disabled = true;
          await window.api.mcpConnect(name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-disconnect').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpDisconnect(btn.dataset.name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpRemoveServer(btn.dataset.name);
          await loadMcpServerList();
        });
      });

      // Show connected tools
      const toolsResult = await window.api.mcpListTools();
      if (toolsResult.ok && toolsResult.tools.length > 0) {
        toolsEl.innerHTML = toolsResult.tools.map(t =>
          `<div style="margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border)">
            <strong>${t.name}</strong> <span style="color:var(--text-secondary);font-size:11px">[${t.serverName}]</span>
            <br><span style="font-size:12px">${t.description || ''}</span>
          </div>`
        ).join('');
      } else {
        toolsEl.innerHTML = '暂无已连接的工具';
      }
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--error-color)">加载失败: ${e.message}</p>`;
    }
  }

  function setupMcpEvents() {
    if (mcpEventsSetup) return;
    mcpEventsSetup = true;

    const btnAdd = document.getElementById('btn-mcp-add');
    const form = document.getElementById('mcp-add-form');
    const btnCancel = document.getElementById('btn-mcp-cancel');
    const btnSave = document.getElementById('btn-mcp-save');

    if (btnAdd) {
      btnAdd.addEventListener('click', () => {
        form.classList.toggle('hidden');
      });
    }
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        form.classList.add('hidden');
      });
    }
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const name = document.getElementById('mcp-new-name').value.trim();
        const command = document.getElementById('mcp-new-command').value.trim();
        const argsStr = document.getElementById('mcp-new-args').value.trim();
        const envStr = document.getElementById('mcp-new-env').value.trim();
        const cwd = document.getElementById('mcp-new-cwd').value.trim();
        const autoConnect = document.getElementById('mcp-new-autoconnect').checked;

        if (!name || !command) {
          alert('名称和命令不能为空');
          return;
        }

        let args = [];
        let env = {};
        try { if (argsStr) args = JSON.parse(argsStr); } catch { alert('参数格式错误(需JSON数组)'); return; }
        try { if (envStr) env = JSON.parse(envStr); } catch { alert('环境变量格式错误(需JSON对象)'); return; }

        const result = await window.api.mcpAddServer({ name, command, args, env, cwd: cwd || undefined, autoConnect });
        if (result.ok) {
          document.getElementById('mcp-new-name').value = '';
          document.getElementById('mcp-new-command').value = '';
          document.getElementById('mcp-new-args').value = '';
          document.getElementById('mcp-new-env').value = '';
          document.getElementById('mcp-new-cwd').value = '';
          document.getElementById('mcp-new-autoconnect').checked = false;
          form.classList.add('hidden');
          await loadMcpServerList();
        } else {
          alert(result.error || '添加失败');
        }
      });
    }
  }

  // 头像路径 → 小尺寸 data URL（仅用于 WebUI/远程镜像；data:/http 原样返回）
