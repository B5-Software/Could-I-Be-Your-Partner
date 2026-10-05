  const settingsAssistantTools = SettingsAssistantTools;

  let settingsHelper = null;
  let settingsHelperOpening = false;
  let settingsHelperGeneration = 0;
  const settingsShell = document.querySelector('#page-settings .settings-shell');
  const settingsWorkspace = document.createElement('div'); settingsWorkspace.className = 'settings-workspace';
  settingsShell.before(settingsWorkspace); settingsWorkspace.append(settingsShell);
  const settingsHelperPanel = document.createElement('aside'); settingsHelperPanel.className = 'settings-assistant'; settingsHelperPanel.inert = true;
  settingsHelperPanel.innerHTML = '<div class="settings-assistant-inner"><header><strong></strong><button class="btn-icon" type="button"><i class="fa-solid fa-xmark"></i></button></header><p class="setting-hint"></p><div class="settings-assistant-messages" role="log" aria-live="polite"></div><form><textarea rows="3"></textarea><div><button class="btn-secondary" type="button"></button><button class="btn-primary" type="submit"></button></div></form></div>';
  settingsWorkspace.append(settingsHelperPanel);
  const settingsHelperTitle = settingsHelperPanel.querySelector('strong'); settingsHelperTitle.textContent = chatGPTText('设置助手');
  settingsHelperPanel.querySelector('p').textContent = chatGPTText('临时会话，不保存记录。密钥和安全设置请在对应页面修改。');
  const settingsHelperMessages = settingsHelperPanel.querySelector('[role="log"]');
  const settingsHelperInput = settingsHelperPanel.querySelector('textarea'); settingsHelperInput.placeholder = chatGPTText('描述要查找或调整的设置…'); settingsHelperInput.setAttribute('aria-label', chatGPTText('询问设置助手'));
  const settingsHelperSend = settingsHelperPanel.querySelector('[type="submit"]'); settingsHelperSend.textContent = chatGPTText('发送');
  const settingsHelperStop = settingsHelperPanel.querySelector('form [type="button"]'); settingsHelperStop.textContent = chatGPTText('停止'); settingsHelperStop.disabled = true;
  const settingsHelperClose = settingsHelperPanel.querySelector('header button'); settingsHelperClose.title = chatGPTText('关闭');
  const settingsHelperOpen = document.createElement('button'); settingsHelperOpen.type = 'button'; settingsHelperOpen.className = 'btn-secondary'; settingsHelperOpen.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> '; settingsHelperOpen.append(chatGPTText('设置助手')); settingsHelperOpen.setAttribute('aria-expanded', 'false');
  document.querySelector('#page-settings .page-header-actions').append(settingsHelperOpen);
  function settingsHelperMessage(text, kind) {
    const item = document.createElement('div'); item.className = 'settings-assistant-message ' + kind; item.textContent = text;
    settingsHelperMessages.append(item); settingsHelperMessages.scrollTop = settingsHelperMessages.scrollHeight; return item;
  }
  async function openSettingsHelper() {
    if (settingsHelper || settingsHelperOpening) return;
    settingsHelperOpening = true; const generation = ++settingsHelperGeneration;
    settingsHelperSend.disabled = false; settingsHelperStop.disabled = true;
    settingsWorkspace.classList.add('assistant-open'); settingsHelperPanel.inert = false; settingsHelperOpen.setAttribute('aria-expanded', 'true'); settingsHelperInput.focus();
    settingsHelperMessages.replaceChildren(); settingsHelperMessage(chatGPTText('可以帮你查找设置、调整外观和限额。账号与安全设置会带你前往对应页面。'), 'system');
    const settings = await readSettings();
    if (generation !== settingsHelperGeneration) return;
    const api = {};
    for (const key of ['chatLLM', 'chatLLMStream', 'summarizeText', 'budgetCheck', 'agentAbort', 'onLLMRetry', 'onStreamChunk', 'onStreamEnd']) if (typeof window.api[key] === 'function') api[key] = (...args) => window.api[key](...args);
    api.getSettings = async () => ({ ...settings, llm: { ...settings.llm }, email: { enabled: false }, decision: { enabled: false }, agent: { maxIterations: 12 }, autoOptimizeToolSelection: false, tools: {}, privacyProtection: { enabled: true, filterResults: true, filterArgs: true } });
    api.getFullSystemInfo = async () => ({}); api.workspaceCreate = async () => ({ ok: false });
    const helper = new Agent({ host: AgentHostKit.createHeadlessHost({ api }), ephemeral: true, allowedToolNames: settingsAssistantTools.map(tool => tool.function.name) });
    helper.minimalMode = true; helper.setSessionKey('settings-' + crypto.randomUUID());
    helper.getSystemPrompt = () => 'You are CIBYP settings assistant. Reply in the user’s language (UI: ' + settings.language + '). Only manage this application’s settings. First read the safe settings catalog; exact paths and valid ranges are authoritative. Change only what the user explicitly requests. For private, credential, account, provider and security settings, use settings_navigate and ask the user to edit there; never request or disclose secrets. Do not execute code, install software, access files or use ordinary Agent tools. This is an ephemeral conversation. Explain the final applied values clearly.';
    helper.getRuntimeToolSchemas = () => settingsAssistantTools;
    helper.executeTool = async (name, args) => {
      if (generation !== settingsHelperGeneration) return { ok: false, error: 'Session closed' };
      if (name === 'settings_read') return window.api.settingsAssistantCatalog(args.query);
      if (name === 'settings_patch') {
        const result = await window.api.settingsAssistantPatch(args.changes);
        if (result.ok) await loadSettingsPage(); return result;
      }
      if (name === 'settings_navigate') {
        const result = await window.api.settingsAssistantNavigate(args.path);
        if (result.ok) {
          window.navigatePage('settings'); window.activateSettingsTab(result.category);
          const field = result.fieldId ? document.getElementById(result.fieldId) : null;
          const target = field?.closest('.setting-item') || field || document.querySelector('.settings-panel[data-tab="' + result.category + '"]');
          target?.scrollIntoView({ block: 'center', behavior: 'smooth' }); target?.classList.add('settings-assistant-target');
          setTimeout(() => target?.classList.remove('settings-assistant-target'), 2400);
          if (field && !result.manual) field.focus({ preventScroll: true });
        } return result;
      }
      return { ok: false, error: 'Only settings tools are available' };
    };
    // Pin the chosen model so this assistant cannot alter or route the chat session's model.
    const pool = settings.llm.pool || [];
    const entry = pool.find(entry => entry.enabled !== false && entry.provider === 'opencode-zen' && (entry.providerLimits?.free || entry.model === 'big-pickle' || entry.model.endsWith('-free'))) || pool.find(entry => entry.id === settings.llm.activeEntryId && entry.enabled !== false);
    if (entry) helper.llmOverride = { ...entry, poolEntryId: entry.id, reasoningEffort: entry.effort || 'auto' };
    settingsHelper = helper;
    try { await helper.init(); }
    catch (error) { settingsHelperMessage(error.message, 'error'); }
    finally { if (generation === settingsHelperGeneration) settingsHelperOpening = false; }
    if (generation !== settingsHelperGeneration) { helper.stop(); releaseSettingsHelper(helper); }
  }
  function releaseSettingsHelper(helper) {
    for (const key of ['_llmRetryUnsub', '_llmExternalUsageUnsub', '_streamChunkUnsub', '_streamEndUnsub']) { helper[key]?.(); helper[key] = null; }
    helper.onMessage = helper.onStatusChange = helper.onToolCall = null;
    helper.contextManager.clear?.();
  }
  function closeSettingsHelper() {
    ++settingsHelperGeneration; settingsHelperOpening = false;
    settingsWorkspace.classList.remove('assistant-open'); settingsHelperPanel.inert = true; settingsHelperOpen.setAttribute('aria-expanded', 'false');
    if (settingsHelper) { settingsHelper.stop(); releaseSettingsHelper(settingsHelper); settingsHelper = null; }
    settingsHelperMessages.replaceChildren(); settingsHelperInput.value = ''; settingsHelperOpen.focus();
  }
  settingsHelperOpen.addEventListener('click', () => settingsHelper ? closeSettingsHelper() : openSettingsHelper().catch(error => settingsHelperMessage(error.message, 'error')));
  settingsHelperClose.addEventListener('click', closeSettingsHelper);
  settingsHelperStop.addEventListener('click', () => settingsHelper?.stop());
  settingsHelperInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); settingsHelperPanel.querySelector('form').requestSubmit(); } });
  settingsHelperPanel.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const helper = settingsHelper; const text = settingsHelperInput.value.trim();
    if (!helper || helper.running || settingsHelperOpening || !text) return;
    const safeText = typeof PrivacyFilter !== 'undefined' ? PrivacyFilter.filterPrivacyInfo(text) : text;
    settingsHelperInput.value = ''; settingsHelperMessage(safeText, 'user');
    let reply = null; let streamed = '';
    helper.onMessage = (type, data) => {
      if (helper !== settingsHelper) return;
      if (type === 'stream-chunk' && data.content) { streamed += data.content; reply ||= settingsHelperMessage('', 'assistant'); reply.textContent = streamed; settingsHelperMessages.scrollTop = settingsHelperMessages.scrollHeight; }
      else if (type === 'assistant' && data) { reply ||= settingsHelperMessage('', 'assistant'); reply.textContent = typeof data === 'string' ? data : String(data.content || ''); reply = null; streamed = ''; }
      else if (type === 'settings-navigate' && data?.ok) { window.activateSettingsTab(data.category); document.getElementById(data.fieldId)?.scrollIntoView({ block: 'center' }); document.getElementById(data.fieldId)?.focus(); }
      else if (type === 'error' || type === 'system') settingsHelperMessage(String(data), type);
    };
    settingsHelperSend.disabled = true; settingsHelperStop.disabled = false;
    try { await helper.sendMessage(safeText); } catch (error) { if (helper === settingsHelper) settingsHelperMessage(error.message, 'error'); }
    finally { if (helper === settingsHelper) { settingsHelperSend.disabled = false; settingsHelperStop.disabled = true; } }
  });
