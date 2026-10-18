  // Authoritative message IDs arrive after admission, including optimistic and streamed bubbles.
  const messageBindings = new WeakMap();
  function messageActionsFor(mode) {
    const active = sessionManager?.getActive(mode)?.agent || agent;
    let key;
    const ready = async () => { await active._ensureBackend(); key = active.backendKey; };
    const request = async (method, ...args) => { if (!key) await ready(); return window.CibypBackendViews.request(method, key, ...args); };
    return {
      text: (name, fallback) => t(name, fallback),
      load: async () => {
        const view = await request('getView');
        const raw = new Map(view.messages.map(message => [message.metadata?.messageId, message]));
        return { busy: view.session.busy, items: view.displayMessages.filter(message => message.id && ['user','assistant','tool'].includes(message.role) && !['context-update','compaction-checkpoint'].includes(raw.get(message.id)?.metadata?.kind)).map(message => ({
          id: message.id, role: message.role, content: typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '', excluded: raw.get(message.id)?.metadata?.contextExcluded === true,
        })) };
      },
      preview: (ids, scope) => request('getMessageEditPlan', ids, scope),
      apply: async (ids, scope) => {
        const result = await request('editMessages', ids, scope);
        if (!result.ok) throw new Error(result.error);
        // The shared messages-deleted event replays every attached frontend once.
        window.CibypBackendViews.hydrate(active, result.view); updateContextProgress(); return result;
      },
      stop: async () => {
        await request('stop'); const deadline = Date.now() + 15000;
        while ((await request('getView')).session.busy) { if (Date.now() > deadline) throw new Error(t('ui.messageEdit.stopTimeout', '任务还未停止，请稍后重试。')); await new Promise(resolve => setTimeout(resolve, 80)); }
      },
    };
  }
  window.CibypMessages = {
    open(options = {}) { return openMessageManager(messageActionsFor(options.mode || currentMode), options); },
    remove(options = {}) { return confirmMessageRemoval(messageActionsFor(options.mode || currentMode), options); },
    bind(element, info) {
      if (!element || !['user','assistant'].includes(info.role)) return;
      const prior = messageBindings.get(element);
      messageBindings.set(element, { ...prior, ...info, content: String(info.content || '').trimEnd() });
      if (!prior) element.addEventListener('contextmenu', event => { event.preventDefault(); showMessageContextMenu(event, element, info.role); });
      if (element.querySelector('.message-edit-actions')) return;
      const controls = document.createElement('div'); controls.className = 'message-edit-actions'; controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', t('ui.messageEdit.title', '管理消息'));
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-icon message-delete-action';
      button.title = t(info.role === 'user' ? 'ui.messageEdit.deleteTurn' : 'ui.messageEdit.deleteMessage', info.role === 'user' ? '删除本轮对话' : '删除消息'); button.setAttribute('aria-label', button.title);
      button.setAttribute('data-i18n-title', info.role === 'user' ? 'ui.messageEdit.deleteTurn' : 'ui.messageEdit.deleteMessage'); button.setAttribute('data-i18n-aria-label', button.getAttribute('data-i18n-title'));
      button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>';
      button.disabled = !element.dataset.messageId;
      button.onclick = () => window.CibypMessages.remove({ mode: info.mode, ids: [element.dataset.messageId] }).catch(error => showToast(error.message, 'error'));
      controls.append(button); element.querySelector('.message-body, .babe-msg-body')?.append(controls);
    },
    admitted(owner, message) {
      const mode = owner.mode || 'chat';
      if (sessionManager?.getActive(mode)?.agent !== owner || !message.messageId) return;
      const container = document.getElementById(mode === 'chat' ? 'chat-messages' : mode === 'code' ? 'code-chat-messages' : 'babe-chat-messages');
      const rows = [...(container?.querySelectorAll('.message, .babe-message') || [])];
      const element = rows.find(row => !row.dataset.messageId && messageBindings.get(row)?.role === message.role && messageBindings.get(row)?.content === String(message.content || '').trimEnd());
      if (!element) return;
      element.dataset.messageId = message.messageId;
      const button = element.querySelector('.message-delete-action'); if (button) button.disabled = false;
    },
  };
  for (const mode of ['chat','code','babe']) {
    const container = document.getElementById(mode === 'chat' ? 'chat-messages' : mode === 'code' ? 'code-chat-messages' : 'babe-chat-messages');
    for (const row of container?.querySelectorAll('.message[data-message-id],.babe-message[data-message-id]') || []) window.CibypMessages.bind(row, {mode, role:row.classList.contains('user') ? 'user' : 'assistant'});
  }
  for (const [selector, mode] of [['.chat-actions','chat'], ['.babe-actions','babe'], ['.code-agent-header','code']]) {
    const toolbar = document.querySelector(selector); if (!toolbar) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-icon message-manager-trigger'; button.dataset.messageManager = mode;
    button.title = t('ui.messageEdit.title', '管理消息'); button.setAttribute('aria-label', button.title);
    button.setAttribute('data-i18n-title', 'ui.messageEdit.title'); button.setAttribute('data-i18n-aria-label', 'ui.messageEdit.title');
    button.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11a7 7 0 0 1-7 7H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M7 8h10M7 12h7"/></svg>';
    button.onclick = () => window.CibypMessages.open({mode}).catch(error => showToast(error.message,'error')); toolbar.append(button);
  }
