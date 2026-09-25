  // ---- Remote 镜像应用函数（与 WebUI 客户端逻辑一致）----
  let _remoteApplying = false; // 防止事件委托反馈循环
  let _remoteEventHandlers = null; // 事件委托处理器引用
  let _remoteBodyChunks = null; // 分块 mirror_body 重组缓冲区

  // 本地控制元素：不被远端镜像覆盖（Local/Remote 切换器、远程连接模态框、连接横幅）
  function _isLocalControlEl(el) {
    if (!el || el.nodeType !== 1) return false;
    return !!(el.closest('#connection-switcher') || el.closest('#remote-connect-modal') ||
              el.closest('#remote-conn-banner') || el.closest('#titlebar'));
  }

  // CSS path 生成（与 WebUI 客户端 cssPath 一致）
  function remoteCssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var selector = cur.nodeName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      var parent = cur.parentNode;
      if (parent && parent.children) {
        var typeIdx = 1;
        var sib = cur.previousElementSibling;
        while (sib) {
          if (sib.nodeName.toLowerCase() === selector) typeIdx++;
          sib = sib.previousElementSibling;
        }
        var sameType = 0;
        for (var si = 0; si < parent.children.length; si++) {
          if (parent.children[si].nodeName.toLowerCase() === selector) sameType++;
        }
        if (sameType > 1) selector += ':nth-of-type(' + typeIdx + ')';
      }
      if (cur.className && typeof cur.className === 'string') {
        var cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) selector += '.' + cls;
      }
      parts.unshift(selector);
      cur = cur.parentNode;
    }
    return parts.join(' > ');
  }

  function applyRemoteHead(msg) {
    _remoteApplying = true;
    try {
      var html = msg.html || '';
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
      if (msg.theme_mode) document.documentElement.setAttribute('data-theme', msg.theme_mode);
      var head = document.head;
      // 移除已有的渲染器 CSS（保留 FA 链接和 shell 样式）
      var toRemove = head.querySelectorAll('link:not([href*="fontawesome"]),style:not([data-shell])');
      for (var i = 0; i < toRemove.length; i++) toRemove[i].remove();
      // 插入远端 head 内容
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var nodes = tmp.querySelectorAll('link,style');
      for (var j = 0; j < nodes.length; j++) head.appendChild(nodes[j].cloneNode(true));
    } catch (e) { console.error('[Remote] applyHead error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  function applyRemoteBody(msg) {
    _remoteApplying = true;
    try {
      // Remote 端保留本地标题栏（含 Local/Remote 切换器、窗口控制按钮），
      // 不用主机的 titlebar 覆盖 —— 否则远端将无法切换回 Local 模式。
      // 对话标题通过单独的 dom_text 事件同步到 #titlebar-title。
      var app = document.getElementById('app');
      if (!app) return;
      app.innerHTML = msg.html || '';
      // canvas 替换为占位符（canvas 内容无法镜像）
      var canvases = app.querySelectorAll('canvas');
      for (var c = 0; c < canvases.length; c++) {
        var cv = canvases[c];
        var div = document.createElement('div');
        div.style.cssText = 'width:' + (cv.style.width || '100%') + ';height:' + (cv.style.height || '200px') + ';min-height:100px;display:flex;align-items:center;justify-content:center;background:var(--bg-secondary,#ebebeb);color:var(--text-tertiary,#999);font-size:12px;border-radius:4px;';
        div.textContent = '[Canvas 内容不可镜像]';
        if (cv.parentNode) cv.parentNode.replaceChild(div, cv);
      }
      // 恢复本地连接横幅状态（远端 mirror_body 可能覆盖它）
      var banner = app.querySelector('#remote-conn-banner');
      if (banner) { banner.classList.add('hidden'); banner.setAttribute('data-state', 'connected'); }
    } catch (e) { console.error('[Remote] applyBody error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  function applyRemoteDomClear(msg) {
    _remoteApplying = true;
    try { var c = document.querySelector(msg.container); if (c && !_isLocalControlEl(c)) c.innerHTML = ''; }
    catch (e) { console.error('[Remote] dom_clear error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomReplace(msg) {
    _remoteApplying = true;
    try { var c = document.querySelector(msg.container); if (c && !_isLocalControlEl(c)) c.innerHTML = msg.html || ''; }
    catch (e) { console.error('[Remote] dom_replace error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomRemove(msg) {
    _remoteApplying = true;
    try { var el = document.querySelector(msg.selector); if (el && !_isLocalControlEl(el)) el.remove(); }
    catch (e) { console.error('[Remote] dom_remove error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomUpdate(msg) {
    _remoteApplying = true;
    try {
      var el = document.querySelector(msg.selector);
      if (!el || _isLocalControlEl(el)) return;
      if (msg.attr !== undefined) {
        el.setAttribute(msg.attr, msg.value != null ? msg.value : '');
      } else if (msg.html !== undefined && el.outerHTML) {
        el.outerHTML = msg.html;
      }
    } catch (e) { console.error('[Remote] dom_update error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomText(msg) {
    _remoteApplying = true;
    try { var el = document.querySelector(msg.selector); if (el && !_isLocalControlEl(el)) el.textContent = msg.text != null ? msg.text : ''; }
    catch (e) { console.error('[Remote] dom_text error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomAppend(msg) {
    _remoteApplying = true;
    try {
      var c = document.querySelector(msg.container);
      if (c && !_isLocalControlEl(c)) {
        var tmp = document.createElement('div');
        tmp.innerHTML = msg.html || '';
        while (tmp.firstChild) c.appendChild(tmp.firstChild);
        // 自动滚屏（聊天容器，吸附状态才生效）
        var chatContainers = ['#chat-messages', '#code-chat-messages', '#babe-chat-messages'];
        for (var i = 0; i < chatContainers.length; i++) {
          if (c.closest(chatContainers[i])) {
            if (typeof window.requestAutoScroll === 'function') window.requestAutoScroll(c);
            else c.scrollTop = c.scrollHeight;
            break;
          }
        }
      }
    } catch (e) { console.error('[Remote] dom_append error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomValue(msg) {
    _remoteApplying = true;
    try {
      var el = document.querySelector(msg.selector);
      if (el && !_isLocalControlEl(el) && 'value' in el) {
        el.value = msg.value != null ? msg.value : '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) { console.error('[Remote] dom_value error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
