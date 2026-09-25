  // ---- Email Received Handler ----
  window.api.onEmailReceived((email) => {
    // Forward email content to agent as hot message
    if (!agent || typeof agent.injectHotMessage !== 'function') return;
    const content = `[收到邮件] 发件人: ${email.from || '未知'}, 主题: ${email.subject || '(无主题)'}\n\n${email.text || email.html || ''}`;
    const dcfg = agent.settings?.decision || {};
    if (dcfg.enabled && dcfg.usages?.emailIntent !== false && typeof window.api.decisionChoice === 'function') {
      // 决策模型先分类：仅"值得处理"的邮件才唤醒 Agent（低置信/失败 → 默认唤醒，避免漏邮）
      window.api.decisionChoice({
        state: content.slice(0, 1500),
        instructions: '这封邮件是否需要立即交给 AI 助手阅读和处理？',
        criteria: {
          agent: '需要助手阅读、回复或用户会关心的邮件',
          ignore: '广告/营销/自动通知/垃圾邮件，无需打扰用户'
        },
        key: 'intent',
        usage: 'emailIntent'
      }).then((r) => {
        if (!r || !r.value || r.value === 'agent') agent.injectHotMessage(content);
      }).catch(() => agent.injectHotMessage(content));
    } else {
      agent.injectHotMessage(content);
    }
  });
