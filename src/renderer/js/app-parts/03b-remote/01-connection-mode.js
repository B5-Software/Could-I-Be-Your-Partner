  // ---- Local/Remote 选择器 ----
  // Remote 模式：把本渲染器当作远程主机的“瘦客户端 / 镜像”，所有 Agent 执行发生在远端。
  let remoteWs = null;             // Remote 模式的 WS 连接
  var isRemoteMode = false;         // 当前是否为 Remote 模式（用 var 提升，避免 WebUIMirror 早期引用触发 TDZ）
  let remoteBaseUrl = '';           // 远程 HTTP 基址（用于显示）
  let remotePassword = '';          // 远程密码（保存以便重连）
  let remoteTotp = '';              // 远程 TOTP（保存以便重连）
  let remoteIntentionalClose = false; // 主动断开标志（避免触发自动重连）
  let remoteReconnectTimer = null; // 自动重连定时器
  let remoteAvatars = null;         // { ai, user } 远端头像
  const _remoteWsPendingByType = new Map(); // WS 请求/响应映射（按期望响应类型）
  let remoteConnectionId = 0;        // 连接生成计数器，invalidate 旧的连接尝试

  function setConnectionMode(mode) {
    const localBtn = document.getElementById('conn-btn-local');
    const remoteBtn = document.getElementById('conn-btn-remote');
    if (mode === 'remote') {
      localBtn?.classList.remove('active');
      remoteBtn?.classList.add('active');
      document.getElementById('remote-connect-modal').classList.remove('hidden');
    } else {
      localBtn?.classList.add('active');
      remoteBtn?.classList.remove('active');
      // 主动断开远程连接
      remoteIntentionalClose = true;
      remoteConnectionId++; // invalidate 所有进行中的连接尝试
      if (remoteReconnectTimer) { clearTimeout(remoteReconnectTimer); remoteReconnectTimer = null; }
      if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
      const wasRemote = isRemoteMode;
      isRemoteMode = false;
      remoteAvatars = null;
      // 停用事件委托
      disableRemoteEventDelegation();
      // Local 模式不显示远程连接横幅
      const banner = document.getElementById('remote-conn-banner');
      if (banner) banner.classList.add('hidden');
      setRemoteBadge('');
      // 恢复本地 UI 状态
      if (btnReoptimizeTools) btnReoptimizeTools.classList.add('hidden');
      hideApprovalPanelRemote();
      // 如果之前在 Remote 模式，mirror_body 已替换 #app 内容，需要重新加载恢复本地 DOM
      if (wasRemote) {
        location.reload();
        return;
      }
    }
  }
  document.getElementById('conn-btn-local')?.addEventListener('click', () => setConnectionMode('local'));
  document.getElementById('conn-btn-remote')?.addEventListener('click', () => setConnectionMode('remote'));
  document.getElementById('btn-remote-cancel')?.addEventListener('click', () => {
    fadeOutHide(document.getElementById('remote-connect-modal'));
    setConnectionMode('local');
  });

  // 远程连接横幅状态
  function setRemoteBanner(state, message) {
    const banner = document.getElementById('remote-conn-banner');
    if (!banner) return;
    banner.dataset.state = state;
    banner.classList.remove('hidden');
    const txt = banner.querySelector('.remote-conn-text');
    const reconnectBtn = banner.querySelector('.remote-conn-reconnect');
    if (txt) {
      const addr = remoteBaseUrl ? ` (${remoteBaseUrl})` : '';
      if (state === 'connecting') txt.textContent = '正在连接远程主机…' + addr;
      else if (state === 'connected') txt.textContent = '已连接远程主机' + addr;
      else if (state === 'disconnected') txt.textContent = message || ('未连接远程主机' + addr);
      else if (state === 'reconnecting') txt.textContent = '远程连接断开，正在重连…' + addr;
      else if (state === 'error') txt.textContent = (message || '远程连接错误') + addr;
    }
    if (reconnectBtn) reconnectBtn.style.display = (state === 'disconnected' || state === 'error') ? '' : 'none';
  }

  // 标题栏远程地址徽标
  function setRemoteBadge(addr) {
    const badge = document.getElementById('remote-addr-badge');
    if (!badge) return;
    if (addr) { badge.textContent = '🌐 ' + addr.replace(/^https?:\/\//, ''); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  // 横幅“重连”按钮
  document.querySelector('#remote-conn-banner .remote-conn-reconnect')?.addEventListener('click', () => {
    if (remoteBaseUrl && remotePassword) connectRemote(remoteBaseUrl, remotePassword, remoteTotp, true);
  });
  // 横幅“关闭”按钮：仅隐藏，不影响连接状态
  document.querySelector('#remote-conn-banner .remote-conn-dismiss')?.addEventListener('click', () => {
    const banner = document.getElementById('remote-conn-banner');
    if (banner) banner.classList.add('hidden');
  });

  // 发起一次远程连接。reconnect=true 表示自动重连调用。
  async function connectRemote(url, pwd, totp, reconnect = false) {
    const myId = ++remoteConnectionId;
    const statusEl = document.getElementById('remote-status');
    if (!reconnect && statusEl) statusEl.textContent = '连接中...';
    setRemoteBanner('connecting');
    // 先关掉旧连接
    remoteIntentionalClose = true;
    if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
    remoteIntentionalClose = false;
    try {
      // 1. 预校验凭据（HTTP 登录）。跨源时 CORS 已在服务端放行；cookie 不需要。
      const loginRes = await fetch(`${url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd, totpCode: totp })
      });
      if (myId !== remoteConnectionId) return; // 已被 setConnectionMode('local') 取消
      const loginData = await loginRes.json();
      if (myId !== remoteConnectionId) return; // 已被取消
      if (!loginData.ok) {
        if (!reconnect && statusEl) statusEl.textContent = loginData.error || '登录失败';
        setRemoteBanner('error', loginData.error || '登录失败');
        return;
      }
      // 2. 建立 WS（http→ws, https→wss）
      const wsUrl = url.replace(/^http/, 'ws') + '/ws';
      remoteWs = new WebSocket(wsUrl);
      remoteWs.onopen = () => {
        if (myId !== remoteConnectionId) { try { remoteWs.close(); } catch (_) {} return; }
        // 跨源 WS 无法携带 cookie，用首条 auth 消息完成认证
        remoteWs.send(JSON.stringify({ type: 'auth', password: pwd, totpCode: totp }));
      };
      remoteWs.onmessage = (ev) => {
        try { handleRemoteMessage(JSON.parse(ev.data)); } catch (_) {}
      };
      remoteWs.onerror = () => {
        if (myId !== remoteConnectionId) return;
        if (!reconnect && statusEl) statusEl.textContent = '连接失败，请检查地址或网络';
        setRemoteBanner('error', 'WebSocket 连接失败');
      };
      remoteWs.onclose = () => {
        if (myId !== remoteConnectionId) return; // 旧连接，不重连
        const wasRemote = isRemoteMode;
        isRemoteMode = false;
        // 清理挂起的请求
        for (const [, p] of _remoteWsPendingByType) { clearTimeout(p.timer); try { p.reject(new Error('连接已断开')); } catch {} }
        _remoteWsPendingByType.clear();
        if (remoteIntentionalClose) {
          setRemoteBanner('disconnected');
          return;
        }
        // 意外断开：自动重连
        if (wasRemote || reconnect) {
          setRemoteBanner('reconnecting');
          if (remoteReconnectTimer) clearTimeout(remoteReconnectTimer);
          remoteReconnectTimer = setTimeout(() => {
            connectRemote(url, pwd, totp, true);
          }, 3000);
        } else {
          setRemoteBanner('disconnected');
        }
      };
    } catch (e) {
      if (myId !== remoteConnectionId) return; // 已被取消
      if (!reconnect && statusEl) statusEl.textContent = '错误: ' + (e?.message || e);
      setRemoteBanner('error', String(e?.message || e));
      // 网络错误也尝试重连
      if (remoteReconnectTimer) clearTimeout(remoteReconnectTimer);
      remoteReconnectTimer = setTimeout(() => connectRemote(url, pwd, totp, true), 5000);
    }
  }

  document.getElementById('btn-remote-connect')?.addEventListener('click', async () => {
    let url = document.getElementById('remote-url').value.trim().replace(/\/$/, '');
    const pwd = document.getElementById('remote-password').value;
    const totp = document.getElementById('remote-totp').value.trim();
    const statusEl = document.getElementById('remote-status');
    if (!url || !pwd) { statusEl.textContent = '请填写地址和密码'; return; }
    // 自动补全协议前缀：用户可能输入 "172.168.7.48:3456" 而未带 http://
    // 不补全的话 fetch 会把它当作相对路径，解析为 file:// 协议下的路径
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    remoteBaseUrl = url;
    remotePassword = pwd;
    remoteTotp = totp;
    setRemoteBadge(url);
    await connectRemote(url, pwd, totp, false);
  });

  // WS 请求/响应：发送 msg 并等待 expectedType 响应
  function remoteWsRequest(msg, expectedType, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) { reject(new Error('未连接到远程主机')); return; }
      if (_remoteWsPendingByType.has(expectedType)) { reject(new Error('已有相同请求进行中')); return; }
      const timer = setTimeout(() => { _remoteWsPendingByType.delete(expectedType); reject(new Error('请求超时')); }, timeout);
      _remoteWsPendingByType.set(expectedType, { resolve, reject, timer });
      remoteWs.send(JSON.stringify(msg));
    });
  }

  function remoteWsSend(msg) {
    if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // 上传附件到远程（通过 WS，跨源无法用 HTTP+cookie）
  async function uploadAttachmentRemote(att) {
    try {
      let dataUrl;
      if (att.file && att.file.arrayBuffer) {
        const buf = await att.file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        dataUrl = `data:${att.type || 'application/octet-stream'};base64,${btoa(bin)}`;
      } else if (att.path) {
        // 本地路径文件：通过 preload 读取
        const r = await window.api.readFileBase64?.(att.path);
        if (r?.ok && r.data) dataUrl = r.data;
      }
      if (!dataUrl) return null;
      const resp = await remoteWsRequest({ type: 'uploadAttachment', name: att.name, type: att.type, data: dataUrl }, 'uploadResult');
      if (resp.ok) return { name: resp.name, path: resp.path, type: resp.type };
      return null;
    } catch (e) { console.error('[Remote] 附件上传失败:', e); return null; }
  }
