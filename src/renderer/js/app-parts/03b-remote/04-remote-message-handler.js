  function handleRemoteMessage(data) {
    if (!data?.type) return;
    // 1. 响应类消息分发到挂起的请求
    const pending = _remoteWsPendingByType.get(data.type);
    if (pending) {
      _remoteWsPendingByType.delete(data.type);
      clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }

    switch (data.type) {
      case 'init':
        // 连接已建立：设置本地状态，等待 mirror_head + mirror_body 到达
        isRemoteMode = true;
        remoteIntentionalClose = false;
        fadeOutHide(document.getElementById('remote-connect-modal'));
        const statusEl0 = document.getElementById('remote-status');
        if (statusEl0) statusEl0.textContent = '已连接，可远程操作';
        setRemoteBanner('connected');
        // 启用事件委托：所有交互通过 ui_event 转发到远端
        enableRemoteEventDelegation();
        // 请求模式 / 上下文 / 重新优化按钮的快照
        remoteWsSend({ type: 'requestState' });
        break;

      // ---- 镜像消息：直接应用到本地 DOM（与 WebUI 客户端一致）----
      case 'mirror_head':
        applyRemoteHead(data);
        break;
      case 'mirror_body':
        applyRemoteBody(data);
        break;
      case 'mirror_body_start':
        _remoteBodyChunks = { transferId: data.transferId, chunks: new Array(data.totalChunks), totalChunks: data.totalChunks, received: 0 };
        break;
      case 'mirror_body_chunk':
        if (_remoteBodyChunks && _remoteBodyChunks.transferId === data.transferId) {
          _remoteBodyChunks.chunks[data.index] = data.chunk;
          _remoteBodyChunks.received++;
        }
        break;
      case 'mirror_body_end':
        if (_remoteBodyChunks && _remoteBodyChunks.transferId === data.transferId) {
          try {
            var fullJson = _remoteBodyChunks.chunks.join('');
            var snapshot = JSON.parse(fullJson);
            applyRemoteBody(snapshot);
          } catch (e) { console.error('[Remote] Failed to reassemble chunked mirror_body:', e); }
          _remoteBodyChunks = null;
        }
        break;
      case 'dom_clear':
        applyRemoteDomClear(data);
        break;
      case 'dom_replace':
        applyRemoteDomReplace(data);
        break;
      case 'dom_remove':
        applyRemoteDomRemove(data);
        break;
      case 'dom_update':
        applyRemoteDomUpdate(data);
        break;
      case 'dom_append':
        applyRemoteDomAppend(data);
        break;
      case 'dom_text':
        applyRemoteDomText(data);
        break;
      case 'dom_value':
        applyRemoteDomValue(data);
        break;

      // ---- UI 状态消息（镜像不覆盖的特殊状态）----
      case 'theme':
        applyRemoteTheme(data.theme);
        break;
      case 'modeSwitch':
        // 镜像模式下页面切换由 dom_update 处理，这里仅同步按钮高亮
        handleRemoteModeSwitch(data.mode);
        break;
      case 'contextProgress':
        updateRemoteContextProgress(data.data);
        break;
      case 'reoptimizeState':
        if (btnReoptimizeTools) btnReoptimizeTools.classList.toggle('hidden', !data.visible);
        break;
      case 'approval':
        if (data.toolName) showApprovalPanel(data.toolName, data.args);
        break;
      case 'approvalCleared':
        hideApprovalPanelRemote();
        break;
      case 'stateSnapshot':
        if (data.mode) handleRemoteModeSwitch(data.mode);
        if (data.contextProgress) updateRemoteContextProgress(data.contextProgress);
        if (btnReoptimizeTools) btnReoptimizeTools.classList.toggle('hidden', !data.reoptimizeVisible);
        break;
      case 'auth_fail':
        // 认证失败：显示错误，关闭连接
        const statusEl = document.getElementById('remote-status');
        if (statusEl) statusEl.textContent = data.error || '认证失败';
        setRemoteBanner('error', data.error || '认证失败');
        remoteIntentionalClose = true;
        if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
        isRemoteMode = false;
        disableRemoteEventDelegation();
        break;
      case 'requestFileDownload': {
        // 远端请求下载文件（Remote 模式下本地渲染器是 Agent 端）
        if (data.path) {
          window.api.readFileBase64(data.path).then(function(result) {
            if (!result.ok) {
              remoteWsSend({ type: 'fileDownloadResponse', ok: false, error: result.error, filename: data.filename });
              return;
            }
            // 提取纯 base64 数据（去掉 data URL 前缀）
            var base64 = (result.data || '').replace(/^data:[^;]+;base64,/, '');
            remoteWsSend({
              type: 'fileDownloadResponse',
              ok: true,
              filename: data.filename,
              data: base64,
              mimeType: result.mime || 'application/octet-stream'
            });
          });
        }
        break;
      }
      case 'fileDownloadResponse': {
        // 远端回传的文件数据，在本地触发下载
        if (data.ok && data.data) {
          _triggerBlobDownload(data.data, data.filename, data.mimeType);
        } else {
          console.error('[Remote] 文件下载失败:', data.error);
        }
        break;
      }

      // ---- 以下语义消息在镜像模式下由 dom_* 覆盖，不再单独处理 ----
      // message, messagesSync, status, title, tarot, avatars, toolCall, conversationSwitch
      case 'history':
      case 'conversationDeleted':
        // 已被 remoteWsRequest 消费；此处仅为兜底
        break;
      default:
        break;
    }
  }
