  // ==================== 面板最小化/恢复（索引贴） ====================
  // 追踪当前被最小化的面板 id，避免重复创建索引贴
  const minimizedPanels = new Set();

  // 最小化面板：隐藏面板并在右侧边缘生成一个可点击的纵向索引贴
  window.minimizePanel = function(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel || minimizedPanels.has(panelId)) return;

    // 从面板头部提取图标与标题文本
    const header = panel.querySelector('.geogebra-header h3');
    const iconEl = header ? header.querySelector('i') : null;
    const iconClass = iconEl ? iconEl.className : '';
    const title = header ? header.textContent.trim() : panelId;

    // 隐藏面板并释放主内容区空间（与关闭行为一致）
    panel.classList.add('hidden');
    document.body.classList.remove('geogebra-open');
    minimizedPanels.add(panelId);

    // 在索引贴容器中创建对应 tab
    const container = document.getElementById('panel-tabs-container');
    if (!container) return;
    if (container.querySelector(`[data-panel-id="${panelId}"]`)) return;

    const tab = document.createElement('div');
    tab.className = 'panel-tab';
    tab.dataset.panelId = panelId;
    tab.title = `恢复 ${title}`;
    tab.innerHTML = (iconClass ? `<i class="${iconClass}"></i>` : '') + `<span>${title}</span>`;
    tab.addEventListener('click', () => {
      window.restorePanel(panelId);
    });
    container.appendChild(tab);
  };

  // 恢复面板：移除隐藏状态并删除对应索引贴
  window.restorePanel = function(panelId) {
    const panel = document.getElementById(panelId);
    if (panel) {
      panel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');
    }
    minimizedPanels.delete(panelId);

    const container = document.getElementById('panel-tabs-container');
    if (container) {
      const tab = container.querySelector(`[data-panel-id="${panelId}"]`);
      if (tab) tab.remove();
    }
  };

  // 绑定所有最小化按钮：点击时找到所属面板并最小化
  document.querySelectorAll('.btn-minimize-panel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.geogebra-panel');
      if (panel && panel.id) {
        window.minimizePanel(panel.id);
      }
    });
  });
