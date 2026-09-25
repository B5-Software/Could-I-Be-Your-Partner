  // ---- 事件委托：Remote 模式下所有交互通过 ui_event 转发到远端 ----
  function enableRemoteEventDelegation() {
    if (_remoteEventHandlers) return; // 已启用
    var sendEvent = function(evtType, target, extra) {
      if (_remoteApplying || !remoteWs || remoteWs.readyState !== 1) return;
      // 跳过本地控制元素（连接切换器、远程模态框、横幅）
      if (target.closest('#connection-switcher') || target.closest('#remote-connect-modal') ||
          target.closest('#remote-conn-banner')) return;
      var path = remoteCssPath(target);
      if (!path) return;
      var data = { type: 'ui_event', event: evtType, target: path };
      if (extra) for (var k in extra) data[k] = extra[k];
      remoteWsSend(data);
    };
    var clickHandler = function(e) {
      if (_remoteApplying) return;
      // 拦截 Markdown 链接：http/https 链接在本地新标签页打开，不转发到远端
      var link = e.target.closest('a');
      if (link) {
        var href = link.getAttribute('href');
        if (href && (href.indexOf('http://') === 0 || href.indexOf('https://') === 0)) {
          e.preventDefault(); e.stopPropagation();
          window.open(href, '_blank');
          return;
        }
        e.preventDefault();
      }
      sendEvent('click', e.target);
    };
    var inputHandler = function(e) {
      if (_remoteApplying) return;
      sendEvent('input', e.target, { value: e.target.value });
    };
    var changeHandler = function(e) {
      if (_remoteApplying) return;
      // 文件输入：读取为 base64 并上传
      if (e.target.type === 'file' && e.target.files && e.target.files.length > 0) {
        var file = e.target.files[0];
        var reader = new FileReader();
        reader.onload = function() {
          var dataUrl = reader.result;
          var base64 = dataUrl.split(',')[1];
          remoteWsSend({ type: 'uploadAttachment', name: file.name, type: file.type, data: base64 });
        };
        reader.readAsDataURL(file);
        return;
      }
      sendEvent('change', e.target, { value: e.target.value, checked: e.target.checked });
    };
    var submitHandler = function(e) {
      if (_remoteApplying) return;
      e.preventDefault();
      sendEvent('submit', e.target);
    };
    // keydown 委托：处理输入框的 Enter 发送（applyRemoteBody 替换 DOM 后原始监听器会丢失）
    var keydownHandler = function(e) {
      if (_remoteApplying) return;
      // 只处理 Enter 键（发送）和 Shift+Enter（换行，不转发）
      if (e.key !== 'Enter' || e.shiftKey) return;
      var target = e.target;
      // 匹配各模式的输入框
      var isChatInput = target.id === 'chat-input' || target.id === 'code-chat-input' || target.id === 'babe-chat-input';
      if (!isChatInput) return;
      // Remote 模式下直接调用本地 sendMessage（sendMessage 内部会转发到 WS）
      e.preventDefault();
      if (target.id === 'chat-input') sendMessage();
      else if (target.id === 'code-chat-input') sendCodeMessage();
      else if (target.id === 'babe-chat-input') sendBabeMessage();
    };
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('input', inputHandler, true);
    document.addEventListener('change', changeHandler, true);
    document.addEventListener('submit', submitHandler, true);
    document.addEventListener('keydown', keydownHandler, true);
    _remoteEventHandlers = { clickHandler: clickHandler, inputHandler: inputHandler, changeHandler: changeHandler, submitHandler: submitHandler, keydownHandler: keydownHandler };
    console.log('[Remote] 事件委托已启用');
  }

  function disableRemoteEventDelegation() {
    if (!_remoteEventHandlers) return;
    document.removeEventListener('click', _remoteEventHandlers.clickHandler, true);
    document.removeEventListener('input', _remoteEventHandlers.inputHandler, true);
    document.removeEventListener('change', _remoteEventHandlers.changeHandler, true);
    document.removeEventListener('submit', _remoteEventHandlers.submitHandler, true);
    document.removeEventListener('keydown', _remoteEventHandlers.keydownHandler, true);
    _remoteEventHandlers = null;
    console.log('[Remote] 事件委托已停用');
  }

  // 处理远程推送的消息（服务端 WS 协议）
  // Remote 模式采用镜像机制：直接应用 mirror_head/mirror_body/dom_* 到本地 DOM，
  // 与 WebUI 浏览器客户端行为一致。语义消息（message/status/tarot 等）由 dom_* 覆盖，不再处理。
