  const settingsHelp = {
    overview: ['设置概览', '查看配置状态和常用入口', '入门 常用 快速'],
    llm: ['模型与连接', '默认模型用于新会话；已锁定的会话保持所选模型。连接字段自动保存。', 'LLM API 模型池 provider key'],
    context: ['Token 与上下文', '设置单次请求的容量、输出、工具加载及历史压缩。', 'token tokens 上限 预算 长度 压缩 Jev 工具'],
    budget: ['消费与用量上限', '累计限额与单次输出分开配置；美元费用按价格表估算。', '费用 花费 日 周 月 余额 token 图片 限额'],
    decision: ['Jev 决策模型', '配置轻量决策服务，并单独选择模型路由、工具选择等使用场景。', 'Jev 自动选择 智慧 reasoning'],
    image: ['图像生成', '配置生图服务与参数；每日张数在消费与用量上限中统一设置。', '图片 生图 image'],
    usage: ['用量统计', '查看已记录的 Token、模型和消费趋势。', '统计 tokens 账单 历史'],
    ai: ['AI 形象', '形象和提示词修改后即时生效。', '头像 名称 人设 prompt'],
    babe: ['Babe 模式', '设置恋爱模式形象及主动消息偏好。', '恋爱 陪伴 主动'],
    user: ['个人资料', '设置显示名称、头像与个人介绍。', '昵称 资料 头像'],
    theme: ['外观', '深浅色、强调色、背景色和焦点描边。配色同步到 App 与 VM。', '个性化 深色 浅色 accent 背景 焦点 描边'],
    animations: ['动效', '页面与弹窗渐显渐隐，侧栏侧向滑动；同时遵循系统减少动态效果偏好。', '动画 展开 折叠'],
    fonts: ['字体', '字体与大小修改后即时生效。', '字号 排版'],
    tui: ['TUI 偏好', '终端主题与思考展开偏好，和 TUI 命令共享配置。', '终端 theme thinking 深色 浅色 背景'],
    language: ['语言', '选择界面语言。', '中文 English Deutsch'],
    voice: ['语音', '本地语音需要先下载对应模型，支持状态见资源下载。', 'STT TTS 朗读 麦克风 唤醒'],
    ime: ['输入法', '设置屏幕键盘与候选词。', '键盘 拼音 OSK'],
    notifications: ['通知', '按事件选择桌面通知，修改后即时生效。', '通知 提醒 系统'],
    mcp: ['MCP', '添加服务器后使用连接按钮；工具会加入统一发现目录。', '扩展 tools server'],
    email: ['邮箱', '填写收发配置后使用保存或测试按钮。', 'SMTP IMAP 邮件'],
    fedikitten: ['FediKitten', '使用登录按钮连接账号。', '社交 登录'],
    cibypim: ['CIBYP-IM', '使用登录按钮连接账号与消息服务。', '聊天 即时消息 登录'],
    webcontrol: ['Web 控制', '配置访问方式、密码与连接状态。', '远程 浏览器 remote'],
    playwright: ['浏览器自动化', '保存后下一次浏览器启动使用新配置。', 'Playwright 浏览器 headless'],
    automation: ['自动化', '配置本地 HTTP 信号服务及访问令牌。', '触发 定时 token HTTP'],
    plugins: ['插件', '安装和管理插件及其配置。', '扩展 DeepSeek MCP'],
    terminal: ['终端', '新终端使用所选 Shell；停止任务策略控制已有进程。', 'Shell PowerShell bash zsh'],
    sandbox: ['工具执行权限', '设置各模式的文件访问范围与审批行为。', '权限 沙箱 安全 approval'],
    runtime: ['本机与虚拟机', '选择执行位置和 VM 资源；已有终端仍属于创建时的位置。', 'VM QEMU OS workspace 工作目录'],
    security: ['安全', '工具授权、隐私保护及后台托盘行为。', '隐私 审批 托盘 密钥'],
    network: ['网络', '配置代理，保存后重新应用网络设置。', '代理 proxy 网络'],
    entropy: ['熵源', '选择随机数来源及硬件连接方式。', 'TRNG 随机数'],
    firmware: ['TRNG 固件', '导出硬件固件与连接说明。', 'Arduino 硬件'],
    resources: ['资源下载', '按需下载语音等资源，下载按钮启动操作。', '下载 模型 镜像'],
    environment: ['环境检测', '运行检测查看工具和运行环境是否就绪。', '诊断 状态 修复'],
    updates: ['更新', '配置更新频道与检查频率，使用检查按钮获取结果。', '版本 更新 release'],
  };
  function refreshSettingsOverview(s) {
    const grid = document.getElementById('settings-overview-cards');
    if (!grid) return;
    const limits = TokenPolicy.resolve(s);
    const budget = s.budget || {};
    const budgetSummary = [budget.dailyTokenLimit > 0 ? `每日 ${budget.dailyTokenLimit.toLocaleString()} Token` : '',
      budget.dailyLimitUSD > 0 ? `日 $${budget.dailyLimitUSD}` : '', budget.weeklyLimitUSD > 0 ? `周 $${budget.weeklyLimitUSD}` : '',
      budget.monthlyLimitUSD > 0 ? `月 $${budget.monthlyLimitUSD}` : '', s.imageGen?.dailyMaxImages > 0 ? `每日 ${s.imageGen.dailyMaxImages} 张图` : '', s.decision?.dailyMaxCalls > 0 ? `每日 Jev ${s.decision.dailyMaxCalls} 次` : ''].filter(Boolean).join(' · ');
    const cards = [
      ['llm', 'fa-microchip', '模型与连接', s.llm.model || '尚未配置模型'],
      ['context', 'fa-sliders', 'Token 与上下文', `${limits.contextTokens.toLocaleString()} 容量 · ${limits.outputTokens.toLocaleString()} 输出`],
      ['budget', 'fa-wallet', '消费与用量上限', budgetSummary || '未设置累计限额'],
      ['runtime', 'fa-server', '执行位置', s.runtime?.location === 'vm' ? '虚拟机' : '本机'],
      ['theme', 'fa-palette', '个性化', ({ light: '浅色', dark: '深色', system: '跟随系统' })[s.theme?.mode] || '跟随系统'],
      ['decision', 'fa-scale-balanced', 'Jev 决策模型', s.decision?.enabled ? '已启用 · 选择使用场景' : '未启用 · 可使用本地工具选择'],
    ];
    grid.replaceChildren(...cards.map(([tab, icon, title, value]) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.settingsOpen = tab;
      const symbol = document.createElement('i'); symbol.className = `fa-solid ${icon}`;
      const label = document.createElement('strong'); label.textContent = title;
      const detail = document.createElement('span'); detail.textContent = value;
      button.append(symbol, label, detail); return button;
    }));
  }
  window.refreshSettingsOverview = refreshSettingsOverview;
  document.addEventListener('click', e => {
    const jump = e.target.closest('[data-settings-open]');
    if (jump) { window.navigatePage('settings'); window.activateSettingsTab(jump.dataset.settingsOpen); }
    const page = e.target.closest('[data-settings-page]');
    if (page) window.navigatePage(page.dataset.settingsPage);
  });
  // Invalid numeric values never reach an asynchronous change handler.
  document.addEventListener('change', e => {
    const field = e.target;
    if (!field.closest?.('#page-settings') || !field.matches('input[type="number"]')) return;
    if (field.value === '' && field.min === '0') field.value = '0';
    if (field.value === '' || !field.checkValidity()) {
      field.setAttribute('aria-invalid', 'true'); e.stopImmediatePropagation();
      const status = document.getElementById('settings-save-status');
      status.dataset.state = 'error'; status.textContent = '未保存：请输入有效数值' + (field.min ? `（至少 ${field.min}${field.max ? '，最多 ' + field.max : ''}）` : '');
      field.reportValidity();
    } else field.removeAttribute('aria-invalid');
  }, true);

  // Register every category with accessible names, descriptions and keyboard navigation.
  Promise.resolve().then(() => {
    document.querySelectorAll('#page-settings .settings-panel').forEach(panel => {
      const tab = panel.dataset.tab;
      panel.id ||= 'settings-panel-' + tab;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'settings-tab-' + tab);
      panel.inert = !panel.classList.contains('active'); panel.setAttribute('aria-hidden', String(panel.inert));
      const info = settingsHelp[tab];
      if (info && tab !== 'overview') {
        const intro = document.createElement('p'); intro.className = 'settings-section-intro'; intro.textContent = info[1]; panel.prepend(intro);
      }
      panel.querySelectorAll('.setting-item').forEach(item => {
        const label = item.querySelector('label');
        const controls = item.querySelectorAll('input, select, textarea');
        for (const control of controls) {
          if (controls.length === 1 && label && control.id) label.htmlFor = control.id;
          if (!control.hasAttribute('aria-label') && !control.labels?.length) control.setAttribute('aria-label', control.title || label?.textContent.trim() || control.placeholder || control.id || info?.[0] || tab);
        }
      });
      panel.querySelectorAll('input, select, textarea').forEach(control => {
        if (control.labels?.length || control.hasAttribute('aria-label')) return;
        const label = control.parentElement.querySelector(':scope > label');
        if (label && control.id) label.htmlFor = control.id;
        else control.setAttribute('aria-label', control.title || control.placeholder || control.id || info?.[0] || tab);
      });
      const button = document.querySelector('.settings-tab[data-tab="' + tab + '"]');
      if (button) {
        button.id = 'settings-tab-' + tab; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
        button.setAttribute('aria-selected', String(!panel.inert)); button.tabIndex = panel.inert ? -1 : 0;
      }
    });
    document.querySelector('.settings-tabs').setAttribute('role', 'tablist');
    document.querySelector('.settings-tabs').setAttribute('aria-label', '设置分类');
    document.querySelector('.settings-tabs').addEventListener('keydown', e => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !e.target.matches('.settings-tab')) return;
      const tabs = [...document.querySelectorAll('.settings-tab')].filter(el => !el.hidden && el.style.display !== 'none');
      const index = tabs.indexOf(e.target);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1) + tabs.length) % tabs.length;
      e.preventDefault(); tabs[next].click(); tabs[next].focus();
    });
    const fold = (element, title) => {
      if (!element || element.closest('details')) return;
      const details = document.createElement('details'); details.className = 'settings-advanced';
      const summary = document.createElement('summary'); summary.textContent = title;
      element.before(details); details.append(summary, element);
    };
    fold(document.getElementById('budget-pricing-list')?.closest('.settings-group'), '模型价格表（用于费用估算）');
    fold(document.getElementById('setting-budget-peak-enabled')?.closest('.settings-group'), '峰谷时段价格（高级）');
    const resetGroup = document.getElementById('btn-reset-usage')?.closest('.settings-group');
    if (resetGroup) {
      const panel = resetGroup.closest('.settings-panel');
      fold(resetGroup, '今日计数管理（高级）');
      panel.append(resetGroup.parentElement);
    }
    const compression = document.getElementById('setting-context-threshold')?.closest('.setting-item');
    if (compression) {
      fold(compression, '调整压缩策略（高级）');
      const details = compression.parentElement;
      for (const id of ['setting-context-retain', 'setting-context-retries', 'setting-context-max-tokens']) details.append(document.getElementById(id).closest('.setting-item'));
    }
    fold(document.getElementById('setting-llm-provider')?.closest('.settings-group'), '直接编辑默认模型连接（高级）');
  });
