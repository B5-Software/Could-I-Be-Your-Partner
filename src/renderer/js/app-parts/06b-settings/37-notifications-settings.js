  const notifyToggles = [
    { id: 'setting-notify-enabled', key: 'enabled' },
    { id: 'setting-notify-approval', key: 'approval' },
    { id: 'setting-notify-session-done', key: 'sessionDone' },
    { id: 'setting-notify-question', key: 'question' },
    { id: 'setting-notify-present', key: 'present' },
    { id: 'setting-notify-babe-proactive', key: 'babeProactive' },
    { id: 'setting-notify-update', key: 'updateAvailable' }
  ];
  notifyToggles.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.notifications) s.notifications = {};
      s.notifications[key] = el.checked;
      await saveSettings(s);
    });
  });
  const btnNotifyTest = document.getElementById('btn-notify-test');
  if (btnNotifyTest) {
    btnNotifyTest.addEventListener('click', async () => {
      try {
        const r = await window.api.sendNotification({
          title: 'CIBYP 测试通知',
          body: '如果您看到这条通知，说明系统通知工作正常。'
        });
        if (!r?.ok) {
          alert('通知发送失败：' + (r?.error || '未知原因'));
        }
      } catch (e) {
        alert('通知发送异常：' + e.message);
      }
    });
  }
