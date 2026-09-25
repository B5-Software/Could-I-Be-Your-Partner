  wireChatAgent(agent);

  await agent.init();
  sessionManager = new SessionManager({
    maxConcurrent: Math.max(1, Number(agent.settings?.sessions?.maxConcurrent) || 10),
    // 关键：必须复用全局 AppBus，否则 SessionManager 内部默认会新建一个私有总线，
    // 导致 session-status/session-title/session-created/session-closed 等监听全部失效，
    // 表现为会话标签栏不刷新、排队消息不推进、历史页不自动刷新。
    bus: AppBus
  });
  window.__sessionManager = sessionManager;
  const primaryChatSession = sessionManager.registerAgent('chat', agent, {
    title: agent.conversationTitle || '未命名对话'
  });
  sessionManager.activate('chat', primaryChatSession.key);
