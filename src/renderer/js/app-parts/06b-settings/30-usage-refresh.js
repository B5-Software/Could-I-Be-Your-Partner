  document.querySelectorAll('.usage-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.usage-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadUsageStats(btn.dataset.period);
    });
  });

  // Usage stats refresh button
  const usageRefreshBtn = document.getElementById('btn-usage-refresh');
  if (usageRefreshBtn) usageRefreshBtn.addEventListener('click', async () => {
    const activePeriod = document.querySelector('.usage-period-btn.active');
    await loadUsageStats(activePeriod ? activePeriod.dataset.period : 'daily');
    window.showToast('用量统计已刷新', 'success');
  });
