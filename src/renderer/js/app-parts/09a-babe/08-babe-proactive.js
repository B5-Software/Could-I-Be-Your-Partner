  function restartBabeProactiveTimer(intervalOverride) {
    if (babeProactiveTimer) {
      clearInterval(babeProactiveTimer);
      babeProactiveTimer = null;
    }
    // 支持在 babeAgent 尚未初始化时由启动流程传入 interval
    const interval = intervalOverride ?? babeAgent?.settings?.babe?.proactiveInterval;
    if (!interval || interval <= 0) return;
    // 转换为毫秒（设置中以分钟为单位）
    const ms = interval * 60 * 1000;
    babeProactiveTimer = setInterval(() => {
      babeProactiveMessage();
    }, ms);
  }

  // 主动发消息：让 Babe 主动发起一条话题
  // 无论当前是否在 Babe 模式都会触发；消息只追加到 Babe Session（不会泄露到其他模式）
  // 如果当前没有 Babe 会话，则自动新建一个
  async function babeProactiveMessage() {
    // 若 babeAgent 尚未初始化，则自动新建 Babe 会话
    if (!babeAgent) {
      const ok = await initBabeAgent();
      if (!ok) return;
    }
    if (babeAgent.running) return; // 正在回复中，跳过
    // 注意：不再检查是否在 Babe 模式页面 —— 主动消息在任何模式下都应触发
    // 聊天内容只写入 #babe-chat-messages 和 babeMessages，天然与其他模式隔离
    babeProactiveActive = true;
    babeProactiveProduced = false;
    try {
      // 随机选一个话题提示，交给 LLM 以 Babe 口吻生成主动消息
      const topicHints = [
        '关心用户今天过得怎么样',
        '分享自己刚想到的一件小事',
        '询问用户最近在忙什么',
        '表达想用户的心情',
        '聊聊最近看到的有趣事物',
        '问问用户有没有好好吃饭'
      ];
      const hint = topicHints[Math.floor(Math.random() * topicHints.length)];
      // 调用 proactiveSend：让 Babe 主动发起，不走 user 消息路径
      await babeAgent.proactiveSend(hint);
    } catch (e) {
      console.error('[Babe] proactive message failed:', e);
    } finally {
      // 主动消息接收完成时发送系统通知（仅当确实产生了内容）
      const produced = babeProactiveProduced;
      babeProactiveActive = false;
      babeProactiveProduced = false;
      if (produced) {
        const babeName = babeAgent?.settings?.babe?.name || 'Babe';
        // 用户正在 Babe 模式页面时无需通知（直接可见）；否则绕过 sendAppNotification 的焦点检查
        const babePage = document.getElementById('page-babe');
        const onBabePage = !!(babePage && babePage.classList.contains('active'));
        if (!onBabePage) {
          try {
            const s = await window.api.getSettings();
            const n = s.notifications || {};
            if (n.enabled !== false && n.babeProactive !== false) {
              await window.api.sendNotification({
                title: `${babeName} 主动发来一条消息`,
                body: '快去看看 TA 说了什么吧',
                category: 'babeProactive'
              });
            }
          } catch (e) {
            console.warn('[Babe] proactive notification failed:', e?.message || e);
          }
        }
      }
    }
  }
