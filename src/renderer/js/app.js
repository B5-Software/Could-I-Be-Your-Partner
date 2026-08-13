/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 生成文件：由 scripts/build-app-bundle.js 从 src/renderer/js/app-parts/*.js 拼接生成。
 * 请勿直接编辑本文件，修改 app-parts 后运行 npm run build-app-bundle。
 */

export default (async function appEntry() {
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Main Application Controller
// 注：本 part 已不包含 IIFE 包装，由 build-app-bundle.js 生成 ESM app.js 时
// 统一包在 `export default (async function appEntry() { ... })();` 中。
  // Wait for KaTeX to load
  let waitCount = 0;
  while (!window.katex && waitCount < 50) {
    await new Promise(r => setTimeout(r, 100));
    waitCount++;
  }

  // Init theme
  await ThemeManager.init();

  // Helper: push current theme CSS vars to web control
  function pushThemeToWebControl() {
    // Use getComputedStyle so CSS-file defaults are read even when no inline style is set
    const style = getComputedStyle(document.documentElement);
    const vars = {
      accent: style.getPropertyValue('--accent').trim(),
      accentLight: style.getPropertyValue('--accent-light').trim(),
      accentDark: style.getPropertyValue('--accent-dark').trim(),
      accentBg: style.getPropertyValue('--accent-bg').trim(),
      bgPrimary: style.getPropertyValue('--bg-primary').trim(),
      bgSecondary: style.getPropertyValue('--bg-secondary').trim(),
      bgTertiary: style.getPropertyValue('--bg-tertiary').trim(),
      bgHover: style.getPropertyValue('--bg-hover').trim(),
      isDark: document.documentElement.getAttribute('data-theme') === 'dark',
    };
    window.api.webControlPushTheme(vars);
  }

  function makeAvatarHTML(avatarData, isAI, style) {
    const sz = style || 'width:100%;height:100%;border-radius:50%;object-fit:cover';
    if (avatarData) {
      const src = avatarData.startsWith('data:') ? avatarData : 'file://' + avatarData.replace(/\\/g, '/');
      return `<img src="${src}" style="${sz}" alt="">`;
    }
    return isAI ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-user"></i>';
  }

  // ---- 头像框系统 ----
  // 缓存已加载的 SVG 内容，避免重复 IPC 调用
  const _avatarFrameCache = {}; // id -> svg content
  // 当前生效的头像框 ID（由 settings 加载时填充）
  const _avatarFrameState = { ai: null, user: null, babe: null };
  // 用于在多实例插入时为 SVG id 添加唯一后缀，避免 ID 冲突
  let _avatarFrameUid = 0;

  // 异步加载 SVG 头像框内容并缓存
  async function loadAvatarFrameSVG(id) {
    if (!id) return '';
    if (_avatarFrameCache[id]) return _avatarFrameCache[id];
    try {
      const res = await window.api.avatarFramesGet(id);
      if (res?.ok && res.content) {
        _avatarFrameCache[id] = res.content;
        return res.content;
      }
    } catch (_) {}
    return '';
  }

  // 为 SVG 内容中的 id/url(#id) 添加唯一后缀
  function _uniqueSvgIds(svg) {
    if (!svg) return '';
    const suffix = '_f' + (++_avatarFrameUid);
    return svg
      .replace(/\bid="([^"]+)"/g, (m, id) => `id="${id}${suffix}"`)
      .replace(/url\(#([^)]+)\)/g, (m, id) => `url(#${id}${suffix})`);
  }

  // 生成头像框叠加层 HTML（不含外层 div）
  function makeFrameOverlayHTML(frameId) {
    const svg = frameId ? _avatarFrameCache[frameId] : null;
    if (!svg) return '';
    return `<div class="avatar-frame-overlay">${_uniqueSvgIds(svg)}</div>`;
  }

  // 包装聊天消息中的头像 HTML（含头像框叠加层）
  function makeFramedAvatarHTML(avatarData, isAI, style) {
    const frameId = isAI ? _avatarFrameState.ai : _avatarFrameState.user;
    const inner = makeAvatarHTML(avatarData, isAI, style);
    if (!frameId) return inner;
    const svg = _avatarFrameCache[frameId];
    if (!svg) return inner;
    return `<div class="avatar-framed-wrap">${inner}${makeFrameOverlayHTML(frameId)}</div>`;
  }

  // 生成 Babe 模式头像 HTML（含头像框叠加层）
  // role: 'babe' (TA) 或 'user' (用户)；Babe 用独立配置的头像/头像框，user 复用个人资料头像/头像框
  function makeBabeFramedAvatarHTML(avatarData, role, style) {
    const frameId = role === 'babe' ? _avatarFrameState.babe : _avatarFrameState.user;
    const sz = style || 'width:100%;height:100%;border-radius:50%;object-fit:cover';
    let inner;
    if (avatarData) {
      const src = avatarData.startsWith('data:') ? avatarData : 'file://' + avatarData.replace(/\\/g, '/');
      inner = `<img src="${src}" style="${sz}" alt="">`;
    } else {
      inner = role === 'babe' ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-solid fa-user"></i>';
    }
    if (!frameId) return inner;
    const svg = _avatarFrameCache[frameId];
    if (!svg) return inner;
    return `<div class="avatar-framed-wrap">${inner}${makeFrameOverlayHTML(frameId)}</div>`;
  }

  // 加载头像框列表并渲染设置中的三个 grid（AI / User / Babe）
  async function loadAvatarFrames() {
    try {
      const res = await window.api.avatarFramesList();
      if (!res?.ok || !Array.isArray(res.frames)) return;
      const aiGrid = document.getElementById('setting-ai-avatar-frame-grid');
      const userGrid = document.getElementById('setting-user-avatar-frame-grid');
      const babeGrid = document.getElementById('setting-babe-avatar-frame-grid');
      if (!aiGrid || !userGrid) return;

      // 构建 "无头像框" 项
      const buildNoneItem = (isSelected) => {
        const div = document.createElement('div');
        div.className = 'avatar-frame-item none-item' + (isSelected ? ' selected' : '');
        div.dataset.frameId = '';
        div.title = '无头像框';
        div.innerHTML = '<div class="frame-inner"><i class="fa-solid fa-ban"></i></div>';
        return div;
      };

      // 构建头像框项
      const buildFrameItem = (frame, isSelected) => {
        const div = document.createElement('div');
        div.className = 'avatar-frame-item' + (isSelected ? ' selected' : '');
        div.dataset.frameId = frame.id;
        div.title = frame.id;
        div.innerHTML = '<div class="frame-inner"><i class="fa-solid fa-user"></i></div>';
        // 异步加载并插入 SVG 缩略图
        loadAvatarFrameSVG(frame.id).then((svg) => {
          if (svg && div.isConnected) {
            div.insertAdjacentHTML('afterbegin', `<div class="frame-thumb">${_uniqueSvgIds(svg)}</div>`);
          }
        });
        return div;
      };

      // 渲染 AI grid
      aiGrid.innerHTML = '';
      aiGrid.appendChild(buildNoneItem(!_avatarFrameState.ai));
      res.frames.forEach((f) => aiGrid.appendChild(buildFrameItem(f, _avatarFrameState.ai === f.id)));

      // 渲染 User grid
      userGrid.innerHTML = '';
      userGrid.appendChild(buildNoneItem(!_avatarFrameState.user));
      res.frames.forEach((f) => userGrid.appendChild(buildFrameItem(f, _avatarFrameState.user === f.id)));

      // 渲染 Babe grid（Babe 模式独立头像框）
      if (babeGrid) {
        babeGrid.innerHTML = '';
        babeGrid.appendChild(buildNoneItem(!_avatarFrameState.babe));
        res.frames.forEach((f) => babeGrid.appendChild(buildFrameItem(f, _avatarFrameState.babe === f.id)));
      }

      // 绑定点击事件（事件委托）
      aiGrid.onclick = async (e) => {
        const item = e.target.closest('.avatar-frame-item');
        if (!item) return;
        const frameId = item.dataset.frameId || '';
        _avatarFrameState.ai = frameId || null;
        if (frameId) await loadAvatarFrameSVG(frameId);
        // 持久化到设置
        const s = await window.api.getSettings();
        if (!s.aiPersona) s.aiPersona = {};
        s.aiPersona.avatarFrame = frameId;
        await saveSettings(s);
        // 更新选中态
        aiGrid.querySelectorAll('.avatar-frame-item').forEach((i) => i.classList.toggle('selected', i === item));
        // 更新设置预览叠加
        updateAvatarPreviewFrame('ai');
        // 更新 Hero 显示
        updatePersonaDisplay(s.aiPersona);
      };

      userGrid.onclick = async (e) => {
        const item = e.target.closest('.avatar-frame-item');
        if (!item) return;
        const frameId = item.dataset.frameId || '';
        _avatarFrameState.user = frameId || null;
        if (frameId) await loadAvatarFrameSVG(frameId);
        const s = await window.api.getSettings();
        if (!s.userProfile) s.userProfile = {};
        s.userProfile.avatarFrame = frameId;
        await saveSettings(s);
        userGrid.querySelectorAll('.avatar-frame-item').forEach((i) => i.classList.toggle('selected', i === item));
        updateAvatarPreviewFrame('user');
      };

      // Babe grid 点击事件（Babe 模式独立头像框，存储到 settings.babe.avatarFrame）
      if (babeGrid) {
        babeGrid.onclick = async (e) => {
          const item = e.target.closest('.avatar-frame-item');
          if (!item) return;
          const frameId = item.dataset.frameId || '';
          _avatarFrameState.babe = frameId || null;
          if (frameId) await loadAvatarFrameSVG(frameId);
          const s = await window.api.getSettings();
          if (!s.babe) s.babe = {};
          s.babe.avatarFrame = frameId;
          await saveSettings(s);
          // 同步到 babeAgent.settings
          if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
          babeGrid.querySelectorAll('.avatar-frame-item').forEach((i) => i.classList.toggle('selected', i === item));
          updateAvatarPreviewFrame('babe');
          // 更新 Babe Hero 显示
          updateBabePersonaDisplay(s.babe);
        };
      }
    } catch (e) {
      console.error('loadAvatarFrames failed:', e);
    }
  }

  // 更新设置中的头像预览叠加层
  function updateAvatarPreviewFrame(role) {
    const previewId = role === 'ai' ? 'setting-ai-avatar-preview'
      : role === 'babe' ? 'setting-babe-avatar-preview'
      : 'setting-user-avatar-preview';
    const preview = document.getElementById(previewId);
    if (!preview) return;
    // 移除现有叠加层
    const existing = preview.querySelector('.avatar-frame-overlay');
    if (existing) existing.remove();
    const frameId = role === 'ai' ? _avatarFrameState.ai
      : role === 'babe' ? _avatarFrameState.babe
      : _avatarFrameState.user;
    if (frameId && _avatarFrameCache[frameId]) {
      preview.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
    }
  }

  async function pushAvatarsToWeb() {
    const s = await window.api.getSettings();
    window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: s.userProfile?.avatar || '' });
  }

  // Intercept ThemeManager.apply so every theme change is auto-pushed
  const _origApply = ThemeManager.apply.bind(ThemeManager);
  ThemeManager.apply = function(theme) {
    _origApply(theme);
    // Defer slightly to allow applyThemeMode (which sets data-theme) to settle
    setTimeout(pushThemeToWebControl, 50);
    // Monaco 主题跟随
    setTimeout(() => {
      if (monacoEditor) {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
      }
    }, 50);
  };
  // Push initial theme (ThemeManager.init already ran with the original apply)
  setTimeout(pushThemeToWebControl, 200);
  setTimeout(pushAvatarsToWeb, 250);

  // Sync app version from package metadata (main process)
  async function syncAboutVersion() {
    const el = document.getElementById('about-version');
    if (!el) return;
    try {
      const version = await window.api.getAppVersion();
      el.textContent = `v${version || '-'}`;
    } catch {
      // keep fallback text
    }
  }
  syncAboutVersion();

  function syncBuiltinToolCount() {
    const el = document.getElementById('about-builtins-count');
    if (!el) return;
    const count = Array.isArray(TOOL_DEFINITIONS) ? TOOL_DEFINITIONS.length : 0;
    el.textContent = `${count}个内置工具`;
  }
  syncBuiltinToolCount();

  // Init agent
  let agent = new Agent();

  // Skill 编辑器保存/创建/删除后，主窗口自动刷新目录和当前技能页。
  if (typeof window.api.onSkillsChanged === 'function') {
    window.api.onSkillsChanged(async () => {
      if (typeof agent.refreshSkillsCatalog === 'function') {
        try { await agent.refreshSkillsCatalog(); } catch { /* ignore */ }
      }
      if (agent.contextManager && typeof agent.getSystemPrompt === 'function') {
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      }
      const activePage = document.querySelector('.page.active');
      if (activePage && activePage.id === 'page-skills' && typeof loadSkillsPage === 'function') {
        loadSkillsPage();
      }
    });
  }

  // ---- IPC Dialog Listeners ----
  // 监听main进程的确认对话框请求
  window.api.onShowConfirmDialog(async (message) => {
    try {
      const result = await window.confirmDialog(message, '敏感操作确认');
      window.api.sendConfirmDialogResponse(result);
    } catch (e) {
      window.api.sendConfirmDialogResponse(false);
    }
  });

  // DOM Elements
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const btnNewChat = document.getElementById('btn-new-chat');

  // ── 全局 Toast 提示（用于请求失败重试等自动消失提示） ──
  // 类型: 'error' | 'warn' | 'info' | 'success'
  const btnClearChat = document.getElementById('btn-clear-chat');
  const agentStatus = document.getElementById('agent-status');
  const agentTarot = document.getElementById('agent-tarot');

  // 命运之牌 UI 可见性：关闭时隐藏所有相关 UI，后端抽牌逻辑不变
  let tarotVisible = true;
  function applyTarotVisibility(visible) {
    tarotVisible = visible !== false;
    if (agentTarot) agentTarot.classList.toggle('hidden', !tarotVisible);
  }
  // .no-tarot 构建版本：尽早异步检测并设置全局标志，添加 body.no-tarot class
  // 主进程已强制 settings.tarotVisible=false，所以 applyTarotVisibility(false) 会被自动调用；
  // 这里额外设置 window.NO_TAROT_BUILD 给 filterToolsByConfig 使用，并添加 CSS class 隐藏设置页塔罗牌开关
  if (typeof window !== 'undefined') window.NO_TAROT_BUILD = false;
  if (window.api && typeof window.api.isNoTarotBuild === 'function') {
    window.api.isNoTarotBuild().then(r => {
      if (r && r.ok && r.noTarot) {
        window.NO_TAROT_BUILD = true;
        document.body.classList.add('no-tarot');
        applyTarotVisibility(false);
      }
    }).catch(() => {});
  }
  const todoPanel = document.getElementById('todo-panel');
  const todoList = document.getElementById('todo-list');
  const todoInput = document.getElementById('todo-input');
  const approvalPanel = document.getElementById('approval-panel');
  const approvalContent = document.getElementById('approval-content');
  // 工具首次使用授权模态框（Playwright / Computer Use）
  const toolAuthModal = document.getElementById('tool-auth-modal');
  const toolAuthTitleEl = document.getElementById('tool-auth-title');
  const toolAuthIconEl = document.getElementById('tool-auth-icon');
  const toolAuthWarningEl = document.getElementById('tool-auth-warning');
  const toolAuthToolEl = document.getElementById('tool-auth-tool');
  // 当前等待授权回调的 agent 实例（chat / code / babe 三者之一）
  let _toolAuthAgent = null;
  const btnStop = document.getElementById('btn-stop');
  const btnAttachFile = document.getElementById('btn-attach-file');
  const btnCamera = document.getElementById('btn-camera');
  const btnReoptimizeTools = document.getElementById('btn-reoptimize-tools');
  const btnOpenWorkspace = document.getElementById('btn-open-workspace');
  const attachmentsPreview = document.getElementById('attachments-preview');
  const imagePreviewModal = document.getElementById('image-preview-modal');
  const cameraModal = document.getElementById('camera-modal');

  // Streaming message bubbles: requestId → { el, contentEl, rawContent, renderTimer, shown }
  const streamingBubbles = new Map();

  // ---- WebUI 事件驱动镜像控制器 ----
  // 不再使用 MutationObserver 全量推送（导致死循环刷新 + 输入框被打断）。
  // 改为：WS 连接时推送完整 mirror_head + mirror_body 快照（界面与 Local 一致），
  // 之后由渲染器关键 UI 函数主动推送增量事件（dom_append/dom_clear/dom_replace/dom_remove/dom_update/dom_text）。
  // WebUI 端按事件更新对应 DOM 部分，输入框等用户交互元素不受影响。
  // 主题/头像/标题/模式等仍走原有 push 通道。
  const WebUIMirror = {
    _applyingRemote: false,

    init() {
      // 主动推送初始快照：不依赖 webControl:mirrorInit 信号（避免 preload 缓存导致回调不可用）
      // 主进程会缓存最近一次的 mirror_head + mirror_body，新 WS 客户端连接时自动重放
      setTimeout(() => {
        this.sendMirrorHead();
        this.sendMirrorBody();
      }, 50);

      // 监听主进程的 mirrorInit 请求：新 WS 客户端连接时主进程会触发此信号，
      // 要求渲染器推送最新快照（确保新客户端拿到当前界面而非过期缓存）
      if (typeof window.api?.webControlMirrorInit === 'function') {
        window.api.webControlMirrorInit(() => {
          this.sendMirrorHead();
          this.sendMirrorBody();
        });
      }

      // 接收 WebUI 转发的 UI 事件
      if (typeof window.api?.onWebControlUiEvent === 'function') {
        window.api.onWebControlUiEvent((data) => {
          this.handleUiEvent(data);
        });
      }

      console.log('[WebUIMirror] Event-driven controller initialized');
    },

    buildMirrorHead() {
      let headHtml = document.head.innerHTML;
      headHtml = headHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
      const themeMode = document.documentElement.getAttribute('data-theme') || 'light';
      return { type: 'mirror_head', html: headHtml, theme_mode: themeMode };
    },

    buildMirrorBody() {
      const app = document.getElementById('app');
      const titlebar = document.getElementById('titlebar');
      // 虚拟滚动列表只保留可视窗口，镜像快照前临时展开为完整列表
      if (typeof window.HistoryList === 'object' && typeof window.HistoryList.materializeAll === 'function') {
        window.HistoryList.materializeAll();
      }
      // 完整保留所有内容，不截断历史
      // 包含 #app 外的模态框（onboarding/confirm/message 等）
      const modals = [];
      document.querySelectorAll('.modal-overlay').forEach(m => {
        if (m.id === 'remote-connect-modal' || m.id === 'remote-conn-banner') return;
        modals.push(m.outerHTML);
      });
      const snapshot = {
        type: 'mirror_body',
        html: app ? app.innerHTML : '',
        titlebar: titlebar ? titlebar.outerHTML : '',
        modals: modals.join('')
      };
      if (typeof window.HistoryList === 'object' && typeof window.HistoryList.restoreAll === 'function') {
        window.HistoryList.restoreAll();
      }
      return snapshot;
    },

    sendMirrorHead() {
      if (isRemoteMode) return; // Remote 模式不向本地 WebUI 服务器推送（避免双重镜像）
      try { if (typeof window.api?.webControlMirrorUpdate === 'function') window.api.webControlMirrorUpdate(this.buildMirrorHead()); } catch (e) {}
    },

    _bodySendTimer: null,
    // 分块传输阈值：超过此大小则拆分为多个 chunk 发送（保证完整性，避免单条 WS 消息过大）
    _chunkSize: 256 * 1024, // 256KB per chunk
    sendMirrorBody() {
      if (isRemoteMode) return; // Remote 模式不向本地 WebUI 服务器推送
      // 防抖 500ms：避免短时间多次全量 body 推送
      if (this._bodySendTimer) clearTimeout(this._bodySendTimer);
      this._bodySendTimer = setTimeout(() => {
        this._bodySendTimer = null;
        try {
          if (typeof window.api?.webControlMirrorUpdate !== 'function') return;
          const snapshot = this.buildMirrorBody();
          // 将快照序列化为 JSON 字符串后分块传输
          const json = JSON.stringify(snapshot);
          if (json.length <= this._chunkSize) {
            // 小包直接发送
            window.api.webControlMirrorUpdate(snapshot);
          } else {
            // 大包分块传输：mirror_body_start → mirror_body_chunk * N → mirror_body_end
            const totalChunks = Math.ceil(json.length / this._chunkSize);
            const transferId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            window.api.webControlMirrorUpdate({ type: 'mirror_body_start', transferId, totalChunks, size: json.length });
            for (let i = 0; i < totalChunks; i++) {
              const chunk = json.slice(i * this._chunkSize, (i + 1) * this._chunkSize);
              window.api.webControlMirrorUpdate({ type: 'mirror_body_chunk', transferId, index: i, chunk });
            }
            window.api.webControlMirrorUpdate({ type: 'mirror_body_end', transferId });
          }
        } catch (e) { console.error('[WebUIMirror] sendMirrorBody error:', e); }
      }, 500);
    },

    // ---- 增量事件推送 ----
    // 推送 DOM 增量事件到 WebUI。event 形如：
    //   { type:'dom_append', container:'#chat-messages', html:'<div>...</div>' }
    //   { type:'dom_clear',   container:'#chat-messages' }
    //   { type:'dom_replace', container:'#history-list', html:'...' }
    //   { type:'dom_remove',  selector:'#thinking-indicator' }
    //   { type:'dom_update',  selector:'#tool-xxx', html:'...' }（替换元素 outerHTML）
    //   { type:'dom_text',    selector:'#titlebar-title', text:'...' }
    // dom_replace 节流：同 container 在 200ms 内合并为最后一次（避免大 innerHTML 反复推送）
    _replaceTimers: {},
    pushDomEvent(event) {
      if (isRemoteMode) return; // Remote 模式不推送 DOM 事件
      // dom_replace 节流：同 container 合并
      if (event.type === 'dom_replace' && event.container) {
        const key = event.container;
        if (this._replaceTimers[key]) clearTimeout(this._replaceTimers[key]);
        this._replaceTimers[key] = setTimeout(() => {
          this._replaceTimers[key] = null;
          try { if (typeof window.api?.webControlMirrorUpdate === 'function') window.api.webControlMirrorUpdate(event); } catch (e) {}
        }, 200);
        return;
      }
      try { if (typeof window.api?.webControlMirrorUpdate === 'function') window.api.webControlMirrorUpdate(event); } catch (e) {}
    },

    handleUiEvent(data) {
      if (!data || !data.target) return;
      try {
        let el = document.querySelector(data.target);
        if (!el) {
          // 降级查找：去掉 class 部分（class 可能因动态状态如 active 而不匹配）
          // 保留 id、标签名、nth-of-type，重新查找
          const degraded = data.target.replace(/\.[^ .>#]+/g, '');
          if (degraded !== data.target) {
            el = document.querySelector(degraded);
          }
        }
        if (!el) {
          // 再降级：去掉 nth-of-type 和 class，只用标签名和 id
          const simple = data.target.replace(/\.[^ .>#]+/g, '').replace(/:nth-of-type\(\d+\)/g, '');
          if (simple !== data.target) {
            el = document.querySelector(simple);
          }
        }
        if (!el) {
          // 找不到元素：不再全量 resync（会销毁 WebUI 正在输入的文本框）
          // 增量事件已在各 UI 变更点推送，无需全量兜底
          console.warn('[WebUIMirror] Element not found, skip:', data.target);
          return;
        }
        this._applyingRemote = true;
        switch (data.event) {
          case 'click':
            el.click();
            break;
          case 'input':
            if (data.value !== undefined && el.value !== undefined) {
              el.value = data.value;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          case 'change':
            if (data.value !== undefined && el.value !== undefined) {
              el.value = data.value;
            }
            if (data.checked !== undefined && 'checked' in el) {
              el.checked = data.checked;
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          case 'submit':
            el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            break;
        }
        // 不再推送全量 body 兜底：增量 pushDomEvent 已在各 UI 变更点推送，
        // 全量 body 会销毁 WebUI 用户正在输入的文本框
      } catch (e) {
        console.error('[WebUIMirror] UI event dispatch error:', e);
      } finally {
        setTimeout(() => { this._applyingRemote = false; }, 20);
      }
    },

    _resyncTimer: null,
    _scheduleResync(delay = 200) {
      // 保留方法供显式调用（如 mode 切换等重大状态变更），但 handleUiEvent 不再自动触发
      if (this._resyncTimer) clearTimeout(this._resyncTimer);
      this._resyncTimer = setTimeout(() => {
        this._resyncTimer = null;
        this.sendMirrorBody();
      }, delay);
    },
  };
  WebUIMirror.init();

  // 初始化虚拟滚动器（聊天记录动态渲染，离屏消息不渲染 markdown）
  if (typeof VirtualScroller !== 'undefined' && chatMessages) {
    VirtualScroller.attach(chatMessages);
    // Code/Babe 消息容器未接入主虚拟滚动：挂载轻量懒渲染，
    // 长会话下自动折叠离屏消息的渲染内容，防止 DOM 无界增长
    const codeMsgsEl = document.getElementById('code-chat-messages');
    if (codeMsgsEl) {
      VirtualScroller.attachLazyContainer(codeMsgsEl, { selector: '.message', contentSel: '.message-content' });
    }
    const babeMsgsEl = document.getElementById('babe-chat-messages');
    if (babeMsgsEl) {
      VirtualScroller.attachLazyContainer(babeMsgsEl, { selector: '.babe-message', contentSel: '.babe-msg-bubble' });
    }
  }

  // 推送容器选择器：根据 currentMode 返回对应消息容器的选择器
  function getChatContainerSelector() {
    if (currentMode === 'code') return '#code-chat-messages';
    if (currentMode === 'babe') return '#babe-chat-messages';
    return '#chat-messages';
  }

  // 统一的聊天容器清空 + 增量推送
  function clearChatMessagesUI() {
    chatMessages.innerHTML = '';
    // 清理子代理卡片记录：DOM 已随 innerHTML 清空，同步释放 Map 引用与计时器
    // （否则下次"新对话"后旧子代理卡片引用仍驻留在 _subAgentCards 中）
    if (typeof _subAgentCards !== 'undefined' && _subAgentCards) {
      for (const rec of _subAgentCards.values()) {
        if (rec.timer) clearInterval(rec.timer);
      }
      _subAgentCards.clear();
    }
    // 清空虚拟滚动观察状态：彻底释放旧会话的消息节点、占位 div 与
    // dataset 中缓存的原始内容引用，避免每次"新对话"线性累积内存
    if (typeof VirtualScroller !== 'undefined' && VirtualScroller.reset) VirtualScroller.reset();
    // 递增回放 generation：取消任何进行中的异步历史回放，
    // 防止新会话消息与旧会话残留交错
    window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1;
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: getChatContainerSelector() });
    // 同步移除思考指示器（若存在）
    WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
  }

  function setTitlebarTitle(title) {
    const titleEl = document.getElementById('titlebar-title');
    if (titleEl) titleEl.textContent = title || '未命名对话';
    // 增量推送：更新标题文本
    WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#titlebar-title', text: title || '未命名对话' });
  }

  // Attachment state
  let currentAttachments = [];

  // ---- Window Controls ----
  // macOS 使用系统红绿灯按钮，隐藏自定义窗口控制按钮
  const isMac = window.api.platform === 'darwin';
  const titlebarEl = document.getElementById('titlebar');
  if (isMac) {
    titlebarEl?.classList.add('platform-darwin');
    document.getElementById('btn-minimize')?.classList.add('hidden');
    document.getElementById('btn-maximize')?.classList.add('hidden');
    document.getElementById('btn-close')?.classList.add('hidden');
  } else {
    document.getElementById('btn-minimize')?.addEventListener('click', () => window.api.windowMinimize());
    document.getElementById('btn-maximize')?.addEventListener('click', () => window.api.windowMaximize());
    document.getElementById('btn-close')?.addEventListener('click', () => window.api.windowClose());
  }

  // ---- Title Editing ----
  const titlebarTitle = document.getElementById('titlebar-title');
  const titlebarEdit = document.getElementById('titlebar-title-edit');

  titlebarTitle?.addEventListener('click', () => {
    titlebarTitle.classList.add('hidden');
    titlebarEdit.classList.remove('hidden');
    titlebarEdit.value = agent.conversationTitle || '未命名对话';
    titlebarEdit.focus();
    titlebarEdit.select();
  });

  titlebarEdit?.addEventListener('blur', async () => {
    const newTitle = titlebarEdit.value.trim() || '未命名对话';
    agent.conversationTitle = newTitle;
    setTitlebarTitle(newTitle);
    titlebarEdit.classList.add('hidden');
    titlebarTitle.classList.remove('hidden');
    // Save to history if conversation exists
    if (agent.conversationId) {
      await window.api.historyRename(agent.conversationId, newTitle);
    }
  });

  titlebarEdit?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      titlebarEdit.blur();
    } else if (e.key === 'Escape') {
      titlebarEdit.classList.add('hidden');
      titlebarTitle.classList.remove('hidden');
    }
  });

  // ---- Markdown Renderer with Math Support ----
  // Handle external links - open in system browser
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-external]');
    if (link) {
      e.preventDefault();
      const url = link.getAttribute('href');
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        window.api.openBrowser(url);
      }
    }
  });

  // ---- Page Navigation ----
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const page = document.getElementById(`page-${btn.dataset.page}`);
      if (page) page.classList.add('active');

      // 推送 nav-item active 状态变化到 WebUI（用 data-page 属性选择器，兼容无 id 的 nav-item）
      document.querySelectorAll('.nav-item[data-page]').forEach(b => {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: `.nav-item[data-page="${b.dataset.page}"]`, attr: 'class', value: b.className });
      });
      // 推送所有 page 的 active 状态变化到 WebUI（必须推送全部，否则旧页面 active 不会被移除）
      document.querySelectorAll('.page').forEach(p => {
        if (p.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + p.id, attr: 'class', value: p.className });
      });

      // Load page data
      // 异步加载后推送整个 page 内容到 WebUI/Remote（懒加载页面内容初始 mirror_body 不包含）
      // 注意：input/textarea 的 .value 是 JS property，innerHTML 序列化只含 attribute，
      // 故推送前需将表单值同步到 attribute，否则远端设置页等表单值为空。
      const pushPageAfterLoad = async (loader) => {
        try { await loader(); } catch (_) {}
        // 同步表单元素 value/checked 到 attribute，确保 innerHTML 序列化包含当前值
        page.querySelectorAll('input, textarea, select').forEach(el => {
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (el.checked) el.setAttribute('checked', 'checked');
            else el.removeAttribute('checked');
          } else {
            el.setAttribute('value', el.value);
          }
        });
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-' + btn.dataset.page, html: page.innerHTML });
      };
      if (btn.dataset.page === 'tools') {
        // 进入工具页时按当前模式自动定位到对应选项卡
        codeEditorModeFilter = currentMode || 'chat';
        pushPageAfterLoad(loadToolsPage);
        // Wire up mode switcher buttons (Chat/Code) — only once
        if (!document.getElementById('tools-mode-switcher').dataset.wired) {
          document.getElementById('tools-mode-switcher').dataset.wired = '1';
          document.querySelectorAll('.tools-mode-btn').forEach(mb => {
            mb.addEventListener('click', () => {
              codeEditorModeFilter = mb.dataset.toolMode;
              loadToolsPage();
              // 推送工具页内容到 WebUI/Remote
              WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-tools', html: document.getElementById('page-tools').innerHTML });
            });
          });
        }
      }
      if (btn.dataset.page === 'skills') pushPageAfterLoad(loadSkillsPage);
      if (btn.dataset.page === 'knowledge') pushPageAfterLoad(() => loadKnowledgePage());
      if (btn.dataset.page === 'memory') pushPageAfterLoad(() => loadMemoryPage());
      if (btn.dataset.page === 'settings') pushPageAfterLoad(loadSettingsPage);
      if (btn.dataset.page === 'history') pushPageAfterLoad(loadHistoryPage);
      if (btn.dataset.page === 'code') {
        // 对齐 Babe（进入页面即 initBabeAgent）：首次进入 Code 页面时
        // 自动创建第一个会话标签，避免标签栏长时间只剩"+"按钮。
        pushPageAfterLoad(async () => {
          await loadCodePage();
          if (typeof ensureCodeFirstSession === 'function') {
            await ensureCodeFirstSession();
          }
        });
      }
      if (btn.dataset.page === 'code-history') pushPageAfterLoad(loadCodeHistoryPage);
      if (btn.dataset.page === 'babe') pushPageAfterLoad(() => initBabeAgent());
      if (btn.dataset.page === 'babe-history') pushPageAfterLoad(loadBabeHistoryPage);
      // i18n: re-apply translations to the newly activated page (after dynamic content loads)
      if (typeof i18nApplyToDOM === 'function') {
        setTimeout(() => i18nApplyToDOM(page), 100);
      }
    });
  });

  // ---- Mode Switcher (Chat / Code / Babe) ----
  let currentMode = 'chat';
  let sessionManager = null;
  window.getCurrentMode = () => currentMode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      // Remote 模式：仅切换远端模式，不在本地导航/启动 Agent，也不回推到本地 WebUI
      if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = mode;
        remoteWs.send(JSON.stringify({ type: 'switchMode', mode }));
        return;
      }
      // 切换 Chat/Code/Babe 会话：只停止语音播放，不再掐掉上一个模式的推理。
      // 上一个模式继续在后台运行，sessionManager 负责状态和历史刷新。
      stopVoicePlayback();
      if (sessionManager) {
        const prevSession = sessionManager.getActive(currentMode);
        if (prevSession) sessionManager.deactivate(prevSession);
      }

      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = mode;
      if (typeof showSessionTabsForMode === 'function') showSessionTabsForMode(mode);
      if (mode === 'chat') {
        // Show chat sidebar items, hide code/babe ones
        document.querySelector('.nav-item[data-page="chat"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="history"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="code"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code-history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe-history"]')?.classList.add('hidden');
        // Switch to chat page
        document.querySelector('.nav-item[data-page="chat"]')?.click();
        if (typeof renderSessionTabs === 'function') renderSessionTabs('chat');
        if (sessionManager) {
          const target = resolveModeTarget('chat');
          if (target) activateSession('chat', target.key);
        }
      } else if (mode === 'code') {
        // Code mode: show code sidebar items, hide chat/babe ones
        document.querySelector('.nav-item[data-page="chat"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="code-history"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="babe"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe-history"]')?.classList.add('hidden');
        // Switch to code page
        document.querySelector('.nav-item[data-page="code"]')?.click();
        if (typeof renderSessionTabs === 'function') renderSessionTabs('code');
        if (sessionManager) {
          const target = resolveModeTarget('code');
          if (target) activateSession('code', target.key);
        }
      } else if (mode === 'babe') {
        // Babe mode: show babe sidebar items, hide chat/code ones
        document.querySelector('.nav-item[data-page="chat"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code-history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="babe-history"]')?.classList.remove('hidden');
        // Switch to babe page
        document.querySelector('.nav-item[data-page="babe"]')?.click();
        // 启动 Babe Agent（如果尚未启动）
        initBabeAgent();
        if (typeof renderSessionTabs === 'function') renderSessionTabs('babe');
        if (sessionManager) {
          const target = resolveModeTarget('babe');
          if (target) activateSession('babe', target.key);
        }
      }
      // 切换模式后同步标题栏为目标模式当前对话标题（无则显示"未命名对话"）
      let modeTitle = '';
      if (mode === 'chat') modeTitle = agent?.conversationTitle || '';
      else if (mode === 'code') modeTitle = codeAgent?.conversationTitle || '';
      else if (mode === 'babe') modeTitle = babeAgent?.conversationTitle || '';
      setTitlebarTitle(modeTitle);
      // 同步模式切换到 WebUI（增量更新：modeSwitch 消息包含模式信息，WebUI 端 applyModeSwitch 处理 nav-item 显隐）
      try { window.api.webControlPushModeSwitch(mode); } catch (_) {}
      // 不再推送全量 body：nav-item 显隐由 WebUI 端 applyModeSwitch 处理
      // 各模式的消息变更已有 pushDomEvent 增量推送
    });
  });
  // WebUI → 渲染器：模式切换
  window.api?.onWebControlSwitchMode?.((mode) => {
    if (mode === currentMode) return;
    const btn = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
    if (btn) btn.click();
  });
  // WebUI → 渲染器：重新优化工具
  window.api?.onWebControlReoptimizeTools?.(() => {
    if (btnReoptimizeTools && !btnReoptimizeTools.classList.contains('hidden')) {
      btnReoptimizeTools.click();
    }
  });
  // Initialize: hide code/babe-mode nav items
  document.querySelector('.nav-item[data-page="code"]')?.classList.add('hidden');
  document.querySelector('.nav-item[data-page="code-history"]')?.classList.add('hidden');
  document.querySelector('.nav-item[data-page="babe"]')?.classList.add('hidden');
  document.querySelector('.nav-item[data-page="babe-history"]')?.classList.add('hidden');

  // ---- Agent Callbacks ----
  function wireChatAgent(ag) {
    const isActive = () => {
      const session = sessionManager?.getByAgent(ag);
      return !session || session.active;
    };

    ag.onMessage = (type, data) => {
    switch (type) {
      case 'tarot':
        if (data) {
          // 后端逻辑：始终推送 tarot 到 WebUI（保持子代理/对话上下文一致）
          window.api.webControlPushTarot(data);
          // UI 可见性：关闭时跳过所有前端渲染（agent-tarot 已被 hidden 隐藏）
          if (!isActive()) {
            const session = sessionManager?.getByAgent(ag);
            if (sessionManager && session) sessionManager.bufferUiEvent(session, { type: 'tarot', data });
            break;
          }
          if (!tarotVisible || !agentTarot) break;
          const iconHtml = data.icon ? `<i class="fa-solid ${data.icon}"></i>` : '<i class="fa-solid fa-star"></i>';
          const _lang = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
          const _isZh = (_lang === 'zh-CN');
          const position = data.isReversed ? (_isZh ? '逆位' : 'Reversed') : (_isZh ? '正位' : 'Upright');
          const _cardName = _isZh ? data.name : (data.nameEn || data.name);
          const meaning = data.isReversed ? data.meaningOfReversed : data.meaningOfUpright;
          const eSource = data.entropySource || 'CSPRNG';
          const isTRNG = eSource.startsWith('TRNG');
          const trngBadge = isTRNG ? '<span class="trng-badge" style="margin-left:6px;font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';
          agentTarot.innerHTML = `${iconHtml}<span>${_isZh ? '命运之牌：' : 'Tarot: '}${_cardName}(${position})</span>${trngBadge}`;
          agentTarot.title = `${_cardName}(${position}) - ${meaning || ''} [${eSource}]`;
          // Add system message for tarot card
          const entropyNote = isTRNG ? (_isZh ? ' [TRNG 硬件真随机]' : ' [TRNG Hardware Random]') : '';
          addSystemMessage(`${_isZh ? '抽取了命运之牌：' : 'Drew Tarot: '}${_cardName}(${position})${_isZh ? '（' : ' ('}${data.nameEn}${_isZh ? '）' : ')'}${entropyNote}\n${meaning || ''}`);
        }
        break;
      case 'assistant':
        if (!isActive()) break;
        addMessageToChat('assistant', data);
        window.api.webControlPushMessage('assistant', data);
        break;
      case 'stream-start':
        if (!isActive()) break;
        // Create a placeholder bubble for streaming tokens
        startStreamingMessage(data?.requestId);
        break;
      case 'stream-chunk':
        if (!isActive()) break;
        appendStreamChunk(data?.requestId, data);
        break;
      case 'stream-end':
        if (!isActive()) break;
        finalizeStreamMessage(data?.requestId, data);
        break;
      case 'error':
        if (!isActive()) break;
        // 错误消息已被 agent.js 持久化到 contextManager，这里只负责 UI 显示
        addSystemMessage(`[错误] ${data}`, { persist: false });
        window.api.webControlPushMessage('system', `[错误] ${data}`);
        break;
      case 'optimize-tools-start':
        if (!isActive()) break;
        addThinkingIndicatorWithText('正在优化工具选择...');
        break;
      case 'optimize-tools-end':
        if (!isActive()) break;
        if (ag.running) {
          addThinkingIndicator();
        } else {
          removeThinkingIndicator();
        }
        updateReoptimizeButtonVisibility();
        if (document.getElementById('page-tools')?.classList.contains('active')) {
          loadToolsPage();
        }
        break;
      case 'approval':
        if (!isActive()) break;
        showApprovalPanel(data.toolName, data.args);
        window.api.webControlPushApproval(data.toolName, data.args);
        break;
      case 'tool-auth-required':
        if (!isActive()) break;
        showToolAuthModal(data.toolName, data.category, ag);
        break;
      case 'sub-agent-start': {
        if (!isActive()) break;
        const tarotPart = tarotVisible && data.tarot
          ? ` - 命运之牌: ${data.tarot.name}${data.tarot.isReversed ? '(逆位)' : '(正位)'}${data.tarot?.entropySource?.startsWith('TRNG') ? ' [TRNG]' : ''}`
          : '';
        addSubAgentCard({
          id: data.id,
          title: `子代理启动${tarotPart}`,
          task: data.task,
          startTime: data.startTime,
          status: 'running'
        });
        break;
      }
      case 'sub-agent-done':
        if (!isActive()) break;
        updateSubAgentCard(data.id, {
          status: 'done',
          result: data.result,
          duration: data.duration,
          usage: data.usage,
          toolUseCount: data.toolUseCount,
          iterations: data.iterations
        });
        break;
      case 'sub-agent-message':
        if (!isActive()) break;
        // 子代理中间消息：不显示在聊天页面，而是保存在子代理记录中
        // 用户可点击子代理卡片查看完整对话记录（参考 claude-code-ref 的隔离设计）
        // 消息已通过 agent.subAgents[].messages 自动累积，模态框打开时从 agent.getSubAgent(id) 读取
        // 如果详情模态框正打开且就是该子代理，触发立即刷新
        if (_openSubAgentModalId === data.id && typeof _subAgentModalRender === 'function') {
          requestAnimationFrame(() => {
            if (_openSubAgentModalId === data.id) _subAgentModalRender();
          });
        }
        break;
      case 'sub-agent-batch-start':
        // 不在主聊天显示批次横幅，也不写入主上下文（子代理有独立卡片，避免污染主聊天历史）
        break;
      case 'sub-agent-batch-done':
        break;
      case 'present-file':
        if (!isActive()) {
          const session = sessionManager?.getByAgent(ag);
          if (sessionManager && session) sessionManager.bufferUiEvent(session, { type: 'present-file', data });
          // 系统通知：文件呈递（后台会话也要提醒）
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
          break;
        }
        addFilePresentCard(data);
        // 系统通知：文件呈递
        sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
        break;
    }
    if (isActive()) updateContextProgress();
  };

  ag.onTitleChange = (title) => {
    if (isActive()) setTitlebarTitle(title);
    if (isActive()) window.api.webControlPushTitle(title);
  };

  ag.onStatusChange = (status) => {
    if (!isActive()) {
      // 后台会话状态由 SessionManager 负责；只刷新全局会话 tab。
      if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
      return;
    }
    if (status === 'working') {
      agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 工作中... <span id="work-duration" style="margin-left:6px;font-variant-numeric:tabular-nums">00:00</span>';
      agentStatus.className = 'agent-status working';
      if (btnStop) btnStop.classList.remove('hidden');
      // 热对话：工作时发送按钮保持可见
      // 启动工作时长计时器
      if (window._workTimer) { clearInterval(window._workTimer); }
      window._workStartTime = Date.now();
      const durEl = document.getElementById('work-duration');
      const updateDur = () => {
        const el = document.getElementById('work-duration');
        if (!el || !window._workStartTime) return;
        const sec = Math.floor((Date.now() - window._workStartTime) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        el.textContent = `${mm}:${ss}`;
      };
      updateDur();
      window._workTimer = setInterval(updateDur, 1000);
    } else {
      agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 待命中';
      agentStatus.className = 'agent-status';
      // 仅当 Agent 完成 且 语音播报也完成时才隐藏停止按钮
      refreshChatStopButton();
      btnSend.classList.remove('hidden');
      removeThinkingIndicator(); // 防御：确保待命时思考提示已清除
      // 停止计时器
      const wasWorking = window._workStartTime !== null;
      if (window._workTimer) { clearInterval(window._workTimer); window._workTimer = null; window._workStartTime = null; }
      // Agent 工作完成：隐藏 Playwright 横幅（不关闭浏览器，仅隐藏屏幕右上角提示）
      if (wasWorking && window.api?.pwHideBanner) {
        try { window.api.pwHideBanner(); } catch {}
      }
    }
    // 推送状态变化到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#agent-status', html: agentStatus.outerHTML });
    if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-stop', attr: 'class', value: btnStop.className });
    if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-send', attr: 'class', value: btnSend.className });
    window.api.webControlPushStatus(status);
  };

  ag.onToolCall = (name, args, status, result, callId) => {
    if (!isActive()) {
      const session = sessionManager?.getByAgent(ag);
      if (sessionManager && session && status === 'done' && name === 'getTarot' && result?.ok && result?.result?.spread) {
        sessionManager.bufferUiEvent(session, { type: 'tarot-spread', result: result.result });
      }
      return;
    }
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
    const displayName = toolDef?.desc || name;

    if (status === 'calling') {
      addToolCallToChat(displayName, name, args, callId);
    } else if (status === 'done') {
      updateToolCallResult(name, result, false, callId);
      updateContextProgress();
      // If generateImage returned a URL/base64, display image directly
      if (name === 'generateImage' && result?.ok && result?.url) {
        addImageMessage(result.url);
      }
      // If getTarot returned a multi-card spread, display visual cards
      if (name === 'getTarot' && result?.ok && result?.result?.spread) {
        addTarotSpreadToChat(result.result);
      }
    } else if (status === 'denied') {
      updateToolCallResult(name, { ok: false, error: '用户拒绝了操作' }, true, callId);
      updateContextProgress();
    }
    window.api.webControlPushToolCall(name, args, status, typeof result === 'string' ? result : JSON.stringify(result || ''));
  };

  ag.onTodoUpdate = (items) => {
    if (!isActive()) return;
    renderTodoList(items);
  };
  }

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
  AppBus.on('session-status', (event) => {
    const { session, status, previous } = event.detail || {};
    if (!session) return;
    if (status === SessionStatus.DONE && previous === SessionStatus.RUNNING) {
      const title = session.title || '当前会话';
      sendAppNotification('sessionDone', '会话已完成', `${session.modeLabel || title} - 工作已完成`, !session.active, { sessionKey: session.key, mode: session.mode });
    } else if (status === SessionStatus.ERROR && previous === SessionStatus.RUNNING) {
      sendAppNotification('sessionError', '会话执行失败', `${session.title || '会话'} - ${session.lastError || '未知错误'}`, !session.active, { sessionKey: session.key, mode: session.mode });
    } else if (status === SessionStatus.WAITING_APPROVAL) {
      sendAppNotification('approval', '会话等待审批', `${session.title || '会话'} - 需要您的批准`, !session.active, { sessionKey: session.key, mode: session.mode });
    }
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
    if (status === SessionStatus.DONE || status === SessionStatus.ERROR || status === SessionStatus.IDLE) {
      sessionManager.processQueue();
    }
  });
  AppBus.on('session-dequeued', (event) => {
    const { session, message } = event.detail || {};
    if (!session || !message) return;
    const ag = session.agent;
    if (!ag) return;
    if (session.mode === 'chat') {
      ag.sendMessage(message.text, message.attachments || []).catch(err => {
        if (ag.onMessage) ag.onMessage('error', err?.message || String(err));
      });
    } else if (session.mode === 'code') {
      ag.sendMessage(message.text, message.attachments || []).catch(() => {});
    } else if (session.mode === 'babe') {
      ag.sendMessage(message.text, message.attachments || []).catch(() => {});
    }
  });
  AppBus.on('session-title', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-created', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-deactivated', (event) => {
    const { session } = event.detail || {};
    if (session) {
      try { retractSessionUiRoot(session); } catch { /* ignore */ }
      // 保存当前输入框草稿到被切走的会话
      const input = session.mode === 'code'
        ? document.getElementById('code-chat-input')
        : session.mode === 'babe'
          ? document.getElementById('babe-chat-input')
          : chatInput;
      if (input) session.draft = input.value || '';
    }
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-closed', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-attention', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
    refreshActiveHistoryPage();
  });
  let historyRefreshTimer = null;
  const refreshActiveHistoryPage = () => {
    if (historyRefreshTimer) return;
    historyRefreshTimer = setTimeout(() => {
      historyRefreshTimer = null;
      const active = document.querySelector('.page.active');
      if (!active) return;
      if (active.id === 'page-history') loadHistoryPage();
      else if (active.id === 'page-code-history') loadCodeHistoryPage();
      else if (active.id === 'page-babe-history') loadBabeHistoryPage();
    }, 400);
  };
  ['session-status', 'session-title', 'session-usage', 'session-created', 'session-closed'].forEach(eventName => {
    AppBus.on(eventName, refreshActiveHistoryPage);
  });
  if (typeof window.api.onUsageChanged === 'function') {
    window.api.onUsageChanged((data) => {
      if (!data) return;
      const usageEl = document.getElementById('setting-llm-usage');
      if (usageEl) usageEl.textContent = fmtTokenCount(data.dailyTokensUsed || 0);
      try { refreshBudgetMiniBars(); } catch { /* ignore */ }
      try { refreshSessionCostMini(); } catch { /* ignore */ }
      const activeTab = document.querySelector('.settings-tab-btn.active');
      if (activeTab && activeTab.dataset.tab === 'usage') {
        try { loadUsageStats(document.querySelector('.usage-period-btn.active')?.dataset.period || 'daily'); } catch { /* ignore */ }
      }
    });
  }
  if (typeof window.api.onNotificationClick === 'function') {
    window.api.onNotificationClick((data) => {
      if (!data || !data.sessionKey || !sessionManager) return;
      const session = sessionManager.get(data.sessionKey);
      if (!session) return;
      if (data.mode && data.mode !== currentMode) {
        const modeBtn = document.querySelector(`.mode-btn[data-mode="${data.mode}"]`);
        if (modeBtn) modeBtn.click();
      }
      activateSession(session.mode, session.key);
    });
  }

  function renderSessionTabs(mode) {
    if (!sessionManager) return;
    const tabsEl = document.getElementById(`${mode}-session-tabs`);
    if (!tabsEl) return;
    const sessions = sessionManager.ordered(mode);
    // 标签栏常驻：即使没有会话也只显示“新建会话”按钮；
    // 可见性统一由 showSessionTabsForMode 控制（宿主在 page section 之外）。
    tabsEl.innerHTML = '';
    const active = sessionManager.getActive(mode);
    for (const session of sessions) {
      const attentionMeta = (typeof sessionAttentionMeta === 'function') ? sessionAttentionMeta(session.attention) : null;
      const dotClass = attentionMeta
        ? `attention ${attentionMeta.cls}`
        : escapeHtml(session.status);
      const dotTitle = attentionMeta ? attentionMeta.label : '';
      const attentionBadge = attentionMeta
        ? `<span class="session-attention-badge ${attentionMeta.cls}"><i class="fa-solid ${attentionMeta.icon}"></i>${escapeHtml(attentionMeta.label.replace('等待', ''))}</span>`
        : '';
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (active?.key === session.key ? ' active' : '');
      tab.dataset.sessionKey = session.key;
      tab.draggable = true;
      tab.title = session.title || '未命名会话';
      tab.innerHTML = `
        <span class="session-status-dot ${dotClass}" ${dotTitle ? `title="${escapeHtml(dotTitle)}"` : ''}></span>
        <span class="session-tab-title">${escapeHtml(session.title || '未命名会话')}</span>
        ${attentionBadge}
        <span class="session-tab-close" title="关闭会话"><i class="fa-solid fa-xmark"></i></span>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.session-tab-close')) return;
        activateSession(mode, session.key);
      });
      tab.addEventListener('mouseenter', () => {
        if (tab.classList.contains('dragging')) return;
        showSessionTabPopover(session, tab);
      });
      tab.addEventListener('mouseleave', () => {
        hideSessionTabPopover();
      });
      tab.addEventListener('contextmenu', (e) => {
        hideSessionTabPopover();
        showSessionTabContextMenu(e, mode, session);
      });
      // ---- 拖动排序 ----
      tab.addEventListener('dragstart', (e) => {
        hideSessionTabPopover();
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', session.key); } catch { /* ignore */ }
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        clearSessionDragIndicators(tabsEl);
      });
      const closeBtn = tab.querySelector('.session-tab-close');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSessionBatch(session.mode, new Set([session.key]));
      });
      tabsEl.appendChild(tab);
    }
    // ---- 栏级拖放目标 ----
    tabsEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types || !Array.from(e.dataTransfer.types).includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetTab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
      clearSessionDragIndicators(tabsEl);
      if (targetTab) {
        const rect = targetTab.getBoundingClientRect();
        targetTab.classList.add(e.clientX > rect.left + rect.width / 2 ? 'drop-target-after' : 'drop-target-before');
      }
    });
    tabsEl.addEventListener('dragleave', (e) => {
      if (!tabsEl.contains(e.relatedTarget)) clearSessionDragIndicators(tabsEl);
    });
    tabsEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const key = e.dataTransfer ? (e.dataTransfer.getData('text/plain') || '') : '';
      clearSessionDragIndicators(tabsEl);
      if (!key || !sessionManager.get(key)) return;
      const tabEls = Array.from(tabsEl.querySelectorAll('.session-tab'));
      let index = tabEls.length;
      const targetTab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
      if (targetTab) {
        const rect = targetTab.getBoundingClientRect();
        index = tabEls.indexOf(targetTab) + (e.clientX > rect.left + rect.width / 2 ? 1 : 0);
      }
      try { sessionManager.reorder(mode, key, index); } catch { /* ignore */ }
      renderAllSessionTabs();
    });
    const add = document.createElement('button');
    add.className = 'session-tab-add';
    add.title = '新建会话';
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    add.addEventListener('click', () => createNewSession(mode));
    tabsEl.appendChild(add);
    // 多会话镜像：标签栏内容变更增量推送到 WebUI，保持远端标签栏实时一致
    if (!isRemoteMode) {
      try {
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#' + tabsEl.id, html: tabsEl.innerHTML });
      } catch { /* ignore */ }
    }
  }

  function renderAllSessionTabs() {
    renderSessionTabs('chat');
    renderSessionTabs('code');
    renderSessionTabs('babe');
  }

  function clearSessionDragIndicators(tabsEl) {
    if (!tabsEl) return;
    tabsEl.querySelectorAll('.drop-target-before, .drop-target-after, .dragging').forEach(el => {
      el.classList.remove('drop-target-before', 'drop-target-after');
    });
  }

  // ---- 会话标签悬停预览 ----
  let _stpSessionKey = null;
  let _stpTimer = null;

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function workspaceInfo(session) {
    const ws = (session && session.agent && (session.agent.codeWorkspacePath || session.agent.workspacePath)) || '';
    if (!ws) return { name: '未选择', full: '' };
    const parts = String(ws).split(/[\\/]/).filter(Boolean);
    return { name: parts[parts.length - 1] || ws, full: ws };
  }

  function computeContextStats(ag) {
    const cm = ag && ag.contextManager;
    if (!cm) return null;
    const stats = (typeof cm.getStats === 'function') ? cm.getStats() : null;
    const estimateMsg = (m) => (typeof cm.estimateMessageTokens === 'function' ? cm.estimateMessageTokens(m) : 0);
    const estimateText = (t) => (typeof cm.estimateTokens === 'function' ? cm.estimateTokens(t) : 0);
    const sys = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
    let tools = 0;
    try {
      const schemas = (typeof ag.getRuntimeToolSchemas === 'function') ? ag.getRuntimeToolSchemas() : [];
      tools = Math.ceil(JSON.stringify(schemas).length / 4);
    } catch { /* ignore */ }
    let chat = 0;
    let tool = 0;
    (cm.messages || []).forEach((m) => {
      if (!m) return;
      if (m.role === 'tool') tool += estimateMsg(m);
      else if (m.role === 'user' || m.role === 'assistant') chat += estimateMsg(m);
    });
    const summaries = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
    const used = sys + tools + chat + tool + summaries;
    const max = (stats && stats.maxTokens) || (ag.settings && ag.settings.llm && ag.settings.llm.maxContextLength) || 0;
    const reserve = (ag.settings && ag.settings.llm && ag.settings.llm.maxResponseTokens) || 8192;
    const totalOcc = used + reserve;
    const pct = max ? Math.min(100, (totalOcc / max) * 100) : 0;
    return { sys, tools, chat, tool, summaries, used, max, reserve, totalOcc, pct, usage: { ...(ag.sessionUsage || {}) } };
  }

  function renderPopoverContext(stats) {
    if (!stats) return '该会话上下文尚未初始化';
    const fmt = (n) => (typeof fmtTokenCount === 'function' ? fmtTokenCount(n) : String(n));
    const level = stats.pct >= 85 ? 'danger' : stats.pct >= 65 ? 'warn' : '';
    const rows = [
      ['系统指导 + 工具定义', fmt(stats.sys + stats.tools)],
      ['对话消息', fmt(stats.chat)],
      ['工具结果', fmt(stats.tool)],
      ['摘要', fmt(stats.summaries)],
      ['输入占用', fmt(stats.used)],
      ['输出预留', fmt(stats.reserve)],
      ['本会话累计 Token', fmt(stats.usage.total || 0)]
    ];
    return rows.map(([label, value]) => `<div class="stp-ctx-row"><span>${escapeHtml(label)}</span><b>${value}</b></div>`).join('')
      + `<div class="stp-ctx-bar"><div class="stp-ctx-bar-fill ${level}" style="width:${Math.max(0, Math.min(100, stats.pct)).toFixed(1)}%"></div></div>`
      + `<div class="stp-ctx-total"><span>${escapeHtml('合计 / 窗口')}</span><span>${fmt(stats.totalOcc)} / ${fmt(stats.max)} (${Math.round(stats.pct)}%)</span></div>`;
  }

  function showSessionTabPopover(session, tab) {
    const pop = document.getElementById('session-tab-popover');
    if (!pop || !session || !tab) return;
    _stpSessionKey = session.key;
    const stpTitle = document.getElementById('stp-title');
    const stpStatus = document.getElementById('stp-status');
    const stpElapsed = document.getElementById('stp-elapsed');
    const stpWorkspace = document.getElementById('stp-workspace');
    const stpContext = document.getElementById('stp-context');
    if (!stpTitle || !stpStatus || !stpElapsed || !stpWorkspace || !stpContext) return;

    const update = () => {
      if (_stpSessionKey !== session.key) return;
      const cur = sessionManager.get(session.key);
      if (!cur) { hideSessionTabPopover(); return; }
      stpTitle.textContent = cur.title || '未命名会话';
      const attMeta = (typeof sessionAttentionMeta === 'function') ? sessionAttentionMeta(cur.attention) : null;
      stpStatus.textContent = attMeta ? attMeta.label : (typeof sessionStatusLabel === 'function' ? sessionStatusLabel(cur.status) : String(cur.status || '空闲'));
      const running = cur.status === 'running' || cur.status === 'queued' || cur.status === 'waiting_approval' || cur.status === 'waiting_tool_auth' || (cur.agent && cur.agent.running);
      stpElapsed.textContent = cur.startedAt ? fmtDuration(Date.now() - cur.startedAt) : (running ? '进行中' : '未开始');
      const ws = workspaceInfo(cur);
      stpWorkspace.textContent = ws.name;
      stpWorkspace.title = ws.full || '';
      stpContext.innerHTML = renderPopoverContext(computeContextStats(cur.agent));
    };
    update();

    const rect = tab.getBoundingClientRect();
    pop.classList.remove('hidden');
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
    let top = rect.bottom + 6;
    if (top + popH > window.innerHeight - 8) top = Math.max(8, rect.top - popH - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    if (_stpTimer) clearInterval(_stpTimer);
    _stpTimer = setInterval(update, 1000);
  }

  function hideSessionTabPopover() {
    _stpSessionKey = null;
    if (_stpTimer) { clearInterval(_stpTimer); _stpTimer = null; }
    const pop = document.getElementById('session-tab-popover');
    if (pop) pop.classList.add('hidden');
  }

  // 切换模式时优先恢复该模式最后访问的会话；不存在/已关闭时回退到第一个标签
  function resolveModeTarget(mode) {
    try {
      const active = sessionManager.getActive(mode);
      if (active) return active;
      const lastKey = sessionManager.getLastActive(mode);
      if (lastKey) {
        const last = sessionManager.get(lastKey);
        if (last) return last;
      }
      return sessionManager.ordered(mode)[0] || null;
    } catch {
      return (sessionManager && sessionManager.ordered(mode)[0]) || null;
    }
  }

  // 只显示当前模式对应的标签栏（宿主常驻，其余模式隐藏）
  function showSessionTabsForMode(mode) {
    const host = document.getElementById('session-tabs-host');
    if (host) host.classList.remove('hidden');
    for (const m of ['chat', 'code', 'babe']) {
      const el = document.getElementById(`${m}-session-tabs`);
      if (!el) continue;
      el.classList.remove('hidden');
      const want = m === mode ? 'flex' : 'none';
      if (el.style.getPropertyValue('display') !== want) {
        el.style.setProperty('display', want, 'important');
        if (!isRemoteMode) {
          try {
            WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + el.id, attr: 'style', value: el.style.cssText });
          } catch { /* ignore */ }
        }
      }
    }
  }

  // ---- 会话交互卡片（问卷/游戏邀请等）跨切换保留 ----
  function sessionContainerEl(session) {
    if (!session) return null;
    if (session.mode === 'code') return document.getElementById('code-chat-messages');
    if (session.mode === 'babe') return document.getElementById('babe-chat-messages');
    return chatMessages;
  }

  // 会话激活后：把挂在离屏根节点上的交互卡片移回可见容器
  function flushSessionUiRoot(session) {
    if (!session || !session.uiRoot) return;
    const container = sessionContainerEl(session);
    if (!container) return;
    while (session.uiRoot.firstChild) {
      container.appendChild(session.uiRoot.firstChild);
    }
    requestAnimationFrame(() => {
      const last = container.lastElementChild;
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'end' });
    });
  }

  // 会话切走前：把属于该会话的交互卡片从可见容器收回离屏根节点
  function retractSessionUiRoot(session) {
    if (!session || !session.uiRoot) return;
    const container = sessionContainerEl(session);
    if (!container) return;
    const nodes = container.querySelectorAll(`[data-session-key="${cssEscape(session.key)}"]`);
    for (const node of nodes) session.uiRoot.appendChild(node);
  }

  // 创建交互卡片时使用：卡片挂到所属会话的离屏根节点，
  // 会话激活时立即冲入可见容器，保证后台会话的卡片不丢、不串到别的会话。
  function appendSessionCard(session, node) {
    if (!session || !node) return;
    node.dataset.sessionKey = session.key;
    session.uiRoot.appendChild(node);
    if (session.active) flushSessionUiRoot(session);
  }

  // 切回会话时重放后台期间缓冲的瞬时 UI 事件（文件呈递/命运牌/牌阵）
  function applyBufferedUiEvents(session) {
    if (!session || !Array.isArray(session.uiEvents) || !session.uiEvents.length) return;
    for (const ev of session.uiEvents) {
      try {
        if (ev.type === 'present-file' && typeof addFilePresentCard === 'function') {
          addFilePresentCard(ev.data);
        } else if (ev.type === 'tarot-spread' && typeof addTarotSpreadToChat === 'function') {
          addTarotSpreadToChat(ev.result);
        } else if (ev.type === 'tarot' && ev.data && agentTarot) {
          // 后台期间命运牌文本未写入聊天记录，这里以 UI-only 方式补渲染
          const data = ev.data;
          const iconHtml = data.icon ? `<i class="fa-solid ${data.icon}"></i>` : '<i class="fa-solid fa-star"></i>';
          const _lang = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
          const _isZh = (_lang === 'zh-CN');
          const position = data.isReversed ? (_isZh ? '逆位' : 'Reversed') : (_isZh ? '正位' : 'Upright');
          const _cardName = _isZh ? data.name : (data.nameEn || data.name);
          const meaning = data.isReversed ? data.meaningOfReversed : data.meaningOfUpright;
          const eSource = data.entropySource || 'CSPRNG';
          const isTRNG = eSource.startsWith('TRNG');
          const trngBadge = isTRNG ? '<span class="trng-badge" style="margin-left:6px;font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';
          agentTarot.innerHTML = `${iconHtml}<span>${_isZh ? '命运之牌：' : 'Tarot: '}${_cardName}(${position})</span>${trngBadge}`;
          agentTarot.title = `${_cardName}(${position}) - ${meaning || ''} [${eSource}]`;
          const entropyNote = isTRNG ? (_isZh ? ' [TRNG 硬件真随机]' : ' [TRNG Hardware Random]') : '';
          addSystemMessage(`${_isZh ? '抽取了命运之牌：' : 'Drew Tarot: '}${_cardName}(${position})${_isZh ? '（' : ' ('}${data.nameEn}${_isZh ? '）' : ')'}${entropyNote}\n${meaning || ''}`, { persist: false });
        }
      } catch { /* ignore */ }
    }
  }

  // 切回会话时同步发送/停止按钮与状态显示
  function syncSessionControls(mode, session) {
    const ag = session?.agent;
    if (mode === 'chat') {
      if (ag && ag.running) {
        if (typeof setSendButtons === 'function') setSendButtons(true);
        if (agentStatus) {
          agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 工作中...';
          agentStatus.className = 'agent-status working';
        }
        if (typeof addThinkingIndicator === 'function' && !document.getElementById('thinking-indicator')) {
          addThinkingIndicator();
        }
      } else {
        if (typeof setSendButtons === 'function') setSendButtons(false);
        if (agentStatus) {
          agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 待命中';
          agentStatus.className = 'agent-status';
        }
      }
      const att = session?.attention;
      if (att && agentStatus) {
        agentStatus.innerHTML = `<i class="fa-solid fa-circle"></i> ${escapeHtml(att.label || '等待处理')}`;
        agentStatus.className = 'agent-status working';
      }
      // 多会话镜像：同步状态栏与发送/停止按钮到 WebUI
      if (!isRemoteMode) {
        try {
          WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#agent-status', html: agentStatus.outerHTML });
          if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-stop', attr: 'class', value: btnStop.className });
          if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-send', attr: 'class', value: btnSend.className });
        } catch { /* ignore */ }
      }
    } else if (mode === 'code') {
      if (typeof refreshCodeStopButton === 'function') refreshCodeStopButton();
    } else if (mode === 'babe') {
      if (typeof refreshBabeStopButton === 'function') refreshBabeStopButton();
    }
  }

  /**
   * 批量关闭指定模式的会话。
   * - 若关闭后该模式没有剩余会话，立即新建一个（标签栏常驻，绝不出现空栏）；
   * - 若关闭的是当前激活会话，则自动激活剩余的第一个会话。
   */
  function closeSessionBatch(mode, keys) {
    if (!sessionManager || !keys || !keys.size) return;
    const targets = sessionManager.list(mode).filter(s => keys.has(s.key));
    if (!targets.length) return;
    const activeKey = sessionManager.getActive(mode)?.key || null;
    const runningCount = targets.filter(s => s.status === SessionStatus.RUNNING
      || s.status === SessionStatus.WAITING_APPROVAL
      || s.status === SessionStatus.WAITING_TOOL_AUTH).length;
    const noun = targets.length === 1
      ? `会话“${targets[0].title || '未命名'}”`
      : `${targets.length} 个会话`;
    if (runningCount > 0 && !window.confirm(`${noun}仍在运行，确定停止并关闭吗？`)) return;
    for (const session of targets) {
      sessionManager.stop(session);
      sessionManager.close(session);
    }
    renderAllSessionTabs();
    const remaining = sessionManager.ordered(mode);
    if (!remaining.length) {
      // 关闭最后一个标签页 → 打开一个新会话标签页
      createNewSession(mode).catch(e => console.error('[sessions] 新建会话失败:', e));
      return;
    }
    if (activeKey && keys.has(activeKey)) {
      activateSession(mode, remaining[0].key);
    }
  }

  function closeSession(session) {
    if (!session) return;
    closeSessionBatch(session.mode, new Set([session.key]));
  }

  // 标签页右键菜单：打开工作目录 / 批量关闭
  function showSessionTabContextMenu(e, mode, session) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.session-tab-menu').forEach(m => m.remove());
    const sessions = sessionManager.ordered(mode);
    const idx = sessions.findIndex(s => s.key === session.key);
    const workspacePath = session.agent?.codeWorkspacePath || session.agent?.workspacePath || '';
    const menu = document.createElement('div');
    menu.className = 'session-tab-menu';
    menu.style.cssText = [
      'position:fixed',
      `left:${e.clientX}px`,
      `top:${e.clientY}px`,
      'background:var(--bg-primary)',
      'border:1px solid var(--border)',
      'border-radius:8px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.25)',
      'padding:4px 0',
      'z-index:10001',
      'min-width:200px'
    ].join(';');

    const items = [
      {
        icon: 'fa-folder-open',
        label: '打开工作目录',
        disabled: !workspacePath,
        action: () => { if (workspacePath) window.api.openFileExplorer(workspacePath); }
      },
      {
        icon: 'fa-xmark',
        label: '关闭此标签页',
        action: () => closeSessionBatch(mode, new Set([session.key]))
      },
      {
        icon: 'fa-angles-left',
        label: '关闭左侧所有标签页',
        disabled: idx <= 0,
        action: () => closeSessionBatch(mode, new Set(sessions.slice(0, idx).map(s => s.key)))
      },
      {
        icon: 'fa-angles-right',
        label: '关闭右侧所有标签页',
        disabled: idx >= sessions.length - 1,
        action: () => closeSessionBatch(mode, new Set(sessions.slice(idx + 1).map(s => s.key)))
      },
      {
        icon: 'fa-minus',
        label: '关闭其他标签页',
        disabled: sessions.length <= 1,
        action: () => closeSessionBatch(mode, new Set(sessions.filter(s => s.key !== session.key).map(s => s.key)))
      },
      {
        icon: 'fa-ban',
        label: '关闭所有标签页',
        danger: true,
        action: () => closeSessionBatch(mode, new Set(sessions.map(s => s.key)))
      }
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.style.cssText = [
        'padding:7px 14px',
        'display:flex',
        'align-items:center',
        'gap:10px',
        'font-size:13px',
        'white-space:nowrap',
        'cursor:' + (item.disabled ? 'not-allowed' : 'pointer'),
        'color:' + (item.disabled ? 'var(--text-tertiary)' : (item.danger ? 'var(--danger)' : 'var(--text-primary)')),
        'opacity:' + (item.disabled ? '0.55' : '1'),
        'transition:background 0.15s'
      ].join(';');
      row.innerHTML = `<i class="fa-solid ${item.icon}" style="width:16px;font-size:12px"></i><span>${escapeHtml(item.label)}</span>`;
      if (!item.disabled) {
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        row.addEventListener('click', () => {
          menu.remove();
          item.action();
        });
      }
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('contextmenu', closeMenu);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
      document.addEventListener('contextmenu', closeMenu);
    }, 0);
  }

  async function createNewSession(mode) {
    if (!sessionManager) return;
    if (mode === 'chat') {
      const ag = new Agent();
      ag.mode = 'chat';
      await ag.init();
      wireChatAgent(ag);
      const session = sessionManager.registerAgent('chat', ag, { title: ag.conversationTitle || '未命名会话' });
      activateSession('chat', session.key);
    } else if (mode === 'code') {
      await createCodeSession();
    } else if (mode === 'babe') {
      await createBabeSession();
    }
  }

  async function activateSession(mode, key) {
    if (!sessionManager) return;
    const session = sessionManager.get(key);
    if (!session || session.mode !== mode) return;
    if (currentMode !== mode) {
      const modeBtn = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
      if (modeBtn) modeBtn.click();
      // 等待模式切换完成后再激活目标会话
      setTimeout(() => activateSession(mode, key), 0);
      return;
    }
    sessionManager.activate(mode, key);
    try {
      if (mode === 'chat') {
        agent = session.agent;
        const conv = {
          id: agent.conversationId,
          title: agent.conversationTitle || session.title,
          messages: agent.contextManager?.getHistoryMessages() || [],
          subAgents: agent.subAgents || [],
          workspacePath: agent.workspacePath,
          usage: agent.sessionUsage
        };
        rebuildChatUIFromHistory(conv);
      } else if (mode === 'code') {
        codeAgent = session.agent;
        codeWorkspacePath = codeAgent.codeWorkspacePath || codeAgent.workspacePath || codeWorkspacePath;
        codeMessages = codeAgent.contextManager?.getHistoryMessages().slice() || [];
        await replayCodeSession(session);
      } else if (mode === 'babe') {
        babeAgent = session.agent;
        babeMessages = babeAgent.contextManager?.getHistoryMessages().slice() || [];
        await replayBabeSession(session);
      }
      if (session.status === SessionStatus.WAITING_APPROVAL && session.pendingApproval) {
        const approval = session.pendingApproval;
        if (mode === 'code') showCodeApprovalPanel(approval.toolName, approval.args);
        else if (mode === 'chat') showApprovalPanel(approval.toolName, approval.args);
      }
      if (session.status === SessionStatus.WAITING_TOOL_AUTH && session.pendingToolAuth) {
        showToolAuthModal(session.pendingToolAuth.toolName, session.pendingToolAuth.category, session.agent);
      }
      // WebUI 上传目录跟随当前激活会话的工作目录，避免多会话时落到错误工作区
      const activeWs = session.agent && (session.agent.codeWorkspacePath || session.agent.workspacePath);
      if (activeWs && !isRemoteMode) {
        try { window.api.webControlSetWorkDir(activeWs); } catch { /* ignore */ }
      }
      // 恢复本会话的输入草稿
      const draftInput = mode === 'code'
        ? document.getElementById('code-chat-input')
        : mode === 'babe'
          ? document.getElementById('babe-chat-input')
          : chatInput;
      if (draftInput) {
        draftInput.value = session.draft || '';
        draftInput.style.height = 'auto';
      }
      // 重放后台期间缓冲的瞬时卡片（文件呈递/命运牌/牌阵）
      applyBufferedUiEvents(session);
      // 把问卷/游戏邀请等交互卡片移回可见容器
      flushSessionUiRoot(session);
      // 同步发送/停止按钮与状态显示
      syncSessionControls(mode, session);
      updateContextProgress();
    } catch (e) {
      // 会话内容回放失败不应阻断激活流程，保证标签栏与页面状态仍能刷新
      console.error('[sessions] activateSession replay error:', e);
    } finally {
      // 无论回放是否成功都刷新标签栏，避免切换会话时栏状态不更新/消失
      renderAllSessionTabs();
    }
  }

  await normalizeToolSettings();
  setTitlebarTitle(agent.conversationTitle || '未命名对话');
  updateReoptimizeButtonVisibility();
  updateContextProgress();
  // 初始化完成后渲染一次标签栏：单个会话也保持可见，避免启动后栏状态与后续行为不一致
  renderAllSessionTabs();
  showSessionTabsForMode(currentMode);

  // ---- 标签栏常驻兜底 ----
  // 无论是什么原因把标签栏隐藏/清空（远端镜像替换、页面切换竞态等），
  // 都自动恢复为可见并渲染当前会话。Remote 模式跳过（DOM 由远端驱动）。
  let _sessionTabsRepairPending = false;
  function repairSessionTabs() {
    if (_sessionTabsRepairPending) return;
    _sessionTabsRepairPending = true;
    requestAnimationFrame(() => {
      _sessionTabsRepairPending = false;
      if (typeof isRemoteMode !== 'undefined' && isRemoteMode) return;
      let host = document.getElementById('session-tabs-host');
      if (!host) {
        // 极端情况：宿主节点被整块移除 → 原地重建（含三根栏）
        const mc = document.getElementById('main-content');
        if (mc) {
          host = document.createElement('div');
          host.id = 'session-tabs-host';
          for (const m of ['chat', 'code', 'babe']) {
            const el = document.createElement('div');
            el.className = 'session-tabs';
            el.id = `${m}-session-tabs`;
            el.dataset.mode = m;
            host.appendChild(el);
          }
          mc.insertBefore(host, mc.firstChild);
        }
      }
      if (!host) return;
      showSessionTabsForMode(currentMode);
      if (host.classList.contains('hidden')) host.classList.remove('hidden');
      for (const mode of ['chat', 'code', 'babe']) {
        const el = document.getElementById(`${mode}-session-tabs`);
        if (!el) continue;
        const want = sessionManager ? sessionManager.list(mode).length : 0;
        const have = el.querySelectorAll('.session-tab').length;
        const hasAdd = !!el.querySelector('.session-tab-add');
        if (want !== have || !hasAdd) {
          try { renderSessionTabs(mode); } catch { /* ignore */ }
        }
      }
    });
  }
  if (typeof MutationObserver === 'function') {
    const _sessionTabsObserver = new MutationObserver(repairSessionTabs);
    _sessionTabsObserver.observe(document.getElementById('main-content') || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }
  // 周期看门狗：无论什么原因（异常清空、替换、竞态）都每 1.5s 自愈一次
  setInterval(() => {
    try { repairSessionTabs(); } catch { /* ignore */ }
  }, 1500);

  // ---- 初次使用引导 ----
  // 仅检测 onboardingCompleted 标志：完成过一次就不再弹（用户可随时从设置主动改）
  // 直接从磁盘读取，避免 agent.settings 尚未加载时误判
  async function checkOnboarding() {
    try {
      const s = await window.api.getSettings();
      return !s.onboardingCompleted;
    } catch {
      const s = agent.settings || {};
      return !s.onboardingCompleted;
    }
  }
  async function showOnboardingIfNeeded() {
    if (!(await checkOnboarding())) return;
    const obModal = document.getElementById('onboarding-modal');
    if (!obModal) return;
    obModal.classList.remove('hidden');
    // 预填现有值
    const s = agent.settings || {};
    document.getElementById('ob-ai-name').value = s.aiPersona?.name || '';
    document.getElementById('ob-ai-pronouns').value = s.aiPersona?.pronouns || '';
    document.getElementById('ob-ai-personality').value = s.aiPersona?.personality || '';
    document.getElementById('ob-ai-persona').value = s.aiPersona?.customPrompt || '';
    document.getElementById('ob-user-name').value = s.userProfile?.name || '';
    // 头像预览
    if (s.aiPersona?.avatar) {
      document.getElementById('ob-ai-avatar-preview').innerHTML = `<img src="${s.aiPersona.avatar}" alt="">`;
    }
    if (s.userProfile?.avatar) {
      document.getElementById('ob-user-avatar-preview').innerHTML = `<img src="${s.userProfile.avatar}" alt="">`;
    }
    // LLM 字段
    const provider = s.llm?.provider || 'opencode-zen';
    document.getElementById('ob-llm-provider').value = provider;
    document.getElementById('ob-llm-zen-key').value = s.llm?.zenApiKey || 'public';
    document.getElementById('ob-llm-url').value = s.llm?.apiUrl || '';
    document.getElementById('ob-llm-key').value = s.llm?.apiKey || '';
    updateObProviderFields(provider);
    // 先显示第一步，避免模型加载慢时向导空白（按钮点击无反馈的假象）
    showOnboardingStep(1);
    await refreshObModels();
    // 默认选 DeepSeek 模型
    autoSelectDeepSeek();
  }
  // ---- 步骤向导导航 ----
  const ONBOARDING_TOTAL_STEPS = 3;
  let currentOnboardingStep = 1;
  function showOnboardingStep(n) {
    if (n < 1) n = 1;
    if (n > ONBOARDING_TOTAL_STEPS) n = ONBOARDING_TOTAL_STEPS;
    currentOnboardingStep = n;
    // 切换步骤页面显示
    document.querySelectorAll('.ob-page').forEach(s => {
      if (parseInt(s.dataset.step) === n) s.classList.add('active');
      else s.classList.remove('active');
    });
    // 更新步骤指示器（active + done 状态）
    document.querySelectorAll('.ob-step-item').forEach(d => {
      const step = parseInt(d.dataset.step);
      d.classList.toggle('active', step === n);
      d.classList.toggle('done', step < n);
    });
    // 更新进度条
    const bar = document.getElementById('ob-progress-bar');
    if (bar) bar.style.width = `${((n - 1) / (ONBOARDING_TOTAL_STEPS - 1)) * 100}%`;
    // 更新步骤文本
    const text = document.getElementById('ob-step-text');
    if (text) text.textContent = `${n} / ${ONBOARDING_TOTAL_STEPS}`;
    // 上一步按钮：第一步隐藏
    const prevBtn = document.getElementById('ob-btn-prev');
    if (prevBtn) prevBtn.classList.toggle('hidden', n === 1);
    // 下一步 / 完成按钮：最后一步切换为"完成"
    const nextBtn = document.getElementById('ob-btn-next');
    const finishBtn = document.getElementById('ob-btn-finish');
    if (n === ONBOARDING_TOTAL_STEPS) {
      if (nextBtn) nextBtn.style.display = 'none';
      if (finishBtn) finishBtn.style.display = '';
    } else {
      if (nextBtn) {
        nextBtn.style.display = '';
        nextBtn.innerHTML = '下一步 <i class="fa-solid fa-arrow-right"></i>';
      }
      if (finishBtn) finishBtn.style.display = 'none';
    }
    // 推送 onboarding 步骤切换到 WebUI（整个模态框内容替换，确保所有子元素状态同步）
    const obModal = document.getElementById('onboarding-modal');
    if (obModal) {
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#onboarding-modal', html: obModal.innerHTML });
    }
  }
  // 下一步
  document.getElementById('ob-btn-next')?.addEventListener('click', () => {
    if (currentOnboardingStep < ONBOARDING_TOTAL_STEPS) showOnboardingStep(currentOnboardingStep + 1);
  });
  // 上一步
  document.getElementById('ob-btn-prev')?.addEventListener('click', () => {
    if (currentOnboardingStep > 1) showOnboardingStep(currentOnboardingStep - 1);
  });
  // 跳过引导：直接完成，标记 onboardingCompleted 并关闭
  document.getElementById('ob-btn-skip')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    s.onboardingCompleted = true;
    await window.api.setSettings(s);
    if (typeof agent.applySettings === 'function') agent.applySettings(s);
    else agent.settings = s;
    document.getElementById('onboarding-modal').classList.add('hidden');
  });
  function updateObProviderFields(provider) {
    const zenFields = document.getElementById('ob-zen-key-field');
    const openaiFields = document.getElementById('ob-openai-fields');
    const openaiKeyField = document.getElementById('ob-openai-key-field');
    if (provider === 'opencode-zen') {
      zenFields?.classList.remove('hidden');
      openaiFields?.classList.add('hidden');
      openaiKeyField?.classList.add('hidden');
    } else {
      zenFields?.classList.add('hidden');
      openaiFields?.classList.remove('hidden');
      openaiKeyField?.classList.remove('hidden');
    }
  }
  async function refreshObModels() {
    const provider = document.getElementById('ob-llm-provider')?.value || 'opencode-zen';
    const sel = document.getElementById('ob-llm-model');
    const hint = document.getElementById('ob-model-hint');
    if (!sel) return;
    sel.innerHTML = '<option value="">加载中...</option>';
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      if (provider === 'opencode-zen') {
        const res = await window.api.zenFetchModels();
        if (!res?.ok || !Array.isArray(res.models)) {
          sel.innerHTML = '<option value="">(获取失败)</option>';
          if (hint) hint.textContent = res?.error || '获取失败';
          return;
        }
        const FREE = /free|big-pickle|mimo|north-mini|nemotron|hy3/;
        const isPub = (document.getElementById('ob-llm-zen-key')?.value || '').trim() === 'public';
        let models = res.models.slice();
        if (isPub) models = models.filter(m => FREE.test(m.id));
        models.sort((a,b) => (a.id||'').localeCompare(b.id||''));
        sel.innerHTML = '';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = (FREE.test(m.id) ? '[免费] ' : '') + (m.name || m.id);
          sel.appendChild(opt);
        }
        if (hint) hint.textContent = `共 ${models.length} 个可用模型`;
      } else {
        const url = document.getElementById('ob-llm-url')?.value || '';
        const key = document.getElementById('ob-llm-key')?.value || '';
        if (!url || !key) {
          sel.innerHTML = '<option value="">请先填写 URL 和 Key</option>';
          if (hint) hint.textContent = '请先填写 API URL 和 Key';
          return;
        }
        const res = await window.api.llmFetchModels(provider, url, key);
        if (!res?.ok || !Array.isArray(res.models)) {
          sel.innerHTML = '<option value="">(获取失败)</option>';
          if (hint) hint.textContent = res?.error || '获取失败';
          return;
        }
        sel.innerHTML = '';
        for (const m of res.models) {
          const opt = document.createElement('option');
          opt.value = m.id || m.name || '';
          opt.textContent = m.id || m.name || '';
          sel.appendChild(opt);
        }
        if (hint) hint.textContent = `共 ${res.models.length} 个可用模型`;
      }
    } catch (e) {
      sel.innerHTML = '<option value="">(获取失败)</option>';
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
    }
  }
  function autoSelectDeepSeek() {
    const sel = document.getElementById('ob-llm-model');
    if (!sel) return;
    // 优先选含 deepseek 的模型
    for (const opt of sel.options) {
      if (/deepseek/i.test(opt.value)) { opt.selected = true; return; }
    }
    // 次选 free 模型
    for (const opt of sel.options) {
      if (/free|big-pickle/i.test(opt.value)) { opt.selected = true; return; }
    }
  }
  // provider 切换
  document.getElementById('ob-llm-provider')?.addEventListener('change', (e) => {
    updateObProviderFields(e.target.value);
    refreshObModels().then(autoSelectDeepSeek);
  });
  document.getElementById('ob-llm-zen-key')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-llm-url')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-llm-key')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-btn-zen-genkey')?.addEventListener('click', () => {
    document.getElementById('ob-llm-zen-key').value = 'public';
    refreshObModels().then(autoSelectDeepSeek);
  });
  // 头像选择（复用 avatarPickAndEncode，与设置页一致，macOS/Windows 均可用）
  async function obPickAvatar(target) {
    try {
      const result = await window.api.avatarPickAndEncode();
      if (!result?.ok || !result.dataUrl) return;
      const preview = document.getElementById(target === 'ai' ? 'ob-ai-avatar-preview' : 'ob-user-avatar-preview');
      if (preview) {
        preview.innerHTML = `<img src="${result.dataUrl}" alt="">`;
        preview.dataset.avatar = result.dataUrl;
      }
    } catch (e) {
      console.error('[Onboarding] avatar pick failed:', e);
    }
  }
  function obClearAvatar(target) {
    const preview = document.getElementById(target === 'ai' ? 'ob-ai-avatar-preview' : 'ob-user-avatar-preview');
    if (preview) {
      preview.innerHTML = `<i class="fa-solid fa-${target === 'ai' ? 'user-astronaut' : 'user'}"></i>`;
      delete preview.dataset.avatar;
    }
  }
  document.getElementById('ob-btn-ai-avatar')?.addEventListener('click', () => obPickAvatar('ai'));
  document.getElementById('ob-btn-ai-avatar-clear')?.addEventListener('click', () => obClearAvatar('ai'));
  document.getElementById('ob-btn-user-avatar')?.addEventListener('click', () => obPickAvatar('user'));
  document.getElementById('ob-btn-user-avatar-clear')?.addEventListener('click', () => obClearAvatar('user'));
  // 完成配置
  document.getElementById('ob-btn-finish')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    // AI 形象
    const aiPreview = document.getElementById('ob-ai-avatar-preview');
    s.aiPersona = s.aiPersona || {};
    s.aiPersona.name = document.getElementById('ob-ai-name').value.trim() || 'Partner';
    s.aiPersona.pronouns = document.getElementById('ob-ai-pronouns').value.trim() || 'Ta';
    s.aiPersona.personality = document.getElementById('ob-ai-personality').value.trim() || '活泼可爱、热情友善';
    s.aiPersona.customPrompt = document.getElementById('ob-ai-persona').value.trim();
    if (aiPreview?.dataset.avatar) s.aiPersona.avatar = aiPreview.dataset.avatar;
    // 用户形象
    const userPreview = document.getElementById('ob-user-avatar-preview');
    s.userProfile = s.userProfile || {};
    s.userProfile.name = document.getElementById('ob-user-name').value.trim() || (agent.systemInfo?.username || '用户');
    if (userPreview?.dataset.avatar) s.userProfile.avatar = userPreview.dataset.avatar;
    // LLM 配置
    const provider = document.getElementById('ob-llm-provider').value;
    s.llm = s.llm || {};
    s.llm.provider = provider;
    if (provider === 'opencode-zen') {
      s.llm.zenApiKey = document.getElementById('ob-llm-zen-key').value.trim() || 'public';
      s.llm.apiUrl = 'https://opencode.ai/zen/v1/chat/completions';
      s.llm.apiKey = s.llm.zenApiKey;
    } else {
      s.llm.apiUrl = document.getElementById('ob-llm-url').value.trim();
      s.llm.apiKey = document.getElementById('ob-llm-key').value.trim();
    }
    s.llm.model = document.getElementById('ob-llm-model').value || s.llm.model || '';
    s.onboardingCompleted = true;
    await window.api.setSettings(s);
    // 即时生效
    if (typeof agent.applySettings === 'function') agent.applySettings(s);
    else agent.settings = s;
    // 更新 UI 显示
    if (typeof updatePersonaDisplay === 'function') updatePersonaDisplay(s.aiPersona);
    document.getElementById('onboarding-modal').classList.add('hidden');
    // 通知 WebUI 同步头像
    try { await window.api.webControlSetAvatars(s.aiPersona?.avatar, s.userProfile?.avatar); } catch (_) {}
  });
  showOnboardingIfNeeded();

  // ---- Local/Remote 选择器 ----
  // Remote 模式：把本渲染器当作远程主机的“瘦客户端 / 镜像”，所有 Agent 执行发生在远端。
  let remoteWs = null;             // Remote 模式的 WS 连接
  var isRemoteMode = false;         // 当前是否为 Remote 模式（用 var 提升，避免 WebUIMirror 早期引用触发 TDZ）
  let remoteBaseUrl = '';           // 远程 HTTP 基址（用于显示）
  let remotePassword = '';          // 远程密码（保存以便重连）
  let remoteTotp = '';              // 远程 TOTP（保存以便重连）
  let remoteIntentionalClose = false; // 主动断开标志（避免触发自动重连）
  let remoteReconnectTimer = null; // 自动重连定时器
  let remoteAvatars = null;         // { ai, user } 远端头像
  const _remoteWsPendingByType = new Map(); // WS 请求/响应映射（按期望响应类型）
  let remoteConnectionId = 0;        // 连接生成计数器，invalidate 旧的连接尝试

  function setConnectionMode(mode) {
    const localBtn = document.getElementById('conn-btn-local');
    const remoteBtn = document.getElementById('conn-btn-remote');
    if (mode === 'remote') {
      localBtn?.classList.remove('active');
      remoteBtn?.classList.add('active');
      document.getElementById('remote-connect-modal').classList.remove('hidden');
    } else {
      localBtn?.classList.add('active');
      remoteBtn?.classList.remove('active');
      // 主动断开远程连接
      remoteIntentionalClose = true;
      remoteConnectionId++; // invalidate 所有进行中的连接尝试
      if (remoteReconnectTimer) { clearTimeout(remoteReconnectTimer); remoteReconnectTimer = null; }
      if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
      const wasRemote = isRemoteMode;
      isRemoteMode = false;
      remoteAvatars = null;
      // 停用事件委托
      disableRemoteEventDelegation();
      // Local 模式不显示远程连接横幅
      const banner = document.getElementById('remote-conn-banner');
      if (banner) banner.classList.add('hidden');
      setRemoteBadge('');
      // 恢复本地 UI 状态
      if (btnReoptimizeTools) btnReoptimizeTools.classList.add('hidden');
      hideApprovalPanelRemote();
      // 如果之前在 Remote 模式，mirror_body 已替换 #app 内容，需要重新加载恢复本地 DOM
      if (wasRemote) {
        location.reload();
        return;
      }
    }
  }
  document.getElementById('conn-btn-local')?.addEventListener('click', () => setConnectionMode('local'));
  document.getElementById('conn-btn-remote')?.addEventListener('click', () => setConnectionMode('remote'));
  document.getElementById('btn-remote-cancel')?.addEventListener('click', () => {
    document.getElementById('remote-connect-modal').classList.add('hidden');
    setConnectionMode('local');
  });

  // 远程连接横幅状态
  function setRemoteBanner(state, message) {
    const banner = document.getElementById('remote-conn-banner');
    if (!banner) return;
    banner.dataset.state = state;
    banner.classList.remove('hidden');
    const txt = banner.querySelector('.remote-conn-text');
    const reconnectBtn = banner.querySelector('.remote-conn-reconnect');
    if (txt) {
      const addr = remoteBaseUrl ? ` (${remoteBaseUrl})` : '';
      if (state === 'connecting') txt.textContent = '正在连接远程主机…' + addr;
      else if (state === 'connected') txt.textContent = '已连接远程主机' + addr;
      else if (state === 'disconnected') txt.textContent = message || ('未连接远程主机' + addr);
      else if (state === 'reconnecting') txt.textContent = '远程连接断开，正在重连…' + addr;
      else if (state === 'error') txt.textContent = (message || '远程连接错误') + addr;
    }
    if (reconnectBtn) reconnectBtn.style.display = (state === 'disconnected' || state === 'error') ? '' : 'none';
  }

  // 标题栏远程地址徽标
  function setRemoteBadge(addr) {
    const badge = document.getElementById('remote-addr-badge');
    if (!badge) return;
    if (addr) { badge.textContent = '🌐 ' + addr.replace(/^https?:\/\//, ''); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  // 横幅“重连”按钮
  document.querySelector('#remote-conn-banner .remote-conn-reconnect')?.addEventListener('click', () => {
    if (remoteBaseUrl && remotePassword) connectRemote(remoteBaseUrl, remotePassword, remoteTotp, true);
  });
  // 横幅“关闭”按钮：仅隐藏，不影响连接状态
  document.querySelector('#remote-conn-banner .remote-conn-dismiss')?.addEventListener('click', () => {
    const banner = document.getElementById('remote-conn-banner');
    if (banner) banner.classList.add('hidden');
  });

  // 发起一次远程连接。reconnect=true 表示自动重连调用。
  async function connectRemote(url, pwd, totp, reconnect = false) {
    const myId = ++remoteConnectionId;
    const statusEl = document.getElementById('remote-status');
    if (!reconnect && statusEl) statusEl.textContent = '连接中...';
    setRemoteBanner('connecting');
    // 先关掉旧连接
    remoteIntentionalClose = true;
    if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
    remoteIntentionalClose = false;
    try {
      // 1. 预校验凭据（HTTP 登录）。跨源时 CORS 已在服务端放行；cookie 不需要。
      const loginRes = await fetch(`${url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd, totpCode: totp })
      });
      if (myId !== remoteConnectionId) return; // 已被 setConnectionMode('local') 取消
      const loginData = await loginRes.json();
      if (myId !== remoteConnectionId) return; // 已被取消
      if (!loginData.ok) {
        if (!reconnect && statusEl) statusEl.textContent = loginData.error || '登录失败';
        setRemoteBanner('error', loginData.error || '登录失败');
        return;
      }
      // 2. 建立 WS（http→ws, https→wss）
      const wsUrl = url.replace(/^http/, 'ws') + '/ws';
      remoteWs = new WebSocket(wsUrl);
      remoteWs.onopen = () => {
        if (myId !== remoteConnectionId) { try { remoteWs.close(); } catch (_) {} return; }
        // 跨源 WS 无法携带 cookie，用首条 auth 消息完成认证
        remoteWs.send(JSON.stringify({ type: 'auth', password: pwd, totpCode: totp }));
      };
      remoteWs.onmessage = (ev) => {
        try { handleRemoteMessage(JSON.parse(ev.data)); } catch (_) {}
      };
      remoteWs.onerror = () => {
        if (myId !== remoteConnectionId) return;
        if (!reconnect && statusEl) statusEl.textContent = '连接失败，请检查地址或网络';
        setRemoteBanner('error', 'WebSocket 连接失败');
      };
      remoteWs.onclose = () => {
        if (myId !== remoteConnectionId) return; // 旧连接，不重连
        const wasRemote = isRemoteMode;
        isRemoteMode = false;
        // 清理挂起的请求
        for (const [, p] of _remoteWsPendingByType) { clearTimeout(p.timer); try { p.reject(new Error('连接已断开')); } catch {} }
        _remoteWsPendingByType.clear();
        if (remoteIntentionalClose) {
          setRemoteBanner('disconnected');
          return;
        }
        // 意外断开：自动重连
        if (wasRemote || reconnect) {
          setRemoteBanner('reconnecting');
          if (remoteReconnectTimer) clearTimeout(remoteReconnectTimer);
          remoteReconnectTimer = setTimeout(() => {
            connectRemote(url, pwd, totp, true);
          }, 3000);
        } else {
          setRemoteBanner('disconnected');
        }
      };
    } catch (e) {
      if (myId !== remoteConnectionId) return; // 已被取消
      if (!reconnect && statusEl) statusEl.textContent = '错误: ' + (e?.message || e);
      setRemoteBanner('error', String(e?.message || e));
      // 网络错误也尝试重连
      if (remoteReconnectTimer) clearTimeout(remoteReconnectTimer);
      remoteReconnectTimer = setTimeout(() => connectRemote(url, pwd, totp, true), 5000);
    }
  }

  document.getElementById('btn-remote-connect')?.addEventListener('click', async () => {
    let url = document.getElementById('remote-url').value.trim().replace(/\/$/, '');
    const pwd = document.getElementById('remote-password').value;
    const totp = document.getElementById('remote-totp').value.trim();
    const statusEl = document.getElementById('remote-status');
    if (!url || !pwd) { statusEl.textContent = '请填写地址和密码'; return; }
    // 自动补全协议前缀：用户可能输入 "172.168.7.48:3456" 而未带 http://
    // 不补全的话 fetch 会把它当作相对路径，解析为 file:// 协议下的路径
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    remoteBaseUrl = url;
    remotePassword = pwd;
    remoteTotp = totp;
    setRemoteBadge(url);
    await connectRemote(url, pwd, totp, false);
  });

  // WS 请求/响应：发送 msg 并等待 expectedType 响应
  function remoteWsRequest(msg, expectedType, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) { reject(new Error('未连接到远程主机')); return; }
      if (_remoteWsPendingByType.has(expectedType)) { reject(new Error('已有相同请求进行中')); return; }
      const timer = setTimeout(() => { _remoteWsPendingByType.delete(expectedType); reject(new Error('请求超时')); }, timeout);
      _remoteWsPendingByType.set(expectedType, { resolve, reject, timer });
      remoteWs.send(JSON.stringify(msg));
    });
  }

  function remoteWsSend(msg) {
    if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // 上传附件到远程（通过 WS，跨源无法用 HTTP+cookie）
  async function uploadAttachmentRemote(att) {
    try {
      let dataUrl;
      if (att.file && att.file.arrayBuffer) {
        const buf = await att.file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        dataUrl = `data:${att.type || 'application/octet-stream'};base64,${btoa(bin)}`;
      } else if (att.path) {
        // 本地路径文件：通过 preload 读取
        const r = await window.api.readFileBase64?.(att.path);
        if (r?.ok && r.data) dataUrl = r.data;
      }
      if (!dataUrl) return null;
      const resp = await remoteWsRequest({ type: 'uploadAttachment', name: att.name, type: att.type, data: dataUrl }, 'uploadResult');
      if (resp.ok) return { name: resp.name, path: resp.path, type: resp.type };
      return null;
    } catch (e) { console.error('[Remote] 附件上传失败:', e); return null; }
  }

  // ---- Remote 镜像应用函数（与 WebUI 客户端逻辑一致）----
  let _remoteApplying = false; // 防止事件委托反馈循环
  let _remoteEventHandlers = null; // 事件委托处理器引用
  let _remoteBodyChunks = null; // 分块 mirror_body 重组缓冲区

  // 本地控制元素：不被远端镜像覆盖（Local/Remote 切换器、远程连接模态框、连接横幅）
  function _isLocalControlEl(el) {
    if (!el || el.nodeType !== 1) return false;
    return !!(el.closest('#connection-switcher') || el.closest('#remote-connect-modal') ||
              el.closest('#remote-conn-banner') || el.closest('#titlebar'));
  }

  // CSS path 生成（与 WebUI 客户端 cssPath 一致）
  function remoteCssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var selector = cur.nodeName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      var parent = cur.parentNode;
      if (parent && parent.children) {
        var typeIdx = 1;
        var sib = cur.previousElementSibling;
        while (sib) {
          if (sib.nodeName.toLowerCase() === selector) typeIdx++;
          sib = sib.previousElementSibling;
        }
        var sameType = 0;
        for (var si = 0; si < parent.children.length; si++) {
          if (parent.children[si].nodeName.toLowerCase() === selector) sameType++;
        }
        if (sameType > 1) selector += ':nth-of-type(' + typeIdx + ')';
      }
      if (cur.className && typeof cur.className === 'string') {
        var cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) selector += '.' + cls;
      }
      parts.unshift(selector);
      cur = cur.parentNode;
    }
    return parts.join(' > ');
  }

  function applyRemoteHead(msg) {
    _remoteApplying = true;
    try {
      var html = msg.html || '';
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
      if (msg.theme_mode) document.documentElement.setAttribute('data-theme', msg.theme_mode);
      var head = document.head;
      // 移除已有的渲染器 CSS（保留 FA 链接和 shell 样式）
      var toRemove = head.querySelectorAll('link:not([href*="fontawesome"]),style:not([data-shell])');
      for (var i = 0; i < toRemove.length; i++) toRemove[i].remove();
      // 插入远端 head 内容
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var nodes = tmp.querySelectorAll('link,style');
      for (var j = 0; j < nodes.length; j++) head.appendChild(nodes[j].cloneNode(true));
    } catch (e) { console.error('[Remote] applyHead error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  function applyRemoteBody(msg) {
    _remoteApplying = true;
    try {
      // Remote 端保留本地标题栏（含 Local/Remote 切换器、窗口控制按钮），
      // 不用主机的 titlebar 覆盖 —— 否则远端将无法切换回 Local 模式。
      // 对话标题通过单独的 dom_text 事件同步到 #titlebar-title。
      var app = document.getElementById('app');
      if (!app) return;
      app.innerHTML = msg.html || '';
      // canvas 替换为占位符（canvas 内容无法镜像）
      var canvases = app.querySelectorAll('canvas');
      for (var c = 0; c < canvases.length; c++) {
        var cv = canvases[c];
        var div = document.createElement('div');
        div.style.cssText = 'width:' + (cv.style.width || '100%') + ';height:' + (cv.style.height || '200px') + ';min-height:100px;display:flex;align-items:center;justify-content:center;background:var(--bg-secondary,#ebebeb);color:var(--text-tertiary,#999);font-size:12px;border-radius:4px;';
        div.textContent = '[Canvas 内容不可镜像]';
        if (cv.parentNode) cv.parentNode.replaceChild(div, cv);
      }
      // 恢复本地连接横幅状态（远端 mirror_body 可能覆盖它）
      var banner = app.querySelector('#remote-conn-banner');
      if (banner) { banner.classList.add('hidden'); banner.setAttribute('data-state', 'connected'); }
    } catch (e) { console.error('[Remote] applyBody error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  function applyRemoteDomClear(msg) {
    _remoteApplying = true;
    try { var c = document.querySelector(msg.container); if (c && !_isLocalControlEl(c)) c.innerHTML = ''; }
    catch (e) { console.error('[Remote] dom_clear error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomReplace(msg) {
    _remoteApplying = true;
    try { var c = document.querySelector(msg.container); if (c && !_isLocalControlEl(c)) c.innerHTML = msg.html || ''; }
    catch (e) { console.error('[Remote] dom_replace error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomRemove(msg) {
    _remoteApplying = true;
    try { var el = document.querySelector(msg.selector); if (el && !_isLocalControlEl(el)) el.remove(); }
    catch (e) { console.error('[Remote] dom_remove error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomUpdate(msg) {
    _remoteApplying = true;
    try {
      var el = document.querySelector(msg.selector);
      if (!el || _isLocalControlEl(el)) return;
      if (msg.attr !== undefined) {
        el.setAttribute(msg.attr, msg.value != null ? msg.value : '');
      } else if (msg.html !== undefined && el.outerHTML) {
        el.outerHTML = msg.html;
      }
    } catch (e) { console.error('[Remote] dom_update error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomText(msg) {
    _remoteApplying = true;
    try { var el = document.querySelector(msg.selector); if (el && !_isLocalControlEl(el)) el.textContent = msg.text != null ? msg.text : ''; }
    catch (e) { console.error('[Remote] dom_text error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomAppend(msg) {
    _remoteApplying = true;
    try {
      var c = document.querySelector(msg.container);
      if (c && !_isLocalControlEl(c)) {
        var tmp = document.createElement('div');
        tmp.innerHTML = msg.html || '';
        while (tmp.firstChild) c.appendChild(tmp.firstChild);
        // 自动滚屏（聊天容器）
        var chatContainers = ['#chat-messages', '#code-chat-messages', '#babe-chat-messages'];
        for (var i = 0; i < chatContainers.length; i++) {
          if (c.closest(chatContainers[i])) { c.scrollTop = c.scrollHeight; break; }
        }
      }
    } catch (e) { console.error('[Remote] dom_append error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomValue(msg) {
    _remoteApplying = true;
    try {
      var el = document.querySelector(msg.selector);
      if (el && !_isLocalControlEl(el) && 'value' in el) {
        el.value = msg.value != null ? msg.value : '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) { console.error('[Remote] dom_value error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  // ---- 事件委托：Remote 模式下所有交互通过 ui_event 转发到远端 ----
  function enableRemoteEventDelegation() {
    if (_remoteEventHandlers) return; // 已启用
    var sendEvent = function(evtType, target, extra) {
      if (_remoteApplying || !remoteWs || remoteWs.readyState !== 1) return;
      // 跳过本地控制元素（连接切换器、远程模态框、横幅）
      if (target.closest('#connection-switcher') || target.closest('#remote-connect-modal') ||
          target.closest('#remote-conn-banner')) return;
      var path = remoteCssPath(target);
      if (!path) return;
      var data = { type: 'ui_event', event: evtType, target: path };
      if (extra) for (var k in extra) data[k] = extra[k];
      remoteWsSend(data);
    };
    var clickHandler = function(e) {
      if (_remoteApplying) return;
      // 拦截 Markdown 链接：http/https 链接在本地新标签页打开，不转发到远端
      var link = e.target.closest('a');
      if (link) {
        var href = link.getAttribute('href');
        if (href && (href.indexOf('http://') === 0 || href.indexOf('https://') === 0)) {
          e.preventDefault(); e.stopPropagation();
          window.open(href, '_blank');
          return;
        }
        e.preventDefault();
      }
      sendEvent('click', e.target);
    };
    var inputHandler = function(e) {
      if (_remoteApplying) return;
      sendEvent('input', e.target, { value: e.target.value });
    };
    var changeHandler = function(e) {
      if (_remoteApplying) return;
      // 文件输入：读取为 base64 并上传
      if (e.target.type === 'file' && e.target.files && e.target.files.length > 0) {
        var file = e.target.files[0];
        var reader = new FileReader();
        reader.onload = function() {
          var dataUrl = reader.result;
          var base64 = dataUrl.split(',')[1];
          remoteWsSend({ type: 'uploadAttachment', name: file.name, type: file.type, data: base64 });
        };
        reader.readAsDataURL(file);
        return;
      }
      sendEvent('change', e.target, { value: e.target.value, checked: e.target.checked });
    };
    var submitHandler = function(e) {
      if (_remoteApplying) return;
      e.preventDefault();
      sendEvent('submit', e.target);
    };
    // keydown 委托：处理输入框的 Enter 发送（applyRemoteBody 替换 DOM 后原始监听器会丢失）
    var keydownHandler = function(e) {
      if (_remoteApplying) return;
      // 只处理 Enter 键（发送）和 Shift+Enter（换行，不转发）
      if (e.key !== 'Enter' || e.shiftKey) return;
      var target = e.target;
      // 匹配各模式的输入框
      var isChatInput = target.id === 'chat-input' || target.id === 'code-chat-input' || target.id === 'babe-chat-input';
      if (!isChatInput) return;
      // Remote 模式下直接调用本地 sendMessage（sendMessage 内部会转发到 WS）
      e.preventDefault();
      if (target.id === 'chat-input') sendMessage();
      else if (target.id === 'code-chat-input') sendCodeMessage();
      else if (target.id === 'babe-chat-input') sendBabeMessage();
    };
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('input', inputHandler, true);
    document.addEventListener('change', changeHandler, true);
    document.addEventListener('submit', submitHandler, true);
    document.addEventListener('keydown', keydownHandler, true);
    _remoteEventHandlers = { clickHandler: clickHandler, inputHandler: inputHandler, changeHandler: changeHandler, submitHandler: submitHandler, keydownHandler: keydownHandler };
    console.log('[Remote] 事件委托已启用');
  }

  function disableRemoteEventDelegation() {
    if (!_remoteEventHandlers) return;
    document.removeEventListener('click', _remoteEventHandlers.clickHandler, true);
    document.removeEventListener('input', _remoteEventHandlers.inputHandler, true);
    document.removeEventListener('change', _remoteEventHandlers.changeHandler, true);
    document.removeEventListener('submit', _remoteEventHandlers.submitHandler, true);
    document.removeEventListener('keydown', _remoteEventHandlers.keydownHandler, true);
    _remoteEventHandlers = null;
    console.log('[Remote] 事件委托已停用');
  }

  // 处理远程推送的消息（服务端 WS 协议）
  // Remote 模式采用镜像机制：直接应用 mirror_head/mirror_body/dom_* 到本地 DOM，
  // 与 WebUI 浏览器客户端行为一致。语义消息（message/status/tarot 等）由 dom_* 覆盖，不再处理。
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
        document.getElementById('remote-connect-modal').classList.add('hidden');
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

  function applyRemoteTheme(t) {
    if (!t) return;
    const root = document.documentElement;
    if (t.accent) root.style.setProperty('--accent', t.accent);
    if (t.accentLight) root.style.setProperty('--accent-light', t.accentLight);
    if (t.accentDark) root.style.setProperty('--accent-dark', t.accentDark);
    if (t.accentBg) {
      root.style.setProperty('--accent-bg', t.accentBg);
      root.style.setProperty('--accent-bg-hover', t.accentBg.replace('0.08', '0.14'));
    }
    if (t.bgPrimary) root.style.setProperty('--bg-primary', t.bgPrimary);
    if (t.bgSecondary) root.style.setProperty('--bg-secondary', t.bgSecondary);
    if (t.bgTertiary) root.style.setProperty('--bg-tertiary', t.bgTertiary);
    if (t.bgHover) root.style.setProperty('--bg-hover', t.bgHover);
    if (typeof t.isDark === 'boolean') {
      root.setAttribute('data-theme', t.isDark ? 'dark' : 'light');
    }
  }

  // 远端模式切换：仅同步按钮高亮，不导航、不回推，避免循环
  function handleRemoteModeSwitch(mode) {
    if (!mode || mode === currentMode) return;
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const nameEl = document.getElementById('agent-name-display');
    if (nameEl) {
      if (mode === 'code') nameEl.textContent = 'Coding Agent';
      else if (mode === 'babe') nameEl.textContent = 'Babe';
      else nameEl.textContent = 'AI Agent';
    }
  }

  function updateRemoteContextProgress(d) {
    if (!d) return;
    const fill = document.getElementById('context-progress-fill');
    const text = document.getElementById('context-progress-text');
    const ind = document.getElementById('chat-context-indicator');
    const pct = Math.min(100, Math.max(0, d.percentage || 0));
    const circumference = 100;
    const dashLen = (pct / 100) * circumference;
    if (fill) fill.setAttribute('stroke-dasharray', `${dashLen} ${circumference}`);
    if (text) {
      const used = d.used || 0, max = d.max || 8192;
      const fmt = (n) => fmtTokenCount(n);
      text.textContent = `${fmt(used)}/${fmt(max)}`;
    }
    if (ind) {
      if (d.used != null) ind.dataset.used = d.used;
      if (d.max != null) ind.dataset.max = d.max;
      if (pct >= 85) ind.dataset.level = 'danger';
      else if (pct >= 65) ind.dataset.level = 'warn';
      else ind.dataset.level = 'normal';
      ind.title = `上下文使用量: ${d.used || 0}/${d.max || 8192} (${Math.round(pct)}%)`;
    }
  }

  function hideApprovalPanelRemote() {
    if (approvalPanel) approvalPanel.classList.add('hidden');
  }

  function updateReoptimizeButtonVisibility() {
    if (!btnReoptimizeTools) return;
    // Code 模式不使用自动优化，隐藏按钮
    // Babe 模式同理（Babe 有独立的 context-indicator）
    const currentAgent = currentMode === 'code' ? codeAgent : (currentMode === 'babe' ? babeAgent : agent);
    const visible = currentMode === 'chat'
      && !!agent.settings?.autoOptimizeToolSelection
      && !(agent.sessionAutoOptimizeDisabled);
    btnReoptimizeTools.classList.toggle('hidden', !visible);
    // 同步重新优化按钮可见性到 WebUI
    try { window.api.webControlPushReoptimizeState(visible); } catch (_) {}
  }

  // 更新上下文进度条函数
  // 通用：更新指定 agent 的上下文圆扇形指示器
  function updateAgentContextProgress(agentInstance, fillId, textId) {
    if (!agentInstance || !agentInstance.contextManager) return;
    const cm = agentInstance.contextManager;
    const stats = cm.getStats ? cm.getStats() : null;
    const progressFill = document.getElementById(fillId);
    const progressText = document.getElementById(textId);
    if (!progressFill || !progressText) return;
    const indicator = progressFill.closest('.context-indicator');
    const estimateMsg = (msg) => (cm.estimateMessageTokens ? cm.estimateMessageTokens(msg) : 0);
    const estimateText = (text) => (cm.estimateTokens ? cm.estimateTokens(text) : 0);
    const systemGuidanceTokens = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
    const toolDefsTokens = Math.ceil(JSON.stringify(
      (typeof agentInstance.getRuntimeToolSchemas === 'function')
        ? agentInstance.getRuntimeToolSchemas()
        : (typeof getToolSchemas === 'function' ? getToolSchemas(agentInstance.settings?.tools || {}) : [])
    ).length / 4);

    let chatTokens = 0;
    let toolResultTokens = 0;
    (cm.messages || []).forEach(msg => {
      if (!msg) return;
      if (msg.role === 'tool') {
        toolResultTokens += estimateMsg(msg);
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        chatTokens += estimateMsg(msg);
      }
    });

    const summaryTokens = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
    const otherTokens = Math.max(0, summaryTokens);
    const tokens = systemGuidanceTokens + toolDefsTokens + chatTokens + toolResultTokens + otherTokens;
    const maxTokens = stats?.maxTokens ?? (agentInstance.settings?.llm?.maxContextLength || 0);
    // 输出预留：为模型生成回复保留 maxResponseTokens 的空间
    // 总占用 = 当前输入 token + 输出预留，分母为完整上下文窗口 maxTokens
    // （不再用 maxTokens - maxResponseTokens 做分母，避免输出预留被计算两次的错觉）
    const maxResponseTokens = agentInstance.settings?.llm?.maxResponseTokens || 8192;
    const totalOccupied = tokens + maxResponseTokens;
    const effectiveMax = maxTokens;
    const percentage = maxTokens ? Math.min(100, (totalOccupied / maxTokens) * 100) : 0;
    const inputOnlyPct = maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : 0;

    // 更新 SVG 圆扇形：stroke-dasharray="percentage, 100-percentage"
    // 圆周长 = 2 * PI * r = 2 * PI * 15.915 ≈ 100，所以直接用百分比
    progressFill.setAttribute('stroke-dasharray', `${percentage} ${100 - percentage}`);
    // 文本：精简显示（≥1K 用 K，≥1M 用 M，≥1G/T/P 用对应单位），显示当前占用+输出预留 / 完整上下文窗口
    const fmt = (n) => fmtTokenCount(n);
    progressText.textContent = `${fmt(totalOccupied)}/${fmt(effectiveMax)}`;

    // 颜色级别
    if (indicator) {
      indicator.dataset.used = totalOccupied;
      indicator.dataset.max = effectiveMax;
      if (percentage >= 95) indicator.dataset.level = 'danger';
      else if (percentage >= 80) indicator.dataset.level = 'warn';
      else indicator.dataset.level = 'normal';
      // 更新/创建 tooltip
      let tooltip = indicator.querySelector('.context-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'context-tooltip';
        indicator.appendChild(tooltip);
      }
      // 绘制迷你扇形图 + 细化占比
      const segPct = (v, total) => total > 0 ? (v/total*100).toFixed(1) : '0';
      const miniR = 12, miniCx = 15, miniCy = 15, miniCircum = 2 * Math.PI * miniR;
      const sysPct = (systemGuidanceTokens / Math.max(1, tokens)) * 100;
      const toolPct = (toolDefsTokens / Math.max(1, tokens)) * 100;
      const chatPct = (chatTokens / Math.max(1, tokens)) * 100;
      const toolResPct = (toolResultTokens / Math.max(1, tokens)) * 100;
      tooltip.innerHTML = `
        <div class="context-tooltip-title">上下文使用详情</div>
        <svg class="context-tooltip-mini-ring" viewBox="0 0 30 30" width="60" height="60">
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--bg-tertiary)" stroke-width="4"/>
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--accent)" stroke-width="4"
          stroke-dasharray="${(percentage/100*miniCircum).toFixed(1)} ${miniCircum.toFixed(1)}"
          stroke-dashoffset="0" transform="rotate(-90 ${miniCx} ${miniCy})"/>
          <text x="${miniCx}" y="${miniCy+3}" text-anchor="middle" font-size="9" fill="var(--text-primary)">${percentage.toFixed(0)}%</text>
        </svg>
        <div class="context-tooltip-row"><span>系统指导</span><span>${systemGuidanceTokens} (${segPct(systemGuidanceTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>工具定义</span><span>${toolDefsTokens} (${segPct(toolDefsTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>聊天记录</span><span>${chatTokens} (${segPct(chatTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>工具结果</span><span>${toolResultTokens} (${segPct(toolResultTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>其他</span><span>${otherTokens} (${segPct(otherTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600">
          <span>当前输入</span><span>${tokens} / ${maxTokens}</span>
        </div>
        <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600;color:var(--accent)">
          <span>输出预留</span><span>${maxResponseTokens}</span>
        </div>
        <div class="context-tooltip-row"><span>占比（含预留）</span><span>${percentage.toFixed(1)}%</span></div>
        <div class="context-tooltip-row" style="color:var(--text-tertiary)"><span>占比（仅输入）</span><span>${inputOnlyPct.toFixed(1)}%</span></div>
        <div class="context-tooltip-row" style="font-weight:600">
          <span>总占用</span><span>${fmt(totalOccupied)} / ${fmt(effectiveMax)}</span>
        </div>
        ${renderSessionTokenStats(agentInstance)}
      `;
    }
  }

  // 渲染当前会话的累计 Token 统计和费用（从 agent.sessionUsage 累计）
  function renderSessionTokenStats(agentInstance) {
    const su = agentInstance?.sessionUsage;
    if (!su) return '';
    // API 未返回 usage 时使用估算值，数字前加 ~ 前缀标识
    const pfx = su.estimated ? '~' : '';
    // ≥1M 用 M（非 10M），≥1G/T/P 用对应单位（防御性编程）
    const fmt = (n) => fmtTokenCount(n, pfx);
    const cachedPct = su.prompt > 0 ? (su.cached / su.prompt * 100).toFixed(1) : '0.0';
    // 计算费用：若该模型在预算控制里配置了价格则显示，否则不显示费用行
    const pricing = getSessionPricing(agentInstance);
    let costRow = '';
    if (pricing) {
      // 新格式：inputPerM / cacheReadPerM / outputPerM / cacheWritePerM（每 1M tokens 多少美元）
      // 旧格式回退：promptPerK/completionPerK（每 1K tokens）
      const toPerM = (v, isPerK) => isPerK ? (Number(v) || 0) * 1000 : (Number(v) || 0);
      const inputPerM = toPerM(pricing.inputPerM ?? pricing.promptPerK, !pricing.inputPerM && !!pricing.promptPerK);
      const cacheReadPerM = pricing.cacheReadPerM != null ? Number(pricing.cacheReadPerM) : inputPerM * 0.1;
      const outputPerM = toPerM(pricing.outputPerM ?? pricing.completionPerK, !pricing.outputPerM && !!pricing.completionPerK);
      const cacheWritePerM = pricing.hasCacheWrite
        ? (pricing.cacheWritePerM != null ? Number(pricing.cacheWritePerM) : inputPerM * 1.25)
        : 0;
      // 应用峰谷倍率
      const ph = agentInstance?.settings?.budget?.peakHours || {};
      let inMul = 1, crMul = 1, outMul = 1, cwMul = 1;
      if (ph.enabled) {
        const hour = new Date().getHours();
        const s = Number(ph.start) ?? 0;
        const e = Number(ph.end) ?? 24;
        const isPeak = s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e);
        if (isPeak) {
          inMul = Number(ph.inputMul) || 1;
          crMul = Number(ph.cacheReadMul) || 1;
          outMul = Number(ph.outputMul) || 1;
          cwMul = Number(ph.cacheWriteMul) || 1;
        }
      }
      const nonCachedPrompt = Math.max(0, su.prompt - su.cached - (su.cacheCreation || 0));
      const inputCost = (nonCachedPrompt / 1e6) * inputPerM * inMul;
      const cacheReadCost = (su.cached / 1e6) * cacheReadPerM * crMul;
      const outputCost = (su.completion / 1e6) * outputPerM * outMul;
      const cacheWriteCost = (su.cacheCreation || 0) / 1e6 * cacheWritePerM * cwMul;
      const promptBilled = inputCost + cacheReadCost + cacheWriteCost;
      const totalCost = promptBilled + outputCost;
      const cacheWriteNote = pricing.hasCacheWrite ? '' : '<div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)"><span>　(此模型不计缓存写入费)</span></div>';
      costRow = `<div class="context-tooltip-row" style="border-top:1px solid var(--border);padding-top:4px">
        <span>费用（${pricing.model}）</span><span>$${totalCost.toFixed(5)}</span>
      </div>
      <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
        <span>　输入</span><span>$${inputCost.toFixed(5)}</span>
      </div>
      <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
        <span>　输出</span><span>$${outputCost.toFixed(5)}</span>
      </div>
      <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
        <span>　缓存读</span><span>$${cacheReadCost.toFixed(5)}</span>
      </div>
      <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
        <span>　缓存写</span><span>$${cacheWriteCost.toFixed(5)}</span>
      </div>${cacheWriteNote}`;
    }
    return `
      <div class="context-tooltip-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;font-weight:600">
        <span>会话累计 Token${su.estimated ? ' <span style="font-size:10px;color:var(--text-tertiary);font-weight:normal">(估算)</span>' : ''}</span><span></span>
      </div>
      <div class="context-tooltip-row"><span>　输入</span><span>${fmt(su.prompt)}</span></div>
      <div class="context-tooltip-row"><span>　输出</span><span>${fmt(su.completion)}</span></div>
      <div class="context-tooltip-row"><span>　总计</span><span>${fmt(su.total)}</span></div>
      ${su.cached > 0 ? `<div class="context-tooltip-row"><span>　缓存命中</span><span>${fmt(su.cached)} (${cachedPct}%)</span></div>` : ''}
      ${su.cacheCreation > 0 ? `<div class="context-tooltip-row"><span>　缓存创建</span><span>${fmt(su.cacheCreation || 0)}</span></div>` : ''}
      ${costRow}
    `;
  }

  // 获取当前会话所用模型的单价配置（来自 settings.budget.models）
  // 支持新格式（inputPerM/cacheReadPerM/outputPerM/cacheWritePerM/hasCacheWrite）
  // 和旧格式（promptPerK/completionPerK）回退
  function getSessionPricing(agentInstance) {
    try {
      const model = agentInstance?.settings?.llm?.model;
      if (!model) return null;
      const prices = agentInstance?.settings?.budget?.models || {};
      const p = prices[model];
      if (!p) return null;
      // 优先识别新格式字段
      const hasNew = p.inputPerM != null || p.outputPerM != null || p.cacheReadPerM != null || p.cacheWritePerM != null;
      const hasOld = p.promptPerK != null || p.completionPerK != null;
      if (!hasNew && !hasOld) return null;
      // hasCacheWrite 显式配置优先，否则按模型名推断（Claude 系默认 true）
      const hasCacheWrite = p.hasCacheWrite != null ? !!p.hasCacheWrite : /claude/i.test(model);
      return {
        model,
        inputPerM: p.inputPerM,
        cacheReadPerM: p.cacheReadPerM,
        outputPerM: p.outputPerM,
        cacheWritePerM: p.cacheWritePerM,
        // 旧字段保留以便回退
        promptPerK: p.promptPerK,
        completionPerK: p.completionPerK,
        hasCacheWrite
      };
    } catch { return null; }
  }

  // 模式 agent 未初始化时，用主 agent 的共享系统指导 + 工具定义估算上下文占用，
  // 并渲染完整的上下文 tooltip（对齐 Chat 模式，避免显示 0）
  function ensureFallbackContext(ind, fill, textEl, sharedMaxCtx) {
    if (!ind) return;
    ind.dataset.used = 0;
    ind.dataset.max = sharedMaxCtx;
    ind.dataset.level = 'normal';
    let sysT = 0, toolT = 0;
    try {
      const cm = agent?.contextManager;
      const sysP = cm?.systemPrompt;
      if (sysP) {
        sysT = cm.estimateMessageTokens ? cm.estimateMessageTokens(sysP) : Math.ceil(String(sysP).length / 4);
      }
      const schemas = (typeof agent?.getRuntimeToolSchemas === 'function')
        ? agent.getRuntimeToolSchemas()
        : (typeof getToolSchemas === 'function' ? getToolSchemas(agent?.settings?.tools || {}) : []);
      toolT = Math.ceil(JSON.stringify(schemas || []).length / 4);
    } catch (_) {}
    const maxResp = agent?.settings?.llm?.maxResponseTokens || 8192;
    const tokens = sysT + toolT;
    const total = tokens + maxResp;
    const pct = sharedMaxCtx ? Math.min(100, (total / sharedMaxCtx) * 100) : 0;
    const inputPct = sharedMaxCtx ? Math.min(100, (tokens / sharedMaxCtx) * 100) : 0;
    const seg = (v) => (v > 0 ? (v / tokens * 100).toFixed(1) : '0');
    if (textEl) textEl.textContent = `${fmtTokenCount(total)}/${fmtTokenCount(sharedMaxCtx)}`;
    if (fill) fill.setAttribute('stroke-dasharray', `${pct} ${100 - pct}`);
    // 创建/重建 tooltip
    let tooltip = ind.querySelector('.context-tooltip');
    if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'context-tooltip'; ind.appendChild(tooltip); }
    const cc = 2 * Math.PI * 12;
    tooltip.innerHTML = `
      <div class="context-tooltip-title">上下文使用详情</div>
      <svg class="context-tooltip-mini-ring" viewBox="0 0 30 30" width="60" height="60">
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--bg-tertiary)" stroke-width="4"/>
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--accent)" stroke-width="4"
          stroke-dasharray="${(inputPct / 100 * cc).toFixed(1)} ${cc.toFixed(1)}"
          stroke-dashoffset="0" transform="rotate(-90 15 15)"/>
        <text x="15" y="18" text-anchor="middle" font-size="9" fill="var(--text-primary)">${pct.toFixed(0)}%</text>
      </svg>
      <div class="context-tooltip-row"><span>系统指导</span><span>${sysT} (${seg(sysT)}%)</span></div>
      <div class="context-tooltip-row"><span>工具定义</span><span>${toolT} (${seg(toolT)}%)</span></div>
      <div class="context-tooltip-row"><span>聊天记录</span><span>0 (0%)</span></div>
      <div class="context-tooltip-row"><span>工具结果</span><span>0 (0%)</span></div>
      <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600">
        <span>当前输入</span><span>${fmtTokenCount(tokens)} / ${fmtTokenCount(sharedMaxCtx)}</span>
      </div>
      <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600;color:var(--accent)">
        <span>输出预留</span><span>${fmtTokenCount(maxResp)}</span>
      </div>
      <div class="context-tooltip-row"><span>占比（含预留）</span><span>${pct.toFixed(1)}%</span></div>
      <div class="context-tooltip-row" style="color:var(--text-tertiary)"><span>占比（仅输入）</span><span>${inputPct.toFixed(1)}%</span></div>
      <div class="context-tooltip-row" style="font-weight:600">
        <span>总占用</span><span>${fmtTokenCount(total)} / ${fmtTokenCount(sharedMaxCtx)}</span>
      </div>`;
  }

  function updateContextProgress() {
    updateAgentContextProgress(agent, 'context-progress-fill', 'context-progress-text');
    // Code / Babe 圆扇形：agent 已初始化时用其 contextManager，否则回退到已加载的 settings 值
    const sharedMaxCtx = agent?.settings?.llm?.maxContextLength || 131072;
    try {
      if (codeAgent) {
        updateAgentContextProgress(codeAgent, 'code-context-progress-fill', 'code-context-progress-text');
      } else {
        ensureFallbackContext(
          document.getElementById('code-context-indicator'),
          document.getElementById('code-context-progress-fill'),
          document.getElementById('code-context-progress-text'),
          sharedMaxCtx
        );
      }
    } catch (_) { /* codeAgent TDZ */ }
    try {
      if (babeAgent) {
        updateAgentContextProgress(babeAgent, 'babe-context-progress-fill', 'babe-context-progress-text');
      } else {
        ensureFallbackContext(
          document.getElementById('babe-context-indicator'),
          document.getElementById('babe-context-progress-fill'),
          document.getElementById('babe-context-progress-text'),
          sharedMaxCtx
        );
      }
    } catch (_) { /* babeAgent TDZ */ }
    // 同步主对话的上下文进度到 WebUI（按当前模式推送对应 agent 的数据）
    try {
      const targetAgent = (currentMode === 'code' && codeAgent) ? codeAgent
        : (currentMode === 'babe' && babeAgent) ? babeAgent
        : agent;
      if (targetAgent && targetAgent.contextManager) {
        const cm = targetAgent.contextManager;
        const stats = cm.getStats ? cm.getStats() : null;
        const estimateMsg = (msg) => (cm.estimateMessageTokens ? cm.estimateMessageTokens(msg) : 0);
        const estimateText = (text) => (cm.estimateTokens ? cm.estimateTokens(text) : 0);
        const systemGuidanceTokens = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
        const toolDefsTokens = Math.ceil(JSON.stringify(
          (typeof targetAgent.getRuntimeToolSchemas === 'function')
            ? targetAgent.getRuntimeToolSchemas()
            : []
        ).length / 4);
        let chatTokens = 0, toolResultTokens = 0;
        (cm.messages || []).forEach(msg => {
          if (!msg) return;
          if (msg.role === 'tool') toolResultTokens += estimateMsg(msg);
          else if (msg.role === 'user' || msg.role === 'assistant') chatTokens += estimateMsg(msg);
        });
        const summaryTokens = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
        const otherTokens = Math.max(0, summaryTokens);
        const tokens = systemGuidanceTokens + toolDefsTokens + chatTokens + toolResultTokens + otherTokens;
        const maxTokens = stats?.maxTokens ?? (targetAgent.settings?.llm?.maxContextLength || 0);
        const percentage = maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : 0;
        // Remote 模式下不向本地 WebUI 服务器推送（避免远端/本地循环推送导致上下文进度抽搐）
        if (!isRemoteMode) {
          window.api.webControlPushContextProgress({
            mode: currentMode,
            used: tokens,
            max: maxTokens,
            percentage,
            details: { systemGuidanceTokens, toolDefsTokens, chatTokens, toolResultTokens, otherTokens }
          });
        }
      }
    } catch (_) {}
  }

  // 定时更新进度条
  setInterval(updateContextProgress, 1000);

  // 刷新上下文指示器右侧的实时预算进度条（今日花费/上限）
  // 在 LLM 响应结束、token 用量更新后调用
  async function refreshBudgetMiniBars() {
    try {
      const st = await window.api.budgetGetStatus();
      if (!st?.ok) return;
      const daily = st.daily || {};
      const monthly = st.monthly || {};
      // 三种模式的预算小条使用同一份数据（按当日总花费）
      const targets = ['chat-budget-mini-bar', 'code-budget-mini-bar', 'babe-budget-mini-bar'];
      for (const id of targets) {
        const el = document.getElementById(id);
        if (!el) continue;
        const cost = daily.costUSD || 0;
        const limit = daily.limitUSD || 0;
        // 仅在 (有限额) 或 (已花费 > 0) 时显示
        if (limit > 0 || cost > 0) {
          el.style.display = '';
          el.dataset.level = daily.level || 'normal';
          const fill = el.querySelector('.bmb-fill');
          const costEl = el.querySelector('.bmb-cost');
          if (fill) fill.style.width = `${Math.min(100, daily.pct || 0)}%`;
          if (costEl) {
            const fmtCost = cost >= 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(6)}`;
            costEl.textContent = limit > 0 ? `${fmtCost} / $${limit.toFixed(2)}` : fmtCost;
          }
          // title 包含今日/本月详情
          const peakTag = (st.peakHours?.enabled) ? ` · 峰时段 ${st.peakHours.start}-${st.peakHours.end}` : '';
          el.title = `今日 $${cost.toFixed(4)}${limit > 0 ? ` / $${limit.toFixed(2)}` : ''} · 本月 $${(monthly.costUSD || 0).toFixed(4)}${peakTag}`;
        } else {
          el.style.display = 'none';
        }
      }
    } catch (_) { /* 静默失败：不影响主流程 */ }
  }
  // 启动时和每 5 秒刷新一次（实时性，但又不至于过频）
  refreshBudgetMiniBars();
  setInterval(refreshBudgetMiniBars, 5000);
  // 监听 LLM 流结束事件以即时刷新
  try {
    window.api.onStreamEnd?.(() => { setTimeout(refreshBudgetMiniBars, 300); });
  } catch (_) {}

  // 刷新上下文指示器右侧的"当前会话消费"小数字（按 agent.sessionUsage + 价格表实时计算）
  function refreshSessionCostMini() {
    try {
      const agents = [
        { id: 'chat-session-cost', agent: typeof agent !== 'undefined' ? agent : null },
        { id: 'code-session-cost', agent: typeof codeAgent !== 'undefined' ? codeAgent : null },
        { id: 'babe-session-cost', agent: typeof babeAgent !== 'undefined' ? babeAgent : null }
      ];
      for (const { id, agent: a } of agents) {
        const el = document.getElementById(id);
        if (!el) continue;
        const su = a?.sessionUsage;
        const pricing = a ? getSessionPricing(a) : null;
        if (!su || !pricing) { el.style.display = 'none'; continue; }
        // 同 renderSessionTokenStats 的费用计算
        const toPerM = (v, isPerK) => isPerK ? (Number(v) || 0) * 1000 : (Number(v) || 0);
        const inputPerM = toPerM(pricing.inputPerM ?? pricing.promptPerK, !pricing.inputPerM && !!pricing.promptPerK);
        const cacheReadPerM = pricing.cacheReadPerM != null ? Number(pricing.cacheReadPerM) : (inputPerM || 0) * 0.1;
        const outputPerM = toPerM(pricing.outputPerM ?? pricing.completionPerK, !pricing.outputPerM && !!pricing.completionPerK);
        const cacheWritePerM = pricing.hasCacheWrite
          ? (pricing.cacheWritePerM != null ? Number(pricing.cacheWritePerM) : (inputPerM || 0) * 1.25)
          : 0;
        const ph = a?.settings?.budget?.peakHours || {};
        let inMul = 1, crMul = 1, outMul = 1, cwMul = 1;
        if (ph.enabled) {
          const hour = new Date().getHours();
          const s = Number(ph.start) ?? 0;
          const e = Number(ph.end) ?? 24;
          const isPeak = s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e);
          if (isPeak) {
            inMul = Number(ph.inputMul) || 1;
            crMul = Number(ph.cacheReadMul) || 1;
            outMul = Number(ph.outputMul) || 1;
            cwMul = Number(ph.cacheWriteMul) || 1;
          }
        }
        const nonCachedPrompt = Math.max(0, su.prompt - su.cached - (su.cacheCreation || 0));
        const totalCost = (nonCachedPrompt / 1e6) * inputPerM * inMul
          + (su.cached / 1e6) * cacheReadPerM * crMul
          + (su.completion / 1e6) * outputPerM * outMul
          + ((su.cacheCreation || 0) / 1e6) * cacheWritePerM * cwMul;
        if (totalCost > 0) {
          el.style.display = '';
          const valEl = el.querySelector('.scm-value');
          const fmtCost = totalCost >= 0.01 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(6)}`;
          if (valEl) valEl.textContent = (su.estimated ? '~' : '') + fmtCost;
          el.title = `当前会话消费${su.estimated ? ' (估算)' : ''}：${fmtCost}\n模型：${pricing.model}`;
        } else {
          el.style.display = 'none';
        }
      }
    } catch (_) { /* 静默失败 */ }
  }
  setInterval(refreshSessionCostMini, 1000);

  btnReoptimizeTools?.addEventListener('click', async () => {
    if (!agent.settings?.autoOptimizeToolSelection) return;
    const seed = chatInput.value.trim() || (typeof agent.getLatestUserMessageText === 'function' ? agent.getLatestUserMessageText() : '') || '手动触发工具重优化';
    await agent.optimizeToolsForConversation(seed, '用户手动点击“重新优化工具选择”');
    updateReoptimizeButtonVisibility();
    if (document.getElementById('page-tools')?.classList.contains('active')) {
      loadToolsPage();
    }
  });

  // ---- Web Control Incoming Events ----
  window.api.onWebControlNewChat(() => {
    stopVoicePlayback(); // 清空语音播放队列
    createNewSession('chat');
    window.api.webControlPushConversationSwitch(null);
  });

window.api.onWebControlSendMessage(async (message) => {
    if (agent.running && !agent.stopped) {
      // Use hot message queue if agent is working
      agent.hotMessages.push(message);
      addMessageToChat('user', message);
      window.api.webControlPushMessage('user', message);
      return;
    }
    addMessageToChat('user', message);
    window.api.webControlPushMessage('user', message, { source: 'web' });
    addThinkingIndicator();
    agent._fromWeb = true;
    await agent.sendMessage(message);
    agent._fromWeb = false;
  });

  // 语音条识别文本 → 填入当前模式当前会话的输入框（autoSend 时自动发送）
  if (typeof window.api?.onVoiceBarFill === 'function') {
    window.api.onVoiceBarFill(async (d) => {
      if (!d || !d.text) return;
      // 问卷等待填写 → 语音答案填入当前题并自动下一题/提交（不走聊天发送）
      const activeQ = window.__activeQuestion;
      if (activeQ && typeof activeQ.submitAnswer === 'function') {
        activeQ.submitAnswer(d.text);
        return;
      }
      const mode = typeof window.getCurrentMode === 'function' ? window.getCurrentMode() : 'chat';
      const inputId = mode === 'code' ? 'code-chat-input' : (mode === 'babe' ? 'babe-chat-input' : 'chat-input');
      const input = document.getElementById(inputId);
      if (input) {
        input.value = d.text.trim();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
      if (!d.autoSend) return;
      // 延后一拍等输入框就绪，复用对应模式的发送逻辑
      setTimeout(() => {
        if (mode === 'code') { try { sendCodeMessage(); } catch (e) { console.warn('[voice] sendCodeMessage:', e); } }
        else if (mode === 'babe') { try { sendBabeMessage(); } catch (e) { console.warn('[voice] sendBabeMessage:', e); } }
        else { try { sendMessage(); } catch (e) { console.warn('[voice] sendMessage:', e); } }
      }, 60);
    });
  }

  window.api.onWebControlStopAgent(() => {
    stopVoicePlayback();
    agent.stop();
    removeThinkingIndicator();
  });

  window.api.onWebControlApprovalResponse((approved) => {
    agent.resolveApproval(approved);
    window.api.webControlClearApproval();
  });

  window.api.onWebControlLoadConversation(async (id) => {
    try {
      stopVoicePlayback(); // 清空语音播放队列
      const conv = await window.api.historyGet(id);
      if (!conv) return;
      // 先查找已存在的会话；没有则创建新会话并加载历史。
      const existing = sessionManager ? sessionManager.list('chat').find(s => String(s.id) === String(conv.id)) : null;
      let targetSession = existing;
      if (targetSession) {
        agent = targetSession.agent;
        activateSession('chat', targetSession.key);
      } else {
        const ag = new Agent();
        ag.mode = 'chat';
        await ag.init();
        await ag.loadFromHistory(conv);
        wireChatAgent(ag);
        targetSession = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
        agent = ag;
        activateSession('chat', targetSession.key);
      }
      setTitlebarTitle(agent.conversationTitle || '未命名对话');
      updateContextProgress();
      // Switch to chat page
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-chat')?.classList.add('active');
      // 推送 nav-item 和 page 切换状态到 WebUI/Remote
      document.querySelectorAll('.nav-item[data-page]').forEach(b => {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: `.nav-item[data-page="${b.dataset.page}"]`, attr: 'class', value: b.className });
      });
      document.querySelectorAll('.page').forEach(p => {
        if (p.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + p.id, attr: 'class', value: p.className });
      });
      // Replay messages in local UI
      clearChatMessagesUI();
      const toolCallMap = {};
      for (const msg of (conv.messages || [])) {
        if (msg.role === 'user') {
          addMessageToChat('user', extractTextContent(msg.content));
        } else if (msg.role === 'assistant') {
          if (msg.content) addMessageToChat('assistant', extractTextContent(msg.content));
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              const toolName = tc.function?.name || 'tool';
              let args = {};
              try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
              const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
              addToolCallToChat(toolDef?.desc || toolName, toolName, args);
              if (tc.id) toolCallMap[tc.id] = toolName;
            }
          }
        } else if (msg.role === 'tool') {
          const toolName = msg.name || toolCallMap[msg.tool_call_id] || 'tool';
          // 兼容旧版多模态 tool 消息 content 为数组的情况：提取文本，避免显示 [object Object]
          let result = msg.content;
          if (Array.isArray(result)) result = extractTextContent(result);
          try { result = JSON.parse(result); } catch {}
          updateToolCallResult(toolName, result);
        } else if (msg.role === 'system') {
          // 回放历史时显示系统消息（不重复持久化）
          addSystemMessage(msg.content, { persist: false });
        }
      }
      // Sync to web control — include tool_calls and tool results so they render properly
      const webMsgs = [];
      for (const m of (conv.messages || [])) {
        if (m.role === 'user') {
          webMsgs.push({ role: 'user', content: m.content || '', timestamp: m.timestamp || Date.now() });
        } else if (m.role === 'assistant') {
          webMsgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls || null, timestamp: m.timestamp || Date.now() });
        } else if (m.role === 'tool') {
          webMsgs.push({ role: 'tool', content: m.content || '', name: m.name || '', tool_call_id: m.tool_call_id || '', timestamp: m.timestamp || Date.now() });
        }
      }
      window.api.webControlPushConversationSwitch(id);
      window.api.webControlPushHistoryMessages(webMsgs);
      window.api.webControlPushTitle(agent.conversationTitle || '未命名对话');
    } catch (e) {
      console.error('[App] onWebControlLoadConversation error:', e.message);
    }
  });

  window.api.onGameFinished((data) => {
    if (!data) return;
    const gameNames = { flyingflower: '飞花令', sanguosha: '三国杀', undercover: '谁是卧底' };
    const gameName = gameNames[data.game] || data.game;
    const resultText = `《${gameName}》游戏结束: ${data.result}`;
    addSystemMessage(resultText);
    window.api.webControlPushMessage('system', resultText);
  });

  // ---- Pending Session: 关闭 App 时保存正在工作的会话 ----
  // 主进程 before-quit 会发送 agent:save-pending 事件，这里响应：
  //   - 如果 agent.running 则保存当前会话信息到 pending 文件
  //   - 否则调用 skipPending 标记无需保存
  window.api.onSavePending(async () => {
    try {
      const runningSessions = sessionManager
        ? sessionManager.list().filter(s => s.status === SessionStatus.RUNNING
            || s.status === SessionStatus.WAITING_APPROVAL
            || s.status === SessionStatus.WAITING_TOOL_AUTH
            || s.status === SessionStatus.QUEUED)
        : [];
      if (runningSessions.length === 0) {
        await window.api.skipPending();
        return;
      }
      const sessions = runningSessions.map(session => {
        const ag = session.agent;
        const lastUserMsg = (ag?.contextManager?.messages || [])
          .filter(m => m.role === 'user')
          .slice(-1)[0];
        const lastUserText = typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content.slice(0, 200)
          : '[多模态内容]';
        return {
          conversationId: ag?.conversationId || session.id,
          conversationTitle: session.title || ag?.conversationTitle || '未命名对话',
          mode: session.mode,
          sessionKey: session.key,
          status: session.status,
          workspacePath: ag?.workspacePath || null,
          codeWorkspacePath: ag?.codeWorkspacePath || null,
          babeAffection: ag?.babeAffection ?? 0,
          tarotCard: ag?.tarotCard || null,
          messageCount: ag?.contextManager?.messages?.length || 0,
          lastUserMessage: lastUserText,
          sessionUsage: ag?.sessionUsage || null
        };
      });
      await window.api.savePendingSession({ sessions });
    } catch (e) {
      console.error('[App] savePendingSession failed:', e.message);
      try { await window.api.skipPending(); } catch {}
    }
  });

  // App 启动时检查是否有 pending 会话，有则弹模态框询问是否继续
  async function checkPendingSessionOnStartup() {
    try {
      const pending = await window.api.getPendingSession();
      const sessions = pending?.sessions;
      const hasLegacy = pending && pending.conversationId;
      if (!pending || (!Array.isArray(sessions) && !hasLegacy)) {
        return;
      }
      if (Array.isArray(sessions) && sessions.length === 0) {
        await window.api.clearPendingSession();
        return;
      }
      // 距离上次保存超过 7 天则忽略
      try {
        const savedAt = new Date(pending.savedAt).getTime();
        if (Date.now() - savedAt > 7 * 24 * 3600 * 1000) {
          await window.api.clearPendingSession();
          return;
        }
      } catch {}
      showPendingResumeModal(pending);
    } catch (e) {
      console.warn('[App] checkPendingSessionOnStartup failed:', e.message);
    }
  }
  // 延迟调用以确保 UI 已就绪
  setTimeout(checkPendingSessionOnStartup, 1500);

  async function resumePendingItem(item) {
    if (!item?.conversationId) return;
    if (item.mode && item.mode !== currentMode) {
      const modeBtn = document.querySelector(`.mode-btn[data-mode="${item.mode}"]`);
      if (modeBtn) modeBtn.click();
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (item.mode === 'code') {
      if (item.codeWorkspacePath) {
        codeWorkspacePath = item.codeWorkspacePath;
        try { await window.api.codeSetLastWorkspace?.(item.codeWorkspacePath); } catch { /* ignore */ }
        const wsPathEl = document.getElementById('code-workspace-path');
        if (wsPathEl) wsPathEl.textContent = item.codeWorkspacePath;
        await loadCodeFileTree(item.codeWorkspacePath);
        await loadCodeHistoryPage();
        await new Promise(resolve => setTimeout(resolve, 250));
        const continueBtn = document.querySelector(`#code-history-list .history-continue[data-id="${item.conversationId}"]`);
        if (continueBtn) continueBtn.click();
      }
      return;
    }
    if (item.mode === 'babe') {
      await loadBabeConversation(item.conversationId);
      return;
    }
    const conv = await window.api.historyGet(item.conversationId);
    if (!conv) return;
    const existing = sessionManager?.list('chat').find(s => String(s.id) === String(conv.id));
    if (existing) {
      agent = existing.agent;
      activateSession('chat', existing.key);
    } else {
      const ag = new Agent();
      ag.mode = 'chat';
      await ag.init();
      await ag.loadFromHistory(conv);
      wireChatAgent(ag);
      const target = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
      agent = ag;
      activateSession('chat', target.key);
    }
  }

  // 显示"上次会话中断"模态框，提供继续/忽略/查看历史等选项
  function showPendingResumeModal(pending) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,0.5);';
    const modeNames = { chat: 'Chat', code: 'Code', babe: 'Babe' };
    const sessions = Array.isArray(pending.sessions) && pending.sessions.length > 0 ? pending.sessions : [pending];
    const primary = sessions[0] || pending;
    const modeLabel = modeNames[primary.mode] || primary.mode || 'Chat';
    const savedAtStr = (() => {
      try { return new Date(pending.savedAt).toLocaleString('zh-CN'); } catch { return ''; }
    })();
    overlay.innerHTML = `
      <div class="modal pending-resume-modal" style="max-width:480px;width:92vw;background:var(--bg-primary);border-radius:16px;box-shadow:var(--shadow-lg);overflow:hidden;border:1px solid var(--border);">
        <div style="padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;">
          <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--warning),#d97706);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;flex-shrink:0;">
            <i class="fa-solid fa-clock-rotate-left"></i>
          </div>
          <div>
            <div style="font-size:16px;font-weight:700;color:var(--text-primary);">上次会话未结束</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">中断于 ${savedAtStr}${sessions.length > 1 ? ` · ${sessions.length} 个会话` : ''}</div>
          </div>
        </div>
        <div style="padding:20px 24px;">
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">检测到上次 App 异常关闭时正在执行的会话尚未保存。是否继续该会话？</div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:12px;color:var(--text-secondary);">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">模式</span>
              <span style="font-weight:600;color:var(--text-primary);">${modeLabel}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">会话标题</span>
              <span style="font-weight:600;color:var(--text-primary);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(primary.conversationTitle || '').replace(/"/g, '&quot;')}">${primary.conversationTitle || '未命名对话'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">消息数</span>
              <span style="font-weight:600;color:var(--text-primary);">${primary.messageCount || 0}</span>
            </div>
            ${primary.lastUserMessage ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);"><div style="color:var(--text-tertiary);margin-bottom:4px;">最后用户消息：</div><div style="color:var(--text-primary);white-space:pre-wrap;word-break:break-word;max-height:80px;overflow:auto;">${(primary.lastUserMessage || '').replace(/</g, '&lt;')}</div></div>` : ''}
          </div>
        </div>
        <div style="padding:14px 24px;border-top:1px solid var(--border);background:var(--bg-secondary);display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" id="pending-ignore-btn" style="padding:8px 16px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-secondary);border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">忽略并清除</button>
          <button type="button" id="pending-continue-btn" style="padding:8px 16px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent-dark));color:#fff;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 2px 8px var(--accent-bg);">
            <i class="fa-solid fa-play" style="margin-right:6px;"></i>继续会话
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const closeOverlay = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };

    overlay.querySelector('#pending-continue-btn').addEventListener('click', async () => {
      try {
        for (const item of sessions) {
          try {
            await resumePendingItem(item);
          } catch (e) {
            console.error('[App] resume pending session failed:', e.message);
          }
        }
        await window.api.clearPendingSession();
      } catch (e) {
        console.error('[App] pending continue failed:', e.message);
      }
      closeOverlay();
    });

    overlay.querySelector('#pending-ignore-btn').addEventListener('click', async () => {
      await window.api.clearPendingSession().catch(() => {});
      closeOverlay();
    });
  }

  // ---- Chat Functions ----
  // 滚动节流：合并同一帧内的多次滚动请求，避免密集重排
  let _scrollRafScheduled = false;
  // 滚动到指定聊天容器的底部。目标元素取容器最后一条消息（而非 thinking-indicator），
  // 这样当 Agent 发送问卷、卡片等带交互的富内容时，滚动定位到内容自身而不是工具调用控件。
  function scrollChatToBottom(targetEl) {
    const container = targetEl || document.getElementById('thinking-indicator')?.parentElement || chatMessages;
    if (_scrollRafScheduled) return;
    _scrollRafScheduled = true;
    requestAnimationFrame(() => {
      _scrollRafScheduled = false;
      const target = container.lastElementChild;
      if (target && target.scrollIntoView) {
        // 直接定位到容器内容底部（内容可能比视口高，用 end 保证底部贴齐）
        target.scrollIntoView({ behavior: 'auto', block: 'end' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  // 暴露 renderMarkdown 供 VirtualScroller 使用
  window.renderMarkdown = renderMarkdown;

  function appendChatElement(el) {
    // 模式感知：根据当前模式把元素追加到对应的消息容器，
    // 避免 Code/Babe 模式的问卷等交互逃逸到 Chat 模式。
    let targetMessagesEl = chatMessages;
    if (currentMode === 'code') {
      targetMessagesEl = document.getElementById('code-chat-messages') || chatMessages;
    } else if (currentMode === 'babe') {
      targetMessagesEl = document.getElementById('babe-chat-messages') || chatMessages;
    }
    const thinking = document.getElementById('thinking-indicator');
    const insertedBeforeThinking = thinking && targetMessagesEl === chatMessages;
    if (insertedBeforeThinking) {
      targetMessagesEl.insertBefore(el, thinking);
    } else {
      targetMessagesEl.appendChild(el);
    }
    scrollChatToBottom(targetMessagesEl);
    // 增量推送：非远程模式才序列化 outerHTML 推送（序列化大元素开销大）
    if (!isRemoteMode) {
      WebUIMirror.pushDomEvent({
        type: 'dom_append',
        container: getChatContainerSelector(),
        html: el.outerHTML,
        before: insertedBeforeThinking ? '#thinking-indicator' : null,
      });
    }
  }

  // ============ 聊天记录搜索（Chat/Code/Babe 共用，Ctrl+F 打开） ============
  const chatSearch = (() => {
    const overlay = document.getElementById('chat-search-overlay');
    const input = document.getElementById('chat-search-input');
    const countEl = document.getElementById('chat-search-count');
    if (!overlay || !input || !countEl) return null;

    let query = '';
    let marks = [];      // 所有高亮 <mark> 元素
    let activeIdx = -1;  // 当前激活的 mark 索引
    let searchableMsgs = []; // 上次搜索的消息元素列表

    // 获取当前模式对应的消息容器选择器
    function getContainer() {
      if (currentMode === 'code') return document.getElementById('code-chat-messages');
      if (currentMode === 'babe') return document.getElementById('babe-chat-messages');
      return chatMessages;
    }

    // 清理所有高亮标记
    function clearMarks() {
      marks.forEach(m => {
        try {
          const parent = m.parentNode;
          if (parent) {
            parent.replaceChild(document.createTextNode(m.textContent), m);
            parent.normalize();
          }
        } catch { /* ignore */ }
      });
      marks = [];
      activeIdx = -1;
      restoreAutoExpandedReasoning();
    }

    // 搜索期间自动展开的 Reasoning 段，切换/关闭时按原状态恢复折叠
    let lastExpandedReasoning = null;
    function restoreAutoExpandedReasoning() {
      if (lastExpandedReasoning) {
        const rs = lastExpandedReasoning.section;
        if (rs && rs.isConnected && lastExpandedReasoning.wasCollapsed && !rs.classList.contains('streaming-reasoning')) {
          rs.classList.add('collapsed');
        }
        lastExpandedReasoning = null;
      }
    }
    // 命中点落在折叠的 Reasoning 内时，临时展开对应段（离开后由 restore 恢复）
    function expandReasoningAround(mark) {
      restoreAutoExpandedReasoning();
      if (!mark || !mark.closest) return;
      const rs = mark.closest('.reasoning-section');
      if (!rs) return;
      lastExpandedReasoning = { section: rs, wasCollapsed: rs.classList.contains('collapsed') };
      rs.classList.remove('collapsed');
    }

    // 在文本节点中查找并包裹匹配片段（保留原始 DOM 结构）
    function highlightNode(node, q) {
      const text = node.textContent;
      const lower = text.toLowerCase();
      const ql = q.toLowerCase();
      if (!ql || !lower.includes(ql)) return;
      const frag = document.createDocumentFragment();
      let idx = 0;
      let start = lower.indexOf(ql);
      while (start !== -1) {
        if (start > idx) frag.appendChild(document.createTextNode(text.slice(idx, start)));
        const mark = document.createElement('mark');
        mark.className = 'chat-search-mark';
        mark.textContent = text.slice(start, start + q.length);
        frag.appendChild(mark);
        marks.push(mark);
        idx = start + q.length;
        start = lower.indexOf(ql, idx);
      }
      if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
      node.parentNode.replaceChild(frag, node);
    }

    // 递归遍历消息元素的可搜索文本节点（跳过时间戳、按钮、图标等）
    function walkTextNodes(el) {
      if (!el) return;
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          highlightNode(child, query);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const cls = child.className || '';
          const tag = child.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BUTTON' ||
              cls.includes('message-time') || cls.includes('msg-time') || cls.includes('message-avatar')) continue;
          walkTextNodes(child);
        }
      }
    }

    // 执行搜索
    function runSearch(q) {
      clearMarks();
      query = q.trim();
      const container = getContainer();
      if (!container) { countEl.textContent = '0 / 0'; return; }

      // 收集消息元素（message / babe-message）
      searchableMsgs = Array.from(container.querySelectorAll('.message, .babe-message'));
      if (!query) {
        marks = [];
        countEl.textContent = '0 / 0';
        return;
      }

      // 对每个消息元素内的文本节点做高亮
      for (const msg of searchableMsgs) {
        walkTextNodes(msg);
      }

      // 过滤出包含匹配的消息
      const matchedMsgs = [];
      for (const msg of searchableMsgs) {
        if (msg.querySelector('.chat-search-mark')) matchedMsgs.push(msg);
      }

      // 在匹配消息上打标记（隐藏不匹配消息，但保持布局简单：只滚动定位）
      // 统计实际 mark 数量
      countEl.textContent = marks.length > 0 ? `1 / ${marks.length}` : '0 / 0';
      if (marks.length > 0) {
        activeIdx = 0;
        activateMark(0, matchedMsgs);
      }
      searchableMsgs = matchedMsgs;
    }

    // 可靠地将 mark 滚动到滚动容器可视区域居中。
    // 不使用 scrollIntoView({ behavior:'smooth' })，避免在 Code 模式内容重新渲染 /
    // 自动滚屏竞争时失效，直接按容器 scrollTop 定位。
    function scrollContainerToMark(mark) {
      const container = getContainer();
      if (!container || !mark || container.clientHeight <= 0) return;
      try {
        const cRect = container.getBoundingClientRect();
        const mRect = mark.getBoundingClientRect();
        // mark 已在可视区域且未越界时保持不动（避免扰乱用户手动滚动位置）
        const alreadyVisible =
          mRect.top >= cRect.top - 8 && mRect.bottom <= cRect.bottom + 8;
        if (alreadyVisible) return;
        const rel = mRect.top - cRect.top;
        container.scrollTop += rel - container.clientHeight / 2;
      } catch { /* ignore */ }
    }

    // 激活指定 mark，并滚动到可见
    function activateMark(idx, matchedMsgs) {
      if (!marks.length) return;
      idx = ((idx % marks.length) + marks.length) % marks.length;
      activeIdx = idx;
      marks.forEach((m, i) => m.classList.toggle('active', i === idx));
      const mark = marks[idx];
      expandReasoningAround(mark);
      scrollContainerToMark(mark);
      // 若 mark 位于嵌套可滚动元素内（如 code 工具调用参数），再滚动该嵌套容器的父链
      let owner = mark.closest('pre.tool-call-args, .message-body, .content');
      if (owner && owner.scrollTo) {
        try {
          const oRect = owner.getBoundingClientRect();
          const mRect = mark.getBoundingClientRect();
          if (mRect.top < oRect.top || mRect.bottom > oRect.bottom) {
            owner.scrollIntoView({ block: 'nearest' });
          }
        } catch { /* ignore */ }
      }
      // 更新计数器：当前第几个 / 总数
      const matchedCount = matchedMsgs ? matchedMsgs.length : searchableMsgs.length;
      countEl.textContent = `${idx + 1} / ${marks.length}（${matchedCount}条消息）`;
    }

    function next(step = 1) {
      if (!marks.length) return;
      const idx = (activeIdx + step + marks.length) % marks.length;
      activateMark(idx);
    }

    // open 幂等化：已打开时只聚焦+全选，不清空已输入的内容（避免"点了没反应"）
    function open() {
      const wasOpen = !overlay.classList.contains('hidden');
      overlay.classList.remove('hidden');
      if (wasOpen) {
        focusInput(true);
        return;
      }
      clearMarks();
      input.value = '';
      query = '';
      countEl.textContent = '0 / 0';
      focusInput(false);
    }

    // 稳定地把焦点交给输入框（同步执行 + 微任务兜底，确保 Code/Babe 模式下也能稳定获得焦点）
    function focusInput(selectText) {
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
      if (selectText) input.select();
      Promise.resolve().then(() => { if (isOpen()) { input.focus({ preventScroll: true }); if (selectText) input.select(); } });
    }

    function close() {
      clearMarks();
      overlay.classList.add('hidden');
      input.blur();
    }

    function isOpen() { return !overlay.classList.contains('hidden'); }

    // 事件绑定
    input.addEventListener('input', () => runSearch(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); next(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.getElementById('chat-search-next')?.addEventListener('click', () => { next(1); focusInput(true); });
    document.getElementById('chat-search-prev')?.addEventListener('click', () => { next(-1); focusInput(true); });
    document.getElementById('chat-search-close')?.addEventListener('click', close);
    // 浮窗内点空白处也关闭（可选，增强交互）
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    // Chat 模式搜索按钮（下载按钮左边）——绑定放在 IIFE 内，保证与搜索模块同生命周期
    document.getElementById('btn-chat-search')?.addEventListener('click', () => {
      open();
    });
    // Code 模式搜索按钮（对齐其他模式的搜索入口）
    document.getElementById('btn-code-chat-search')?.addEventListener('click', () => {
      open();
    });

    // 模式切换时关闭搜索（避免高亮残留到别的容器）
    document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { if (isOpen()) close(); });
    });

    return { open, close, isOpen, runSearch, clearMarks };
  })();

  // ============ Ctrl/Cmd+F 页面级搜索路由 ============
  // 聊天搜索只作用于 Chat/Code/Babe 聊天界面；历史页/设置页各有自己的搜索，
  // 其余标签页不拦截 Ctrl+F，避免聊天搜索泄露到无关页面。
  window.__pageSearchHandlers = window.__pageSearchHandlers || {};
  window.registerPageSearch = function (pageId, handler) {
    if (pageId && handler) window.__pageSearchHandlers[pageId] = handler;
  };

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'f' && e.key !== 'F')) return;
    const active = document.querySelector('.page.active');
    const pageId = active ? String(active.id || '').replace(/^page-/, '') : '';
    if (pageId === 'chat' || pageId === 'code' || pageId === 'babe') {
      e.preventDefault();
      if (chatSearch) chatSearch.open();
      return;
    }
    const handler = window.__pageSearchHandlers[pageId];
    if (handler && typeof handler.open === 'function') {
      e.preventDefault();
      handler.open();
    }
  }, true);

  // 离开历史/设置等页面时关闭其搜索，恢复完整列表
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.nav-item[data-page]');
    if (!nav) return;
    const target = nav.dataset.page;
    if (target === 'chat' || target === 'code' || target === 'babe') return;
    Object.values(window.__pageSearchHandlers || {}).forEach(h => {
      try { if (h && typeof h.close === 'function') h.close(); } catch { /* ignore */ }
    });
  }, true);

  async function normalizeToolSettings() {
    if (!agent.settings) return;
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    if (typeof agent.settings.autoOptimizeToolSelection !== 'boolean') {
      agent.settings.autoOptimizeToolSelection = false;
    }
    const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
    let changed = false;

    TOOL_DEFINITIONS.forEach(tool => {
      if (agent.settings.tools[tool.name] === undefined) {
        agent.settings.tools[tool.name] = true;
        changed = true;
      }
    });

    Object.keys(agent.settings.tools).forEach(name => {
      if (!toolNames.has(name)) {
        delete agent.settings.tools[name];
        changed = true;
      }
    });

    if (changed) {
      await window.api.setSettings(agent.settings);
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    }
  }

  function addMessageToChat(role, content) {
    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // Avatar handling（Remote 模式优先使用远端头像）
    let avatarHTML = '';
    if (role === 'user') {
      avatarHTML = makeFramedAvatarHTML(isRemoteMode ? (remoteAvatars?.user || '') : agent.settings?.userProfile?.avatar, false);
    } else {
      avatarHTML = makeFramedAvatarHTML(isRemoteMode ? (remoteAvatars?.ai || '') : agent.settings?.aiPersona?.avatar, true);
    }

    const bodyClass = role === 'assistant' ? 'message-content markdown-body' : 'message-content';
    // 虚拟滚动优化：assistant 消息延迟渲染 markdown
    // - 批量加载模式（历史回放）：先占位，可见时再渲染
    // - 实时模式（新消息）：立即渲染（保持流式体验）
    if (role === 'assistant' && typeof VirtualScroller !== 'undefined' && VirtualScroller.observeMessage) {
      msg.innerHTML = `
        <div class="message-avatar">${avatarHTML}</div>
        <div class="message-body">
          <div class="${bodyClass}"></div>
          <div class="message-time">${time}</div>
        </div>`;
      appendChatElement(msg);
      // 注册到虚拟滚动器，原始内容存在 dataset 中，可见时才渲染
      VirtualScroller.observeMessage(msg, content);
    } else {
      // user 消息或无虚拟滚动器：直接渲染
      const rendered = role === 'assistant' ? renderMarkdown(content) : escapeHtml(content);
      msg.innerHTML = `
        <div class="message-avatar">${avatarHTML}</div>
        <div class="message-body">
          <div class="${bodyClass}">${rendered}</div>
          <div class="message-time">${time}</div>
        </div>`;
      appendChatElement(msg);
    }

    // Add right-click context menu for deletion
    msg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e, msg, role);
    });
  }

  // ---- Streaming message rendering ----
  // Creates a placeholder assistant bubble for a streaming response.
  function startStreamingMessage(requestId) {
    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    // 保留思考指示器直到第一个 chunk 到达——避免流式开始前的视觉空白期。
    // appendStreamChunk 在首个 chunk 到达时会移除 thinking 指示器。

    const msg = document.createElement('div');
    msg.className = 'message assistant streaming';
    msg.id = 'stream-' + requestId;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    msg.innerHTML = `
      <div class="message-avatar">${avatarHTML}</div>
      <div class="message-body">
        <div class="reasoning-section" style="display:none;">
          <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <i class="fa-solid fa-brain"></i>
            <span>推理过程</span>
            <i class="fa-solid fa-chevron-down reasoning-toggle-icon"></i>
          </div>
          <div class="reasoning-content markdown-body"></div>
        </div>
        <div class="message-content markdown-body"></div>
        <div class="message-time">${time}</div>
      </div>`;
    msg.style.display = 'none'; // hidden until first chunk arrives
    appendChatElement(msg);
    streamingBubbles.set(requestId, {
      el: msg,
      contentEl: msg.querySelector('.message-content'),
      reasoningEl: msg.querySelector('.reasoning-section'),
      reasoningContentEl: msg.querySelector('.reasoning-content'),
      timeEl: msg.querySelector('.message-time'),
      rawContent: '',
      rawReasoning: '',
      renderTimer: null,
      shown: false,
      reasoningShown: false,
      contentStarted: false // 标记 final content 是否开始（用于移除 reasoning 光标）
    });
  }

  // 流式 chunk 去重辅助：只做绝对安全的去重（防同一份数据被消费两次），
  // 不做"边界重叠剥离"——Babe 语气存在大量真实叠词，易误伤。
  // 返回 { raw, lastChunk }
  function dedupAppendChunk(raw, lastChunk, chunkContent) {
    if (!chunkContent) return { raw, lastChunk };
    // 连续重复 chunk（同一份数据被传输/消费两次）：丢弃
    if (chunkContent === lastChunk) return { raw, lastChunk };
    // 累积模式：chunk 包含此前全部已渲染文本（替换而非追加）
    if (chunkContent.length > raw.length && chunkContent.startsWith(raw)) {
      return { raw: chunkContent, lastChunk };
    }
    return { raw: raw + chunkContent, lastChunk: chunkContent };
  }

  // Appends a chunk to the streaming bubble (throttled markdown re-render).
  function appendStreamChunk(requestId, chunk) {
    const bubble = streamingBubbles.get(requestId);
    if (!bubble) return;
    const chunkContent = typeof chunk === 'string' ? chunk : (chunk?.content || '');
    const chunkReasoning = typeof chunk === 'object' ? (chunk?.reasoning || '') : '';
    if (!chunkContent && !chunkReasoning) return;

    if (chunkReasoning) {
      bubble.rawReasoning += chunkReasoning;
      if (!bubble.reasoningShown) {
        bubble.reasoningEl.style.display = '';
        bubble.reasoningShown = true;
      }
    }
    if (chunkContent) {
      const dedup = dedupAppendChunk(bubble.rawContent, bubble._lastChunk, chunkContent);
      bubble.rawContent = dedup.raw;
      bubble._lastChunk = dedup.lastChunk;
      bubble.contentStarted = true; // 标记 final content 开始，停止 reasoning 光标
    }
    if (!bubble.shown) {
      bubble.el.style.display = '';
      bubble.shown = true;
      // 第一个 chunk 到达，移除思考指示器（流式内容接管显示）
      removeThinkingIndicator();
    }
    // Throttle markdown re-render to ~8 fps to avoid layout thrash on long streams.
    if (!bubble.renderTimer) {
      bubble.renderTimer = setTimeout(() => {
        bubble.renderTimer = null;
        if (bubble.contentEl) {
          bubble.contentEl.innerHTML = bubble.rawContent
            ? renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor">▋</span>'
            : '';
        }
        if (bubble.reasoningContentEl && bubble.rawReasoning) {
          // During streaming: show reasoning expanded (live)
          // 一旦 final content 开始，就移除 reasoning 的光标（思考已结束）
          bubble.reasoningEl.classList.remove('collapsed');
          const reasoningCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor">▋</span>';
          bubble.reasoningContentEl.innerHTML = renderMarkdown(bubble.rawReasoning) + reasoningCursor;
          // 自动滚屏：让最新 reasoning 文本可见
          try { bubble.reasoningContentEl.scrollTop = bubble.reasoningContentEl.scrollHeight; } catch (_) {}
        }
        scrollChatToBottom();
        // 远程镜像推送进一步降频：每 ~480ms 推送一次（每 4 次渲染推送 1 次）
        // outerHTML 序列化大元素开销大，是子代理运行时卡顿的主要来源
        if (!isRemoteMode && bubble.el.id) {
          bubble._mirrorCounter = (bubble._mirrorCounter || 0) + 1;
          if (bubble._mirrorCounter >= 4) {
            bubble._mirrorCounter = 0;
            WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          }
        }
      }, 120);
    }
  }

  // Finalizes the streaming bubble: full markdown render, collapse reasoning.
  function finalizeStreamMessage(requestId, data) {
    const bubble = streamingBubbles.get(requestId);
    if (!bubble) return;
    // main.js 先广播的无 content 流结束信号：不固化，等待带权威 content 的结束（agent.js commit）。
    // 只有 data 携带 content（或为字符串内容）时才做最终固化，避免显示停留在流式累积的中间状态。
    const isAuthoritativeFinal = (typeof data === 'string')
      || !(data && typeof data === 'object')
      || data.content !== undefined;
    if (!isAuthoritativeFinal) return;
    streamingBubbles.delete(requestId);
    if (bubble.renderTimer) {
      clearTimeout(bubble.renderTimer);
      bubble.renderTimer = null;
    }
    const fullContent = typeof data === 'object' ? (data?.content || '') : (typeof data === 'string' ? data : '');
    const fullReasoning = typeof data === 'object' ? (data?.reasoning || '') : '';
    const content = fullContent || bubble.rawContent;
    const reasoning = fullReasoning || bubble.rawReasoning;

    if (!content || !content.trim()) {
      if (!reasoning || !reasoning.trim()) {
        // Empty response (e.g. only tool calls) — remove the placeholder bubble.
        bubble.el.remove();
        // 增量推送：移除空响应的流式气泡
        if (bubble.el.id) {
          WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + bubble.el.id });
        }
        return;
      }
      // 仅 reasoning 无 final content：隐藏空的内容气泡和时间戳，只保留 reasoning 容器
      if (bubble.contentEl) bubble.contentEl.style.display = 'none';
      if (bubble.timeEl) bubble.timeEl.style.display = 'none';
      if (bubble.reasoningContentEl && reasoning.trim()) {
        bubble.reasoningEl.style.display = '';
        bubble.reasoningEl.classList.remove('collapsed'); // reasoning-only 时默认展开
        bubble.reasoningContentEl.innerHTML = renderMarkdown(reasoning);
      }
      bubble.el.classList.remove('streaming');
      bubble.el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMessageContextMenu(e, bubble.el, 'assistant');
      });
      scrollChatToBottom();
      // 增量推送：更新流式气泡为最终状态
      if (bubble.el.id) {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
      }
      return;
    }
    bubble.rawContent = content;
    if (bubble.contentEl) {
      bubble.contentEl.innerHTML = content ? renderMarkdown(content) : '';
    }
    // After completion: collapse reasoning by default (user can expand)
    if (bubble.reasoningContentEl && reasoning && reasoning.trim()) {
      bubble.reasoningEl.style.display = '';
      bubble.reasoningEl.classList.add('collapsed');
      bubble.reasoningContentEl.innerHTML = renderMarkdown(reasoning);
      // 即使折叠，也滚到底部，方便用户展开后看到最新内容
      try { bubble.reasoningContentEl.scrollTop = bubble.reasoningContentEl.scrollHeight; } catch (_) {}
    }
    bubble.el.classList.remove('streaming');
    // Attach context menu like a normal assistant message
    bubble.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e, bubble.el, 'assistant');
    });
    scrollChatToBottom();
    // 增量推送：更新流式气泡为最终状态
    if (bubble.el.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
    }
  }

  function addImageMessage(imageUrl) {
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // AI avatar
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);

    const imgId = 'img-' + Date.now();
    msg.innerHTML = `
      <div class="message-avatar">${avatarHTML}</div>
      <div class="message-body">
        <div class="message-content">
          <img id="${imgId}" src="${imageUrl}" style="max-width:400px;max-height:400px;border-radius:8px;cursor:pointer;display:block"/>
        </div>
        <div class="message-time">${time}</div>
      </div>`;

    appendChatElement(msg);

    // 添加点击放大功能
    const imgEl = document.getElementById(imgId);
    if (imgEl) {
      imgEl.addEventListener('click', () => openImageModal(imageUrl));

      // 添加右键菜单
      imgEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showImageContextMenu(e, imageUrl);
      });
    }

    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // 显示塔罗牌阵卡片
  function addTarotSpreadToChat(tarotResult) {
    const spread = tarotResult.spread;
    const cards = tarotResult.cards || [];
    if (!spread || cards.length === 0) return;
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    const eSource = cards[0]?.entropySource || 'CSPRNG';
    const isTRNG = eSource.startsWith('TRNG');
    const trngBadge = isTRNG ? ' <span class="trng-badge" style="font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';

    const cardsHtml = cards.map(c => {
      const meaning = c.isReversed ? c.meaningOfReversed : c.meaningOfUpright;
      const position = c.position?.name || '';
      const posDesc = c.position?.description || '';
      const _lang2 = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
      const _isZh2 = (_lang2 === 'zh-CN');
      const _cardName2 = _isZh2 ? c.name : (c.nameEn || c.name);
      const _orientation2 = c.isReversed ? (_isZh2 ? '逆位' : 'Reversed') : (_isZh2 ? '正位' : 'Upright');
      return '<div class="tarot-spread-card' + (c.isReversed ? ' reversed' : '') + '">' +
        '<div class="card-position">' + escapeHtml(position) + '</div>' +
        '<div class="card-icon"><i class="fa-solid ' + (c.icon || 'fa-star') + '"></i></div>' +
        '<div class="card-name">' + escapeHtml(_cardName2) + '</div>' +
        '<div class="card-orientation">' + _orientation2 + '</div>' +
        '<div class="card-meaning">' + escapeHtml(meaning || '') + '</div>' +
      '</div>';
    }).join('');

    msg.innerHTML =
      '<div class="message-avatar">' + avatarHTML + '</div>' +
      '<div class="message-body">' +
        '<div class="message-content">' +
          '<div style="font-weight:600;margin-bottom:4px">' + escapeHtml(spread.name) + trngBadge + '</div>' +
          '<div style="font-size:0.85em;color:var(--text-secondary);margin-bottom:4px">' + escapeHtml(spread.description || '') + '</div>' +
          '<div class="tarot-spread-display">' + cardsHtml + '</div>' +
        '</div>' +
        '<div class="message-time">' + time + '</div>' +
      '</div>';
    appendChatElement(msg);
    requestAnimationFrame(() => { msg.scrollIntoView({ behavior: 'smooth', block: 'end' }); });
  }

  // 显示图片右键菜单
  function showImageContextMenu(e, imageUrl) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.image-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'image-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 120px;
    `;

    const menuItems = [
      {
        icon: 'fa-copy',
        label: '复制图片',
        action: async () => {
          try {
            // 读取图片文件为blob
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type]: blob })
            ]);
            addSystemMessage('图片已复制到剪贴板');
          } catch (err) {
            addSystemMessage(`复制失败: ${err.message}`);
          }
        }
      },
      {
        icon: 'fa-floppy-disk',
        label: '另存为',
        action: async () => {
          try {
            const sourcePath = imageUrl.replace(/^file:\/\/\/?/, '');
            const fileName = sourcePath.split(/[\\/]/).pop() || 'image.png';
            const result = await window.api.saveFileDialog({
              title: '保存图片',
              defaultPath: fileName,
              filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
            });
            if (result.ok && result.path) {
              await window.api.copyFile(sourcePath, result.path);
              addSystemMessage(`图片已保存到: ${result.path}`);
            }
          } catch (err) {
            addSystemMessage(`保存失败: ${err.message}`);
          }
        }
      }
    ];

    menuItems.forEach(item => {
      const menuItem = document.createElement('div');
      menuItem.style.cssText = `
        padding: 8px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        transition: background 0.2s;
      `;
      menuItem.innerHTML = `<i class="fa-solid ${item.icon}" style="width:16px"></i><span>${item.label}</span>`;

      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.background = 'var(--bg-hover)';
      });
      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'transparent';
      });
      menuItem.addEventListener('click', () => {
        item.action();
        menu.remove();
      });

      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    // 点击其他地方关闭菜单
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }

  // 显示消息右键菜单
  function showMessageContextMenu(e, messageElement, role) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.message-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 160px;
    `;

    const menuItem = document.createElement('div');
    menuItem.style.cssText = `
      padding: 8px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #e74c3c;
    `;
    menuItem.innerHTML = `<i class="fa-solid fa-trash"></i><span>删除对话</span>`;

    menuItem.addEventListener('mouseenter', () => {
      menuItem.style.backgroundColor = 'var(--bg-hover)';
    });
    menuItem.addEventListener('mouseleave', () => {
      menuItem.style.backgroundColor = 'transparent';
    });

    menuItem.addEventListener('click', async () => {
      menu.remove();

      // 查找完整的对话轮次：user -> (system/tool-call)* -> assistant
      const allElements = Array.from(chatMessages.children);
      const currentIndex = allElements.indexOf(messageElement);

      if (currentIndex === -1) return;

      let userMsg = null;
      let assistantMsg = null;
      const middleElements = []; // system messages and tool calls

      if (role === 'user') {
        // 从 user 开始，向后找 assistant
        userMsg = messageElement;
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            // 遇到下一个 user，停止
            break;
          }
        }
      } else if (role === 'assistant') {
        // 从 assistant 开始，向前找 user
        assistantMsg = messageElement;
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            // 遇到上一个 assistant，停止
            break;
          }
        }
      } else {
        // 从 system/tool-call 开始，找前后的 user 和 assistant
        // 向前找 user
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            break;
          }
        }
        // 向后找 assistant
        middleElements.push(messageElement); // 当前元素
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            break;
          }
        }
      }

      if (!userMsg && !assistantMsg) return;

      const pending = [];
      if (userMsg) pending.push(userMsg);
      pending.push(...middleElements);
      if (assistantMsg) pending.push(assistantMsg);

      pending.forEach(el => el.classList.add('pending-delete'));

      // Confirm deletion
      const confirmed = await window.confirmDialog(
        `确定要删除这轮对话吗？\n${userMsg ? '包括用户消息' : ''}${middleElements.length > 0 ? '、工具调用' : ''}${userMsg && assistantMsg ? '和' : ''}${assistantMsg ? 'AI回复' : ''}`,
        '删除对话'
      );

      if (confirmed) {
        pending.forEach(el => el.remove());
      } else {
        pending.forEach(el => el.classList.remove('pending-delete'));
      }
    });

    menu.appendChild(menuItem);
    document.body.appendChild(menu);

    const closeMenu = () => {
      if (menu && menu.parentNode) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }

  function openImageModal(src) {
    const img = document.getElementById('image-preview-img');
    if (img) {
      img.src = src;
      img.alt = '预览';
    }
    imagePreviewModal.classList.remove('hidden');
  }

  function addToolCallToChat(displayName, toolName, args, callId) {
    // runSubAgent 工具调用不在此显示卡片 — 子代理有独立的卡片和详情模态框
    // 避免 args 中过长的任务描述和 result 撑爆聊天页面
    if (toolName === 'runSubAgent') return;

    const el = document.createElement('div');
    el.className = 'tool-call';
    el.id = `tool-${toolName}-${Date.now()}`;
    el.dataset.toolName = toolName;
    if (callId) el.dataset.toolCallId = callId;
    // 截断 args：字符串值限制 200 字符，对象 JSON 限制 500 字符
    const argsStr = Object.entries(args || {})
      .map(([k, v]) => {
        if (typeof v === 'string') return `${k}: ${v.substring(0, 200)}${v.length > 200 ? '…(已截断)' : ''}`;
        const json = JSON.stringify(v);
        return `${k}: ${json.length > 500 ? json.substring(0, 500) + '…(已截断)' : json}`;
      })
      .join('\n');
    el.innerHTML = `
      <div class="tool-call-header">
        <i class="fa-solid fa-gear fa-spin"></i>
        <span>调用工具: ${escapeHtml(displayName)}</span>
        <span class="trng-badge" style="display:none"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>
      </div>
      ${argsStr ? `<div class="tool-call-args">${escapeHtml(argsStr)}</div>` : ''}
      <div class="tool-call-result" style="display:none"></div>`;
    appendChatElement(el);
    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  function updateToolCallResult(toolName, result, isError = false, callId = null) {
    let el = null;
    if (callId) {
      // 同一轮多个同名工具调用时，必须按 callId 精确匹配，
      // 否则多个结果会全部覆盖到最后一个卡片上。
      el = chatMessages.querySelector(`[data-tool-call-id="${cssEscape(callId)}"]`);
    }
    if (!el) {
      const els = chatMessages.querySelectorAll(`[data-tool-name="${toolName}"]`);
      el = els[els.length - 1];
    }
    if (!el) return;
    const header = el.querySelector('.tool-call-header i');
    const isFailure = isError || result?.ok === false;
    if (header) { header.className = `fa-solid ${isFailure ? 'fa-xmark' : 'fa-check'}`; }
    // Show TRNG badge if applicable
    if (result?.entropySource && result.entropySource.startsWith('TRNG')) {
      const badge = el.querySelector('.trng-badge');
      if (badge) badge.style.display = 'inline-flex';
    }
    const resultEl = el.querySelector('.tool-call-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      resultEl.textContent = text.substring(0, 500);
      if (isFailure) resultEl.classList.add('error');
    }
    // 增量推送：更新工具调用卡片的完整 outerHTML
    if (el.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + el.id, html: el.outerHTML });
    }
  }

  // ---- 文件呈递卡片（游戏邀请风格） ----
  function addFilePresentCard(data) {
    if (!data) return;
    const cardId = 'file-present-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const el = document.createElement('div');
    el.className = 'file-present-card';
    el.id = cardId;
    const sizeStr = data.size > 1024 * 1024
      ? (data.size / 1024 / 1024).toFixed(1) + ' MB'
      : data.size > 1024
        ? (data.size / 1024).toFixed(1) + ' KB'
        : data.size + ' B';
    const ext = (data.filename || '').split('.').pop().toUpperCase();
    const iconClass = _getFileIcon(data.filename);
    el.innerHTML = `
      <div class="file-present-header">
        <i class="fa-solid ${iconClass} file-present-icon"></i>
        <div class="file-present-info">
          <span class="file-present-badge">${ext}</span>
          <span class="file-present-title">${escapeHtml(data.title || data.filename || '文件')}</span>
        </div>
      </div>
      ${data.description ? `<div class="file-present-desc">${escapeHtml(data.description)}</div>` : ''}
      <div class="file-present-meta">
        <span><i class="fa-solid fa-file"></i> ${escapeHtml(data.filename || '')}</span>
        <span><i class="fa-solid fa-database"></i> ${sizeStr}</span>
      </div>
      <button class="file-present-download-btn" data-file-path="${escapeHtml(data.fullPath || '')}" data-filename="${escapeHtml(data.filename || 'download')}">
        <i class="fa-solid fa-download"></i> 下载文件
      </button>`;
    // 根据当前模式追加到对应容器
    const container = currentMode === 'code' ? document.getElementById('code-chat-messages')
      : currentMode === 'babe' ? document.getElementById('babe-chat-messages')
      : chatMessages;
    if (!container) return;
    // 移除欢迎消息
    const welcome = container.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    container.appendChild(el);
    requestAnimationFrame(() => { el.scrollIntoView({ behavior: 'smooth', block: 'end' }); });
    // 绑定下载按钮点击
    const dlBtn = el.querySelector('.file-present-download-btn');
    if (dlBtn) {
      dlBtn.addEventListener('click', function() {
        handleFileDownload(this.dataset.filePath, this.dataset.filename);
      });
    }
    // 推送到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: getChatContainerSelector(), html: el.outerHTML });
  }

  function _getFileIcon(filename) {
    if (!filename) return 'fa-file';
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      js: 'fa-file-code', ts: 'fa-file-code', jsx: 'fa-file-code', tsx: 'fa-file-code',
      py: 'fa-file-code', java: 'fa-file-code', c: 'fa-file-code', cpp: 'fa-file-code',
      html: 'fa-file-code', css: 'fa-file-code', json: 'fa-file-code',
      md: 'fa-file-lines', txt: 'fa-file-lines', pdf: 'fa-file-pdf',
      doc: 'fa-file-word', docx: 'fa-file-word', xls: 'fa-file-excel', xlsx: 'fa-file-excel',
      ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint',
      png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image', gif: 'fa-file-image', svg: 'fa-file-image',
      zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper',
      mp3: 'fa-file-audio', wav: 'fa-file-audio', mp4: 'fa-file-video', avi: 'fa-file-video',
    };
    return map[ext] || 'fa-file';
  }

  // 文件下载处理：App 直接下载，Remote 请求远端，WebUI 回传 blob
  function handleFileDownload(filePath, filename) {
    if (!filePath) return;
    // Remote 模式：文件在远端，发送请求让远端回传文件数据
    if (isRemoteMode && remoteWs && remoteWs.readyState === 1) {
      remoteWsSend({ type: 'requestFileDownload', path: filePath, filename: filename });
      return;
    }
    // 本地模式 / WebUI 点击转发：读取文件并下载
    window.api.readFileBase64(filePath).then(function(result) {
      if (!result.ok) { console.error('[FileDownload] 读取失败:', result.error); return; }
      // result.data 格式为 data URL: "data:mime;base64,xxxx"
      var dataUrl = result.data || '';
      var base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
      var mimeType = result.mime || 'application/octet-stream';
      // 如果是 WebUI 转发的点击（_applyingRemote 为 true），通过 WS 回传文件数据
      if (WebUIMirror._applyingRemote) {
        try {
          window.api.webControlMirrorUpdate({ type: 'file_download', filename: filename, data: base64, mimeType: mimeType });
        } catch (e) { console.error('[FileDownload] WebUI 回传失败:', e); }
        return;
      }
      // 本地 Electron：直接 blob 下载
      _triggerBlobDownload(base64, filename, mimeType);
    });
  }

  function _triggerBlobDownload(base64Data, filename, mimeType) {
    var binary = atob(base64Data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 子代理全屏宽度卡片：标题 + 状态 + 用时 + token + 工具调用次数，点击展开完整对话
  const _subAgentCards = new Map(); // id → { el, logEl, startTime, timer }

  function addSubAgentCard({ id, title, task, startTime, status }) {
    const el = document.createElement('div');
    el.className = 'sub-agent-card';
    el.dataset.subAgentId = id;
    el.dataset.status = status || 'running';
    const fmtDur = (ms) => {
      const s = Math.floor((ms || 0) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    };
    el.innerHTML = `
      <div class="sub-agent-card-header" title="点击查看完整记录">
        <div class="sub-agent-card-icon"><i class="fa-solid fa-robot"></i></div>
        <div class="sub-agent-card-meta">
          <div class="sub-agent-card-title">${escapeHtml(title)}</div>
          <div class="sub-agent-card-task">${escapeHtml(task || '').slice(0, 120)}${(task || '').length > 120 ? '…' : ''}</div>
        </div>
        <div class="sub-agent-card-stats">
          <span class="sub-agent-stat sub-agent-status"><i class="fa-solid fa-circle-notch fa-spin"></i> 运行中</span>
          <span class="sub-agent-stat sub-agent-duration"><i class="fa-regular fa-clock"></i> <span class="dur-text">00:00</span></span>
          <span class="sub-agent-stat sub-agent-tools hidden"><i class="fa-solid fa-wrench"></i> <span class="tools-text">0</span></span>
          <span class="sub-agent-stat sub-agent-tokens hidden"><i class="fa-solid fa-coins"></i> <span class="tokens-text">0</span></span>
        </div>
        <button class="btn-icon sub-agent-card-expand" title="查看完整对话"><i class="fa-solid fa-window-maximize"></i></button>
      </div>
      <div class="sub-agent-card-log"></div>`;
    appendChatElement(el);
    const logEl = el.querySelector('.sub-agent-card-log');
    const record = { el, logEl, startTime: startTime || Date.now(), timer: null };
    _subAgentCards.set(id, record);
    // 用时计时器
    const durText = el.querySelector('.dur-text');
    record.timer = setInterval(() => {
      if (durText) durText.textContent = fmtDur(Date.now() - record.startTime);
    }, 1000);
    // 整个卡片头部点击 → 打开详情模态框（参考 claude-code-ref：子代理记录在卡片后台）
    const openDetail = (e) => {
      // 避免点击 stats 区域误触发
      if (e.target.closest('.sub-agent-card-stats')) return;
      showSubAgentDetailModal(id);
    };
    el.querySelector('.sub-agent-card-header').addEventListener('click', openDetail);
    el.querySelector('.sub-agent-card-expand').addEventListener('click', (e) => {
      e.stopPropagation();
      showSubAgentDetailModal(id);
    });
    requestAnimationFrame(() => { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  }

  function updateSubAgentCard(id, updates) {
    const rec = _subAgentCards.get(id);
    if (!rec) return;
    const { el, timer } = rec;
    if (updates.status === 'done') {
      el.dataset.status = 'done';
      if (timer) { clearInterval(timer); rec.timer = null; }
      const statusEl = el.querySelector('.sub-agent-status');
      if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--success, #4caf50)"></i> 完成';
      // 最终用时
      const durText = el.querySelector('.dur-text');
      if (durText && updates.duration != null) {
        const s = Math.floor(updates.duration / 1000);
        durText.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
      // 工具调用次数
      if (updates.toolUseCount != null) {
        const toolsEl = el.querySelector('.sub-agent-tools');
        if (toolsEl) {
          toolsEl.classList.remove('hidden');
          el.querySelector('.tools-text').textContent = updates.toolUseCount;
        }
      }
      // Token 数
      if (updates.usage && updates.usage.total != null) {
        const tokEl = el.querySelector('.sub-agent-tokens');
        if (tokEl) {
          tokEl.classList.remove('hidden');
          el.querySelector('.tokens-text').textContent = fmtTokenCount(updates.usage.total);
        }
      }
      // 结果摘要（默认折叠，避免长结果撑高卡片影响阅读）
      if (updates.result) {
        const resultEl = document.createElement('div');
        resultEl.className = 'sub-agent-card-result collapsed';
        const previewText = updates.result.length > 100
          ? updates.result.substring(0, 100) + '...'
          : updates.result;
        resultEl.innerHTML = `
          <div class="sub-agent-card-result-header">
            <span class="sub-agent-card-result-label">最终结果</span>
            <button class="btn-icon btn-xs sub-agent-result-toggle" title="展开/折叠">
              <i class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
          <div class="sub-agent-card-result-preview">${escapeHtml(previewText)}</div>
          <div class="sub-agent-card-result-full markdown-body" style="display:none">${renderMarkdown(updates.result)}</div>`;
        // 绑定展开/折叠按钮
        const toggleBtn = resultEl.querySelector('.sub-agent-result-toggle');
        const fullEl = resultEl.querySelector('.sub-agent-card-result-full');
        const previewEl = resultEl.querySelector('.sub-agent-card-result-preview');
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = resultEl.classList.toggle('collapsed');
          fullEl.style.display = collapsed ? 'none' : '';
          previewEl.style.display = collapsed ? '' : 'none';
          toggleBtn.querySelector('i').className = collapsed
            ? 'fa-solid fa-chevron-down'
            : 'fa-solid fa-chevron-up';
        });
        el.appendChild(resultEl);
      }
      // 达到迭代上限提示
      if (updates.hitMaxIter) {
        const warnEl = document.createElement('div');
        warnEl.className = 'sub-agent-card-warn';
        warnEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 已达迭代上限，结果为完整报告';
        el.appendChild(warnEl);
      }
    }
    requestAnimationFrame(() => { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  }

  function appendSubAgentLog(id, content) {
    const rec = _subAgentCards.get(id);
    if (!rec) return;
    const line = document.createElement('div');
    line.className = 'sub-agent-log-line';
    line.innerHTML = `<div class="markdown-body">${renderMarkdown(content)}</div>`;
    rec.logEl.appendChild(line);
    requestAnimationFrame(() => { rec.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  }

  // 子代理详情模态框：显示完整对话历史、上下文窗口、token 用量
  // 当前打开的子代理模态框 ID（用于实时刷新）
  let _openSubAgentModalId = null;
  let _subAgentModalRefreshTimer = null;
  // 当前打开的模态框的 render 函数引用（供 sub-agent-message 事件触发立即刷新）
  let _subAgentModalRender = null;

  function showSubAgentDetailModal(id) {
    let existing = document.getElementById('sub-agent-modal');
    if (existing) existing.remove();
    const rec = agent.getSubAgent ? agent.getSubAgent(id) : null;
    const cardRec = _subAgentCards.get(id);
    if (!rec && !cardRec) return;

    _openSubAgentModalId = id;
    const modal = document.createElement('div');
    modal.id = 'sub-agent-modal';
    modal.className = 'sub-agent-modal';
    document.body.appendChild(modal);

    // 渲染函数：首次渲染整个模态框；后续刷新只更新消息列表和统计信息，避免重播动画
    let _modalInitialized = false;
    const render = () => {
      const liveRec = agent.getSubAgent ? agent.getSubAgent(id) : null;
      const liveCardRec = _subAgentCards.get(id);
      if (!liveRec && !liveCardRec) {
        closeModal();
        return;
      }
      // 优先使用实时消息（运行中也能看到）；否则回退到完成时的快照
      const liveMessages = liveRec?.subAgent?.contextManager?.getMessages?.() || [];
      const messages = liveMessages.length > 0 ? liveMessages : (liveRec?.messages || []);
      const usage = liveRec?.usage || liveCardRec?.usage || {};
      const fmtTok = (n) => fmtTokenCount(n);
      const fmtDur = (ms) => {
        if (!ms) return '-';
        const s = Math.floor(ms / 1000);
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      };
      // 上下文窗口使用：基于当前上下文消息的 token 估算（而非累计用量）
      // 累计 usage.prompt + usage.completion 会持续增长，不能反映当前上下文占用
      const maxCtx = liveRec?.subAgent?.contextManager?.maxTokens || (agent?.settings?.llm?.maxContextLength || 131072);
      let usedTokens = 0;
      const subCm = liveRec?.subAgent?.contextManager;
      if (subCm) {
        // 估算当前上下文中所有消息的 token 数
        const estimateMsg = (msg) => subCm.estimateMessageTokens ? subCm.estimateMessageTokens(msg) : 0;
        const estimateText = (text) => subCm.estimateTokens ? subCm.estimateTokens(text) : 0;
        const sysTok = subCm.systemPrompt ? estimateMsg(subCm.systemPrompt) : 0;
        const summaryTok = (subCm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
        let chatTok = 0, toolResTok = 0;
        (subCm.messages || []).forEach(msg => {
          if (!msg) return;
          if (msg.role === 'tool') toolResTok += estimateMsg(msg);
          else if (msg.role === 'user' || msg.role === 'assistant') chatTok += estimateMsg(msg);
        });
        usedTokens = sysTok + summaryTok + chatTok + toolResTok;
      }
      // 如果无法从 contextManager 获取，回退到最后一次请求的 prompt token
      if (usedTokens === 0) usedTokens = usage.lastPrompt || 0;
      // 输出预留：为模型生成回复保留 maxResponseTokens 的空间
      // 总占用 = 当前输入 + 输出预留，分母为完整上下文窗口 maxCtx
      const maxResp = agent?.settings?.llm?.maxResponseTokens || 8192;
      const totalOcc = usedTokens + maxResp;
      const effectiveMaxCtx = maxCtx;
      const ctxPct = maxCtx > 0 ? Math.min(100, Math.round((totalOcc / maxCtx) * 100)) : 0;
      const ctxColor = ctxPct >= 95 ? 'var(--danger, #e74c3c)' : (ctxPct >= 80 ? 'var(--warning, #f39c12)' : 'var(--accent)');
      const isRunning = liveRec?.status === 'running' || (!liveRec?.endTime);
      const bodyHtml = messages.length === 0
        ? '<div class="sub-agent-modal-empty">暂无消息记录（子代理可能仍在初始化）</div>'
        : messages.map(m => renderSubAgentMessage(m)).join('');

      // 首次渲染：构建整个模态框结构
      if (!_modalInitialized) {
        modal.innerHTML = `
        <div class="sub-agent-modal-backdrop"></div>
        <div class="sub-agent-modal-dialog">
          <div class="sub-agent-modal-header">
            <div class="sub-agent-modal-title">
              <i class="fa-solid fa-robot"></i>
              <span>子代理详情</span>
              <span class="sub-agent-modal-running"></span>
              <span class="sub-agent-modal-tarot"></span>
            </div>
            <div class="sub-agent-modal-stats"></div>
            <button class="btn-icon sub-agent-modal-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="sub-agent-modal-task"></div>
          <div class="sub-agent-modal-context" style="padding:8px 18px;border-bottom:1px solid var(--border);background:var(--bg-tertiary, var(--bg-secondary));font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:10px;flex-shrink:0">
            <span><i class="fa-solid fa-window-maximize" style="color:var(--accent)"></i> 上下文窗口</span>
            <div style="flex:1;height:6px;background:var(--bg-primary);border-radius:3px;overflow:hidden;border:1px solid var(--border)">
              <div class="ctx-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s"></div>
            </div>
            <span class="ctx-pct" style="font-variant-numeric:tabular-nums;font-weight:600">0%</span>
            <span class="ctx-tokens" style="color:var(--text-tertiary);font-size:11px">0 / 0</span>
          </div>
          <div class="sub-agent-modal-body">${bodyHtml}</div>
        </div>`;
        modal.querySelector('.sub-agent-modal-close').onclick = closeModal;
        modal.querySelector('.sub-agent-modal-backdrop').onclick = closeModal;
        _modalInitialized = true;
      } else {
        // 后续刷新：只更新 body 内容，避免重播模态框动画
        const bodyEl = modal.querySelector('.sub-agent-modal-body');
        if (bodyEl) bodyEl.innerHTML = bodyHtml;
      }

      // 更新统计区（无论首次还是后续）
      const runningEl = modal.querySelector('.sub-agent-modal-running');
      if (runningEl) runningEl.innerHTML = isRunning ? '<i class="fa-solid fa-circle-notch fa-spin"></i> 运行中' : '';
      const tarotEl = modal.querySelector('.sub-agent-modal-tarot');
      if (tarotEl) tarotEl.innerHTML = liveRec?.tarot ? `命运之牌: ${escapeHtml(liveRec.tarot.name)}${liveRec.tarot.isReversed ? '(逆位)' : '(正位)'}` : '';

      const statsEl = modal.querySelector('.sub-agent-modal-stats');
      if (statsEl) statsEl.innerHTML = `
        <span><i class="fa-regular fa-clock"></i> ${fmtDur(liveRec ? ((liveRec.endTime || Date.now()) - liveRec.startTime) : 0)}</span>
        <span><i class="fa-solid fa-rotate"></i> ${liveRec?.iterations || 0} 轮</span>
        <span><i class="fa-solid fa-wrench"></i> ${liveRec?.toolUseCount || 0} 次工具</span>
        <span><i class="fa-solid fa-coins"></i> 输入 ${fmtTok(usage.prompt)} / 输出 ${fmtTok(usage.completion)} / 共 ${fmtTok(usage.total)}</span>
        ${usage.cached > 0 ? `<span><i class="fa-solid fa-bolt"></i> 缓存命中 ${fmtTok(usage.cached)}</span>` : ''}`;

      const taskEl = modal.querySelector('.sub-agent-modal-task');
      if (taskEl) taskEl.textContent = liveRec?.task || liveCardRec?.el?.dataset?.subAgentId || '';

      const barEl = modal.querySelector('.ctx-progress-bar');
      if (barEl) { barEl.style.width = `${ctxPct}%`; barEl.style.background = ctxColor; }
      const pctEl = modal.querySelector('.ctx-pct');
      if (pctEl) { pctEl.textContent = `${ctxPct}%`; pctEl.style.color = ctxColor; }
      const tokEl = modal.querySelector('.ctx-tokens');
      if (tokEl) tokEl.textContent = `${fmtTok(totalOcc)} / ${fmtTok(effectiveMaxCtx)} (含预留${fmtTok(maxResp)})`;

      // 自动滚动到底部（如果有新消息）
      const body = modal.querySelector('.sub-agent-modal-body');
      if (body && isRunning) body.scrollTop = body.scrollHeight;
    };

    const closeModal = () => {
      if (_subAgentModalRefreshTimer) {
        clearInterval(_subAgentModalRefreshTimer);
        _subAgentModalRefreshTimer = null;
      }
      _openSubAgentModalId = null;
      modal.remove();
      document.removeEventListener('keydown', escHandler);
    };

    // ESC 关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    document.addEventListener('keydown', escHandler);

    // 首次渲染
    render();
    _subAgentModalRender = render;

    // 如果子代理还在运行，启动定时刷新（每 1.5 秒）
    const checkRunning = agent.getSubAgent ? agent.getSubAgent(id) : null;
    if (checkRunning && (checkRunning.status === 'running' || !checkRunning.endTime)) {
      _subAgentModalRefreshTimer = setInterval(() => {
        try {
          const cur = agent.getSubAgent ? agent.getSubAgent(id) : null;
          if (!cur || cur.status !== 'running') {
            // 已完成，最后刷新一次然后停止
            render();
            if (_subAgentModalRefreshTimer) {
              clearInterval(_subAgentModalRefreshTimer);
              _subAgentModalRefreshTimer = null;
            }
          } else if (_openSubAgentModalId === id) {
            render();
          } else {
            // 模态框已关闭
            if (_subAgentModalRefreshTimer) {
              clearInterval(_subAgentModalRefreshTimer);
              _subAgentModalRefreshTimer = null;
            }
          }
        } catch (e) {
          console.error('[SubAgent Modal] refresh error:', e);
        }
      }, 1500);
    }
  }

  function renderSubAgentMessage(m) {
    const role = m.role || 'unknown';
    const roleLabels = { system: '系统', user: '任务', assistant: '子代理', tool: '工具结果' };
    const roleIcon = { system: 'fa-gear', user: 'fa-flag', assistant: 'fa-robot', tool: 'fa-wrench' }[role] || 'fa-message';
    // 截断 content：工具结果可能很长，限制显示长度
    let content = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(c => typeof c === 'string' ? c : (c?.text || '')).join('') : '');
    const MAX_CONTENT = 2000;
    let truncated = false;
    if (content.length > MAX_CONTENT) {
      content = content.substring(0, MAX_CONTENT);
      truncated = true;
    }
    let html = `<div class="sub-agent-msg-item role-${role}">
      <div class="sub-agent-msg-role"><i class="fa-solid ${roleIcon}"></i> ${roleLabels[role] || role}</div>`;
    if (m.tool_calls && m.tool_calls.length > 0) {
      html += `<div class="sub-agent-msg-toolcalls">`;
      for (const tc of m.tool_calls) {
        let argsStr = tc.function?.arguments || '{}';
        try { argsStr = JSON.stringify(JSON.parse(argsStr), null, 2); } catch {}
        // 截断工具参数
        const MAX_ARGS = 800;
        let argsTruncated = false;
        if (argsStr.length > MAX_ARGS) {
          argsStr = argsStr.substring(0, MAX_ARGS);
          argsTruncated = true;
        }
        html += `<div class="sub-agent-msg-tc"><span class="tc-name">${escapeHtml(tc.function?.name || '')}</span><pre class="tc-args">${escapeHtml(argsStr)}${argsTruncated ? '\n…(已截断)' : ''}</pre></div>`;
      }
      html += `</div>`;
    }
    if (content) {
      html += `<div class="sub-agent-msg-content markdown-body">${renderMarkdown(content)}${truncated ? '<div class="sub-agent-msg-truncated">…(内容已截断，完整内容请查看工具返回)</div>' : ''}</div>`;
    }
    if (m.name) {
      html += `<div class="sub-agent-msg-tool-name">工具: ${escapeHtml(m.name)}</div>`;
    }
    html += `</div>`;
    return html;
  }

  function addSystemMessage(content, { persist = true } = {}) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `
      <div class="system-icon"><i class="fa-solid fa-info-circle"></i></div>
      <div class="system-content">${escapeHtml(content)}</div>`;
    appendChatElement(el);
    // 同步保存到聊天历史（确保所有可见的系统消息都会持久化）
    if (persist && agent?.contextManager && agent.conversationId) {
      try {
        agent.contextManager.addSystemMessage(content);
        // 异步触发历史保存（不阻塞 UI）
        if (typeof agent.saveToHistory === 'function') {
          agent.saveToHistory();
        }
      } catch (e) { /* 静默失败：UI 已显示，不应阻塞 */ }
    }
    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // ---- 系统通知辅助 ----
  // 根据设置过滤通知；category: 'approval' | 'sessionDone' | 'question' | 'present'
  // 仅当窗口失焦或被最小化/隐藏时才发送（避免在用户正盯着界面时打扰）
  async function sendAppNotification(category, title, body, force = false, extra = {}) {
    try {
      if (!window.api?.sendNotification) return;
      const s = await window.api.getSettings();
      const n = s.notifications || {};
      // 默认开启：未设置时视为 true
      if (n.enabled === false) return;
      if (n[category] === false) return;
      // 仅在窗口非聚焦或不可见时打扰用户
      const isFocused = document.hasFocus();
      const isHidden = document.visibilityState === 'hidden';
      if (!force && isFocused && !isHidden) return;
      await window.api.sendNotification({ title, body, category, ...(extra || {}) });
    } catch (e) {
      console.warn('[App] sendAppNotification failed:', e?.message || e);
    }
  }

  // ---- Game Invitation Card ----
  const GAME_META = {
    flyingFlower: { name: '飞花令', icon: 'fa-feather', desc: '经典诗词接龙游戏，各方轮流说出含有指定字的诗句', defaultAgents: 2 },
    sanguosha: { name: '三国杀', icon: 'fa-khanda', desc: '经典卡牌对战游戏，选择武将、出牌博弈', defaultAgents: 3 },
    undercover: { name: '谁是卧底', icon: 'fa-user-secret', desc: '经典社交推理游戏，通过描述找出卧底', defaultAgents: 4 },
    idiom: { name: '成语接龙', icon: 'fa-link', desc: '四字成语首尾相接，LLM 生成 + LLM 裁判验证', defaultAgents: 3 },
    guessCharacter: { name: '是否猜人物', icon: 'fa-magnifying-glass', desc: '通过提问只能用是/否回答，猜出 AI 心中的人物', defaultAgents: 1 },
  };

  window.showGameInvitation = function(game, message, suggestedAgents, callingAgent) {
    return new Promise((resolve) => {
      const meta = GAME_META[game] || { name: game, icon: 'fa-gamepad', desc: '', defaultAgents: 2 };
      const numAgents = suggestedAgents || meta.defaultAgents;
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      // 会话进入"等待游戏邀请回应"状态：标签页/历史列表显示指示器，而不是"运行中"
      const ownerAgent = callingAgent || agent;
      const ownerSession = window.__sessionManager?.getByAgent(ownerAgent);
      if (window.__sessionManager && ownerSession) {
        window.__sessionManager.setAttention(ownerSession, { kind: 'game', label: '等待游戏回应' });
      }

      // Wrap inside AI message bubble (like askQuestions)
      const msg = document.createElement('div');
      msg.className = 'message assistant';

      const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);

      const body = document.createElement('div');
      body.className = 'message-body';

      const card = document.createElement('div');
      card.className = 'game-invite-card';
      card.innerHTML = `
        <div class="game-invite-header">
          <div class="game-invite-icon"><i class="fa-solid ${meta.icon}"></i></div>
          <div class="game-invite-info">
            <h4>${escapeHtml(meta.name)}</h4>
            <p>${escapeHtml(meta.desc)}</p>
          </div>
        </div>
        ${message ? `<div class="game-invite-msg">${escapeHtml(message)}</div>` : ''}
        ${game === 'guessCharacter' ? '' : `<div class="game-invite-agents">
          <label>参与 Agent 数量：</label>
          <input type="number" min="1" max="8" value="${numAgents}" class="agent-count-input" />
        </div>`}
        <div class="game-invite-actions">
          <button class="btn-game-ignore">忽略</button>
          <button class="btn-game-accept"><i class="fa-solid fa-play"></i> 开始游戏</button>
        </div>`;

      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = time;

      body.appendChild(card);
      body.appendChild(timeEl);

      msg.innerHTML = `<div class="message-avatar">${avatarHTML}</div>`;
      msg.appendChild(body);

      const btnAccept = card.querySelector('.btn-game-accept');
      const btnIgnore = card.querySelector('.btn-game-ignore');
      const agentInput = card.querySelector('.agent-count-input');

      btnAccept.addEventListener('click', () => {
        if (window.__sessionManager && ownerSession) window.__sessionManager.setAttention(ownerSession, null);
        const count = agentInput ? (parseInt(agentInput.value) || numAgents) : numAgents;
        card.classList.add('accepted');
        btnAccept.textContent = '已接受';
        btnAccept.disabled = true;
        btnIgnore.disabled = true;
        if (agentInput) agentInput.disabled = true;
        resolve({ accepted: true, game, agentCount: count });
      });

      btnIgnore.addEventListener('click', () => {
        if (window.__sessionManager && ownerSession) window.__sessionManager.setAttention(ownerSession, null);
        card.classList.add('ignored');
        btnAccept.disabled = true;
        btnIgnore.disabled = true;
        if (agentInput) agentInput.disabled = true;
        resolve({ accepted: false, game, agentCount: 0 });
      });

      if (ownerSession && typeof appendSessionCard === 'function') {
        appendSessionCard(ownerSession, msg);
      } else {
        appendChatElement(msg);
      }

      // Add right-click deletion support (counts as that turn's AI message)
      msg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMessageContextMenu(e, msg, 'assistant');
      });

      requestAnimationFrame(() => msg.scrollIntoView({ behavior: 'smooth', block: 'end' }));
    });
  };

  function addThinkingIndicator() {
    addThinkingIndicatorWithText('AI 正在思考...');
  }

  function addThinkingIndicatorWithText(text) {
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div><span>${escapeHtml(text || 'AI 正在思考...')}</span>`;
    chatMessages.appendChild(el);
    scrollChatToBottom();
    // 增量推送：思考指示器追加到 chat 容器
    WebUIMirror.pushDomEvent({
      type: 'dom_append',
      container: '#chat-messages',
      html: el.outerHTML,
    });
  }

  function removeThinkingIndicator() {
    const el = document.getElementById('thinking-indicator');
    if (el) el.remove();
    scrollChatToBottom();
    // 增量推送：移除思考指示器
    WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
  }

  function setSendButtons(isWorking) {
    if (isWorking) {
      if (btnStop) btnStop.classList.remove('hidden');
      // 热对话：发送按钮始终可见
    } else {
      // 仅在未播放语音时才隐藏停止按钮
      const speaking = (window.VoiceUI && window.VoiceUI.isSpeaking) ? window.VoiceUI.isSpeaking() : false;
      if (btnStop) btnStop.classList.toggle('hidden', !speaking);
      btnSend.classList.remove('hidden');
    }
  }

  // ---- Send Message ----
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text && currentAttachments.length === 0) return;

    // Remote 模式：转发到远程 WS，不在本地执行 Agent
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      const attachments = [...currentAttachments];
      clearAttachments();
      chatInput.value = '';
      chatInput.style.height = 'auto';

      // 上传附件到远端，构建带附件路径的消息（与 WebUI 协议一致）
      let fullMsg = text;
      if (attachments.length > 0) {
        const uploadedPaths = [];
        for (const att of attachments) {
          const up = await uploadAttachmentRemote(att);
          if (up) uploadedPaths.push(`附件: ${up.path} (${up.name})`);
          else fullMsg += `\n[附件上传失败: ${att.name}]`;
        }
        if (uploadedPaths.length > 0) {
          fullMsg = (text ? text + '\n' : '') + uploadedPaths.join('\n');
        }
      }

      if (fullMsg) addMessageToChat('user', fullMsg);
      addThinkingIndicator();
      remoteWs.send(JSON.stringify({ type: 'sendMessage', message: fullMsg }));
      return;
    }

    // 热对话：Agent工作中时注入新消息
    if (agent.running) {
      chatInput.value = '';
      chatInput.style.height = 'auto';
      WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#chat-input', value: '' });

      // Process attachments
      const attachments = [...currentAttachments];
      clearAttachments();

      let displayText = text;
      if (attachments.length > 0) {
        const names = attachments.map(a => a.name).join(', ');
        displayText += `\n[附件: ${names}]`;
      }
      addMessageToChat('user', displayText);

      await copyAttachmentsToWorkspace(attachments);

      // Process attachments: OCR for images, text extraction for documents
      for (const att of attachments) {
        if (att.isImage && att.path) {
          try {
            const ocrResult = await window.api.ocrRecognize(att.path);
            if (ocrResult.ok && ocrResult.text) att.ocrText = ocrResult.text;
          } catch (e) { console.error('OCR error:', e); }
        } else if (att.path) {
          const ext = att.name.split('.').pop().toLowerCase();
          const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
          if (officeFormats.includes(ext)) {
            try {
              const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
              if (importResult.ok && importResult.content) {
                const workspacePath = agent.workspacePath;
                if (workspacePath) {
                  const textFileName = att.name.replace(/\.\w+$/, '.txt');
                  const textFilePath = `${workspacePath}\\${textFileName}`;
                  const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                  if (saveResult.ok) {
                    att.convertedPath = textFilePath;
                    att.extractedText = `已转换为文本文件：${textFilePath}`;
                  } else {
                    att.extractedText = importResult.content;
                  }
                } else {
                  att.extractedText = importResult.content;
                }
                if (importResult.images && importResult.images.length > 0) {
                  att.extractedImages = importResult.images;
                }
              }
            } catch (e) { console.error('Document extraction error:', e); }
          }
        }
      }

      agent.injectHotMessage(text, attachments);
      return;
    }

    const chatSession = sessionManager?.getByAgent(agent);
    if (chatSession && !agent.running && !sessionManager.requestStart(chatSession)) {
      const queuedAttachments = [...currentAttachments];
      clearAttachments();
      let queuedText = text;
      if (queuedAttachments.length > 0) {
        const names = queuedAttachments.map(a => a.name).join(', ');
        queuedText += `\n[附件: ${names}]`;
      }
      addMessageToChat('user', queuedText);
      sessionManager.queue(chatSession, { text, attachments: queuedAttachments });
      addSystemMessage('当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。', { persist: false });
      return;
    }

    // 正常发送（Agent空闲时）

    // Show stop button immediately
    setSendButtons(true);

    // Check daily limits before sending
    const settings = await window.api.getSettings();
    const llmLimit = settings.llm.dailyMaxTokens || 0;
    const llmUsed = settings.llm.dailyTokensUsed || 0;
    if (llmLimit > 0) {
      if (llmUsed >= llmLimit) {
        addSystemMessage(`⚠️ 已达到今日LLM Token上限(${llmLimit})，请明天再试或在设置中重置使用量。`);
        setSendButtons(false);
        return;
      } else if (llmUsed >= llmLimit * 0.9) {
        addSystemMessage(`⚠️ 警告：今日Token已使用${llmUsed}，接近限制${llmLimit}(${((llmUsed/llmLimit)*100).toFixed(1)}%)`);
      }
    }

    chatInput.value = '';
    chatInput.style.height = 'auto';
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#chat-input', value: '' });

    // Process attachments
    const attachments = [...currentAttachments];
    clearAttachments();

    // Show message with attachment indicators
    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += `\n[附件: ${names}]`;
    }
    addMessageToChat('user', displayText);
    addThinkingIndicator();
    window.api.webControlPushMessage('user', displayText);

    await copyAttachmentsToWorkspace(attachments);

    // Process attachments: OCR for images, text extraction for documents
    for (const att of attachments) {
      if (att.isImage && att.path) {
        // OCR for images
        try {
          const ocrResult = await window.api.ocrRecognize(att.path);
          if (ocrResult.ok && ocrResult.text) {
            att.ocrText = ocrResult.text;
          }
        } catch (e) { console.error('OCR error:', e); }
      } else if (att.path) {
        // Extract text from Office/PDF files
        const ext = att.name.split('.').pop().toLowerCase();
        const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
        if (officeFormats.includes(ext)) {
          try {
            const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
            if (importResult.ok && importResult.content) {
              // 将转换后的文本保存到工作目录
              const workspacePath = agent.workspacePath;
              if (workspacePath) {
                const textFileName = att.name.replace(/\.\w+$/, '.txt');
                const textFilePath = `${workspacePath}\\${textFileName}`;
                const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                if (saveResult.ok) {
                  att.convertedPath = textFilePath;
                  att.extractedText = `已转换为文本文件：${textFilePath}`;
                } else {
                  att.extractedText = importResult.content;
                }
              } else {
                att.extractedText = importResult.content;
              }
              // 如果有图片，也提取出来
              if (importResult.images && importResult.images.length > 0) {
                att.extractedImages = importResult.images;
              }
            }
          } catch (e) { console.error('Document extraction error:', e); }
        }
      }
    }

    try {
      await agent.sendMessage(text, attachments);
    } finally {
      removeThinkingIndicator();
    }
  }

  // ---- Stop Button ----
  // 停止所有语音播报 + 清空播放队列（含后续推理的 TTS）
  function stopVoicePlayback() {
    try { if (window.VoiceUI && window.VoiceUI.stopSpeaking) window.VoiceUI.stopSpeaking(); } catch (_) {}
  }

  // 语音播报全部排空后：若 Agent 也已停止，隐藏"停止"按钮（仅在两者都完成时才隐藏）
  function refreshChatStopButton() {
    if (!btnStop) return;
    const speaking = (window.VoiceUI && window.VoiceUI.isSpeaking) ? window.VoiceUI.isSpeaking() : false;
    if (speaking) {
      btnStop.classList.remove('hidden');
    } else {
      btnStop.classList.add('hidden');
    }
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-stop', attr: 'class', value: btnStop.className });
  }
  // 语音队列全部播完（清空）后回调：重新判断是否隐藏停止按钮
  window.onVoicePlaybackIdle = () => {
    // 仅在非工作状态下评估（工作中按钮早已显示）
    if (agent && !agent.running) {
      try { refreshChatStopButton(); } catch (_) {}
      try { refreshCodeStopButton(); } catch (_) {}
      try { refreshBabeStopButton(); } catch (_) {}
    }
  };
  // 语音开始/继续播放时回调：确保 TTS 先于 Agent 结束的补播也能显示停止按钮
  window.onVoicePlaybackActive = () => {
    if (agent && !agent.running) {
      try { refreshChatStopButton(); } catch (_) {}
      try { refreshCodeStopButton(); } catch (_) {}
      try { refreshBabeStopButton(); } catch (_) {}
    }
  };

  function voiceSpeakingNow() {
    return (window.VoiceUI && window.VoiceUI.isSpeaking) ? window.VoiceUI.isSpeaking() : false;
  }
  function refreshCodeStopButton() {
    const stopBtn = document.getElementById('btn-code-stop');
    if (!stopBtn) return;
    stopBtn.classList.toggle('hidden', !(codeAgent && codeAgent.running) && !voiceSpeakingNow());
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: stopBtn.className });
  }
  function refreshBabeStopButton() {
    const stopBtn = document.getElementById('btn-babe-stop');
    if (!stopBtn) return;
    stopBtn.classList.toggle('hidden', !(babeAgent && babeAgent.running) && !voiceSpeakingNow());
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-babe-stop', attr: 'class', value: stopBtn.className });
  }

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
        remoteWs.send(JSON.stringify({ type: 'stopAgent' }));
        removeThinkingIndicator();
        return;
      }
      stopVoicePlayback();
      agent.stop();
      removeThinkingIndicator();
    });
  }

  btnSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // Quick actions
  document.querySelectorAll('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chatInput.value = btn.dataset.prompt;
      sendMessage();
    });
  });

  // ---- Attachment Handling ----
  function addAttachment(file) {
    const isImage = file.type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(file.name);
    const att = { name: file.name, size: file.size, type: file.type, isImage, path: file.path || null, pendingSave: null };

    // If it's a blob/File without path, save to workspace
    if (!att.path && file.arrayBuffer) {
      att.pendingSave = file.arrayBuffer().then(buf => {
        return window.api.saveUploadedFile(file.name, buf).then(result => {
          if (result.ok) att.path = result.path;
        });
      });
    }

    currentAttachments.push(att);
    renderAttachments();
  }

  async function copyAttachmentsToWorkspace(attachments) {
    const workspacePath = agent.workspacePath;
    if (!workspacePath || !attachments || attachments.length === 0) return;

    const normalizePath = (p) => (p || '').replace(/\//g, '\\');
    const normalizedWorkspace = normalizePath(workspacePath);
    const targetDir = normalizedWorkspace;
    await window.api.makeDirectory(targetDir);

    const pending = attachments.map(att => att.pendingSave).filter(Boolean);
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    for (const att of attachments) {
      if (!att.path) continue;
      const normalizedPath = normalizePath(att.path);
      if (normalizedPath.startsWith(normalizedWorkspace + '\\')) continue;

      const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const destPath = `${targetDir}\\${safeName}`;
      const copyResult = await window.api.copyFile(att.path, destPath);
      if (copyResult.ok) {
        att.originalPath = att.path;
        att.path = destPath;
      }
    }
  }

  function removeAttachment(index) {
    currentAttachments.splice(index, 1);
    renderAttachments();
  }

  function clearAttachments() {
    currentAttachments = [];
    renderAttachments();
  }

  function renderAttachments() {
    if (currentAttachments.length === 0) {
      attachmentsPreview.classList.add('hidden');
      attachmentsPreview.innerHTML = '';
      return;
    }
    attachmentsPreview.classList.remove('hidden');
    attachmentsPreview.innerHTML = currentAttachments.map((att, i) => `
      <div class="attachment-item">
        <i class="fa-solid ${att.isImage ? 'fa-image' : 'fa-file'}"></i>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="btn-icon attachment-remove" data-index="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `).join('');
    attachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => removeAttachment(parseInt(btn.dataset.index)));
    });
  }

  // Attach file button
  if (btnAttachFile) {
    btnAttachFile.addEventListener('click', async () => {
      const result = await window.api.openFileDialog({ multiple: true });
      if (result.ok && result.paths) {
        for (const p of result.paths) {
          const name = p.split(/[\\/]/).pop();
          const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name);
          currentAttachments.push({ name, path: p, isImage });
        }
        renderAttachments();
      }
    });
  }

  // WebUI 上传文件后通知渲染器刷新附件列表
  if (typeof window.api?.onWebControlFileUploaded === 'function') {
    window.api.onWebControlFileUploaded((data) => {
      if (data && data.path) {
        currentAttachments.push({ name: data.name, path: data.path, isImage: data.isImage });
        renderAttachments();
      }
    });
  }

  // Drag and drop
  chatMessages.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatMessages.classList.add('drag-over');
  });
  chatMessages.addEventListener('dragleave', () => {
    chatMessages.classList.remove('drag-over');
  });
  chatMessages.addEventListener('drop', (e) => {
    e.preventDefault();
    chatMessages.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      for (const file of e.dataTransfer.files) {
        addAttachment(file);
      }
    }
  });

  // Paste image
  chatInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const name = `paste-${Date.now()}.png`;
          // Save file directly
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.api.saveUploadedFile(name, arrayBuffer);
          if (result.ok) {
            currentAttachments.push({ name, path: result.path, isImage: true });
            renderAttachments();
          }
        }
      }
    }
  });

  // ---- Camera Modal ----
  if (btnCamera) {
    btnCamera.addEventListener('click', async () => {
      cameraModal.classList.remove('hidden');
      const video = document.getElementById('camera-video');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.play();
      } catch (e) {
        console.error('Camera error:', e);
        cameraModal.classList.add('hidden');
      }
    });
  }

  document.getElementById('btn-close-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-cancel-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-capture-photo')?.addEventListener('click', async () => {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();
    const name = `camera-${Date.now()}.png`;
    const result = await window.api.saveUploadedFile(name, arrayBuffer);
    if (result.ok) {
      currentAttachments.push({ name, path: result.path, isImage: true });
      renderAttachments();
    }
    closeCameraModal();
  });

  function closeCameraModal() {
    const video = document.getElementById('camera-video');
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    cameraModal.classList.add('hidden');
  }

  // ---- Image Preview Modal ----
  document.getElementById('btn-close-image-modal')?.addEventListener('click', () => {
    imagePreviewModal.classList.add('hidden');
  });
  imagePreviewModal?.addEventListener('click', (e) => {
    if (e.target === imagePreviewModal) imagePreviewModal.classList.add('hidden');
  });

  // ---- Open Workspace ----
  if (btnOpenWorkspace) {
    btnOpenWorkspace.addEventListener('click', async () => {
      if (agent.workspacePath) {
        await window.api.workspaceOpenInExplorer(agent.workspacePath);
      } else {
        const base = await window.api.workspaceGetBase();
        if (base.ok) await window.api.openFileExplorer(base.path);
      }
    });
  }

  // 统一的 Chat 欢迎消息渲染：根据生图模型配置决定是否显示"生成图片"按钮
  function renderChatWelcome() {
    const imgConfigured = !!(agent.settings?.imageGen?.apiKey && agent.settings?.imageGen?.model);
    const imgBtn = imgConfigured
      ? `<button class="quick-action-btn" data-prompt="帮我生成一张风景图片"><i class="fa-solid fa-image"></i> 生成图片</button>`
      : '';
    chatMessages.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <h2>你好，我是你的AI伙伴</h2>
        <p>我可以帮你完成各种任务，包括文件操作、代码编写、信息搜索${imgConfigured ? '、图像生成' : ''}等。告诉我你需要什么帮助吧！</p>
        <div class="quick-actions">
          <button class="quick-action-btn" data-prompt="帮我搜索一下最新的科技新闻"><i class="fa-solid fa-magnifying-glass"></i> 搜索新闻</button>
          ${imgBtn}
          <button class="quick-action-btn" data-prompt="帮我创建一个待办事项列表"><i class="fa-solid fa-list-check"></i> 待办事项</button>
          <button class="quick-action-btn" data-prompt="帮我写一段JavaScript代码"><i class="fa-solid fa-code"></i> 编写代码</button>
        </div>
      </div>`;
    document.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.addEventListener('click', () => { chatInput.value = btn.dataset.prompt; sendMessage(); });
    });
    // 增量推送：替换聊天容器内容为欢迎页
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#chat-messages', html: chatMessages.innerHTML });
  }

  // New chat
  btnNewChat.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'newChat' }));
      setTitlebarTitle('未命名对话');
      clearChatMessagesUI();
      renderChatWelcome();
      return;
    }
    createNewSession('chat');
  });

  btnClearChat.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'newChat' }));
      setTitlebarTitle('未命名对话');
      clearChatMessagesUI();
      return;
    }
    const session = sessionManager?.getActive('chat');
    if (session) {
      const running = session.status === SessionStatus.RUNNING
        || session.status === SessionStatus.WAITING_APPROVAL
        || session.status === SessionStatus.WAITING_TOOL_AUTH;
      if (running && !window.confirm('当前会话仍在运行，确定停止并清空吗？')) return;
      sessionManager.close(session);
      if (session.agent === agent) {
        const next = sessionManager.list('chat')[0];
        agent = next ? next.agent : new Agent();
      }
    }
    createNewSession('chat');
  });

  // ---- Todo Panel ----
  document.getElementById('btn-todo-toggle').addEventListener('click', () => {
    todoPanel.classList.toggle('hidden');
  });

  document.getElementById('btn-close-todo').addEventListener('click', () => {
    todoPanel.classList.add('hidden');
  });

  document.getElementById('btn-add-todo').addEventListener('click', () => {
    const text = todoInput.value.trim();
    if (!text) return;
    agent.handleTodo({ action: 'add', text });
    todoInput.value = '';
  });

  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = todoInput.value.trim();
      if (!text) return;
      agent.handleTodo({ action: 'add', text });
      todoInput.value = '';
    }
  });

  function renderTodoList(items) {
    if (items.length === 0) {
      todoList.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa-solid fa-list-check"></i><p>暂无待办事项</p></div>';
    } else {
      todoList.innerHTML = items.map(item => `
        <div class="todo-item ${item.done ? 'done' : ''}" data-id="${item.id}">
          <div class="todo-checkbox"><i class="fa-solid fa-check"></i></div>
          <span class="todo-text">${escapeHtml(item.text)}</span>
          <button class="btn-icon todo-delete" title="删除"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');
    }
    // 增量推送：替换待办列表内容
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#todo-list', html: todoList.innerHTML });
  }

  // ---- Approval Panel ----
  function showApprovalPanel(toolName, args) {
    approvalPanel.classList.remove('hidden');
    approvalPanel.dataset.toolName = toolName || 'unknown';
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
    approvalContent.textContent = `操作: ${toolDef?.desc || toolName}\n\n参数:\n${JSON.stringify(args, null, 2)}`;
    // 增量推送：显示审批面板并更新内容
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#approval-content', text: approvalContent.textContent });
    // 系统通知：敏感操作需要审批时
    const dispName = toolDef?.desc || toolName || '未知操作';
    sendAppNotification('approval', '需要您的批准', `Agent 请求执行: ${dispName}`);
  }

  document.getElementById('btn-approve').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    // 持久化审批决策到聊天历史
    try {
      const toolName = approvalPanel.dataset.toolName || 'unknown';
      addSystemMessage(`[审批] 用户批准执行工具: ${toolName}`, { persist: true });
    } catch {}
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'approvalResponse', approved: true }));
      return;
    }
    agent.resolveApproval(true);
  });

  document.getElementById('btn-deny').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    // 持久化审批决策到聊天历史
    try {
      const toolName = approvalPanel.dataset.toolName || 'unknown';
      addSystemMessage(`[审批] 用户拒绝执行工具: ${toolName}`, { persist: true });
    } catch {}
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'approvalResponse', approved: false }));
      return;
    }
    agent.resolveApproval(false);
  });

  // ---- 工具首次使用授权模态框（Playwright / Computer Use）----
  // 不同类别展示不同的风险说明
  const _TOOL_AUTH_META = {
    playwright: {
      title: '内置浏览器授权',
      icon: 'fa-globe',
      warning: `<strong>AI 请求使用内置浏览器（Playwright）。</strong><br>该工具可由 AI 自动打开网页、点击元素、输入文字并截图。可能涉及：`
        + `<ul><li>自动浏览未知网页（可能触发验证码或追踪）</li>`
        + `<li>自动填写表单（请勿在敏感网站登录时使用）</li>`
        + `<li>页面截图可能包含隐私内容</li></ul>`
    },
    computerUse: {
      title: '电脑控制授权',
      icon: 'fa-desktop',
      warning: `<strong>AI 请求使用电脑控制（Computer Use Protocol）。</strong><br>该工具将截取屏幕、模拟鼠标点击与键盘输入，可控制整个桌面。可能涉及：`
        + `<ul><li>截取整个屏幕（可能包含敏感信息）</li>`
        + `<li>自动点击任意位置（包括系统按钮、文件）</li>`
        + `<li>模拟键盘输入（可能触发快捷键、关闭窗口）</li></ul>`
        + `<strong>请确保已保存所有工作，关闭敏感窗口后再授权。</strong>`
    }
  };

  /**
   * 显示"工具首次使用授权"模态框。
   * @param {string} toolName - 当前调用的工具名（用于显示）
   * @param {'playwright'|'computerUse'} category - 授权类别
   * @param {object} agentInstance - 当前模式的 agent 实例（用于回调 resolveToolAuth）
   */
  function showToolAuthModal(toolName, category, agentInstance) {
    if (!toolAuthModal) return;
    _toolAuthAgent = agentInstance || null;
    const meta = _TOOL_AUTH_META[category] || {
      title: '工具授权',
      icon: 'fa-shield-halved',
      warning: `<strong>AI 请求使用工具 ${toolName}。</strong><br>该工具需要您授权后才能使用。`
    };
    if (toolAuthTitleEl) toolAuthTitleEl.textContent = meta.title;
    if (toolAuthIconEl) toolAuthIconEl.className = `fa-solid ${meta.icon}`;
    if (toolAuthWarningEl) toolAuthWarningEl.innerHTML = meta.warning;
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
    const dispName = toolDef?.desc || toolName;
    if (toolAuthToolEl) {
      toolAuthToolEl.innerHTML = `当前工具：<code>${escapeHtmlSimple(toolName)}</code> — ${escapeHtmlSimple(dispName)}`;
    }
    toolAuthModal.classList.remove('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tool-auth-modal', attr: 'class', value: toolAuthModal.className });
    // 系统通知
    sendAppNotification('approval', '工具授权请求', `AI 请求使用: ${dispName}`);
  }

  function _closeToolAuthModal() {
    if (!toolAuthModal) return;
    toolAuthModal.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tool-auth-modal', attr: 'class', value: toolAuthModal.className });
  }

  function _resolveToolAuth(decision) {
    _closeToolAuthModal();
    const a = _toolAuthAgent;
    _toolAuthAgent = null;
    try {
      if (a && typeof a.resolveToolAuth === 'function') a.resolveToolAuth(decision);
    } catch (e) { /* ignore */ }
    // 授权决策完成后，异步刷新工具页"授权状态列表"
    // agent 在 'allow-always' 时会异步写入 settings.toolAuthGranted，等其完成再刷新
    if (decision === 'allow-always' || decision === 'allow-once' || decision === 'deny') {
      setTimeout(() => {
        try { renderToolAuthList(); } catch {}
      }, 300);
    }
  }

  const _btnToolAuthDeny = document.getElementById('btn-tool-auth-deny');
  const _btnToolAuthOnce = document.getElementById('btn-tool-auth-once');
  const _btnToolAuthAlways = document.getElementById('btn-tool-auth-always');
  const _btnCloseToolAuth = document.getElementById('btn-close-tool-auth');
  if (_btnToolAuthDeny) _btnToolAuthDeny.addEventListener('click', () => _resolveToolAuth('deny'));
  if (_btnToolAuthOnce) _btnToolAuthOnce.addEventListener('click', () => _resolveToolAuth('allow-once'));
  if (_btnToolAuthAlways) _btnToolAuthAlways.addEventListener('click', () => _resolveToolAuth('allow-always'));
  if (_btnCloseToolAuth) _btnCloseToolAuth.addEventListener('click', () => _resolveToolAuth('deny'));

  // ---- 关闭时询问"后台运行"模态框（Tray Mode）----
  const trayAskModal = document.getElementById('tray-ask-modal');
  function _showTrayAskModal() {
    if (!trayAskModal) return;
    trayAskModal.classList.remove('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tray-ask-modal', attr: 'class', value: trayAskModal.className });
  }
  function _closeTrayAskModal() {
    if (!trayAskModal) return;
    trayAskModal.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tray-ask-modal', attr: 'class', value: trayAskModal.className });
  }
  function _respondTrayAsk(decision) {
    _closeTrayAskModal();
    try { window.api.trayRespondCloseDecision(decision); } catch {}
  }
  const _btnTrayNever = document.getElementById('btn-tray-never');
  const _btnTrayOnce = document.getElementById('btn-tray-once');
  const _btnTrayAlways = document.getElementById('btn-tray-always');
  const _btnTrayCancel = document.getElementById('btn-tray-cancel');
  if (_btnTrayNever) _btnTrayNever.addEventListener('click', () => _respondTrayAsk('never'));
  if (_btnTrayOnce) _btnTrayOnce.addEventListener('click', () => _respondTrayAsk('once'));
  if (_btnTrayAlways) _btnTrayAlways.addEventListener('click', () => _respondTrayAsk('always'));
  if (_btnTrayCancel) _btnTrayCancel.addEventListener('click', () => _respondTrayAsk('cancel'));
  // 监听主进程的询问事件
  try {
    window.api.onTrayAskCloseDecision(() => _showTrayAskModal());
  } catch {}

  // ---- Tools Page ----
  function renderToolsStats(mode) {
    mode = mode || codeEditorModeFilter || 'chat';
    const enabledSettings = agent.settings.tools || {};
    const allDefs = getAllToolDefinitions(mode);
    const total = allDefs.length;
    const enabledCount = allDefs.filter(t => enabledSettings[t.name] !== false).length;
    const enabledSchemas = getToolSchemas(enabledSettings, mode);
    const schemaChars = JSON.stringify(enabledSchemas).length;
    const estTokens = Math.ceil(schemaChars / 4);
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeTools = (typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => enabledSettings[t.name] !== false).map(t => t.name);
    const activeMap = {};
    allDefs.forEach(t => { activeMap[t.name] = false; });
    activeTools.forEach(n => { activeMap[n] = true; });
    const activeSchemas = getToolSchemas(activeMap, mode);
    const activeTokens = Math.ceil(JSON.stringify(activeSchemas).length / 4);
    const savedTokens = Math.max(0, estTokens - activeTokens);
    const mcpCount = MCP_DYNAMIC_TOOLS.length;
    const mcpBadge = mcpCount > 0 ? `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-plug-circle-bolt"></i> MCP动态 <strong>${mcpCount}</strong></span>` : '';
    const optimizedInfo = agent.settings.autoOptimizeToolSelection
      ? (hasOptimized
        ? `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前优化: <strong>${activeTools.length}</strong> / ${enabledCount}</span><span class="tools-stat"><i class="fa-solid fa-compress"></i> 优化后 <strong>~${activeTokens.toLocaleString()}</strong> tokens（节省 ~${savedTokens.toLocaleString()}）</span><span class="tools-stat" title="${escapeHtml(agent.optimizedToolReason || '')}"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(agent.optimizedToolReason || '已优化')}</span>`
        : `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前优化: <strong>未执行</strong></span>`)
      : '';
    const statsEl = document.getElementById('tools-stats');
    if (statsEl) {
      statsEl.innerHTML = `<span class="tools-stat"><i class="fa-solid fa-toggle-on"></i> 已启用 <strong>${enabledCount}</strong> / ${total} 个工具</span><span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-layer-group"></i> 工具上下文 <strong>~${estTokens.toLocaleString()}</strong> tokens</span>${mcpBadge}${optimizedInfo}`;
    }
  }

  function loadToolsPage() {
    const groupsEl = document.getElementById('tools-groups');
    const enabledSettings = agent.settings.tools || {};
    // Filter tools by current mode (Chat vs Code)
    const mode = codeEditorModeFilter || 'chat';
    const allDefs = getAllToolDefinitions(mode);
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeToolSet = new Set((typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => enabledSettings[t.name] !== false).map(t => t.name));
    renderToolsStats(mode);

    // Sync mode switcher buttons
    document.querySelectorAll('.tools-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.toolMode === mode);
      // Style active button
      if (btn.dataset.toolMode === mode) {
        btn.style.background = 'var(--accent, #6366f1)';
        btn.style.color = 'white';
        btn.style.borderColor = 'transparent';
      } else {
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
      }
    });

    const autoOptimizeEl = document.getElementById('toggle-auto-optimize-tools');
    const autoOptimizeLabel = document.querySelector('.tools-auto-optimize');
    if (autoOptimizeEl) {
      autoOptimizeEl.checked = !!agent.settings.autoOptimizeToolSelection;
      // Code 模式不使用自动优化（始终用全部启用工具），隐藏开关
      if (autoOptimizeLabel) autoOptimizeLabel.style.display = (mode === 'code') ? 'none' : '';
      autoOptimizeEl.onchange = async () => {
        if (autoOptimizeEl.checked) {
          const confirmed = await window.confirmDialog(
            '开启后，每个新对话首条消息前会先优化本次可用工具集合，以节省上下文占用。\n\n注意：若任务中途发现工具不足，AI会通过内部机制重新优化。是否继续开启？',
            '开启自动优化工具选择'
          );
          if (!confirmed) {
            autoOptimizeEl.checked = false;
            return;
          }
        }
        agent.settings.autoOptimizeToolSelection = !!autoOptimizeEl.checked;
        await window.api.setSettings(agent.settings);
        if (typeof agent.resetOptimizedTools === 'function') {
          agent.resetOptimizedTools();
        }
        updateReoptimizeButtonVisibility();
        renderToolsStats();
      };
    }

    const categoryMap = new Map();
    for (const tool of allDefs) {
      const cat = tool.category || '其他';
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat).push(tool);
    }

    const categoryEntries = Array.from(categoryMap.entries());
    groupsEl.innerHTML = categoryEntries.map(([category, tools]) => {
      const enabledCount = tools.filter(t => enabledSettings[t.name] !== false).length;
      const categoryChecked = enabledCount === tools.length;
      const toolCards = tools.map(tool => {
        const enabled = enabledSettings[tool.name] !== false;
        const active = enabled && activeToolSet.has(tool.name);
        const optimizeClass = agent.settings.autoOptimizeToolSelection
          ? (hasOptimized ? (active ? 'optimized-active' : 'optimized-muted') : '')
          : '';
        const mcpBadge = tool.serverName
          ? `<span class="tool-badge-mcp" title="${typeof t === 'function' ? t('ui.tools.mcp_from', '来自 MCP 服务器: ', {}) : '来自 MCP 服务器: '}${escapeHtml(tool.serverName)}"><i class="fa-solid fa-plug-circle-bolt"></i> ${typeof t === 'function' ? t('ui.tools.mcp_dynamic', '动态', {}) : '动态'} · ${escapeHtml(tool.serverName)}</span>`
          : '';
        const _desc = typeof i18nGetToolDesc === 'function' ? i18nGetToolDesc(tool.name, tool.desc) : tool.desc;
        return `
          <div class="tool-card ${enabled ? '' : 'disabled'} ${optimizeClass}" data-tool="${tool.name}">
            <div class="tool-icon"><i class="fa-solid ${tool.icon}"></i></div>
            <div class="tool-info">
              <div class="tool-name">${tool.name}${mcpBadge}</div>
              <div class="tool-desc">${_desc}</div>
            </div>
            <div class="tool-toggle">
              <div class="toggle-switch">
                <input type="checkbox" ${enabled ? 'checked' : ''} data-tool-name="${tool.name}">
                <span class="toggle-slider"></span>
              </div>
            </div>
          </div>`;
      }).join('');
      const isMcpCategory = category.startsWith('MCP:');
      const mcpRefreshBtn = isMcpCategory
        ? `<button class="mcp-refresh-btn" data-mcp-refresh="${escapeHtml(category)}" title="刷新MCP工具"><i class="fa-solid fa-arrows-rotate"></i></button>`
        : '';
      return `
        <div class="tool-group ${isMcpCategory ? 'mcp-tool-group' : ''}" data-tool-category="${category}">
          <div class="tool-group-header">
            <div class="tool-group-meta">
              <div class="tool-group-title">${isMcpCategory ? '<i class="fa-solid fa-plug-circle-bolt"></i> ' : ''}${typeof i18nGetCategory === 'function' ? i18nGetCategory(category, category) : category}</div>
              <div class="tool-group-count"><span data-category-enabled>${enabledCount}</span> / ${tools.length} ${typeof t === 'function' ? t('ui.tools.enabled', '已启用', {}) : '已启用'}${mcpRefreshBtn}</div>
            </div>
            <label class="tool-group-toggle">
              <span>${typeof t === 'function' ? t('ui.tools.group_toggle', '整组开关', {}) : '整组开关'}</span>
              <div class="toggle-switch">
                <input type="checkbox" ${categoryChecked ? 'checked' : ''} data-tool-category-toggle="${category}">
                <span class="toggle-slider"></span>
              </div>
            </label>
          </div>
          <div class="tools-grid">${toolCards}</div>
        </div>`;
    }).join('');

    groupsEl.querySelectorAll('input[data-tool-name]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const name = cb.dataset.toolName;
        await updateToolSetting(name, cb.checked, cb);
      });
    });

    groupsEl.querySelectorAll('input[data-tool-category-toggle]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const category = cb.dataset.toolCategoryToggle;
        await setToolCategoryEnabled(category, cb.checked);
      });
    });

    groupsEl.querySelectorAll('.tool-card').forEach(card => {
      card.addEventListener('click', async (e) => {
        if (e.target.closest('input')) return;
        const cb = card.querySelector('input[data-tool-name]');
        if (!cb) return;
        cb.checked = !cb.checked;
        await updateToolSetting(cb.dataset.toolName, cb.checked, cb);
      });
    });

    // MCP refresh buttons
    groupsEl.querySelectorAll('.mcp-refresh-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.classList.add('spinning');
        btn.disabled = true;
        try {
          const result = await window.api.mcpListTools();
          if (result && result.tools) {
            registerMcpTools(result.tools);
            agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
            loadToolsPage();
          }
        } catch (err) {
          console.error('[MCP Refresh]', err);
        } finally {
          btn.classList.remove('spinning');
          btn.disabled = false;
        }
      });
    });

    // 渲染工具首次使用授权状态列表（Playwright / Computer Use）
    renderToolAuthList();
  }

  /**
   * 渲染工具首次使用授权状态列表（在工具管理页底部）。
   * 显示每个可授权工具的类别、当前状态（已授权/待授权）和撤销按钮。
   */
  async function renderToolAuthList() {
    const listEl = document.getElementById('tool-auth-list');
    if (!listEl) return;
    let settings;
    try { settings = await window.api.getSettings(); }
    catch (e) { return; }
    const granted = settings?.toolAuthGranted || { playwright: false, computerUse: false };
    const items = [
      {
        category: 'playwright',
        icon: 'fa-globe',
        name: '内置浏览器（Playwright）',
        granted: !!granted.playwright
      },
      {
        category: 'computerUse',
        icon: 'fa-desktop',
        name: '电脑控制（Computer Use）',
        granted: !!granted.computerUse
      }
    ];
    listEl.innerHTML = items.map(it => `
      <div class="tool-auth-item" data-category="${it.category}">
        <div class="ta-name"><i class="fa-solid ${it.icon}"></i> ${escapeHtml(it.name)}</div>
        <div class="ta-status ${it.granted ? 'granted' : 'pending'}">${it.granted ? '已授权' : '待授权'}</div>
        <button class="ta-revoke" ${it.granted ? '' : 'disabled'} data-cat="${it.category}">
          <i class="fa-solid fa-rotate-left"></i> 撤销
        </button>
      </div>
    `).join('');
    // 绑定撤销按钮
    listEl.querySelectorAll('.ta-revoke').forEach(btn => {
      btn.onclick = async () => {
        const cat = btn.dataset.cat;
        if (!cat) return;
        const ok = await window.confirmDialog(
          `撤销"${cat === 'playwright' ? '内置浏览器' : '电脑控制'}"的授权？\n\n下次 AI 调用该工具时将再次弹出授权询问。`,
          '撤销工具授权'
        );
        if (!ok) return;
        try {
          const s = await window.api.getSettings();
          if (!s.toolAuthGranted) s.toolAuthGranted = { playwright: false, computerUse: false };
          s.toolAuthGranted[cat] = false;
          await window.api.setSettings(s);
          // 同步刷新当前 agent 实例的 settings 和会话内缓存
          for (const a of [agent, codeAgent, babeAgent]) {
            if (a && a.settings) a.settings = s;
            if (a && a._sessionToolAuth) a._sessionToolAuth[cat] = false;
          }
          renderToolAuthList();
        } catch (e) { /* ignore */ }
      };
    });
  }

  async function setToolCategoryEnabled(category, enabled) {
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    const toolsInCategory = getAllToolDefinitions(codeEditorModeFilter || 'chat').filter(t => (t.category || '其他') === category);
    toolsInCategory.forEach(t => {
      agent.settings.tools[t.name] = enabled;
    });
    await window.api.setSettings(agent.settings);
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    if (typeof agent.resetOptimizedTools === 'function') {
      agent.resetOptimizedTools();
    }
    loadToolsPage();
  }

  async function updateToolSetting(name, enabled, checkboxEl) {
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    agent.settings.tools[name] = enabled;
    await window.api.setSettings(agent.settings);
    if (checkboxEl) {
      checkboxEl.closest('.tool-card')?.classList.toggle('disabled', !enabled);
    }
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    if (typeof agent.resetOptimizedTools === 'function') {
      agent.resetOptimizedTools();
    }
    renderToolsStats();
    const groupEl = checkboxEl?.closest('.tool-group');
    if (groupEl) {
      const allChecks = Array.from(groupEl.querySelectorAll('input[data-tool-name]'));
      const enabledCount = allChecks.filter(c => c.checked).length;
      const countEl = groupEl.querySelector('[data-category-enabled]');
      if (countEl) countEl.textContent = String(enabledCount);
      const toggle = groupEl.querySelector('input[data-tool-category-toggle]');
      if (toggle) toggle.checked = enabledCount === allChecks.length;
    }
  }

  // ---- Skills Page ----
  async function importStandardSkillFile(skillMdPath) {
    const readResult = await window.api.readFile(skillMdPath);
    if (!readResult?.ok) return { ok: false, error: readResult?.error || '读取 SKILL.md 失败' };

    const rootDir = getPathDirname(skillMdPath);
    const scripts = await collectSkillScripts(rootDir);
    const skillPayload = buildStandardSkillFromMarkdown(skillMdPath, readResult.content || '', scripts);

    const existing = await window.api.listSkills();
    const matched = (Array.isArray(existing) ? existing : []).find(s => String(s?.sourcePath || '') === String(skillMdPath));
    if (matched?.id) {
      const updated = await window.api.updateSkill(matched.id, skillPayload);
      if (updated?.ok === false) return { ok: false, error: updated.error || '更新技能失败' };
      return { ok: true, mode: 'updated', name: skillPayload.name };
    }
    const created = await window.api.createSkill(skillPayload);
    if (!created) return { ok: false, error: '创建技能失败' };
    return { ok: true, mode: 'created', name: skillPayload.name };
  }

  async function loadSkillsPage() {
    const list = document.getElementById('skills-list');
    const userSkills = await window.api.listSkills();
    // Merge bundled (built-in) skills with user skills.
    // User skills with the same name override bundled skills (matching agent behavior).
    let bundled = [];
    try {
      if (typeof BUNDLED_SKILLS !== 'undefined') bundled = BUNDLED_SKILLS || [];
    } catch { /* bundled-skills.js not loaded */ }
    const overriddenNames = new Set(userSkills.map(s => s.name));
    const visibleBundled = bundled.filter(s => !overriddenNames.has(s.name));
    const allSkills = [...visibleBundled, ...userSkills];

    if (allSkills.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-lightbulb"></i><p>暂无技能，点击上方按钮添加或导入 SKILL.md</p></div>';
      return;
    }
    list.innerHTML = allSkills.map(s => {
      const isBundled = !!s.bundled;
      const isOverriding = !isBundled && bundled.some(b => b.name === s.name);
      const iconClass = isBundled ? 'fa-shield-halved' : 'fa-lightbulb';
      const badgeHtml = isBundled
        ? '<span class="skill-badge skill-badge-builtin">内置</span>'
        : (isOverriding ? '<span class="skill-badge skill-badge-override">覆盖内置</span>' : '');
      const actionsHtml = isBundled
        ? `<button class="btn-icon skill-view" data-id="${escapeHtml(s.id || '')}" title="查看（只读）"><i class="fa-solid fa-eye"></i></button>`
        : `<button class="btn-icon skill-edit" data-id="${escapeHtml(s.id || '')}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
           <button class="btn-icon skill-delete" data-id="${s.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>`;
      return `
      <div class="skill-card${isBundled ? ' skill-card-builtin' : ''}" data-id="${s.id}">
        <div class="skill-icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="skill-info">
          <div class="skill-name">${escapeHtml(s.name || '')} ${badgeHtml}</div>
          <div class="skill-desc">${escapeHtml(s.description || '')}</div>
          <div class="skill-meta">${escapeHtml(getSkillSummaryMeta(s))}</div>
        </div>
        <div class="skill-actions">${actionsHtml}</div>
      </div>`;
    }).join('');

    list.querySelectorAll('.skill-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.deleteSkill(btn.dataset.id);
        if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        loadSkillsPage();
      });
    });

    list.querySelectorAll('.skill-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        window.api.openSkillEditor({ id: btn.dataset.id });
      });
    });

    list.querySelectorAll('.skill-view').forEach(btn => {
      btn.addEventListener('click', () => {
        window.api.openSkillEditor({ id: btn.dataset.id, readonly: true });
      });
    });
  }

  // Skill Modal
  function _resetSkillModalEditable() {
    ['skill-name', 'skill-desc', 'skill-prompt'].forEach(fid => {
      const el = document.getElementById(fid);
      if (el) el.removeAttribute('readonly');
    });
    const saveBtn = document.getElementById('btn-save-skill');
    if (saveBtn) saveBtn.style.display = '';
  }
  document.getElementById('btn-add-skill').addEventListener('click', () => {
    window.api.openSkillEditor({});
  });

  document.getElementById('btn-close-skill-modal').addEventListener('click', () => {
    _resetSkillModalEditable();
    document.getElementById('skill-modal').classList.add('hidden');
  });

  document.getElementById('btn-cancel-skill').addEventListener('click', () => {
    _resetSkillModalEditable();
    document.getElementById('skill-modal').classList.add('hidden');
  });

  document.getElementById('btn-save-skill').addEventListener('click', async () => {
    const editId = document.getElementById('skill-edit-id').value;
    const name = document.getElementById('skill-name').value.trim();
    const description = document.getElementById('skill-desc').value.trim();
    const prompt = document.getElementById('skill-prompt').value.trim();
    if (!name) return;
    if (editId) {
      await window.api.updateSkill(editId, { name, description, prompt });
    } else {
      await window.api.createSkill({ name, description, prompt });
    }
    if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    _resetSkillModalEditable();
    document.getElementById('skill-modal').classList.add('hidden');
    document.getElementById('skill-name').value = '';
    document.getElementById('skill-desc').value = '';
    document.getElementById('skill-prompt').value = '';
    document.getElementById('skill-edit-id').value = '';
    loadSkillsPage();
  });

  const btnImportStandardSkill = document.getElementById('btn-import-standard-skill');
  if (btnImportStandardSkill) {
    btnImportStandardSkill.addEventListener('click', async () => {
      const selectResult = await window.api.openFileDialog({
        title: '选择标准 Skill 文件（SKILL.md）',
        multiple: true,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
      });
      if (!selectResult?.ok || !Array.isArray(selectResult.paths) || selectResult.paths.length === 0) return;

      const resultLines = [];
      for (const skillPath of selectResult.paths) {
        try {
          const imported = await importStandardSkillFile(skillPath);
          if (imported.ok) {
            resultLines.push(`${imported.mode === 'updated' ? '更新' : '导入'}成功：${imported.name}`);
          } else {
            resultLines.push(`导入失败：${getPathBasename(skillPath)} (${imported.error || '未知错误'})`);
          }
        } catch (e) {
          resultLines.push(`导入失败：${getPathBasename(skillPath)} (${e.message})`);
        }
      }

      if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      loadSkillsPage();
      addMessage('system', `技能导入结果：\n- ${resultLines.join('\n- ')}`);
    });
  }

  // ---- Knowledge Page ----
  async function loadKnowledgePage(query = '') {
    const list = document.getElementById('knowledge-list');
    const items = await window.api.knowledgeSearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-database"></i><p>知识库为空</p></div>';
      return;
    }
    list.innerHTML = items.map(k => `
      <div class="knowledge-item" data-id="${k.id}">
        <div class="item-title">${escapeHtml(k.title || '未命名')}</div>
        <div class="item-content">${escapeHtml(k.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(k.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-actions">
            <button class="btn-icon knowledge-delete" data-id="${k.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.knowledge-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条知识吗？');
        if (!confirmed) return;
        await window.api.knowledgeDelete(btn.dataset.id);
        loadKnowledgePage(query);
      });
    });
  }

  document.getElementById('knowledge-search').addEventListener('input', (e) => {
    loadKnowledgePage(e.target.value);
  });

  // Knowledge import button
  const btnImportKnowledge = document.getElementById('btn-import-knowledge');
  if (btnImportKnowledge) {
    btnImportKnowledge.addEventListener('click', async () => {
      try {
        // 先选择文件
        const selectResult = await window.api.openFileDialog();
        if (!selectResult.ok || !selectResult.paths || selectResult.paths.length === 0) return;

        // 对每个文件进行导入
        for (const filePath of selectResult.paths) {
          const result = await window.api.knowledgeImportFile(filePath, agent.workspacePath);
          if (result.ok) {
            const title = result.fileName || '导入文件';
            await window.api.knowledgeAdd({ title, content: result.content });

            // 如果有提取的图片，也添加到消息中作为引用
            if (result.images && result.images.length > 0) {
              await window.api.knowledgeAdd({
                title: `${title} - 图片`,
                content: `图片文件：${result.images.join(', ')}`
              });
            }
          } else {
            const errMsg = result.error || '导入失败';
            if (typeof window.showToast === 'function') {
              window.showToast(`${result.fileName || '文件'}: ${errMsg}`, 'error', 6000);
            } else {
              console.error('Knowledge import failed:', errMsg);
            }
          }
        }
        loadKnowledgePage();
      } catch (e) {
        console.error('Import knowledge error:', e);
      }
    });
  }

  // ---- Memory Page ----
  async function loadMemoryPage(query = '') {
    const list = document.getElementById('memory-list');
    const items = await window.api.memorySearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-brain"></i><p>暂无长期记忆</p></div>';
      return;
    }
    list.innerHTML = items.map(m => `
      <div class="memory-item" data-id="${m.id}">
        <div class="item-content">${escapeHtml(m.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(m.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-tags">${(m.tags || []).map(t => `<span class="item-tag">${escapeHtml(t)}</span>`).join('')}</div>
          <div class="item-actions">
            <button class="btn-icon memory-edit" data-id="${m.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
            <button class="btn-icon memory-delete" data-id="${m.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.memory-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条记忆吗？');
        if (!confirmed) return;
        await window.api.memoryDelete(btn.dataset.id);
        loadMemoryPage(query);
      });
    });

    list.querySelectorAll('.memory-edit').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const current = items.find(i => String(i.id) === String(id));
        const result = await openMemoryEditDialog(current);
        if (!result) return;
        await window.api.memoryUpdate(id, { content: result.content, tags: result.tags });
        loadMemoryPage(query);
      });
    });
  }

  document.getElementById('memory-search').addEventListener('input', (e) => {
    loadMemoryPage(e.target.value);
  });

  // ---- Memory Edit Modal ----
  let memoryEditResolve = null;
  function openMemoryEditDialog(item) {
    return new Promise((resolve) => {
      const modal = document.getElementById('memory-edit-modal');
      const contentEl = document.getElementById('memory-edit-content');
      const tagsEl = document.getElementById('memory-edit-tags');
      if (!modal || !contentEl || !tagsEl) {
        resolve(null);
        return;
      }
      memoryEditResolve = resolve;
      contentEl.value = item?.content || '';
      tagsEl.value = (item?.tags || []).join(', ');
      modal.classList.remove('hidden');
      contentEl.focus();
    });
  }

  function closeMemoryEditDialog(result) {
    const modal = document.getElementById('memory-edit-modal');
    modal?.classList.add('hidden');
    if (memoryEditResolve) {
      memoryEditResolve(result);
      memoryEditResolve = null;
    }
  }

  document.getElementById('btn-close-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-cancel-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-save-memory-edit')?.addEventListener('click', () => {
    const contentEl = document.getElementById('memory-edit-content');
    const tagsEl = document.getElementById('memory-edit-tags');
    const content = contentEl?.value.trim() || '';
    const tags = (tagsEl?.value || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!content) return;
    closeMemoryEditDialog({ content, tags });
  });

  // ---- Settings Page ----
  function updateLLMProviderFields(provider) {
    const openaiFields = document.getElementById('llm-openai-fields');
    const zenFields = document.getElementById('llm-zen-fields');
    if (!openaiFields || !zenFields) return;
    if (provider === 'opencode-zen') {
      openaiFields.classList.add('hidden');
      zenFields.classList.remove('hidden');
    } else {
      openaiFields.classList.remove('hidden');
      zenFields.classList.add('hidden');
    }
  }

  async function refreshZenModels(selectedModel) {
    const sel = document.getElementById('setting-llm-zen-model');
    const hint = document.getElementById('zen-model-hint');
    if (!sel) return;
    sel.innerHTML = '<option value="">加载中...</option>';
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      const res = await window.api.zenFetchModels();
      if (!res || !res.ok || !Array.isArray(res.models)) {
        sel.innerHTML = '<option value="">(获取失败)</option>';
        if (hint) hint.textContent = res?.error || '获取失败，请检查 Zen API Key 或网络';
        return;
      }
      const FREE_KEYWORDS = /free|big-pickle|mimo|north-mini|nemotron|hy3/;
      // 检测是否为免登录公共 key：若是，则只展示免费模型
      const keyInput = document.getElementById('setting-llm-zen-key');
      const isPublicKey = (keyInput?.value || '').trim() === 'public' || keyInput?.dataset?.publicKey === '1';
      let models = res.models.slice();
      if (isPublicKey) {
        models = models.filter(m => FREE_KEYWORDS.test(m.id));
      }
      models.sort((a, b) => {
        const af = FREE_KEYWORDS.test(a.id) ? 0 : 1;
        const bf = FREE_KEYWORDS.test(b.id) ? 0 : 1;
        if (af !== bf) return af - bf;
        return (a.id || '').localeCompare(b.id || '');
      });
      sel.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        const isFree = FREE_KEYWORDS.test(m.id);
        opt.textContent = (isFree ? '[免费] ' : '') + (m.name || m.id);
        sel.appendChild(opt);
      }
      if (selectedModel) {
        // try exact match
        let matched = false;
        for (const opt of sel.options) {
          if (opt.value === selectedModel) { opt.selected = true; matched = true; break; }
        }
        if (!matched && sel.options.length > 0) {
          sel.options[0].selected = true;
        }
      }
      if (hint) hint.textContent = `共 ${models.length} 个可用模型（标 [免费] 的为免费模型）`;
    } catch (e) {
      sel.innerHTML = '<option value="">(获取失败)</option>';
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
    }
  }

  async function refreshLLMModels() {
    const provider = document.getElementById('setting-llm-provider')?.value || 'openai-compat';
    const apiUrl = document.getElementById('setting-llm-url')?.value || '';
    const apiKey = document.getElementById('setting-llm-key')?.value || '';
    const hint = document.getElementById('llm-model-hint');
    const list = document.getElementById('llm-model-list');
    if (!list) return;
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      const res = await window.api.llmFetchModels(provider, apiUrl, apiKey);
      if (!res || !res.ok || !Array.isArray(res.models)) {
        if (hint) hint.textContent = res?.error || '获取失败，请检查 API URL/Key 或网络';
        return;
      }
      list.innerHTML = '';
      for (const m of res.models) {
        const opt = document.createElement('option');
        opt.value = m.id || m.name || '';
        opt.textContent = m.id || m.name || '';
        list.appendChild(opt);
      }
      if (hint) hint.textContent = `共 ${res.models.length} 个可用模型`;
    } catch (e) {
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
    }
  }

  async function loadUsageStats(period) {
    const summaryEl = document.getElementById('usage-summary');
    const chartEl = document.getElementById('usage-chart');
    const modelsEl = document.getElementById('usage-models');
    if (!summaryEl || !chartEl || !modelsEl) return;
    summaryEl.innerHTML = '<div style="opacity:0.6">加载中...</div>';
    chartEl.innerHTML = '';
    modelsEl.innerHTML = '';
    try {
      const res = await window.api.usageGetRange(period || 'daily');
      if (!res || !res.ok) {
        summaryEl.innerHTML = '<div>加载失败</div>';
        return;
      }
      const fmt = (n) => (n || 0).toLocaleString();
      const fmtUSD = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const data = res;
      const hasCost = (data.costUSD || 0) > 0 || (data.inputCost || 0) > 0 || (data.outputCost || 0) > 0;
      const cards = [
        { label: '总 Token', value: fmt(data.totalTokens), accent: true },
        { label: '提示 Token', value: fmt(data.promptTokens) },
        { label: '生成 Token', value: fmt(data.completionTokens) },
        { label: '请求次数', value: fmt(data.requestCount) }
      ];
      // 若有费用数据则加入金钱卡片
      if (hasCost) {
        cards.push({ label: '总消费 (USD)', value: fmtUSD(data.costUSD), accent: true, kind: 'cost' });
        cards.push({ label: '输入消费', value: fmtUSD(data.inputCost), kind: 'cost' });
        cards.push({ label: '输出消费', value: fmtUSD(data.outputCost), kind: 'cost' });
        if ((data.cacheReadCost || 0) > 0) cards.push({ label: '缓存读消费', value: fmtUSD(data.cacheReadCost), kind: 'cost' });
        if ((data.cacheWriteCost || 0) > 0) cards.push({ label: '缓存写消费', value: fmtUSD(data.cacheWriteCost), kind: 'cost' });
      }
      summaryEl.innerHTML = cards.map(c =>
        `<div class="usage-card${c.accent ? ' accent' : ''}${c.kind === 'cost' ? ' cost' : ''}">
          <div class="usage-card-label">${c.label}</div>
          <div class="usage-card-value">${c.value}</div>
        </div>`
      ).join('');
      // chart: 按小时（daily）或按天（weekly/monthly）
      const isHourly = data.isHourly;
      const chartTitleEl = document.getElementById('usage-chart-title');
      if (chartTitleEl) chartTitleEl.textContent = isHourly ? '按小时趋势' : '按日趋势';
      const chartData = isHourly ? (data.hours || []) : (data.days || []);
      if (chartData.length === 0) {
        chartEl.innerHTML = '<div style="opacity:0.5;font-size:12px;width:100%;text-align:center;">无数据</div>';
      } else {
        const max = Math.max(1, ...chartData.map(d => d.total || 0));
        chartEl.innerHTML = chartData.map(d => {
          const h = Math.max(2, Math.round((d.total / max) * 140));
          const label = isHourly ? `${d.hour}h` : d.date.slice(5);
          const costStr = (d.costUSD || 0) > 0 ? ` · $${(d.costUSD || 0).toFixed(4)}` : '';
          const title = isHourly ? `${d.hour}:00 - ${fmt(d.total)} tokens${costStr}` : `${d.date}: ${fmt(d.total)} tokens${costStr}`;
          return `<div title="${title}" style="flex:1;min-width:4px;height:${h}px;background:var(--accent);border-radius:2px 2px 0 0;position:relative;">
            <div style="position:absolute;bottom:-16px;left:50%;transform:translateX(-50%);font-size:9px;opacity:0.5;white-space:nowrap;">${label}</div>
          </div>`;
        }).join('');
        chartEl.style.marginBottom = '20px';
      }
      // by model
      const models = data.models || {};
      const modelEntries = Object.entries(models).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
      if (modelEntries.length === 0) {
        modelsEl.innerHTML = '<div style="opacity:0.5;font-size:12px;">无数据</div>';
      } else {
        modelsEl.innerHTML = modelEntries.map(([id, st]) => {
          const costStr = (st.costUSD || 0) > 0 ? ` · <span style="color:var(--accent)">$${(st.costUSD || 0).toFixed(4)}</span>` : '';
          return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="font-family:monospace;font-size:12px;">${id}</span>
            <span><b>${fmt(st.total)}</b> tokens · ${fmt(st.count)} 次${costStr}</span>
          </div>`;
        }).join('');
      }
    } catch (e) {
      summaryEl.innerHTML = '<div>错误: ' + (e?.message || e) + '</div>';
    }
  }

  async function loadSettingsPage() {
    const s = await window.api.getSettings();
    document.getElementById('setting-llm-url').value = s.llm.apiUrl || '';
    document.getElementById('setting-llm-key').value = s.llm.apiKey || '';
    document.getElementById('setting-llm-model').value = s.llm.model || '';
    document.getElementById('setting-llm-temp').value = s.llm.temperature;
    document.getElementById('setting-temp-val').textContent = s.llm.temperature;
    document.getElementById('setting-llm-ctx').value = s.llm.maxContextLength;
    document.getElementById('setting-llm-max-response').value = s.llm.maxResponseTokens || 8192;
    document.getElementById('setting-llm-daily-limit').value = s.llm.dailyMaxTokens || 0;
    document.getElementById('setting-llm-stream').checked = s.llm.streamResponses !== false;
    const forceVisionEl = document.getElementById('setting-llm-force-vision');
    if (forceVisionEl) forceVisionEl.checked = s.llm.forceVision === true;
    document.getElementById('setting-llm-retries').value = s.llm.maxRetries ?? 10;
    document.getElementById('setting-llm-timeout').value = Math.round((s.llm.timeoutMs ?? 300000) / 1000);
    document.getElementById('setting-llm-fallback-model').value = s.llm.fallbackModel || '';
    const llmUsage = s.llm.dailyTokensUsed || 0;
    const llmLimit = s.llm.dailyMaxTokens || 0;
    const llmUsageEl = document.getElementById('setting-llm-usage');
    llmUsageEl.textContent = `今日已用: ${llmUsage}`;
    if (llmLimit > 0 && llmUsage >= llmLimit * 0.8) {
      llmUsageEl.classList.add('warning');
      llmUsageEl.textContent = `今日已用: ${llmUsage} (接近限制 ${llmLimit})`;
    }

    // Provider / Zen / Reasoning
    const provider = s.llm.provider || 'openai-compat';
    document.getElementById('setting-llm-provider').value = provider;
    const zenKeyEl = document.getElementById('setting-llm-zen-key');
    if (zenKeyEl) {
      zenKeyEl.value = s.llm.zenApiKey || '';
      // 标记是否为免登录 public key，用于 refreshZenModels 过滤
      if ((s.llm.zenApiKey || '').trim() === 'public') {
        zenKeyEl.dataset.publicKey = '1';
      } else {
        delete zenKeyEl.dataset.publicKey;
      }
    }
    const reasoningEl = document.getElementById('setting-llm-reasoning');
    if (reasoningEl) reasoningEl.value = s.llm.reasoningEffort || 'off';
    updateLLMProviderFields(provider);
    if (provider === 'opencode-zen') {
      const zenModelSel = document.getElementById('setting-llm-zen-model');
      if (zenModelSel) refreshZenModels(s.llm.model);
    }

    document.getElementById('setting-img-url').value = s.imageGen.apiUrl || '';
    document.getElementById('setting-img-key').value = s.imageGen.apiKey || '';
    document.getElementById('setting-img-model').value = s.imageGen.model || '';
    document.getElementById('setting-img-size').value = s.imageGen.imageSize || '1024x1024';
    document.getElementById('setting-img-daily-limit').value = s.imageGen.dailyMaxImages || 0;
    const imgUsage = s.imageGen.dailyImagesUsed || 0;
    const imgLimit = s.imageGen.dailyMaxImages || 0;
    const imgUsageEl = document.getElementById('setting-img-usage');
    imgUsageEl.textContent = `今日已用: ${imgUsage}`;
    if (imgLimit > 0 && imgUsage >= imgLimit * 0.8) {
      imgUsageEl.classList.add('warning');
      imgUsageEl.textContent = `今日已用: ${imgUsage} (接近限制 ${imgLimit})`;
    }

    document.getElementById('setting-accent-color').value = s.theme.accentColor;
    document.getElementById('setting-bg-color').value = s.theme.backgroundColor;
    document.getElementById('setting-auto-approve').checked = s.autoApproveSensitive;

    // 隐私信息保护
    const priv = s.privacyProtection || {};
    const privEnabledEl = document.getElementById('setting-privacy-enabled');
    if (privEnabledEl) privEnabledEl.checked = priv.enabled === true;
    const privResultsEl = document.getElementById('setting-privacy-filter-results');
    if (privResultsEl) privResultsEl.checked = priv.filterResults !== false;
    const privArgsEl = document.getElementById('setting-privacy-filter-args');
    if (privArgsEl) privArgsEl.checked = priv.filterArgs !== false;
    const privTermEl = document.getElementById('setting-privacy-filter-terminal');
    if (privTermEl) privTermEl.checked = priv.filterTerminal !== false;
    const privAttachEl = document.getElementById('setting-privacy-filter-attachments');
    if (privAttachEl) privAttachEl.checked = priv.filterAttachments !== false;
    // 过滤类别勾选（缺失键按 DEFAULT_CATEGORIES 默认值，如 evasion 默认关）
    const catEls = document.querySelectorAll('#privacy-categories-item input[data-cat]');
    if (catEls.length > 0) {
      const cats = (priv.categories && typeof priv.categories === 'object') ? priv.categories : {};
      const defCats = (window.PrivacyFilter && window.PrivacyFilter.DEFAULT_CATEGORIES) || {};
      catEls.forEach(inp => {
        const val = cats[inp.dataset.cat];
        inp.checked = val === true ? true : (val === false ? false : defCats[inp.dataset.cat] === true);
      });
    }
    updatePrivacyTriggerState(priv.enabled === true);

    // 后台托盘模式
    const trayEnabledEl = document.getElementById('setting-tray-enabled');
    const closeToTrayEl = document.getElementById('setting-close-to-tray');
    if (trayEnabledEl) trayEnabledEl.checked = s.trayEnabled !== false;
    if (closeToTrayEl) closeToTrayEl.value = ['ask', 'always', 'never'].includes(s.closeToTray) ? s.closeToTray : 'ask';

    // Theme mode
    document.querySelectorAll('.theme-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === s.theme.mode);
    });

    // AI Persona settings
    const persona = s.aiPersona || {};
    const nameEl = document.getElementById('setting-ai-name');
    const bioEl = document.getElementById('setting-ai-bio');
    const pronounsEl = document.getElementById('setting-ai-pronouns');
    const personalityEl = document.getElementById('setting-ai-personality');
    const customPromptEl = document.getElementById('setting-ai-custom-prompt');
    if (nameEl) nameEl.value = persona.name || '';
    if (bioEl) bioEl.value = persona.bio || '';
    if (pronounsEl) pronounsEl.value = persona.pronouns || '';
    if (personalityEl) personalityEl.value = persona.personality || '';
    if (customPromptEl) customPromptEl.value = persona.customPrompt || '';
    // 命运之牌 UI 可见性开关（默认 true）
    const tarotVisibleEl = document.getElementById('setting-tarot-visible');
    if (tarotVisibleEl) tarotVisibleEl.checked = s.tarotVisible !== false;
    applyTarotVisibility(s.tarotVisible !== false);
    // Notification settings (default: enabled + all categories on)
    const notif = s.notifications || {};
    const notifEnabledEl = document.getElementById('setting-notify-enabled');
    if (notifEnabledEl) notifEnabledEl.checked = notif.enabled !== false;
    const notifApprovalEl = document.getElementById('setting-notify-approval');
    if (notifApprovalEl) notifApprovalEl.checked = notif.approval !== false;
    const notifSessionEl = document.getElementById('setting-notify-session-done');
    if (notifSessionEl) notifSessionEl.checked = notif.sessionDone !== false;
    const notifQuestionEl = document.getElementById('setting-notify-question');
    if (notifQuestionEl) notifQuestionEl.checked = notif.question !== false;
    const notifPresentEl = document.getElementById('setting-notify-present');
    if (notifPresentEl) notifPresentEl.checked = notif.present !== false;
    const notifBabeProactiveEl = document.getElementById('setting-notify-babe-proactive');
    if (notifBabeProactiveEl) notifBabeProactiveEl.checked = notif.babeProactive !== false;
    // Language setting
    const langSelect = document.getElementById('setting-language');
    if (langSelect) langSelect.value = s.language || 'zh-CN';
    // Avatar migration: if stored as file path, convert to base64
    let aiAvatarData = persona.avatar || '';
    if (aiAvatarData && !aiAvatarData.startsWith('data:') && !aiAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(aiAvatarData);
      if (enc.ok) { aiAvatarData = enc.dataUrl; s.aiPersona.avatar = aiAvatarData; await window.api.setSettings(s); }
    }
    // 头像框系统：加载 AI 头像框状态并预加载 SVG
    _avatarFrameState.ai = persona.avatarFrame || null;
    if (_avatarFrameState.ai) await loadAvatarFrameSVG(_avatarFrameState.ai);
    updateAvatarPreview(aiAvatarData);

    // Babe Mode settings
    const babe = s.babe || {};
    const babeNameEl = document.getElementById('setting-babe-name');
    const babeGenderEl = document.getElementById('setting-babe-gender');
    const babeAgeEl = document.getElementById('setting-babe-age');
    const babePersonalityEl = document.getElementById('setting-babe-personality');
    const babePersonaEl = document.getElementById('setting-babe-persona');
    const babeUserNicknameEl = document.getElementById('setting-babe-user-nickname');
    const babeProactiveIntervalEl = document.getElementById('setting-babe-proactive-interval');
    const babeInitialAffectionEl = document.getElementById('setting-babe-initial-affection');
    if (babeNameEl) babeNameEl.value = babe.name || '';
    if (babeGenderEl) babeGenderEl.value = babe.gender || 'female';
    if (babeAgeEl) babeAgeEl.value = babe.age || '';
    if (babePersonalityEl) babePersonalityEl.value = babe.personality || '';
    if (babePersonaEl) babePersonaEl.value = babe.persona || '';
    if (babeUserNicknameEl) babeUserNicknameEl.value = babe.userNickname || '';
    if (babeProactiveIntervalEl) babeProactiveIntervalEl.value = String(babe.proactiveInterval ?? 0);
    if (babeInitialAffectionEl) babeInitialAffectionEl.value = babe.initialAffection ?? 30;
    // Babe 头像：迁移文件路径为 base64（与 AI/User 头像一致）
    let babeAvatarData = babe.avatar || '';
    if (babeAvatarData && !babeAvatarData.startsWith('data:') && !babeAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(babeAvatarData);
      if (enc.ok) { babeAvatarData = enc.dataUrl; s.babe.avatar = babeAvatarData; await window.api.setSettings(s); }
    }
    // 头像框系统：加载 Babe 头像框状态并预加载 SVG
    _avatarFrameState.babe = babe.avatarFrame || null;
    if (_avatarFrameState.babe) await loadAvatarFrameSVG(_avatarFrameState.babe);
    updateBabeAvatarPreview(babeAvatarData);

    // User Profile settings
    const userProfile = s.userProfile || {};
    const userNameEl = document.getElementById('setting-user-name');
    const userBioEl = document.getElementById('setting-user-bio');
    if (userNameEl) userNameEl.value = userProfile.name || '';
    if (userBioEl) userBioEl.value = userProfile.bio || '';
    let userAvatarData = userProfile.avatar || '';
    if (userAvatarData && !userAvatarData.startsWith('data:') && !userAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(userAvatarData);
      if (enc.ok) { userAvatarData = enc.dataUrl; s.userProfile.avatar = userAvatarData; await window.api.setSettings(s); }
    }
    // 头像框系统：加载 User 头像框状态并预加载 SVG
    _avatarFrameState.user = userProfile.avatarFrame || null;
    if (_avatarFrameState.user) await loadAvatarFrameSVG(_avatarFrameState.user);
    updateUserAvatarPreview(userAvatarData);
    window.api.webControlSetAvatars({ ai: aiAvatarData, user: userAvatarData });

    // 头像框系统：加载并渲染头像框选择器 grid（异步，不阻塞设置面板其他渲染）
    loadAvatarFrames();
    // 同步更新 Hero 显示的头像框
    updatePersonaDisplay(persona);

    // Entropy settings
    const entropy = s.entropy || {};
    document.querySelectorAll('.entropy-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.source === (entropy.source || 'csprng')));
    document.getElementById('entropy-trng-settings').style.display = entropy.source === 'trng' ? '' : 'none';
    document.querySelectorAll('.trng-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === (entropy.trngMode || 'network')));
    document.getElementById('trng-network-settings').style.display = (entropy.trngMode || 'network') === 'network' ? '' : 'none';
    document.getElementById('trng-serial-settings').style.display = entropy.trngMode === 'serial' ? '' : 'none';
    const trngHostEl = document.getElementById('setting-trng-host');
    if (trngHostEl) trngHostEl.value = entropy.trngNetworkHost || '192.168.4.1';
    const trngPortEl = document.getElementById('setting-trng-port');
    if (trngPortEl) trngPortEl.value = entropy.trngNetworkPort || 80;
    const trngBaudEl = document.getElementById('setting-trng-serial-baud');
    if (trngBaudEl) trngBaudEl.value = entropy.trngSerialBaud || 115200;
    const trngSerialEl = document.getElementById('setting-trng-serial-port');
    if (trngSerialEl && entropy.trngSerialPort) trngSerialEl.value = entropy.trngSerialPort;
    if (entropy.trngMode === 'serial') {
      refreshTrngPorts(false);
    }

    // 更新配色方案可见性
    updateColorSchemeVisibility();

    // Proxy settings
    const proxy = s.proxy || {};
    document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === (proxy.mode || 'system'));
    });
    document.getElementById('manual-proxy-settings').style.display = proxy.mode === 'manual' ? '' : 'none';
    const proxyHttpEl = document.getElementById('setting-proxy-http');
    if (proxyHttpEl) proxyHttpEl.value = proxy.http || '';
    const proxyHttpsEl = document.getElementById('setting-proxy-https');
    if (proxyHttpsEl) proxyHttpsEl.value = proxy.https || '';
    const proxyBypassEl = document.getElementById('setting-proxy-bypass');
    if (proxyBypassEl) proxyBypassEl.value = proxy.bypass || 'localhost,127.0.0.1';

    // MCP settings
    await loadMcpServerList();
    setupMcpEvents();

    // Email settings
    const email = s.email || {};
    const eid = (id, prop, def='') => { const el = document.getElementById(id); if (el) el.value = email[prop] ?? def; };
    const emailModeEl = document.getElementById('setting-email-mode');
    if (emailModeEl) emailModeEl.value = email.mode || 'send-receive';
    updateEmailModeVisibility(email.mode || 'send-receive');
    eid('setting-email-smtp-host', 'smtpHost');
    eid('setting-email-smtp-port', 'smtpPort', 587);
    const smtpSecure = document.getElementById('setting-email-smtp-secure');
    if (smtpSecure) smtpSecure.checked = email.smtpSecure !== false;
    eid('setting-email-imap-host', 'imapHost');
    eid('setting-email-imap-port', 'imapPort', 993);
    const imapTls = document.getElementById('setting-email-imap-tls');
    if (imapTls) imapTls.checked = email.imapTls !== false;
    eid('setting-email-user', 'emailUser');
    eid('setting-email-pass', 'emailPass');
    eid('setting-email-owner', 'ownerAddress');
    eid('setting-email-totp-secret', 'totpSecret');
    eid('setting-email-poll-interval', 'pollInterval', 30);
    eid('setting-email-resend-interval', 'resendIntervalMinutes', 30);
    eid('setting-email-max-resends', 'maxResends', 3);
    const emailEnabled = document.getElementById('setting-email-enabled');
    if (emailEnabled) emailEnabled.checked = !!email.enabled;
    // 渲染控制白名单
    renderEmailAllowedSenders(email.allowedSenders || []);
    setupEmailEvents();

    // Web Control settings
    const wc = s.webControl || {};
    const wcPortEl = document.getElementById('setting-wc-port');
    if (wcPortEl) wcPortEl.value = wc.port || 3456;
    const wcEnabledEl = document.getElementById('setting-wc-enabled');
    if (wcEnabledEl) wcEnabledEl.checked = !!wc.enabled;
    const wcAutoStartEl = document.getElementById('setting-wc-autostart');
    if (wcAutoStartEl) wcAutoStartEl.checked = !!wc.autoStartOnOpen;
    const wc2faEl = document.getElementById('setting-wc-enable-2fa');
    if (wc2faEl) {
      wc2faEl.checked = !!wc.enable2FA;
      document.getElementById('wc-2fa-area').style.display = wc.enable2FA ? '' : 'none';
    }
    // Update toggle button state
    updateWcToggleButton();
    setupWebControlEvents();
    loadImeSettings();
  }

  // ---- MCP Settings Helpers ----
  let mcpEventsSetup = false;

  // ---- Email Settings Helpers ----
  let emailEventsSetup = false;

  function updateEmailModeVisibility(mode) {
    const smtpGroup = document.getElementById('email-smtp-group');
    const imapGroup = document.getElementById('email-imap-group');
    if (smtpGroup) smtpGroup.style.display = (mode === 'send-only' || mode === 'send-receive') ? '' : 'none';
    if (imapGroup) imapGroup.style.display = (mode === 'receive-only' || mode === 'send-receive') ? '' : 'none';
  }

  // 渲染邮件控制白名单列表
  function renderEmailAllowedSenders(senders) {
    const listEl = document.getElementById('email-allowed-senders-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const arr = Array.isArray(senders) ? senders : [];
    if (arr.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-tertiary);padding:6px 0';
      empty.textContent = '白名单为空。将只接受"用户邮箱地址"的指令。';
      listEl.appendChild(empty);
      return;
    }
    for (const addr of arr) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border)';
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-envelope';
      icon.style.cssText = 'font-size:12px;color:var(--accent)';
      const text = document.createElement('span');
      text.style.cssText = 'flex:1;font-size:13px;word-break:break-all';
      text.textContent = addr;
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon btn-sm';
      delBtn.title = '删除';
      delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      delBtn.style.cssText = 'color:var(--danger);padding:2px 6px';
      delBtn.addEventListener('click', async () => {
        const s = await window.api.getSettings();
        const cur = Array.isArray(s.email?.allowedSenders) ? s.email.allowedSenders : [];
        const next = cur.filter(x => String(x).toLowerCase() !== String(addr).toLowerCase());
        s.email = { ...(s.email || {}), allowedSenders: next };
        await saveSettings(s);
        renderEmailAllowedSenders(next);
      });
      row.appendChild(icon);
      row.appendChild(text);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }

  // 绑定白名单输入框添加按钮事件（只绑定一次）
  let emailAllowedSendersEventsSetup = false;
  function setupEmailAllowedSendersEvents() {
    if (emailAllowedSendersEventsSetup) return;
    emailAllowedSendersEventsSetup = true;
    const addBtn = document.getElementById('btn-email-add-sender');
    const input = document.getElementById('email-allowed-sender-input');
    if (!addBtn || !input) return;

    const doAdd = async () => {
      const val = (input.value || '').trim().toLowerCase();
      if (!val) return;
      // 简单邮箱格式校验
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        alert('请输入有效的邮箱地址');
        return;
      }
      const s = await window.api.getSettings();
      const cur = Array.isArray(s.email?.allowedSenders) ? s.email.allowedSenders.map(x => String(x).toLowerCase()) : [];
      if (cur.includes(val)) {
        alert('该邮箱已在白名单中');
        return;
      }
      cur.push(val);
      s.email = { ...(s.email || {}), allowedSenders: cur };
      await saveSettings(s);
      input.value = '';
      renderEmailAllowedSenders(cur);
    };

    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doAdd();
      }
    });
  }

  function setupEmailEvents() {
    if (emailEventsSetup) return;
    emailEventsSetup = true;

    // Mode change
    document.getElementById('setting-email-mode')?.addEventListener('change', (e) => {
      updateEmailModeVisibility(e.target.value);
    });

    // 白名单按钮事件
    setupEmailAllowedSendersEvents();

    // Generate TOTP
    document.getElementById('btn-email-gen-totp')?.addEventListener('click', async () => {
      const result = await window.api.emailGenerateTOTP();
      if (result.ok) {
        const qrArea = document.getElementById('email-totp-qr-area');
        const qrImg = document.getElementById('email-totp-qr-img');
        const secretText = document.getElementById('email-totp-secret-text');
        const secretInput = document.getElementById('setting-email-totp-secret');
        if (qrArea) qrArea.style.display = '';
        if (qrImg) qrImg.src = result.qrDataUrl;
        if (secretText) secretText.textContent = `密钥: ${result.secret}`;
        if (secretInput) secretInput.value = result.secret;
        // Save secret immediately
        await window.api.emailSaveTOTPSecret(result.secret);
      } else {
        alert('TOTP 生成失败: ' + (result.error || '未知错误'));
      }
    });

    // Verify TOTP
    document.getElementById('btn-email-verify-totp')?.addEventListener('click', async () => {
      const code = document.getElementById('email-totp-verify-code')?.value?.trim();
      if (!code) return;
      const result = await window.api.emailVerifyTOTP(code);
      const span = document.getElementById('email-totp-verify-result');
      if (result.ok && result.valid) {
        if (span) { span.textContent = '✅ 验证通过'; span.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (span) { span.textContent = '❌ 验证失败'; span.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Test connection
    document.getElementById('btn-email-test')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('email-test-result');
      if (resultEl) { resultEl.textContent = '正在测试连接...'; resultEl.style.color = 'var(--text-secondary)'; }
      // Save first
      await saveEmailSettings();
      const result = await window.api.emailConnect();
      if (result.ok) {
        if (resultEl) { resultEl.textContent = `✅ 连接成功。SMTP: ${result.smtp || 'OK'}, IMAP: ${result.imap || 'OK'}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (resultEl) { resultEl.textContent = `❌ 连接失败: ${result.error}`; resultEl.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Save settings
    document.getElementById('btn-email-save')?.addEventListener('click', async () => {
      await saveEmailSettings();
      const resultEl = document.getElementById('email-test-result');
      if (resultEl) { resultEl.textContent = '✅ 设置已保存'; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      // If enabled, start polling
      const enabled = document.getElementById('setting-email-enabled')?.checked;
      if (enabled) {
        const r = await window.api.emailStartPolling();
        if (r.ok && resultEl) resultEl.textContent += '，邮件轮询已启动';
      } else {
        await window.api.emailStopPolling();
      }
    });
  }

  async function saveEmailSettings() {
    const s = await window.api.getSettings();
    // 保留已有的 allowedSenders 列表（白名单由专门的添加/删除按钮管理，这里只读不覆盖）
    const existingAllowed = Array.isArray(s.email?.allowedSenders) ? s.email.allowedSenders : [];
    s.email = {
      enabled: document.getElementById('setting-email-enabled')?.checked || false,
      mode: document.getElementById('setting-email-mode')?.value || 'send-receive',
      smtpHost: document.getElementById('setting-email-smtp-host')?.value?.trim() || '',
      smtpPort: parseInt(document.getElementById('setting-email-smtp-port')?.value) || 587,
      smtpSecure: document.getElementById('setting-email-smtp-secure')?.checked ?? true,
      imapHost: document.getElementById('setting-email-imap-host')?.value?.trim() || '',
      imapPort: parseInt(document.getElementById('setting-email-imap-port')?.value) || 993,
      imapTls: document.getElementById('setting-email-imap-tls')?.checked ?? true,
      emailUser: document.getElementById('setting-email-user')?.value?.trim() || '',
      emailPass: document.getElementById('setting-email-pass')?.value?.trim() || '',
      ownerAddress: document.getElementById('setting-email-owner')?.value?.trim() || '',
      totpSecret: document.getElementById('setting-email-totp-secret')?.value?.trim() || s.email?.totpSecret || '',
      pollInterval: parseInt(document.getElementById('setting-email-poll-interval')?.value) || 30,
      resendIntervalMinutes: parseInt(document.getElementById('setting-email-resend-interval')?.value) || 30,
      maxResends: parseInt(document.getElementById('setting-email-max-resends')?.value) || 3,
      allowedSenders: existingAllowed,
    };
    await saveSettings(s);
  }

  // ---- Web Control Settings Helpers ----
  let wcEventsSetup = false;

  async function updateWcToggleButton() {
    const btn = document.getElementById('btn-wc-toggle');
    const resultEl = document.getElementById('wc-status-result');
    if (!btn) return;
    try {
      const status = await window.api.webControlGetStatus();
      if (status.running) {
        btn.innerHTML = '<i class="fa-solid fa-stop"></i> 停止';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-danger');
        if (resultEl) { resultEl.textContent = `✅ 运行中: http://localhost:${status.port}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i> 启动';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
        if (resultEl) { resultEl.textContent = '未运行'; resultEl.style.color = 'var(--text-secondary)'; }
      }
    } catch {}
  }

  async function saveWebControlSettings() {
    const s = await window.api.getSettings();
    const passwordInput = document.getElementById('setting-wc-password')?.value?.trim();
    let passwordHash = s.webControl?.passwordHash || '';
    if (passwordInput) {
      const hashResult = await window.api.webControlHashPassword(passwordInput);
      if (hashResult.ok) passwordHash = hashResult.hash;
    }
    s.webControl = {
      enabled: document.getElementById('setting-wc-enabled')?.checked || false,
      autoStartOnOpen: document.getElementById('setting-wc-autostart')?.checked || false,
      port: parseInt(document.getElementById('setting-wc-port')?.value) || 3456,
      password: '',
      passwordHash,
      enable2FA: document.getElementById('setting-wc-enable-2fa')?.checked || false,
      totpSecret: s.webControl?.totpSecret || '',
    };
    await saveSettings(s);
    // Clear password field after save
    const pwEl = document.getElementById('setting-wc-password');
    if (pwEl) pwEl.value = '';
    // 热更新运行中服务的配置（修复改密码后 WebUI 登录仍用旧 hash 的问题）
    try { await window.api.webControlReconfigure(); } catch (_) {}
  }

  function setupWebControlEvents() {
    if (wcEventsSetup) return;
    wcEventsSetup = true;

    // 2FA toggle
    document.getElementById('setting-wc-enable-2fa')?.addEventListener('change', (e) => {
      document.getElementById('wc-2fa-area').style.display = e.target.checked ? '' : 'none';
    });

    // Generate TOTP
    document.getElementById('btn-wc-gen-totp')?.addEventListener('click', async () => {
      const result = await window.api.webControlGenerateTOTP();
      if (result.ok) {
        const qrArea = document.getElementById('wc-totp-qr-area');
        const qrImg = document.getElementById('wc-totp-qr-img');
        const secretText = document.getElementById('wc-totp-secret-text');
        if (qrArea) qrArea.style.display = '';
        if (qrImg) qrImg.src = result.qrDataUrl;
        if (secretText) secretText.textContent = `密钥: ${result.secret}`;
        // Save to settings
        const s = await window.api.getSettings();
        s.webControl = s.webControl || {};
        s.webControl.totpSecret = result.secret;
        await saveSettings(s);
      } else {
        alert('TOTP 生成失败: ' + (result.error || '未知错误'));
      }
    });

    // Verify TOTP
    document.getElementById('btn-wc-verify-totp')?.addEventListener('click', async () => {
      const code = document.getElementById('wc-totp-verify-code')?.value?.trim();
      if (!code) return;
      const result = await window.api.webControlVerifyTOTP(code);
      const span = document.getElementById('wc-totp-verify-result');
      if (result.ok && result.valid) {
        if (span) { span.textContent = '✅ 验证通过'; span.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (span) { span.textContent = '❌ 验证失败'; span.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Save
    document.getElementById('btn-wc-save')?.addEventListener('click', async () => {
      await saveWebControlSettings();
      const resultEl = document.getElementById('wc-status-result');
      if (resultEl) { resultEl.textContent = '✅ 设置已保存'; resultEl.style.color = 'var(--success-color, #4caf50)'; }
    });

    // Toggle start/stop
    document.getElementById('btn-wc-toggle')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('wc-status-result');
      const status = await window.api.webControlGetStatus();
      if (status.running) {
        const r = await window.api.webControlStop();
        if (r.ok) {
          if (resultEl) { resultEl.textContent = '已停止'; resultEl.style.color = 'var(--text-secondary)'; }
        } else {
          if (resultEl) { resultEl.textContent = '❌ 停止失败: ' + (r.error || ''); resultEl.style.color = 'var(--error-color, #f44336)'; }
        }
      } else {
        // Save first, then start
        await saveWebControlSettings();
        const r = await window.api.webControlStart();
        if (r.ok) {
          if (resultEl) { resultEl.textContent = `✅ ${r.message}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
        } else {
          if (resultEl) { resultEl.textContent = '❌ 启动失败: ' + (r.error || ''); resultEl.style.color = 'var(--error-color, #f44336)'; }
        }
      }
      updateWcToggleButton();
    });
  }

  // ── Playwright Settings ──
  async function loadPlaywrightSettings() {
    const s = await window.api.getSettings();
    const pw = s.playwright || {};
    const modeSelect = document.getElementById('setting-pw-mode');
    const pathInput = document.getElementById('setting-pw-path');
    const followLangCheckbox = document.getElementById('setting-pw-follow-lang');
    const headlessCheckbox = document.getElementById('setting-pw-headless');
    const bannerCheckbox = document.getElementById('setting-pw-banner-enabled');
    const argsTextarea = document.getElementById('setting-pw-args');
    const customRow = document.getElementById('pw-custom-path-row');
    const testBtn = document.getElementById('btn-pw-test');
    const saveBtn = document.getElementById('btn-pw-save');
    const searchBtn = document.getElementById('btn-pw-search');
    const browseBtn = document.getElementById('btn-pw-browse');
    const detectedEl = document.getElementById('pw-detected-browsers');
    const testResultEl = document.getElementById('pw-test-result');

    if (modeSelect) modeSelect.value = pw.mode || 'auto';
    if (pathInput) pathInput.value = pw.path || '';
    if (followLangCheckbox) followLangCheckbox.checked = pw.followLang !== false;
    // UI 语义：checked = 有头模式；setting 语义：headless=true 表示无头
    if (headlessCheckbox) headlessCheckbox.checked = pw.headless !== true;
    // 横幅开关：默认开启，仅 headed 模式下显示
    if (bannerCheckbox) bannerCheckbox.checked = pw.bannerEnabled !== false;
    if (argsTextarea) argsTextarea.value = pw.args || '';

    // Show/hide custom path row
    function updateCustomRowVisibility() {
      if (!modeSelect || !customRow) return;
      if (modeSelect.value === 'custom') {
        customRow.style.display = '';
      } else {
        customRow.style.display = 'none';
      }
    }
    if (modeSelect) {
      modeSelect.addEventListener('change', updateCustomRowVisibility);
      updateCustomRowVisibility();
    }

    // Browse for browser binary
    if (browseBtn) {
      browseBtn.addEventListener('click', async () => {
        const result = await window.api.pwBrowserDialog();
        if (result.ok && pathInput) {
          pathInput.value = result.path;
        }
      });
    }

    // Search for browsers
    if (searchBtn) {
      searchBtn.addEventListener('click', async () => {
        if (detectedEl) {
          detectedEl.innerHTML = '<span style="color:var(--text-tertiary)">搜索中...</span>';
        }
        const result = await window.api.pwSearchBrowsers();
        if (result.ok && result.browsers && result.browsers.length > 0) {
          detectedEl.innerHTML = result.browsers.map(b =>
            `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>${b.name}</span><code style="font-size:11px;color:var(--accent)">${b.path}</code></div>`
          ).join('');
        } else {
          detectedEl.innerHTML = '<span style="color:var(--danger)">未检测到已安装的浏览器</span>';
        }
      });
    }

    // Test launch
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        if (testResultEl) {
          testResultEl.textContent = '测试中...';
          testResultEl.style.color = 'var(--text-secondary)';
        }
        const testSettings = {
          mode: modeSelect ? modeSelect.value : 'auto',
          path: pathInput ? pathInput.value : '',
          followLang: followLangCheckbox ? followLangCheckbox.checked : true,
          headless: headlessCheckbox ? !headlessCheckbox.checked : false,
          bannerEnabled: bannerCheckbox ? bannerCheckbox.checked : true,
          args: argsTextarea ? argsTextarea.value : ''
        };
        // 先持久化设置：测试启动即应用，避免用户忘记点"保存"导致 Agent 调用仍用旧浏览器
        try {
          const s2 = await window.api.getSettings();
          s2.playwright = testSettings;
          await saveSettings(s2);
          await window.api.pwCloseBrowser();
        } catch (e) {
          console.warn('Test launch: persist settings failed:', e);
        }
        const result = await window.api.pwTestLaunch(testSettings);
        if (testResultEl) {
          if (result.ok) {
            testResultEl.textContent = '✅ ' + (result.message || '测试成功');
            testResultEl.style.color = 'var(--success, #4caf50)';
          } else {
            testResultEl.textContent = '❌ ' + (result.error || '测试失败');
            testResultEl.style.color = 'var(--danger, #f44336)';
          }
        }
      });
    }

    // Save
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const s2 = await window.api.getSettings();
        s2.playwright = {
          mode: modeSelect ? modeSelect.value : 'auto',
          path: pathInput ? pathInput.value : '',
          followLang: followLangCheckbox ? followLangCheckbox.checked : true,
          headless: headlessCheckbox ? !headlessCheckbox.checked : false,
          bannerEnabled: bannerCheckbox ? bannerCheckbox.checked : true,
          args: argsTextarea ? argsTextarea.value : ''
        };
        await saveSettings(s2);
        // Close existing browser so next launch uses new settings
        await window.api.pwCloseBrowser();
        if (testResultEl) {
          testResultEl.textContent = '✅ ' + (typeof i18nGetLanguage === 'function' && i18nGetLanguage() !== 'zh-CN' ? 'Settings saved' : '设置已保存');
          testResultEl.style.color = 'var(--success, #4caf50)';
        }
      });
    }
  }
  loadPlaywrightSettings();

  // ── Budget Control Settings ──
  // 数据结构：settings.budget = {
  //   monthlyCapUsd, dailyLimitUSD, overAction, fallbackModel, warningThreshold,
  //   models: { [modelId]: { inputPerM, cacheReadPerM, outputPerM, cacheWritePerM, hasCacheWrite } },
  //   peakHours: { enabled, start, end, inputMul, cacheReadMul, outputMul, cacheWriteMul }
  // }
  async function loadBudgetSettings() {
    const s = await window.api.getSettings();
    const budget = s.budget || {};
    const dailyCapInput = document.getElementById('setting-budget-daily-cap');
    const weeklyCapInput = document.getElementById('setting-budget-weekly-cap');
    const capInput = document.getElementById('setting-budget-monthly-cap');
    const actionSel = document.getElementById('setting-budget-action');
    const fallbackInput = document.getElementById('setting-budget-fallback-model');
    const tzSel = document.getElementById('setting-budget-timezone');
    const weekModeSel = document.getElementById('setting-budget-week-mode');
    const monthModeSel = document.getElementById('setting-budget-month-mode');
    if (dailyCapInput) dailyCapInput.value = budget.dailyLimitUSD ?? 0;
    if (weeklyCapInput) weeklyCapInput.value = budget.weeklyLimitUSD ?? 0;
    if (capInput) capInput.value = budget.monthlyLimitUSD ?? 0;
    if (actionSel) actionSel.value = budget.overLimitAction || budget.overAction || 'warn';
    if (fallbackInput) fallbackInput.value = budget.fallbackModel || '';
    if (tzSel) tzSel.value = budget.timezone || 'Asia/Shanghai';
    if (weekModeSel) weekModeSel.value = budget.weekMode || 'natural';
    if (monthModeSel) monthModeSel.value = budget.monthMode || 'natural';

    // 峰谷时段字段
    const ph = budget.peakHours || {};
    const phEnabled = document.getElementById('setting-budget-peak-enabled');
    const phStart = document.getElementById('setting-budget-peak-start');
    const phEnd = document.getElementById('setting-budget-peak-end');
    const phInMul = document.getElementById('setting-budget-peak-input-mul');
    const phCrMul = document.getElementById('setting-budget-peak-cacheread-mul');
    const phOutMul = document.getElementById('setting-budget-peak-output-mul');
    const phCwMul = document.getElementById('setting-budget-peak-cachewrite-mul');
    if (phEnabled) phEnabled.checked = !!ph.enabled;
    if (phStart) phStart.value = ph.start ?? 9;
    if (phEnd) phEnd.value = ph.end ?? 18;
    if (phInMul) phInMul.value = ph.inputMul ?? 1.5;
    if (phCrMul) phCrMul.value = ph.cacheReadMul ?? 1.5;
    if (phOutMul) phOutMul.value = ph.outputMul ?? 1.5;
    if (phCwMul) phCwMul.value = ph.cacheWriteMul ?? 1.5;

    const listEl = document.getElementById('budget-pricing-list');
    if (listEl) {
      listEl.innerHTML = '';
      const models = budget.models || {};
      for (const [modelId, price] of Object.entries(models)) {
        appendBudgetPricingRow(listEl, modelId, price);
      }
      // 默认至少显示一行空行
      if (listEl.children.length === 0) {
        appendBudgetPricingRow(listEl, '', {});
      }
    }

    // 按钮绑定
    const addRowBtn = document.getElementById('btn-budget-add-row');
    if (addRowBtn) {
      addRowBtn.onclick = () => {
        if (!listEl) return;
        appendBudgetPricingRow(listEl, '', {});
      };
    }
    const importCurrentBtn = document.getElementById('btn-budget-import-current');
    if (importCurrentBtn) {
      importCurrentBtn.onclick = async () => {
        const cur = await window.api.getSettings();
        const model = cur?.llm?.model;
        if (!model) { window.showToast('未检测到当前 LLM 模型', 'warn'); return; }
        if (!listEl) return;
        // 去重添加
        const existing = Array.from(listEl.querySelectorAll('.budget-model-id')).map(i => i.value.trim());
        if (existing.includes(model)) { window.showToast('价格表中已存在该模型', 'info'); return; }
        // 默认根据模型名自动推断 hasCacheWrite
        appendBudgetPricingRow(listEl, model, { hasCacheWrite: /claude/i.test(model) });
      };
    }
    const importUsageBtn = document.getElementById('btn-budget-import-usage');
    if (importUsageBtn) {
      importUsageBtn.onclick = async () => {
        const res = await window.api.usageGetRange('monthly');
        if (!listEl) return;
        const usedModels = Object.keys(res?.models || {});
        if (usedModels.length === 0) { window.showToast('用量记录中没有模型数据', 'info'); return; }
        const existing = new Set(Array.from(listEl.querySelectorAll('.budget-model-id')).map(i => i.value.trim()));
        let added = 0;
        for (const m of usedModels) {
          if (!existing.has(m)) { appendBudgetPricingRow(listEl, m, { hasCacheWrite: /claude/i.test(m) }); added++; }
        }
        window.showToast(added > 0 ? `已导入 ${added} 个模型` : '所有已用模型都已在价格表中', 'success');
      };
    }
    const budgetRefreshBtn = document.getElementById('btn-budget-refresh');
    if (budgetRefreshBtn) budgetRefreshBtn.onclick = async () => {
      await refreshBudgetStatus();
      window.showToast('预算数据已刷新', 'success');
    };
    const pickFallbackBtn = document.getElementById('btn-budget-pick-fallback');
    if (pickFallbackBtn) {
      pickFallbackBtn.onclick = async () => {
        // 复用 LLM 设置的模型选择逻辑：列出可用模型
        try {
          const cur = await window.api.getSettings();
          // llmFetchModels 返回 {ok, models} 对象，需要从中提取 models 数组
          const provider = cur?.llm?.provider || 'openai-compat';
          const apiUrl = cur?.llm?.apiUrl || '';
          const apiKey = cur?.llm?.apiKey || '';
          const zenKey = cur?.llm?.zenApiKey || '';
          let res;
          if (provider === 'opencode-zen') {
            res = await window.api.zenFetchModels();
          } else {
            res = await window.api.llmFetchModels(provider, apiUrl, apiKey || zenKey);
          }
          const list = Array.isArray(res?.models) ? res.models : [];
          if (list.length === 0) {
            window.showToast('无可选模型，请先在 LLM 标签页获取模型列表', 'warn');
            return;
          }
          // 弹出简单选择框
          const picked = prompt('选择 fallback 模型（输入序号）:\n' + list.map((m, i) => `${i + 1}. ${m.id || m.name || m}`).join('\n'));
          const idx = parseInt(picked) - 1;
          if (!isNaN(idx) && list[idx]) {
            const modelId = typeof list[idx] === 'string' ? list[idx] : (list[idx].id || list[idx].name);
            if (fallbackInput) fallbackInput.value = modelId;
          }
        } catch (e) { window.showToast('获取模型列表失败: ' + e.message, 'error'); }
      };
    }

    // 自动保存：绑定输入事件
    [dailyCapInput, capInput, actionSel, fallbackInput, phEnabled, phStart, phEnd, phInMul, phCrMul, phOutMul, phCwMul].forEach(el => {
      if (!el) return;
      el.addEventListener('change', saveBudgetSettings);
    });
    listEl?.addEventListener('input', () => { /* 输入时仅更新内部状态，保存由 change 触发 */ });
    // 注意：listEl 不再绑定 change 事件，因为 appendBudgetPricingRow 中
    // 已经为每个 input 单独绑定了 change → saveBudgetSettings，
    // 若 listEl 也绑定会导致 change 事件冒泡时重复触发保存（弹两次 toast）

    await refreshBudgetStatus(budget);
  }

  function appendBudgetPricingRow(listEl, modelId, price) {
    price = price || {};
    // 旧字段迁移：promptPerK/completionPerK → inputPerM/outputPerM
    let inputPerM = price.inputPerM;
    if (inputPerM == null && price.promptPerK != null) inputPerM = (Number(price.promptPerK) || 0) * 1000;
    let outputPerM = price.outputPerM;
    if (outputPerM == null && price.completionPerK != null) outputPerM = (Number(price.completionPerK) || 0) * 1000;
    let cacheReadPerM = price.cacheReadPerM;
    if (cacheReadPerM == null && inputPerM != null) cacheReadPerM = (Number(inputPerM) || 0) * 0.1;
    let cacheWritePerM = price.cacheWritePerM;
    if (cacheWritePerM == null && inputPerM != null) cacheWritePerM = (Number(inputPerM) || 0) * 1.25;
    const hasCacheWrite = price.hasCacheWrite != null ? !!price.hasCacheWrite : /claude/i.test(modelId || '');
    const esc = (v) => String(v ?? '').replace(/[<>&"]/g, s => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[s]));
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1.6fr 0.9fr 0.9fr 0.9fr 0.9fr 0.7fr auto;gap:6px;align-items:center';
    row.innerHTML = `
      <input type="text" class="budget-model-id" value="${esc(modelId)}" placeholder="model-id">
      <input type="number" class="budget-input-perm" value="${inputPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 输入价格 (USD)">
      <input type="number" class="budget-cacheread-perm" value="${cacheReadPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 缓存读取价格 (USD)">
      <input type="number" class="budget-output-perm" value="${outputPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 输出价格 (USD)">
      <input type="number" class="budget-cachewrite-perm" value="${cacheWritePerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 缓存写入价格 (USD)">
      <input type="checkbox" class="budget-has-cache-write" ${hasCacheWrite ? 'checked' : ''} title="该模型支持缓存写入计费" style="justify-self:center">
      <button class="btn-icon" title="删除"><i class="fa-solid fa-trash-can"></i></button>
    `;
    // 当模型 ID 改变且未手动勾选过 CW 时，根据模型名自动推断
    const idEl = row.querySelector('.budget-model-id');
    const cwEl = row.querySelector('.budget-has-cache-write');
    idEl?.addEventListener('change', () => {
      if (/claude/i.test(idEl.value || '')) {
        cwEl.checked = true;
        saveBudgetSettings();
      }
    });
    row.querySelector('button').onclick = () => {
      row.remove();
      saveBudgetSettings();
    };
    row.querySelectorAll('input').forEach(i => i.addEventListener('change', saveBudgetSettings));
    listEl.appendChild(row);
  }

  async function saveBudgetSettings() {
    const dailyCapInput = document.getElementById('setting-budget-daily-cap');
    const weeklyCapInput = document.getElementById('setting-budget-weekly-cap');
    const capInput = document.getElementById('setting-budget-monthly-cap');
    const actionSel = document.getElementById('setting-budget-action');
    const fallbackInput = document.getElementById('setting-budget-fallback-model');
    const tzSel = document.getElementById('setting-budget-timezone');
    const weekModeSel = document.getElementById('setting-budget-week-mode');
    const monthModeSel = document.getElementById('setting-budget-month-mode');
    const listEl = document.getElementById('budget-pricing-list');
    const phEnabled = document.getElementById('setting-budget-peak-enabled');
    const phStart = document.getElementById('setting-budget-peak-start');
    const phEnd = document.getElementById('setting-budget-peak-end');
    const phInMul = document.getElementById('setting-budget-peak-input-mul');
    const phCrMul = document.getElementById('setting-budget-peak-cacheread-mul');
    const phOutMul = document.getElementById('setting-budget-peak-output-mul');
    const phCwMul = document.getElementById('setting-budget-peak-cachewrite-mul');
    const models = {};
    if (listEl) {
      listEl.querySelectorAll(':scope > div').forEach(row => {
        const idEl = row.querySelector('.budget-model-id');
        if (!idEl) return;
        const mid = (idEl.value || '').trim();
        if (!mid) return;
        const pEl = row.querySelector('.budget-input-perm');
        const crEl = row.querySelector('.budget-cacheread-perm');
        const cEl = row.querySelector('.budget-output-perm');
        const cwEl = row.querySelector('.budget-cachewrite-perm');
        const hcwEl = row.querySelector('.budget-has-cache-write');
        models[mid] = {
          inputPerM: parseFloat(pEl?.value) || 0,
          cacheReadPerM: parseFloat(crEl?.value) || 0,
          outputPerM: parseFloat(cEl?.value) || 0,
          cacheWritePerM: parseFloat(cwEl?.value) || 0,
          hasCacheWrite: !!hcwEl?.checked
        };
      });
    }
    const budget = {
      dailyLimitUSD: parseFloat(dailyCapInput?.value) || 0,
      weeklyLimitUSD: parseFloat(weeklyCapInput?.value) || 0,
      monthlyLimitUSD: parseFloat(capInput?.value) || 0,
      monthlyCapUsd: parseFloat(capInput?.value) || 0, // 保留旧字段以兼容旧代码
      overLimitAction: actionSel?.value || 'warn',
      overAction: actionSel?.value || 'warn', // 保留旧字段以兼容旧代码
      fallbackModel: (fallbackInput?.value || '').trim(),
      warningThreshold: 0.8,
      timezone: tzSel?.value || 'Asia/Shanghai',
      weekMode: weekModeSel?.value || 'natural',
      monthMode: monthModeSel?.value || 'natural',
      models,
      peakHours: {
        enabled: !!phEnabled?.checked,
        start: parseInt(phStart?.value) ?? 9,
        end: parseInt(phEnd?.value) ?? 18,
        inputMul: parseFloat(phInMul?.value) || 1,
        cacheReadMul: parseFloat(phCrMul?.value) || 1,
        outputMul: parseFloat(phOutMul?.value) || 1,
        cacheWriteMul: parseFloat(phCwMul?.value) || 1
      }
    };
    await saveSettings({ budget });
    await refreshBudgetStatus(budget);
    if (typeof window.showToast === 'function') window.showToast('预算设置已保存', 'success', 2500);
  }

  async function refreshBudgetStatus(budget) {
    const statusEl = document.getElementById('budget-status');
    if (!statusEl) return;
    try {
      // 使用新的 budget:getStatus API（后端已根据价格表+峰谷价计算好）
      const st = await window.api.budgetGetStatus();
      const fmt = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const fmtLimit = (v) => `$${(Number(v) || 0).toFixed(2)}`;
      const renderSection = (title, info) => {
        const limit = info.limitUSD > 0;
        const pct = info.pct;
        const barColor = info.level === 'danger' ? '#f44336' : (info.level === 'warn' ? '#ff9800' : 'var(--accent)');
        return `
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-weight:600">
              <span>${title}</span><span style="color:${barColor}">${fmt(info.costUSD)}${limit ? ` / ${fmtLimit(info.limitUSD)} (${pct.toFixed(1)}%)` : '（未设限）'}</span>
            </div>
            ${limit ? `<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${pct}%;background:${barColor};transition:width 0.3s"></div></div>` : ''}
            <div style="font-size:11px;color:var(--text-secondary);display:grid;grid-template-columns:1fr 1fr;gap:2px 12px">
              <span>输入 ${fmt(info.inputCost)}</span>
              <span>输出 ${fmt(info.outputCost)}</span>
              <span>缓存读 ${fmt(info.cacheReadCost)}</span>
              <span>缓存写 ${fmt(info.cacheWriteCost)}</span>
            </div>
          </div>
        `;
      };
      const peak = st?.peakHours || {};
      const peakBadge = peak.enabled ? `<span style="font-size:10px;color:var(--text-tertiary);margin-left:6px">峰时段 ${peak.start}-${peak.end}</span>` : '';
      statusEl.innerHTML = `
        ${renderSection('今日消费' + peakBadge, st?.daily || {})}
        ${st?.weekly ? renderSection('本周消费', st.weekly) : ''}
        ${renderSection('本月消费', st?.monthly || {})}
      `;
      // 同步刷新图表区域（若存在）
      const activePeriod = document.querySelector('.budget-period-btn.active');
      if (activePeriod) loadBudgetChart(activePeriod.dataset.period);
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">加载失败: ${e.message}</span>`;
    }
  }

  // 预算统计图表：渲染卡片 + 柱状图 + 圆环占比
  async function loadBudgetChart(period) {
    const summaryEl = document.getElementById('budget-chart-summary');
    const chartEl = document.getElementById('budget-chart');
    const ringsEl = document.getElementById('budget-rings');
    if (!summaryEl || !chartEl || !ringsEl) return;
    try {
      const [status, usage] = await Promise.all([
        window.api.budgetGetStatus(),
        window.api.usageGetRange(period || 'daily')
      ]);
      if (!status?.ok) {
        summaryEl.innerHTML = '<div style="opacity:0.6">加载失败</div>';
        return;
      }
      const periodInfo = status[period || 'daily'] || {};
      const periodLabels = { daily: '今日', weekly: '本周', monthly: '本月' };
      const fmt = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const fmtLimit = (v) => `$${(Number(v) || 0).toFixed(2)}`;
      const hasLimit = periodInfo.limitUSD > 0;
      const pct = periodInfo.pct || 0;
      const barColor = periodInfo.level === 'danger' ? '#f44336' : (periodInfo.level === 'warn' ? '#ff9800' : 'var(--accent)');

      // 卡片
      const cards = [
        { label: `${periodLabels[period]}消费`, value: fmt(periodInfo.costUSD), accent: true },
        { label: '输入消费', value: fmt(periodInfo.inputCost) },
        { label: '输出消费', value: fmt(periodInfo.outputCost) }
      ];
      if ((periodInfo.cacheReadCost || 0) > 0) cards.push({ label: '缓存读消费', value: fmt(periodInfo.cacheReadCost) });
      if ((periodInfo.cacheWriteCost || 0) > 0) cards.push({ label: '缓存写消费', value: fmt(periodInfo.cacheWriteCost) });
      summaryEl.innerHTML = cards.map(c =>
        `<div class="usage-card${c.accent ? ' accent' : ''} cost">
          <div class="usage-card-label">${c.label}</div>
          <div class="usage-card-value">${c.value}</div>
        </div>`
      ).join('');

      // 柱状图（按小时或按日）
      const isHourly = usage.isHourly;
      const chartData = isHourly ? (usage.hours || []) : (usage.days || []);
      const max = Math.max(0.0001, ...chartData.map(d => d.costUSD || 0));
      if (chartData.length === 0) {
        chartEl.innerHTML = '<div style="opacity:0.5;font-size:12px;width:100%;text-align:center;">无数据</div>';
      } else {
        chartEl.innerHTML = chartData.map(d => {
          const h = Math.max(2, Math.round(((d.costUSD || 0) / max) * 100));
          const label = isHourly ? `${d.hour}h` : (d.date || '').slice(5);
          const title = isHourly ? `${d.hour}:00 - ${fmt(d.costUSD)}` : `${d.date}: ${fmt(d.costUSD)}`;
          return `<div title="${title}" style="flex:1;min-width:4px;height:${h}px;background:var(--accent);border-radius:2px 2px 0 0;position:relative;">
            <div style="position:absolute;bottom:-16px;left:50%;transform:translateX(-50%);font-size:9px;opacity:0.5;white-space:nowrap;">${label}</div>
          </div>`;
        }).join('');
      }

      // 圆环占比（日/周/月三个）
      const periods = ['daily', 'weekly', 'monthly'];
      const labels = { daily: '日', weekly: '周', monthly: '月' };
      ringsEl.innerHTML = periods.map(p => {
        const info = status[p] || {};
        const pPct = info.pct || 0;
        const pColor = info.level === 'danger' ? '#f44336' : (info.level === 'warn' ? '#ff9800' : 'var(--accent)');
        const r = 15.915;
        const dashArray = `${(pPct/100 * 100).toFixed(1)} ${(100 - pPct/100 * 100).toFixed(1)}`;
        return `<div style="text-align:center">
          <svg viewBox="0 0 36 36" width="64" height="64">
            <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--border)" stroke-width="3"/>
            <circle cx="18" cy="18" r="${r}" fill="none" stroke="${pColor}" stroke-width="3"
              stroke-dasharray="${dashArray}" stroke-dashoffset="0" transform="rotate(-90 18 18)" stroke-linecap="round"/>
            <text x="18" y="20" text-anchor="middle" font-size="9" fill="var(--text-primary)" font-weight="600">${pPct.toFixed(0)}%</text>
          </svg>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${labels[p]}预算</div>
          <div style="font-size:10px;color:var(--text-tertiary)">${fmt(info.costUSD)}${info.limitUSD > 0 ? ' / ' + fmtLimit(info.limitUSD) : ''}</div>
        </div>`;
      }).join('');
    } catch (e) {
      console.error('loadBudgetChart failed:', e);
    }
  }

  // 预算周期按钮切换
  document.querySelectorAll('.budget-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.budget-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadBudgetChart(btn.dataset.period);
    });
  });
  // 周期设置变化时刷新图表
  document.getElementById('setting-budget-timezone')?.addEventListener('change', () => loadBudgetChart('daily'));
  document.getElementById('setting-budget-week-mode')?.addEventListener('change', () => loadBudgetChart('weekly'));
  document.getElementById('setting-budget-month-mode')?.addEventListener('change', () => loadBudgetChart('monthly'));
  loadBudgetSettings();

  // ── Terminal Settings ──
  // settings.terminal = { abortStrategy: 'kill'|'clearC'|'none', shell: 'auto'|..., customShellPath }
  async function loadTerminalSettings() {
    const s = await window.api.getSettings();
    const t = s.terminal || {};
    const abortSel = document.getElementById('setting-terminal-abortstrategy');
    const shellSel = document.getElementById('setting-terminal-shell');
    const customRow = document.getElementById('terminal-custom-shell-row');
    const customInput = document.getElementById('setting-terminal-custom-path');
    const sessionsMax = document.getElementById('setting-sessions-max');
    if (abortSel) abortSel.value = t.abortStrategy || 'kill';
    if (shellSel) shellSel.value = t.shell || 'auto';
    if (customInput) customInput.value = t.customShellPath || '';
    if (customRow) customRow.style.display = (shellSel && shellSel.value === 'custom') ? '' : 'none';
    if (sessionsMax) sessionsMax.value = String(Math.max(1, Number(s.sessions?.maxConcurrent) || 10));
  }
  document.getElementById('setting-terminal-abortstrategy')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.abortStrategy = e.target.value;
    await saveSettings(s);
    window.showToast?.('终端策略已保存', 'success', 2000);
  });
  document.getElementById('setting-terminal-shell')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.shell = e.target.value;
    await saveSettings(s);
    // 自定义路径输入框的显隐
    const customRow = document.getElementById('terminal-custom-shell-row');
    if (customRow) customRow.style.display = e.target.value === 'custom' ? '' : 'none';
    window.showToast?.('Shell 设置已保存', 'success', 2000);
  });
  document.getElementById('setting-terminal-custom-path')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.customShellPath = (e.target.value || '').trim();
    await saveSettings(s);
  });
  document.getElementById('setting-sessions-max')?.addEventListener('change', async (e) => {
    const value = Math.max(1, Math.min(50, Number(e.target.value) || 10));
    const s = await window.api.getSettings();
    if (!s.sessions) s.sessions = {};
    s.sessions.maxConcurrent = value;
    await saveSettings(s);
    if (sessionManager) sessionManager.maxConcurrent = value;
    e.target.value = String(value);
    window.showToast?.('最大并发会话数已保存', 'success', 2000);
  });
  loadTerminalSettings();

  async function loadMcpServerList() {
    const listEl = document.getElementById('mcp-servers-list');
    const toolsEl = document.getElementById('mcp-connected-tools');
    if (!listEl) return;

    try {
      const servers = await window.api.mcpListServers();
      if (!servers || servers.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">暂无 MCP 服务器配置</p>';
        toolsEl.innerHTML = '暂无已连接的 MCP 服务器';
        return;
      }

      listEl.innerHTML = servers.map(s => {
        const statusDot = s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : '';
        const statusText = s.status === 'connected' ? '已连接' : s.status === 'connecting' ? '连接中...' : s.status === 'error' ? '错误' : '未连接';
        return `
          <div class="mcp-server-card" data-name="${s.name}">
            <div class="mcp-server-icon"><i class="fa-solid fa-server"></i></div>
            <div class="mcp-server-info">
              <h4>${s.name}</h4>
              <p>${s.command || ''} ${(s.args || []).join(' ')}</p>
            </div>
            <div class="mcp-server-status">
              <span class="dot ${statusDot}"></span>
              <span>${statusText}${s.toolCount ? ` (${s.toolCount} 工具)` : ''}</span>
            </div>
            <div class="mcp-server-actions">
              ${s.status === 'connected'
                ? `<button class="btn-icon btn-mcp-disconnect" data-name="${s.name}" title="断开"><i class="fa-solid fa-plug-circle-xmark"></i></button>`
                : `<button class="btn-icon btn-mcp-connect" data-name="${s.name}" title="连接"><i class="fa-solid fa-plug-circle-check"></i></button>`
              }
              <button class="btn-icon btn-mcp-remove" data-name="${s.name}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>`;
      }).join('');

      // Bind buttons
      listEl.querySelectorAll('.btn-mcp-connect').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          btn.disabled = true;
          await window.api.mcpConnect(name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-disconnect').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpDisconnect(btn.dataset.name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpRemoveServer(btn.dataset.name);
          await loadMcpServerList();
        });
      });

      // Show connected tools
      const toolsResult = await window.api.mcpListTools();
      if (toolsResult.ok && toolsResult.tools.length > 0) {
        toolsEl.innerHTML = toolsResult.tools.map(t =>
          `<div style="margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border)">
            <strong>${t.name}</strong> <span style="color:var(--text-secondary);font-size:11px">[${t.serverName}]</span>
            <br><span style="font-size:12px">${t.description || ''}</span>
          </div>`
        ).join('');
      } else {
        toolsEl.innerHTML = '暂无已连接的工具';
      }
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--error-color)">加载失败: ${e.message}</p>`;
    }
  }

  function setupMcpEvents() {
    if (mcpEventsSetup) return;
    mcpEventsSetup = true;

    const btnAdd = document.getElementById('btn-mcp-add');
    const form = document.getElementById('mcp-add-form');
    const btnCancel = document.getElementById('btn-mcp-cancel');
    const btnSave = document.getElementById('btn-mcp-save');

    if (btnAdd) {
      btnAdd.addEventListener('click', () => {
        form.classList.toggle('hidden');
      });
    }
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        form.classList.add('hidden');
      });
    }
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const name = document.getElementById('mcp-new-name').value.trim();
        const command = document.getElementById('mcp-new-command').value.trim();
        const argsStr = document.getElementById('mcp-new-args').value.trim();
        const envStr = document.getElementById('mcp-new-env').value.trim();
        const cwd = document.getElementById('mcp-new-cwd').value.trim();
        const autoConnect = document.getElementById('mcp-new-autoconnect').checked;

        if (!name || !command) {
          alert('名称和命令不能为空');
          return;
        }

        let args = [];
        let env = {};
        try { if (argsStr) args = JSON.parse(argsStr); } catch { alert('参数格式错误(需JSON数组)'); return; }
        try { if (envStr) env = JSON.parse(envStr); } catch { alert('环境变量格式错误(需JSON对象)'); return; }

        const result = await window.api.mcpAddServer({ name, command, args, env, cwd: cwd || undefined, autoConnect });
        if (result.ok) {
          document.getElementById('mcp-new-name').value = '';
          document.getElementById('mcp-new-command').value = '';
          document.getElementById('mcp-new-args').value = '';
          document.getElementById('mcp-new-env').value = '';
          document.getElementById('mcp-new-cwd').value = '';
          document.getElementById('mcp-new-autoconnect').checked = false;
          form.classList.add('hidden');
          await loadMcpServerList();
        } else {
          alert(result.error || '添加失败');
        }
      });
    }
  }

  function updateAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-ai-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, true, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    updateAvatarPreviewFrame('ai');
  }

  function updateUserAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-user-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, false, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    updateAvatarPreviewFrame('user');
  }

  function updateBabeAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-babe-avatar-preview');
    if (!preview) return;
    // Babe 默认头像：无图时使用心形图标
    if (avatarData) {
      preview.innerHTML = makeAvatarHTML(avatarData, true, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    } else {
      preview.innerHTML = '<i class="fa-solid fa-heart"></i>';
    }
    updateAvatarPreviewFrame('babe');
  }

  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.querySelector(`.settings-panel[data-tab="${btn.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
      // Lazy-load usage stats when the tab is opened
      if (btn.dataset.tab === 'usage') {
        const activePeriod = document.querySelector('.usage-period-btn.active');
        loadUsageStats(activePeriod ? activePeriod.dataset.period : 'daily');
      }
      // 推送设置选项卡和面板的 active 状态到 WebUI/Remote
      document.querySelectorAll('.settings-tab').forEach(b => {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '.settings-tab[data-tab="' + b.dataset.tab + '"]', attr: 'class', value: b.className });
      });
      document.querySelectorAll('.settings-panel').forEach(p => {
        if (p.dataset.tab) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '.settings-panel[data-tab="' + p.dataset.tab + '"]', attr: 'class', value: p.className });
      });
    });
  });

  // ============ 设置页搜索（Ctrl/Cmd+F 打开，仅设置页生效） ============
  const settingsSearch = (() => {
    const input = document.getElementById('settings-search-input');
    const countEl = document.getElementById('settings-search-count');
    if (!input || !countEl) return null;

    let query = '';
    let lastActiveTab = 'ai';

    function activateTab(tabId) {
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tabId));
    }

    function settingItemText(item) {
      let text = item.textContent || '';
      item.querySelectorAll('input, textarea, select').forEach(el => {
        text += ' ' + (el.value || '') + ' ' + (el.placeholder || '');
      });
      return text.toLowerCase();
    }

    function applyQuery() {
      const q = query;
      const panels = Array.from(document.querySelectorAll('#page-settings .settings-panel'));
      let matchCount = 0;
      let firstPanelTab = null;
      panels.forEach(panel => {
        const items = Array.from(panel.querySelectorAll(':scope > .settings-group > .setting-item, :scope > .setting-item'));
        let panelMatches = 0;
        items.forEach(item => {
          const ok = !q || settingItemText(item).includes(q);
          item.classList.toggle('settings-search-match', !!q && ok);
          item.style.display = q ? (ok ? '' : 'none') : '';
          if (q && ok) panelMatches++;
        });
        panel.querySelectorAll(':scope > .settings-group').forEach(group => {
          const hasVisibleItem = group.querySelector('.setting-item:not([style*="display: none"])');
          const titleMatch = q && group.querySelector('h3') && (group.querySelector('h3').textContent || '').toLowerCase().includes(q);
          group.style.display = q ? ((hasVisibleItem || titleMatch) ? '' : 'none') : '';
        });
        const panelVisible = !q || panelMatches > 0;
        panel.style.display = q ? (panelVisible ? '' : 'none') : '';
        if (panelVisible && q) {
          matchCount += panelMatches;
          if (!firstPanelTab) firstPanelTab = panel.dataset.tab;
        }
        const tab = document.querySelector(`.settings-tab[data-tab="${panel.dataset.tab}"]`);
        if (tab) tab.style.display = q ? (panelVisible ? '' : 'none') : '';
      });
      countEl.textContent = q ? `${matchCount} 项` : '';
      input.classList.toggle('has-results', !!q);
      if (q && firstPanelTab) activateTab(firstPanelTab);
      else if (!q) activateTab(lastActiveTab);
    }

    function open() {
      lastActiveTab = document.querySelector('.settings-tab.active')?.dataset.tab || 'ai';
      input.focus({ preventScroll: true });
      try { input.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      Promise.resolve().then(() => input.focus({ preventScroll: true }));
    }

    function close() {
      if (query || input.value) {
        query = '';
        input.value = '';
        applyQuery();
      }
      input.blur();
    }

    input.addEventListener('input', () => {
      query = input.value.trim().toLowerCase();
      applyQuery();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    document.querySelectorAll('.settings-tab').forEach(b => {
      b.addEventListener('click', () => { if (!query) lastActiveTab = b.dataset.tab; });
    });

    if (typeof window.registerPageSearch === 'function') {
      window.registerPageSearch('settings', { open, close });
    }
    return { open, close };
  })();

  // Settings change handlers
  async function saveSettings(updates) {
    const current = await window.api.getSettings();
    const merged = { ...current, ...updates };
    await window.api.setSettings(merged);
    // 即时生效：更新 maxTokens + 重算 systemPrompt（persona/llm 变更后立即生效，无需重启）
    if (typeof agent.applySettings === 'function') {
      agent.applySettings(merged);
    } else {
      agent.settings = merged;
    }
    // 隐私信息保护：同步到 Code / Babe 代理实例（其 settings 为独立快照）
    if (merged.privacyProtection) {
      if (typeof codeAgent !== 'undefined' && codeAgent && codeAgent.settings) codeAgent.settings.privacyProtection = merged.privacyProtection;
      if (typeof babeAgent !== 'undefined' && babeAgent && babeAgent.settings) babeAgent.settings.privacyProtection = merged.privacyProtection;
    }
  }

  // LLM settings
  ['setting-llm-url', 'setting-llm-key', 'setting-llm-model', 'setting-llm-ctx', 'setting-llm-daily-limit', 'setting-llm-max-response'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-llm-url': 'apiUrl', 'setting-llm-key': 'apiKey', 'setting-llm-model': 'model', 'setting-llm-ctx': 'maxContextLength', 'setting-llm-daily-limit': 'dailyMaxTokens', 'setting-llm-max-response': 'maxResponseTokens' }[id];
      const val = (id === 'setting-llm-ctx' || id === 'setting-llm-daily-limit' || id === 'setting-llm-max-response') ? parseInt(e.target.value) : e.target.value;
      const s = await window.api.getSettings();
      s.llm[key] = val;
      await saveSettings(s);
      if (key === 'maxContextLength') agent.contextManager.setMaxTokens(val);
    });
  });

  document.getElementById('setting-llm-temp').addEventListener('input', async (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById('setting-temp-val').textContent = val;
    const s = await window.api.getSettings();
    s.llm.temperature = val;
    await saveSettings(s);
  });

  // Streaming / retry / timeout / fallback model
  document.getElementById('setting-llm-stream').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.streamResponses = e.target.checked;
    await saveSettings(s);
  });
  const forceVisionSaveEl = document.getElementById('setting-llm-force-vision');
  if (forceVisionSaveEl) {
    forceVisionSaveEl.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.llm.forceVision = e.target.checked;
      await saveSettings(s);
    });
  }
  document.getElementById('setting-llm-retries').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.maxRetries = Math.max(0, parseInt(e.target.value) || 0);
    await saveSettings(s);
  });
  document.getElementById('setting-llm-timeout').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.timeoutMs = Math.max(0, parseInt(e.target.value) || 0) * 1000;
    await saveSettings(s);
  });
  document.getElementById('setting-llm-fallback-model').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.fallbackModel = e.target.value.trim();
    await saveSettings(s);
  });

  // Provider selection — switches between OpenAI-compat and Zen fields
  document.getElementById('setting-llm-provider').addEventListener('change', async (e) => {
    const provider = e.target.value;
    const s = await window.api.getSettings();
    s.llm.provider = provider;
    // When switching to Zen, persist a sensible default apiUrl/model
    if (provider === 'opencode-zen') {
      if (!s.llm.model || !s.llm.model.startsWith('gpt-') && !s.llm.model.startsWith('claude-') &&
          !s.llm.model.startsWith('qwen') && !s.llm.model.startsWith('deepseek') &&
          !s.llm.model.startsWith('kimi') && !s.llm.model.startsWith('glm-') &&
          !s.llm.model.startsWith('big-pickle') && !s.llm.model.startsWith('mimo') &&
          !s.llm.model.startsWith('north-mini') && !s.llm.model.startsWith('nemotron') &&
          !s.llm.model.startsWith('gemini') && !s.llm.model.startsWith('minimax') &&
          !s.llm.model.startsWith('grok-')) {
        s.llm.model = 'big-pickle';
      }
    }
    await saveSettings(s);
    updateLLMProviderFields(provider);
    if (provider === 'opencode-zen') {
      await refreshZenModels(s.llm.model);
      // sync zen-model dropdown with current model
      const zenSel = document.getElementById('setting-llm-zen-model');
      if (zenSel) zenSel.value = s.llm.model;
    } else {
      // restore model field text
      const modelEl = document.getElementById('setting-llm-model');
      if (modelEl) modelEl.value = s.llm.model || '';
    }
  });

  // Zen API key
  document.getElementById('setting-llm-zen-key').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.zenApiKey = e.target.value.trim();
    // 用户手动改 key 时清除 public 标记
    if (e.target.value.trim() === 'public') {
      e.target.dataset.publicKey = '1';
    } else {
      delete e.target.dataset.publicKey;
    }
    await saveSettings(s);
    // refresh models with new key
    await refreshZenModels(s.llm.model);
  });

  // Zen model select — sync to llm.model
  document.getElementById('setting-llm-zen-model').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.model = e.target.value;
    await saveSettings(s);
  });

  // Zen refresh button
  const zenRefreshBtn = document.getElementById('btn-zen-refresh');
  if (zenRefreshBtn) zenRefreshBtn.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    await refreshZenModels(s.llm.model);
  });

  // Zen 生成免登录公共 Key（public，限免模型可用）
  const zenGenKeyBtn = document.getElementById('btn-zen-generate-key');
  if (zenGenKeyBtn) zenGenKeyBtn.addEventListener('click', async () => {
    const keyInput = document.getElementById('setting-llm-zen-key');
    if (!keyInput) return;
    // 使用 opencode 内置的免登录公共 key："public"（仅可调用限时免费模型）
    keyInput.value = 'public';
    keyInput.dataset.publicKey = '1';
    const s = await window.api.getSettings();
    s.llm.zenApiKey = 'public';
    s.llm.provider = 'opencode-zen';
    s.llm.apiUrl = 'https://opencode.ai/zen/v1/chat/completions';
    await saveSettings(s);
    // 刷新模型列表，过滤为仅显示免费模型
    await refreshZenModels(s.llm.model);
    const hint = document.getElementById('zen-model-hint');
    if (hint) hint.textContent = '已使用免登录公共 Key（public），仅可调用限时免费模型';
  });

  // OpenAI/Anthropic compatible models refresh button
  const llmRefreshBtn = document.getElementById('btn-llm-refresh-models');
  if (llmRefreshBtn) llmRefreshBtn.addEventListener('click', () => refreshLLMModels());

  // Zen auth link
  const zenAuthLink = document.getElementById('link-zen-auth');
  if (zenAuthLink) zenAuthLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openBrowser('https://opencode.ai/auth');
  });

  // Reasoning effort
  document.getElementById('setting-llm-reasoning').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.reasoningEffort = e.target.value;
    await saveSettings(s);
  });

  // Usage stats period buttons
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

  // Image settings
  ['setting-img-url', 'setting-img-key', 'setting-img-model', 'setting-img-daily-limit'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-img-url': 'apiUrl', 'setting-img-key': 'apiKey', 'setting-img-model': 'model', 'setting-img-daily-limit': 'dailyMaxImages' }[id];
      const s = await window.api.getSettings();
      const val = id === 'setting-img-daily-limit' ? parseInt(e.target.value) : e.target.value;
      s.imageGen[key] = val;
      await saveSettings(s);
    });
  });

  document.getElementById('setting-img-size').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.imageGen.imageSize = e.target.value;
    await saveSettings(s);
  });

  // Theme mode
  document.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.theme-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const s = await window.api.getSettings();
      const oldMode = s.theme.mode;
      s.theme.mode = btn.dataset.mode;

      // 检测是否切换了深浅色模式
      const oldDark = await ThemeManager.getCurrentDarkMode(oldMode);
      const newDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
      const currentBgDark = ThemeManager.isBackgroundDark(s.theme.backgroundColor);

      // 如果深浅色模式改变，或者当前配色与目标模式不符，随机应用目标色系的配色
      if (oldDark !== newDark || currentBgDark !== newDark) {
        const scheme = ThemeManager.getRandomScheme(newDark);
        s.theme.accentColor = scheme.accent;
        s.theme.backgroundColor = scheme.bg;
        document.getElementById('setting-accent-color').value = scheme.accent;
        document.getElementById('setting-bg-color').value = scheme.bg;
      }

      await saveSettings(s);
      ThemeManager.apply(s.theme);
      updateColorSchemeVisibility();
    });
  });

  // Accent color
  document.getElementById('setting-accent-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.accentColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#accent-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-accent-color').value = color;
      const s = await window.api.getSettings();
      s.theme.accentColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Background color
  document.getElementById('setting-bg-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.backgroundColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#bg-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-bg-color').value = color;
      const s = await window.api.getSettings();
      s.theme.backgroundColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Color schemes
  async function updateColorSchemeVisibility() {
    const s = await window.api.getSettings();
    const isDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
    document.querySelectorAll('.scheme-btn').forEach(btn => {
      const bgColor = btn.dataset.bg;
      const btnIsDark = ThemeManager.isBackgroundDark(bgColor);
      // 只显示当前深浅色系的配色
      if (btnIsDark === isDark) {
        btn.style.display = '';
      } else {
        btn.style.display = 'none';
      }
    });
  }

  document.querySelectorAll('.scheme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const accent = btn.dataset.accent;
      const bg = btn.dataset.bg;
      document.getElementById('setting-accent-color').value = accent;
      document.getElementById('setting-bg-color').value = bg;
      const s = await window.api.getSettings();
      s.theme.accentColor = accent;
      s.theme.backgroundColor = bg;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Password toggle
  document.querySelectorAll('.btn-toggle-pwd').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target.type === 'password') {
        target.type = 'text';
        btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
      } else {
        target.type = 'password';
        btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      }
    });
  });

  // Auto-approve toggle
  document.getElementById('setting-auto-approve').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const confirmed = await window.api.confirmSensitive('开启自动批准敏感操作后，AI Agent将无需确认即可执行文件删除、终端命令等危险操作。\n\n确定要开启吗？');
      if (!confirmed) {
        e.target.checked = false;
        return;
      }
    }
    const s = await window.api.getSettings();
    s.autoApproveSensitive = e.target.checked;
    await saveSettings(s);
  });

  // 隐私信息保护：总开关与过滤触发器
  function updatePrivacyTriggerState(enabled) {
    const item = document.getElementById('privacy-trigger-item');
    if (item) {
      item.querySelectorAll('input').forEach(inp => { inp.disabled = !enabled; });
      item.style.opacity = enabled ? '' : '0.5';
    }
    const catItem = document.getElementById('privacy-categories-item');
    if (catItem) {
      catItem.querySelectorAll('input').forEach(inp => { inp.disabled = !enabled; });
      catItem.style.opacity = enabled ? '' : '0.5';
    }
  }

  async function savePrivacySettings() {
    const s = await window.api.getSettings();
    const categories = {};
    document.querySelectorAll('#privacy-categories-item input[data-cat]').forEach(inp => {
      categories[inp.dataset.cat] = inp.checked;
    });
    s.privacyProtection = {
      enabled: document.getElementById('setting-privacy-enabled').checked,
      filterResults: document.getElementById('setting-privacy-filter-results').checked,
      filterArgs: document.getElementById('setting-privacy-filter-args').checked,
      filterTerminal: document.getElementById('setting-privacy-filter-terminal').checked,
      filterAttachments: document.getElementById('setting-privacy-filter-attachments').checked,
      categories
    };
    await saveSettings(s);
  }

  document.getElementById('setting-privacy-enabled').addEventListener('change', (e) => {
    updatePrivacyTriggerState(e.target.checked);
    savePrivacySettings();
  });
  ['setting-privacy-filter-results', 'setting-privacy-filter-args', 'setting-privacy-filter-terminal'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => savePrivacySettings());
  });

  // 后台托盘：启用托盘图标
  document.getElementById('setting-tray-enabled')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      const r = await window.api.traySetEnabled(enabled);
      if (r && r.ok) {
        // 同步本地 settings 缓存
        try { agent.settings = r.settings; } catch {}
      } else {
        e.target.checked = !enabled; // 回滚
      }
    } catch (err) {
      console.error('[Tray] set enabled failed:', err);
      e.target.checked = !enabled;
    }
  });

  // 后台托盘：关闭窗口行为
  document.getElementById('setting-close-to-tray')?.addEventListener('change', async (e) => {
    const mode = e.target.value;
    if (!['ask', 'always', 'never'].includes(mode)) return;
    try {
      const r = await window.api.traySetCloseToTray(mode);
      if (r && r.ok) {
        try { agent.settings = r.settings; } catch {}
      }
    } catch (err) {
      console.error('[Tray] set closeToTray failed:', err);
    }
  });

  // 后台托盘：测试隐藏按钮
  document.getElementById('btn-tray-test-hide')?.addEventListener('click', () => {
    try { window.api.trayHideToTray(); } catch (err) {
      console.error('[Tray] test hide failed:', err);
    }
  });

  // Usage reset button
  document.getElementById('btn-reset-usage')?.addEventListener('click', async () => {
    const confirmed = await window.api.confirmSensitive('确定要重置每日使用量统计吗？\n\n这将清零今日的Token用量和图片生成数。');
    if (!confirmed) return;

    const s = await window.api.getSettings();
    s.llm.dailyTokensUsed = 0;
    s.llm.dailyTokenDate = '';
    s.imageGen.dailyImagesUsed = 0;
    s.imageGen.dailyImageDate = '';
    await saveSettings(s);

    // Refresh display
    document.getElementById('setting-llm-usage').textContent = '今日已用: 0';
    document.getElementById('setting-img-usage').textContent = '今日已用: 0';
    alert('使用量已重置');
  });

  // Firmware export button
  document.getElementById('btn-export-firmware')?.addEventListener('click', async () => {
    const result = await window.api.firmwareExport();
    if (result.ok) {
      showMessageModal(`固件源码已导出到：<br>${result.path}<br><br>请在 Arduino IDE 中打开 CIBYP-TRNG.ino 文件。`, '导出成功', 'success');
      window.api.openFileExplorer(result.path);
    } else {
      showMessageModal(`导出失败：${result.error || '未知错误'}`, '导出失败', 'error');
    }
  });

  // Arduino download link
  document.querySelectorAll('.link-arduino-download').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openBrowser('https://www.arduino.cc/en/software');
    });
  });

  // ---- AI Persona Settings ----
  ['setting-ai-name', 'setting-ai-bio', 'setting-ai-pronouns', 'setting-ai-personality', 'setting-ai-custom-prompt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = {
          'setting-ai-name': 'name',
          'setting-ai-bio': 'bio',
          'setting-ai-pronouns': 'pronouns',
          'setting-ai-personality': 'personality',
          'setting-ai-custom-prompt': 'customPrompt',
        }[id];
        const s = await window.api.getSettings();
        if (!s.aiPersona) s.aiPersona = {};
        s.aiPersona[key] = el.value;
        await saveSettings(s);
        // Update agent system prompt
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        // Update display
        updatePersonaDisplay(s.aiPersona);
      });
    }
  });

  // 命运之牌可见性开关
  const tarotVisibleToggle = document.getElementById('setting-tarot-visible');
  if (tarotVisibleToggle) {
    tarotVisibleToggle.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      s.tarotVisible = tarotVisibleToggle.checked;
      await saveSettings(s);
      applyTarotVisibility(s.tarotVisible);
    });
  }

  // 通知开关 - 总开关 + 5 个分类 + 测试按钮
  const notifyToggles = [
    { id: 'setting-notify-enabled', key: 'enabled' },
    { id: 'setting-notify-approval', key: 'approval' },
    { id: 'setting-notify-session-done', key: 'sessionDone' },
    { id: 'setting-notify-question', key: 'question' },
    { id: 'setting-notify-present', key: 'present' },
    { id: 'setting-notify-babe-proactive', key: 'babeProactive' }
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

  // Language settings save button
  const btnSaveLanguage = document.getElementById('btn-save-language');
  if (btnSaveLanguage) {
    btnSaveLanguage.addEventListener('click', async () => {
      const langSelect = document.getElementById('setting-language');
      const lang = langSelect ? langSelect.value : 'zh-CN';
      const s = await window.api.getSettings();
      s.language = lang;
      await saveSettings(s);
      if (typeof i18nSetLanguage === 'function') {
        i18nSetLanguage(lang);
        i18nApplyToDOM();
      }
      // Update agent instances so system prompts use the new language
      if (typeof agent !== 'undefined' && agent && agent.settings) {
        agent.settings.language = lang;
        agent.contextManager?.setSystemPrompt(agent.getSystemPrompt());
      }
      if (typeof codeAgent !== 'undefined' && codeAgent && codeAgent.settings) {
        codeAgent.settings.language = lang;
        codeAgent.contextManager?.setSystemPrompt(codeAgent.getSystemPrompt());
      }
      if (typeof babeAgent !== 'undefined' && babeAgent && babeAgent.settings) {
        babeAgent.settings.language = lang;
        babeAgent.contextManager?.setSystemPrompt(babeAgent.getSystemPrompt());
      }
      window.showMessageModal?.(t('ui.language.saved', '语言设置已保存，部分文本将在下次启动后完全生效', {}), t('ui.language.notice', '提示', {}), 'info');
    });
  }

  // ---- Babe Mode Settings ----
  ['setting-babe-name', 'setting-babe-gender', 'setting-babe-age', 'setting-babe-personality', 'setting-babe-persona', 'setting-babe-user-nickname', 'setting-babe-proactive-interval', 'setting-babe-initial-affection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = {
          'setting-babe-name': 'name',
          'setting-babe-gender': 'gender',
          'setting-babe-age': 'age',
          'setting-babe-personality': 'personality',
          'setting-babe-persona': 'persona',
          'setting-babe-user-nickname': 'userNickname',
          'setting-babe-proactive-interval': 'proactiveInterval',
          'setting-babe-initial-affection': 'initialAffection'
        }[id];
        const val = (id === 'setting-babe-proactive-interval' || id === 'setting-babe-initial-affection')
          ? parseInt(el.value, 10) || 0
          : el.value;
        const s = await window.api.getSettings();
        if (!s.babe) s.babe = {};
        s.babe[key] = val;
        await saveSettings(s);
        // 如果修改了初始好感度，且当前没有活跃 Babe 会话，更新 babeAgent 的好感度
        if (key === 'initialAffection' && babeAgent && !babeCurrentHistoryId) {
          babeAgent.babeAffection = val;
          updateBabeAffection(val);
        }
        // 主动消息频率变更时重启定时器
        if (key === 'proactiveInterval') {
          restartBabeProactiveTimer(val);
        }
      });
    }
  });

  // AI avatar file picker
  document.getElementById('btn-ai-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.aiPersona) s.aiPersona = {};
      s.aiPersona.avatar = result.dataUrl;
      await saveSettings(s);
      updateAvatarPreview(result.dataUrl);
      updatePersonaDisplay(s.aiPersona);
      window.api.webControlSetAvatars({ ai: result.dataUrl, user: s.userProfile?.avatar || '' });
    }
  });

  document.getElementById('btn-ai-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.aiPersona) s.aiPersona = {};
    s.aiPersona.avatar = '';
    await saveSettings(s);
    updateAvatarPreview('');
    updatePersonaDisplay(s.aiPersona);
    window.api.webControlSetAvatars({ ai: '', user: s.userProfile?.avatar || '' });
  });

  function updatePersonaDisplay(persona) {
    const nameEl = document.getElementById('agent-name-display');
    const avatarEl = document.getElementById('agent-avatar-display');
    if (nameEl && persona?.name) nameEl.textContent = persona.name;
    if (avatarEl) {
      const frameId = _avatarFrameState.ai;
      const hasFrame = !!(frameId && _avatarFrameCache[frameId]);
      // 有头像框时不设置 inline 尺寸，让 CSS .has-frame > img 控制（140% 与 overlay 同尺寸对齐）
      const avatarSize = hasFrame
        ? 'border-radius:50%;object-fit:cover'
        : 'width:28px;height:28px;border-radius:50%;object-fit:cover';
      avatarEl.innerHTML = makeAvatarHTML(persona?.avatar, true, avatarSize);
      // Hero 头像框叠加
      if (hasFrame) {
        avatarEl.classList.add('has-frame');
        avatarEl.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
      } else {
        avatarEl.classList.remove('has-frame');
      }
    }
  }

  // ---- User Profile Settings ----
  ['setting-user-name', 'setting-user-bio'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = { 'setting-user-name': 'name', 'setting-user-bio': 'bio' }[id];
        const s = await window.api.getSettings();
        if (!s.userProfile) s.userProfile = {};
        s.userProfile[key] = el.value;
        await saveSettings(s);
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      });
    }
  });

  document.getElementById('btn-user-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.userProfile) s.userProfile = {};
      s.userProfile.avatar = result.dataUrl;
      await saveSettings(s);
      updateUserAvatarPreview(result.dataUrl);
      window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: result.dataUrl });
    }
  });

  document.getElementById('btn-user-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.userProfile) s.userProfile = {};
    s.userProfile.avatar = '';
    await saveSettings(s);
    updateUserAvatarPreview('');
    window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: '' });
  });

  // ---- Babe Avatar Settings ----
  document.getElementById('btn-babe-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.babe) s.babe = {};
      s.babe.avatar = result.dataUrl;
      await saveSettings(s);
      // 同步到 babeAgent.settings
      if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
      updateBabeAvatarPreview(result.dataUrl);
      updateBabePersonaDisplay(s.babe);
    }
  });

  document.getElementById('btn-babe-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.babe) s.babe = {};
    s.babe.avatar = '';
    await saveSettings(s);
    if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
    updateBabeAvatarPreview('');
    updateBabePersonaDisplay(s.babe);
  });

  // ---- Entropy Source Settings ----
  document.querySelectorAll('.entropy-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.entropy-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const source = btn.dataset.source;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy.source = source;
      await saveSettings(s);
      document.getElementById('entropy-trng-settings').style.display = source === 'trng' ? '' : 'none';
    });
  });

  document.querySelectorAll('.trng-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.trng-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy.trngMode = mode;
      await saveSettings(s);
      document.getElementById('trng-network-settings').style.display = mode === 'network' ? '' : 'none';
      document.getElementById('trng-serial-settings').style.display = mode === 'serial' ? '' : 'none';
      if (mode === 'serial') {
        refreshTrngPorts(true);
      }
    });
  });

  ['setting-trng-host', 'setting-trng-port'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
      const key = id === 'setting-trng-host' ? 'trngNetworkHost' : 'trngNetworkPort';
      const val = id === 'setting-trng-port' ? parseInt(e.target.value) : e.target.value;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy[key] = val;
      await saveSettings(s);
    });
  });

  document.getElementById('setting-trng-serial-port')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.entropy) s.entropy = {};
    s.entropy.trngSerialPort = e.target.value;
    await saveSettings(s);
  });
  document.getElementById('setting-trng-serial-baud')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.entropy) s.entropy = {};
    s.entropy.trngSerialBaud = parseInt(e.target.value);
    await saveSettings(s);
  });

  async function refreshTrngPorts(showStatus) {
    const result = await window.api.trngListPorts();
    const sel = document.getElementById('setting-trng-serial-port');
    const statusEl = document.getElementById('trng-port-status');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">选择串口...</option>';

    if (result.ok && Array.isArray(result.ports)) {
      result.ports.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = `${p.path} ${p.manufacturer || ''} ${p.serialNumber || ''}`.trim();
        sel.appendChild(opt);
      });
      if (current) sel.value = current;
      if (statusEl && showStatus) {
        statusEl.textContent = result.ports.length > 0 ? `发现 ${result.ports.length} 个串口` : '未检测到串口';
        statusEl.className = 'setting-hint';
      }
      sel.disabled = false;
      return;
    }

    const errMsg = result?.error || '串口列表获取失败';
    if (statusEl && showStatus) {
      statusEl.textContent = errMsg.includes('serialport') ? 'serialport 未安装，请先安装依赖' : `串口列表失败: ${errMsg}`;
      statusEl.className = 'setting-hint warning';
    }
    sel.disabled = true;
  }

  document.getElementById('btn-refresh-ports')?.addEventListener('click', async () => {
    refreshTrngPorts(true);
  });

  document.getElementById('btn-trng-test')?.addEventListener('click', async () => {
    const el = document.getElementById('trng-test-result');
    if (el) el.textContent = '正在测试...';
    const result = await window.api.trngTest();
    if (el) {
      if (result.ok) {
        const r = result.result;
        const _lang3 = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
        const _isZh3 = (_lang3 === 'zh-CN');
        el.textContent = `${_isZh3 ? '连接成功! 抽到: ' : 'Connected! Drew: '}${r.name}${r.orientation === 'reversed' ? ' (Reversed)' : ' (Upright)'} - ${r.entropySource}`;
        el.className = 'setting-hint success';
      } else {
        el.textContent = `连接失败: ${result.error}`;
        el.className = 'setting-hint warning';
      }
    }
  });

  // ---- Proxy Settings ----
  document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.proxy-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const s = await window.api.getSettings();
      if (!s.proxy) s.proxy = {};
      s.proxy.mode = mode;
      await saveSettings(s);
      document.getElementById('manual-proxy-settings').style.display = mode === 'manual' ? '' : 'none';
      // 动态应用代理到 Electron session + aria2（无需重启）
      window.api.applyProxy(s.proxy).catch(() => {});
    });
  });

  ['setting-proxy-http', 'setting-proxy-https', 'setting-proxy-bypass'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
      const key = id.replace('setting-proxy-', '');
      const s = await window.api.getSettings();
      if (!s.proxy) s.proxy = {};
      s.proxy[key] = e.target.value;
      await saveSettings(s);
      // 动态应用代理到 Electron session + aria2（无需重启）
      window.api.applyProxy(s.proxy).catch(() => {});
    });
  });

  // ---- History Page ----
  async function loadHistoryPage() {
    const list = document.getElementById('history-list');
    if (!list) return;

    // Remote 模式：通过 WS 拉取远端历史，继续/删除均转发到远端
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载远程历史…</p></div>';
      try {
        const resp = await remoteWsRequest({ type: 'getHistory' }, 'history', 8000);
        const histories = resp.history || [];
        if (!histories || histories.length === 0) {
          list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>远端暂无对话历史</p></div>';
          return;
        }
        list.innerHTML = histories.map(h => {
          let timeStr = '未知时间';
          const ts = h.timestamp ? (typeof h.timestamp === 'number' ? h.timestamp : Date.parse(h.timestamp))
            : (h.createdAt ? (typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt)) : null);
          if (ts && !isNaN(ts)) timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          return `
          <div class="history-item" data-id="${escapeHtml(h.id)}">
            <div class="history-info">
            <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(h.status || 'idle', null)}</div>
              <div class="history-time">${timeStr}</div>
            </div>
            <div class="history-actions">
              <button class="btn-icon history-continue" data-id="${escapeHtml(h.id)}" title="继续对话"><i class="fa-solid fa-play"></i></button>
              <button class="btn-icon history-delete" data-id="${escapeHtml(h.id)}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>`;
        }).join('');
        list.querySelectorAll('.history-continue').forEach(btn => {
          btn.addEventListener('click', () => {
            if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) return;
            remoteWs.send(JSON.stringify({ type: 'loadConversation', id: btn.dataset.id }));
            // 高亮当前项；远端加载后会推送 messagesSync
            list.querySelectorAll('.history-item').forEach(el => el.classList.toggle('active', el.dataset.id === btn.dataset.id));
            // 切换到对话页
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-chat')?.classList.add('active');
            clearChatMessagesUI();
            addThinkingIndicator();
          });
        });
        list.querySelectorAll('.history-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('确认删除此远端对话？')) return;
            try {
              await remoteWsRequest({ type: 'deleteConversation', id: btn.dataset.id }, 'conversationDeleted', 8000);
            } catch (e) { /* 忽略，仍刷新列表 */ }
            loadHistoryPage();
          });
        });
      } catch (e) {
        list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>加载远程历史失败: ${escapeHtml(e.message || '')}</p></div>`;
      }
      return;
    }

    // 本地模式：优先走虚拟滚动 + 搜索 + 事件委托；下方旧的全量渲染保留为回退
    if (typeof HistoryList !== 'undefined') {
      await loadHistoryPageVirtual();
      return;
    }

    const histories = await window.api.historyList();
    if (!histories || histories.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无对话历史</p></div>';
      return;
    }
    list.innerHTML = histories.map(h => {
      let timeStr = '未知时间';
      if (h.timestamp) {
        const ts = typeof h.timestamp === 'number' ? h.timestamp : Date.parse(h.timestamp);
        if (!isNaN(ts)) {
          timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
      } else if (h.createdAt) {
        const ts = typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt);
        if (!isNaN(ts)) {
          timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
      }
      const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('chat', h) : null;
      return `
      <div class="history-item" data-id="${h.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(live ? live.status : h.status, live ? live.lastError : h.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon history-continue" data-id="${h.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon history-open-workspace" data-id="${h.id}" title="打开工作目录"><i class="fa-solid fa-folder-open"></i></button>
          <button class="btn-icon history-export-json" data-id="${h.id}" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon history-export-md" data-id="${h.id}" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon history-delete" data-id="${h.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>
      `;
    }).join('');

    const sanitizeFileName = (name) => (name || '对话记录').replace(/[\\/:*?"<>|]/g, '_');
    const buildMarkdown = (conv) => {
      const title = conv.title || '未命名对话';
      const createdAt = conv.createdAt ? new Date(conv.createdAt).toLocaleString('zh-CN') : '';
      const updatedAt = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString('zh-CN') : '';
      const lines = [];
      lines.push(`# ${title}`);
      lines.push('');
      if (createdAt) lines.push(`- 创建时间：${createdAt}`);
      if (updatedAt) lines.push(`- 更新时间：${updatedAt}`);
      if (conv.workspacePath) lines.push(`- 工作目录：${conv.workspacePath}`);
      lines.push('');

      (conv.messages || []).forEach(msg => {
        const role = msg.role || 'assistant';
        const roleName = role === 'user' ? '用户' : role === 'assistant' ? 'AI' : role === 'system' ? '系统' : '工具';
        lines.push(`## ${roleName}`);
        if (role === 'tool') {
          let toolContent = msg.content;
          try { toolContent = JSON.stringify(JSON.parse(msg.content), null, 2); } catch {}
          lines.push('```json');
          lines.push(toolContent || '');
          lines.push('```');
        } else {
          lines.push(msg.content || '');
        }
        lines.push('');
      });
      return lines.join('\n');
    };

    list.querySelectorAll('.history-continue').forEach(btn => {
      btn.addEventListener('click', async () => {
        stopVoicePlayback(); // 切换会话前清空语音播放队列
        const conv = await window.api.historyGet(btn.dataset.id);
        if (conv) {
          const existing = sessionManager ? sessionManager.list('chat').find(s => String(s.id) === String(conv.id)) : null;
          if (existing) {
            agent = existing.agent;
            activateSession('chat', existing.key);
          } else {
            const ag = new Agent();
            ag.mode = 'chat';
            await ag.init();
            await ag.loadFromHistory(conv);
            wireChatAgent(ag);
            const target = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
            agent = ag;
            activateSession('chat', target.key);
          }
          setTitlebarTitle(agent.conversationTitle || '未命名对话');
          updateContextProgress();
          // Switch to chat page
          document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
          document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
          document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
          document.getElementById('page-chat')?.classList.add('active');
          // Replay messages（异步分块渲染 + 进度模态框，避免长历史阻塞/卡死）
          chatMessages.innerHTML = '';
          if (typeof VirtualScroller !== 'undefined') VirtualScroller.reset();
          if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchStart();
          WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#chat-messages' });
          WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
          // 递增 generation：取消任何进行中的历史回放，防止新旧会话消息交错
          const chatGeneration = (window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1);
          await replayHistoryMessages(conv.messages || [], {
            cancelCheck: () => window.__chatReplayGeneration !== chatGeneration
          });
          // 批量加载结束：触发首屏渲染（仅渲染可视区域内的消息）
          if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchEnd();
          requestAnimationFrame(() => {
            const last = chatMessages.lastElementChild;
            if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
          });
        }
      });
    });

    list.querySelectorAll('.history-open-workspace').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (conv?.workspacePath) {
          window.api.openFileExplorer(conv.workspacePath);
        } else {
          alert('该对话没有记录工作目录');
        }
      });
    });

    list.querySelectorAll('.history-export-json').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (!conv) return;
        const filename = `${sanitizeFileName(conv.title || '对话记录')}.json`;
        const result = await window.api.saveFileDialog({
          title: '导出对话记录(JSON)',
          defaultPath: filename,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (!result.ok || !result.path) return;
        const content = JSON.stringify(conv, null, 2);
        const saveResult = await window.api.writeFile(result.path, content);
        if (saveResult.ok) {
          showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
        } else {
          showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
        }
      });
    });

    list.querySelectorAll('.history-export-md').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (!conv) return;
        const filename = `${sanitizeFileName(conv.title || '对话记录')}.md`;
        const result = await window.api.saveFileDialog({
          title: '导出对话记录(Markdown)',
          defaultPath: filename,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        });
        if (!result.ok || !result.path) return;
        const content = buildMarkdown(conv);
        const saveResult = await window.api.writeFile(result.path, content);
        if (saveResult.ok) {
          showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
        } else {
          showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
        }
      });
    });

    list.querySelectorAll('.history-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        // 对齐 Babe 模式：删除历史记录前二次确认，防止误删
        const conv = await window.api.historyGet(btn.dataset.id).catch(() => null);
        const titleForConfirm = conv?.title || '此对话';
        const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
        if (!confirmed) return;
        await window.api.historyDelete(btn.dataset.id);
        if (agent.conversationId === btn.dataset.id) {
          agent.newConversation();
          clearChatMessagesUI();
          setTitlebarTitle('未命名对话');
        }
        loadHistoryPage();
      });
    });
    // 增量推送：替换历史列表内容
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#history-list', html: list.innerHTML });
  }

  // ============ 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let historyRawItems = [];
  let historySearch = null;

  function formatHistoryTime(h) {
    let timeStr = '未知时间';
    const ts = h.timestamp ? (typeof h.timestamp === 'number' ? h.timestamp : Date.parse(h.timestamp))
      : (h.updatedAt ? (typeof h.updatedAt === 'number' ? h.updatedAt : Date.parse(h.updatedAt)) : null)
      || (h.createdAt ? (typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt)) : null);
    if (ts && !isNaN(ts)) {
      timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    return timeStr;
  }

  function ensureHistoryListAttached() {
    const list = document.getElementById('history-list');
    if (!list || typeof HistoryList === 'undefined') return false;
    if (!list.dataset.hlAttached) {
      list.dataset.hlAttached = '1';
      HistoryList.attach(list, {
        renderItem: renderHistoryItem,
        onAction: handleHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无对话历史</p></div>',
        stride: 78,
        overscan: 8
      });
      historySearch = (typeof window.makeHistorySearchV2 === 'function') ? window.makeHistorySearchV2({
        key: 'history',
        inputId: 'history-search-input',
        countId: 'history-search-count',
        listId: 'history-list',
        searchMode: 'chat',
        getRawItems: () => historyRawItems,
        getTitleText: (item) => item.title || '',
        renderItem: renderHistoryItem,
        renderContentItem: renderHistoryContentItem,
        onAction: handleHistoryAction,
        restoreItems: () => HistoryList.setItems(list, historyRawItems)
      }) : null;
    }
    return true;
  }

  function renderHistoryItem(h) {
    const timeStr = formatHistoryTime(h);
    const countText = h.messageCount ? ` · ${h.messageCount} 条消息` : '';
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('chat', h) : null;
    const status = live ? live.status : h.status;
    const attention = live ? live.attention : null;
    const lastError = live ? live.lastError : h.lastError;
    return `
      <div class="history-item" data-id="${escapeHtml(h.id)}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(status, lastError, attention)}</div>
          <div class="history-time">${timeStr}${countText}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="open-workspace" title="打开工作目录"><i class="fa-solid fa-folder-open"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function renderHistoryContentItem(h) {
    const timeStr = formatHistoryTime(h);
    const countText = h.messageCount ? ` · ${h.messageCount} 条消息` : '';
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('chat', h) : null;
    const snippets = Array.isArray(h.snippets) ? h.snippets.slice(0, 10) : [];
    const snippetsHtml = snippets.map(s => `<div class="history-snippet">${(typeof buildSearchSnippetHtml === 'function') ? buildSearchSnippetHtml(s) : escapeHtml(s.hit || '')}</div>`).join('');
    const moreHtml = (h.snippetTotal && h.snippetTotal > 10)
      ? `<div class="history-snippet-more">还有 ${h.snippetTotal - 10} 处命中</div>`
      : '';
    return `
      <div class="history-item history-item-content" data-id="${escapeHtml(h.id)}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(live ? live.status : h.status, live ? live.lastError : h.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr}${countText}</div>
          <div class="history-snippets">${snippetsHtml}${moreHtml}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="open-workspace" title="打开工作目录"><i class="fa-solid fa-folder-open"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function sanitizeHistoryFileName(name) {
    return (name || '对话记录').replace(/[\\/:*?"<>|]/g, '_');
  }

  function buildHistoryMarkdown(conv) {
    const title = conv.title || '未命名对话';
    const createdAt = conv.createdAt ? new Date(conv.createdAt).toLocaleString('zh-CN') : '';
    const updatedAt = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString('zh-CN') : '';
    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    if (createdAt) lines.push(`- 创建时间：${createdAt}`);
    if (updatedAt) lines.push(`- 更新时间：${updatedAt}`);
    if (conv.workspacePath) lines.push(`- 工作目录：${conv.workspacePath}`);
    lines.push('');
    (conv.messages || []).forEach(msg => {
      const role = msg.role || 'assistant';
      const roleName = role === 'user' ? '用户' : role === 'assistant' ? 'AI' : role === 'system' ? '系统' : '工具';
      lines.push(`## ${roleName}`);
      if (role === 'tool') {
        let toolContent = msg.content;
        try { toolContent = JSON.stringify(JSON.parse(msg.content), null, 2); } catch {}
        lines.push('```json');
        lines.push(toolContent || '');
        lines.push('```');
      } else {
        lines.push(msg.content || '');
      }
      lines.push('');
    });
    return lines.join('\n');
  }

  async function handleHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;

    if (action === 'continue') {
      stopVoicePlayback();
      const conv = await window.api.historyGet(id);
      if (!conv) return;
      const existing = sessionManager ? sessionManager.list('chat').find(s => String(s.id) === String(conv.id)) : null;
      if (existing) {
        agent = existing.agent;
        activateSession('chat', existing.key);
      } else {
        const ag = new Agent();
        ag.mode = 'chat';
        await ag.init();
        await ag.loadFromHistory(conv);
        wireChatAgent(ag);
        const target = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
        agent = ag;
        activateSession('chat', target.key);
      }
      setTitlebarTitle(agent.conversationTitle || '未命名对话');
      updateContextProgress();
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-chat')?.classList.add('active');
      chatMessages.innerHTML = '';
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.reset();
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchStart();
      WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#chat-messages' });
      WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
      const chatGeneration = (window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1);
      await replayHistoryMessages(conv.messages || [], {
        cancelCheck: () => window.__chatReplayGeneration !== chatGeneration
      });
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchEnd();
      requestAnimationFrame(() => {
        const last = chatMessages.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    } else if (action === 'open-workspace') {
      const conv = await window.api.historyGet(id);
      if (conv?.workspacePath) {
        window.api.openFileExplorer(conv.workspacePath);
      } else {
        alert('该对话没有记录工作目录');
      }
    } else if (action === 'export-json' || action === 'export-md') {
      const conv = await window.api.historyGet(id);
      if (!conv) return;
      const isJson = action === 'export-json';
      const filename = `${sanitizeHistoryFileName(conv.title || '对话记录')}.${isJson ? 'json' : 'md'}`;
      const result = await window.api.saveFileDialog({
        title: isJson ? '导出对话记录(JSON)' : '导出对话记录(Markdown)',
        defaultPath: filename,
        filters: isJson ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
      });
      if (!result.ok || !result.path) return;
      const content = isJson ? JSON.stringify(conv, null, 2) : buildHistoryMarkdown(conv);
      const saveResult = await window.api.writeFile(result.path, content);
      if (saveResult.ok) {
        showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
      } else {
        showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
      }
    } else if (action === 'delete') {
      const conv = await window.api.historyGet(id).catch(() => null);
      const titleForConfirm = conv?.title || '此对话';
      const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
      if (!confirmed) return;
      await window.api.historyDelete(id);
      if (agent.conversationId === id) {
        agent.newConversation();
        clearChatMessagesUI();
        setTitlebarTitle('未命名对话');
      }
      loadHistoryPage();
    }
  }

  async function loadHistoryPageVirtual() {
    const list = document.getElementById('history-list');
    if (!list) return;
    ensureHistoryListAttached();
    HistoryList.showMessage(list, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载历史…</p></div>');
    try {
      const histories = await window.api.historyList();
      historyRawItems = Array.isArray(histories) ? histories : [];
      if (historySearch) historySearch.refresh();
      else HistoryList.setItems(list, historyRawItems);
      // 推送完整页面快照前展开虚拟列表，避免 WebUI 只看到当前窗口
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(list, `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message || '')}</p></div>`);
    }
  }

  // ---- Init AI Persona Display ----
  async function initPersonaDisplay() {
    const s = await window.api.getSettings();
    // i18n: initialize language from saved settings before any UI rendering
    if (typeof i18nInit === 'function') {
      i18nInit(s.language || 'zh-CN');
      i18nApplyToDOM();
      // Re-apply after a delay to catch dynamically rendered content
      setTimeout(() => i18nApplyToDOM(), 500);
      setTimeout(() => i18nApplyToDOM(), 1500);
    }
    // Update mode switcher labels based on language
    updateModeLabels(s.language || 'zh-CN');
    // 头像框系统：启动时加载 avatarFrame 状态并预加载 SVG 缓存
    if (s.aiPersona?.avatarFrame) {
      _avatarFrameState.ai = s.aiPersona.avatarFrame;
      await loadAvatarFrameSVG(s.aiPersona.avatarFrame);
    }
    if (s.userProfile?.avatarFrame) {
      _avatarFrameState.user = s.userProfile.avatarFrame;
      await loadAvatarFrameSVG(s.userProfile.avatarFrame);
    }
    if (s.babe?.avatarFrame) {
      _avatarFrameState.babe = s.babe.avatarFrame;
      await loadAvatarFrameSVG(s.babe.avatarFrame);
    }
    if (s.aiPersona) updatePersonaDisplay(s.aiPersona);
    // 启动时立即读取命运之牌可见性设置项并应用，避免未读设置导致 UI 不一致
    applyTarotVisibility(s.tarotVisible !== false);
    // 启动 Babe 主动消息定时器（即使用户未进入 Babe 模式，主动消息也应按时触发）
    restartBabeProactiveTimer(s.babe?.proactiveInterval);
  }

  // Update mode switcher button labels based on language
  function updateModeLabels(lang) {
    document.querySelectorAll('.mode-label').forEach(el => {
      const val = el.getAttribute('data-' + (lang || 'zh-CN')) || el.getAttribute('data-zh') || 'Chat';
      el.textContent = val;
    });
  }

  // ---- History 加载进度模态框（非阻塞解析大历史记录） ----
  // 大历史记录回放时逐批渲染，每批之间让出事件循环（yield），
  // 模态框实时显示进度，避免渲染器长时间阻塞卡死。
  function showHistoryProgress(total) {
    const modal = document.getElementById('history-progress-modal');
    if (!modal) return;
    const fill = document.getElementById('history-progress-fill');
    const count = document.getElementById('history-progress-count');
    const text = document.getElementById('history-progress-text');
    if (fill) fill.style.width = '0%';
    if (count) count.textContent = `0 / ${total}`;
    if (text) text.textContent = '正在解析历史记录…';
    modal.classList.remove('hidden');
  }

  function updateHistoryProgress(done, total, label) {
    const fill = document.getElementById('history-progress-fill');
    const count = document.getElementById('history-progress-count');
    const text = document.getElementById('history-progress-text');
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
    if (fill) fill.style.width = pct + '%';
    if (count) count.textContent = `${done} / ${total}`;
    if (text && label) text.textContent = label;
  }

  function hideHistoryProgress() {
    const modal = document.getElementById('history-progress-modal');
    if (modal) modal.classList.add('hidden');
  }

  // 让出事件循环一帧（macrotask），使进度模态框能刷新、DOM 能回流
  function yieldHistoryUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // 分块异步回放历史消息：每块处理完 yield 一次并刷新进度条。
  // 返回 true 表示正常完成；返回 false 表示中途被取消（本次会话已切换）。
  async function replayHistoryMessages(messages, opts = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const total = list.length;
    const chunkSize = opts.chunkSize || 40; // 每批处理 40 条，避免长任务阻塞
    const cancelCheck = opts.cancelCheck || null; // 可选取消检查函数
    const toolCallMap = {};
    if (total > 0) showHistoryProgress(total);
    let done = 0;
    try {
      for (let start = 0; start < total; start += chunkSize) {
        // 每个 chunk 前检查是否被取消（用户切换会话/清空）
        if (cancelCheck && cancelCheck()) return false;
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const msg = list[i];
          if (!msg) continue;
          if (msg.role === 'user') {
            addMessageToChat('user', extractTextContent(msg.content));
          } else if (msg.role === 'assistant') {
            if (msg.content) addMessageToChat('assistant', extractTextContent(msg.content));
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                addToolCallToChat(displayName, toolName, args, tc.id);
                if (tc.id) toolCallMap[tc.id] = toolName;
              }
            }
          } else if (msg.role === 'tool') {
            const toolName = msg.name || toolCallMap[msg.tool_call_id] || 'tool';
            // 兼容旧版多模态 tool 消息 content 为数组的情况：提取文本，避免显示 [object Object]
            let result = msg.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            try { result = JSON.parse(result); } catch {}
            updateToolCallResult(toolName, result, false, msg.tool_call_id);
          } else if (msg.role === 'system') {
            // 回放历史时显示系统消息（不重复持久化）
            addSystemMessage(msg.content, { persist: false });
          }
          done++;
        }
        // 每个 chunk 处理完都刷新进度，并让出事件循环（使模态框能更新、DOM 能回流）
        const isLast = end >= total;
        updateHistoryProgress(done, total, isLast ? '渲染完成，正在收尾…' : `已渲染 ${done}/${total} 条消息`);
        await yieldHistoryUI();
      }
      return true;
    } finally {
      hideHistoryProgress();
    }
  }

  // 从历史会话重建 Chat UI（供 pending-resume 和其他场景使用）
  // 注意：调用方应已调用 agent.loadFromHistory(conv) 同步状态
  function rebuildChatUIFromHistory(conv) {
    setTitlebarTitle(agent.conversationTitle || conv?.title || '未命名对话');
    updateContextProgress();
    // 切换到 chat 页
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-chat')?.classList.add('active');
    // 清空并回放消息（异步分块渲染，避免长历史阻塞渲染器）
    chatMessages.innerHTML = '';
    if (typeof VirtualScroller !== 'undefined') VirtualScroller.reset();
    if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchStart();
    if (typeof WebUIMirror !== 'undefined' && WebUIMirror.pushDomEvent) {
      WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#chat-messages' });
      WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
    }
    // 分块异步回放，不阻塞渲染器；完成后触发首屏渲染与滚动
    // 每次启动回放递增 generation；其他入口（新会话/切换）也会递增以取消进行中的回放
    const chatGeneration = (window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1);
    replayHistoryMessages(conv?.messages || [], {
      cancelCheck: () => window.__chatReplayGeneration !== chatGeneration
    }).then(finished => {
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchEnd();
      if (!finished) return;
      // 重建子代理卡片：子代理聊天记录已持久化到历史，
      // 恢复会话后仍可打开详情模态框查看完整对话。
      if (conv?.subAgents && Array.isArray(conv.subAgents) && conv.subAgents.length > 0) {
        for (const rec of conv.subAgents) {
          if (!rec || !rec.id) continue;
          addSubAgentCard({
            id: rec.id,
            title: rec.task ? `子代理：${String(rec.task).slice(0, 20)}` : '子代理',
            task: rec.task || '',
            startTime: rec.startTime || Date.now(),
            status: rec.status || 'done'
          });
          updateSubAgentCard(rec.id, {
            status: rec.status || 'done',
            duration: (rec.endTime && rec.startTime) ? (rec.endTime - rec.startTime) : 0,
            toolUseCount: rec.toolUseCount || 0,
            usage: rec.usage || {},
            result: rec.result || ''
          });
        }
      }
      requestAnimationFrame(() => {
        const last = chatMessages.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    });
  }

  // Listen for language changes to update mode labels
  window.addEventListener('languagechange', (e) => {
    updateModeLabels(e.detail.lang);
  });

  initPersonaDisplay();

  // ---- GeoGebra Side Panel ----
  let ggbApplet = null;
  let ggbInitialized = false;
  let ggbInitPromise = null;
  let ggbLastError = null; // { message, ts }
  const ggbPanel = document.getElementById('geogebra-panel');
  const btnCloseGgb = document.getElementById('btn-close-geogebra');

  // 异步初始化：返回 Promise，在 appletOnLoad 触发后 resolve
  window.initGeoGebra = function() {
    if (ggbInitialized && ggbApplet) {
      ggbPanel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');
      return Promise.resolve({ ok: true, message: 'GeoGebra已显示', ready: true });
    }
    if (ggbInitPromise) return ggbInitPromise;

    ggbInitPromise = new Promise((resolve) => {
      const timeoutMs = 30000; // 30s 超时（远程加载 web3d 模块）
      const timer = setTimeout(() => {
        if (!ggbInitialized) {
          ggbInitPromise = null;
          resolve({ ok: false, error: 'GeoGebra 加载超时（30s），请检查网络是否能访问 www.geogebra.org', ready: false });
        }
      }, timeoutMs);

      // 关键：先显示面板并等待布局完成，读取 host 实际像素尺寸，
      // 再用具体像素值传给 GGB params（而非 '100%'）。
      // GGB inject 时会把 '100%' 解析为 host clientWidth/Height，若此时为 0（flex 布局未完成）就固化为 0×0，
      // 后续 setSize 也救不回来（GGB 内部 canvas 已按 0×0 创建）。
      ggbPanel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');

      // 用 requestAnimationFrame ×2 确保布局完成（一帧可能不够，flex 有时需要两帧）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const ggbHost = document.getElementById('ggb-element');
          const hostWidth = Math.max(100, ggbHost ? ggbHost.clientWidth : 480);
          const hostHeight = Math.max(100, ggbHost ? ggbHost.clientHeight : 600);

          const params = {
            appName: 'classic',
            width: hostWidth,   // 用具体像素值，不用 '100%'
            height: hostHeight,
            showToolBar: true,
            showAlgebraInput: true,
            showMenuBar: false,
            showAppsPicker: false,
            showKeyboard: false,
            enableRightClick: false,
            enableShiftDragZoom: true,
            showResetIcon: true,
            appletOnLoad: function() {
              clearTimeout(timer);
              ggbApplet = window.ggbApplet;
              ggbInitialized = true;
              // 注册错误监听器：GGB 命令失败时会回调
              try {
                if (ggbApplet && typeof ggbApplet.setErrorListener === 'function') {
                  ggbApplet.setErrorListener(function(msg) {
                    ggbLastError = { message: String(msg || 'GeoGebra 命令错误'), ts: Date.now() };
                  });
                }
                if (ggbApplet && typeof ggbApplet.setClientListener === 'function') {
                  ggbApplet.setClientListener(function(_applet, type, args) {
                    if (type === 'error' || (Array.isArray(args) && args && args[0] === 'ERROR')) {
                      ggbLastError = { message: String((args && args[1]) || 'GeoGebra 错误'), ts: Date.now() };
                    }
                  });
                }
              } catch (e) { /* 监听器注册失败忽略 */ }
              console.log('GeoGebra loaded');
              // 注册 ResizeObserver：GGB 不会自动跟随 host 尺寸变化，需手动 setSize
              try {
                const roHost = document.getElementById('ggb-element');
                if (roHost && typeof ResizeObserver === 'function') {
                  const ro = new ResizeObserver(() => {
                    if (ggbApplet && typeof ggbApplet.setSize === 'function') {
                      const w = Math.max(50, roHost.clientWidth);
                      const h = Math.max(50, roHost.clientHeight);
                      try { ggbApplet.setSize(w, h); } catch (_) { /* 忽略尺寸更新异常 */ }
                    }
                  });
                  ro.observe(roHost);
                }
              } catch (_) { /* ResizeObserver 不可用 */ }
              // 梯度延迟 setSize：覆盖 GGB 内部布局完成的各个时间点
              const forceResize = () => {
                const fh = document.getElementById('ggb-element');
                if (!fh || !ggbApplet || typeof ggbApplet.setSize !== 'function') return;
                const w = Math.max(50, fh.clientWidth);
                const h = Math.max(50, fh.clientHeight);
                try { ggbApplet.setSize(w, h); } catch (_) {}
                try { if (typeof ggbApplet.setWidth === 'function') ggbApplet.setWidth(w); } catch (_) {}
                try { if (typeof ggbApplet.setHeight === 'function') ggbApplet.setHeight(h); } catch (_) {}
              };
              [0, 100, 300, 600, 1000].forEach(delay => {
                setTimeout(forceResize, delay);
              });
              resolve({ ok: true, message: 'GeoGebra已启动', ready: true });
            }
          };

          // 面板已 remove('hidden')，host 已有真实尺寸，params 已用具体像素值。
          // 直接 inject（GGB 不会用 0×0 固化 canvas）。
          try {
            const ggbApp = new GGBApplet(params, true);
            ggbApp.inject('ggb-element');
          } catch (e) {
            clearTimeout(timer);
            ggbInitPromise = null;
            resolve({ ok: false, error: 'GeoGebra 注入失败: ' + (e && e.message || String(e)), ready: false });
          }
        });
      });
    });
    return ggbInitPromise;
  };

  window.evalGeoGebraCommand = async function(cmd) {
    if (!ggbApplet || typeof ggbApplet.evalCommand !== 'function') {
      // 尝试等待初始化完成
      if (ggbInitPromise) {
        await ggbInitPromise;
      }
      if (!ggbApplet || typeof ggbApplet.evalCommand !== 'function') {
        return { ok: false, error: 'GeoGebra未初始化（applet 尚未加载完成）' };
      }
    }
    if (!cmd || typeof cmd !== 'string') {
      return { ok: false, error: '命令为空' };
    }

    // 清空上次错误
    ggbLastError = null;

    const maxRetries = 8;
    const retryDelayMs = 200;
    // 兼容多种懒加载错误措辞
    const lazyModulePattern = /(not loaded yet|loading\s+\w+\s+module|commands? not available|正在加载|未加载)/i;

    const getObjectValue = (name) => {
      try {
        const type = ggbApplet.getObjectType(name);
        if (type === 'numeric') {
          const numVal = ggbApplet.getValue(name);
          return isFinite(numVal) ? numVal : ggbApplet.getValueString(name);
        }
        if (type === 'point') {
          const x = ggbApplet.getXcoord(name);
          const y = ggbApplet.getYcoord(name);
          return `(${x}, ${y})`;
        }
        return ggbApplet.getValueString(name);
      } catch {
        return null;
      }
    };

    // 判断命令是否预期产生新对象（赋值、Solve、Roots 等）；
    // 修改/设置类命令（SetColor/SetLineThickness/ShowLabel/Delete 等）用 () 语法但不产生 label，不应误判
    const isModifierCmd = /^\s*(Set|Show|Delete|Rename|ZoomIn|ZoomOut|Pan|Center|Select|Update|Freeze|Copy|Repaint|Refresh|SetActiveView|ShowAxes|ShowGrid|SetPerspective|SetBackgroundColor|SetRounding)\b/i.test(cmd);
    const producesLabel = !isModifierCmd && /[=:]|^(\s*)(Solve|Roots|Factor|Expand|Derivative|Integral|Limit|Sequence|Vertex|Intersect|Midpoint|Centroid|ClosestPoint|Root|Extremum|TurningPoint|Slope|Length|Area|Perimeter|Radius|Angle|Distance|Curvature)\b/i.test(cmd);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let label = null;
        if (typeof ggbApplet.evalCommandGetLabels === 'function') {
          label = ggbApplet.evalCommandGetLabels(cmd);
        } else {
          ggbApplet.evalCommand(cmd);
        }
        await new Promise(r => setTimeout(r, 120));
        // 优先检查错误监听器捕获的错误
        if (ggbLastError && Date.now() - (ggbLastError.ts || 0) < 3000) {
          const errMsg = ggbLastError.message;
          if (lazyModulePattern.test(errMsg) && attempt < maxRetries) {
            ggbLastError = null;
            await new Promise(r => setTimeout(r, retryDelayMs));
            continue;
          }
          return { ok: false, error: errMsg, cmd };
        }
        const labels = (label || '').split(',').map(s => s.trim()).filter(Boolean);
        let value = null;
        if (labels.length === 1) {
          value = getObjectValue(labels[0]);
        } else if (labels.length > 1) {
          value = labels.map(n => ({ name: n, value: getObjectValue(n) }));
        }
        // 如果命令应该产生 label 但返回空，视为失败
        if (producesLabel && labels.length === 0) {
          return { ok: false, error: `命令未产生任何对象，可能语法错误：${cmd}`, cmd, value: null };
        }
        return { ok: true, label: label || null, value, cmd };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (lazyModulePattern.test(msg) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, retryDelayMs));
          continue;
        }
        return { ok: false, error: msg, cmd };
      }
    }

    return { ok: false, error: '命令执行超时（懒加载模块未就绪）', cmd };
  };

  window.getAllGeoGebraObjects = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      const names = ggbApplet.getAllObjectNames();
      const objs = [];
      for (const n of names) {
        const type = ggbApplet.getObjectType(n);
        let value = ggbApplet.getValueString(n);

        // 对数值类型尝试获取数值
        if (type === 'numeric') {
          try {
            const numVal = ggbApplet.getValue(n);
            if (!isNaN(numVal) && isFinite(numVal)) {
              value = numVal.toString();
            }
          } catch { /* 保持原 value */ }
        }
        // 对点类型，尝试获取坐标
        else if (type === 'point') {
          try {
            const x = ggbApplet.getXcoord(n);
            const y = ggbApplet.getYcoord(n);
            if (!isNaN(x) && !isNaN(y)) {
              value = `(${x}, ${y})`;
            }
          } catch { /* 保持原 value */ }
        }

        objs.push({
          name: n,
          type: type,
          value: value,
          visible: ggbApplet.getVisible(n)
        });
      }
      return { ok: true, objects: objs };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.deleteGeoGebraObject = function(name) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      ggbApplet.deleteObject(name);
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.exportGeoGebraPNG = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      const png = ggbApplet.getPNGBase64(1, true, 72);
      return { ok: true, data: png };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  if (btnCloseGgb) {
    btnCloseGgb.addEventListener('click', () => {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Canvas Implementation ----
  const canvasPanel = document.getElementById('canvas-panel');
  const canvasSvg = document.getElementById('canvas-svg');
  const btnCloseCanvas = document.getElementById('btn-close-canvas');
  const canvasObjects = new Map(); // Store object references

  window.initCanvas = function() {
    if (!canvasPanel || !canvasSvg) {
      return { ok: false, error: '画布元素未找到' };
    }

    // Close GeoGebra if open (only one split-screen at a time)
    if (ggbPanel && !ggbPanel.classList.contains('hidden')) {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }

    canvasPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open'); // Reuse same CSS class for split-screen

    // Auto-clear canvas when initializing
    window.clearCanvas();

    return { ok: true, message: '画布已初始化并清空' };
  };

  window.clearCanvas = function() {
    if (!canvasSvg) {
      return { ok: false, error: '画布未初始化' };
    }

    // Remove all child elements
    while (canvasSvg.firstChild) {
      canvasSvg.removeChild(canvasSvg.firstChild);
    }
    canvasObjects.clear();

    return { ok: true, message: '画布已清空' };
  };

  window.addCanvasObject = function(type, id, attributes) {
    if (!canvasSvg) {
      return { ok: false, error: '画布未初始化' };
    }

    if (canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 已存在` };
    }

    try {
      const element = document.createElementNS('http://www.w3.org/2000/svg', type);
      element.setAttribute('id', id);

      // Set attributes
      for (const [key, value] of Object.entries(attributes || {})) {
        element.setAttribute(key, value);
      }

      canvasSvg.appendChild(element);
      canvasObjects.set(id, element);

      return { ok: true, message: `对象 ${id} 已添加` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.updateCanvasObject = function(id, attributes) {
    if (!canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 不存在` };
    }

    try {
      const element = canvasObjects.get(id);
      for (const [key, value] of Object.entries(attributes || {})) {
        element.setAttribute(key, value);
      }

      return { ok: true, message: `对象 ${id} 已更新` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.deleteCanvasObject = function(id) {
    if (!canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 不存在` };
    }

    try {
      const element = canvasObjects.get(id);
      element.remove();
      canvasObjects.delete(id);

      return { ok: true, message: `对象 ${id} 已删除` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.exportCanvasSVG = async function(filename, workspacePath) {
    if (!canvasSvg || !workspacePath) {
      return { ok: false, error: '画布或工作区路径未设置' };
    }

    try {
      // Get SVG content
      const svgContent = new XMLSerializer().serializeToString(canvasSvg);
      const fullSvg = `<?xml version="1.0" encoding="UTF-8"?>\n${svgContent}`;

      // Save to workspace
      const result = await window.api.writeFile(
        `${workspacePath}/${filename}`,
        fullSvg
      );

      if (result.ok) {
        return { ok: true, path: `${workspacePath}/${filename}`, message: 'SVG已导出' };
      } else {
        return result;
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  if (btnCloseCanvas) {
    btnCloseCanvas.addEventListener('click', () => {
      canvasPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Spreadsheet Implementation ----
  const spreadsheetPanel = document.getElementById('spreadsheet-panel');
  const spreadsheetBody = document.getElementById('spreadsheet-body');
  const btnCloseSpreadsheet = document.getElementById('btn-close-spreadsheet');
  let ssEngine = null;
  let ssUI = null;

  function ensureSpreadsheet() {
    if (!ssEngine) {
      ssEngine = new SpreadsheetEngine();
      ssUI = new SpreadsheetUI(ssEngine, 'spreadsheet-body');
    }
    // Wire up formula bar input
    const fxInput = spreadsheetPanel?.querySelector('.ss-fx');
    if (fxInput && !fxInput._bound) {
      fxInput._bound = true;
      fxInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && ssUI?.selectedCell) {
          ssEngine.setCell(ssUI.selectedCell, fxInput.value);
        }
      });
    }
    return { engine: ssEngine, ui: ssUI };
  }

  window.initSpreadsheet = function(title) {
    if (!spreadsheetPanel) return { ok: false, error: '数据表格面板元素未找到' };
    // Close other panels
    if (ggbPanel && !ggbPanel.classList.contains('hidden')) {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }
    if (canvasPanel && !canvasPanel.classList.contains('hidden')) {
      canvasPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }
    spreadsheetPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');
    const { engine } = ensureSpreadsheet();
    if (title) engine.title = title;
    return { ok: true, message: '数据表格已打开' };
  };

  window.spreadsheetSetCells = function(entries) {
    const { engine } = ensureSpreadsheet();
    return engine.setCells(entries);
  };

  window.spreadsheetGetCells = function(range) {
    const { engine } = ensureSpreadsheet();
    return { ok: true, cells: engine.getCells(range) };
  };

  window.spreadsheetSetCellFormat = function(addr, format) {
    const { engine } = ensureSpreadsheet();
    return { ok: true, cell: engine.setCellFormat(addr, format) };
  };

  window.spreadsheetSetRangeFormat = function(range, format) {
    const { engine } = ensureSpreadsheet();
    return engine.setRangeFormat(range, format);
  };

  window.spreadsheetClearCells = function(range) {
    const { engine } = ensureSpreadsheet();
    return engine.clearCells(range);
  };

  window.spreadsheetInsertRows = function(rowNum, count) {
    const { engine } = ensureSpreadsheet();
    return engine.insertRow(rowNum, count || 1);
  };

  window.spreadsheetDeleteRows = function(rowNum, count) {
    const { engine } = ensureSpreadsheet();
    return engine.deleteRow(rowNum, count || 1);
  };

  window.spreadsheetInsertCols = function(colLetter, count) {
    const { engine } = ensureSpreadsheet();
    return engine.insertCol(colLetter, count || 1);
  };

  window.spreadsheetDeleteCols = function(colLetter, count) {
    const { engine } = ensureSpreadsheet();
    return engine.deleteCol(colLetter, count || 1);
  };

  window.spreadsheetSortRange = function(range, colLetter, ascending) {
    const { engine } = ensureSpreadsheet();
    return engine.sortRange(range, colLetter, ascending);
  };

  window.spreadsheetGetData = function() {
    const { engine } = ensureSpreadsheet();
    return { ok: true, data: engine.getData() };
  };

  window.spreadsheetExportCSV = function() {
    const { engine } = ensureSpreadsheet();
    return { ok: true, csv: engine.exportCSV() };
  };

  window.spreadsheetImportCSV = function(csv, startAddr) {
    const { engine } = ensureSpreadsheet();
    return engine.importCSV(csv, startAddr || 'A1');
  };

  if (btnCloseSpreadsheet) {
    btnCloseSpreadsheet.addEventListener('click', () => {
      spreadsheetPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Spreadsheet File Import/Export ----
  window.spreadsheetImportFile = async function(filePath) {
    const result = await window.api.spreadsheetImportFile(filePath);
    if (!result.ok) return result;
    ensureSpreadsheet();
    spreadsheetPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');
    if (result.sheetName) ssEngine.title = result.sheetName;
    if (result.cells && result.cells.length > 0) {
      ssEngine.setCells(result.cells);
    }
    return { ok: true, message: `已导入 ${result.cells?.length || 0} 个单元格`, sheetName: result.sheetName };
  };

  window.spreadsheetExportFile = async function(filePath) {
    ensureSpreadsheet();
    const data = ssEngine.getData();
    // data.cells 是数组 [{addr, raw, value, format}, ...]
    // 直接传给导出函数，每个元素需要 addr + value/raw
    const cells = (data.cells || []).map(c => ({
      addr: c.addr,
      value: c.value,
      raw: c.raw,  // 保留原始公式/文本，让导出函数优先使用 raw
      format: c.format || {}  // 保留单元格格式（粗体/斜体/颜色/背景/对齐/字号）
    }));
    return await window.api.spreadsheetExportFile(filePath, cells, data.title || 'Sheet1');
  };

  // ---- Email Received Handler ----
  window.api.onEmailReceived((email) => {
    // Forward email content to agent as hot message
    if (agent && typeof agent.injectHotMessage === 'function') {
      const content = `[来自邮件] 发件人: ${email.from || '未知'}, 主题: ${email.subject || '无主题'}\n\n${email.text || email.html || ''}`;
      agent.injectHotMessage(content);
    }
  });

  // ---- Ask Questions (Chat Bubble) ----
  window.askQuestions = function(questions, callingAgent) {
    return new Promise((resolve) => {
      if (!Array.isArray(questions) || questions.length === 0) {
        resolve([]);
        return;
      }

      // 会话进入"等待问卷回答"状态：标签页/历史列表显示指示器，而不是"运行中"
      const ownerAgent = callingAgent || agent;
      const ownerSession = window.__sessionManager?.getByAgent(ownerAgent);
      if (window.__sessionManager && ownerSession) {
        window.__sessionManager.setAttention(ownerSession, { kind: 'questionnaire', label: '等待问卷回答' });
      }

      // 系统通知：问卷需要用户回答
      const firstQ = questions[0];
      const qLabel = firstQ?.label || firstQ?.title || firstQ?.question || '请回答问题';
      sendAppNotification('question', 'Agent 有问题想问您', qLabel);

      const answers = new Array(questions.length).fill('');
      let currentIndex = 0;

      const msg = document.createElement('div');
      msg.className = 'message assistant';
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      let avatarHTML = '';
      const persona = agent.settings?.aiPersona;
      avatarHTML = makeFramedAvatarHTML(persona?.avatar, true);

      const body = document.createElement('div');
      body.className = 'message-body';

      const content = document.createElement('div');
      content.className = 'message-content';
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.gap = '12px';

      const header = document.createElement('div');
      header.style.fontWeight = '500';

      const optionsWrap = document.createElement('div');
      optionsWrap.style.display = 'flex';
      optionsWrap.style.flexDirection = 'column';
      optionsWrap.style.gap = '8px';

      const hint = document.createElement('div');
      hint.style.fontSize = '12px';
      hint.style.color = 'var(--error-color)';
      hint.style.display = 'none';

      const nav = document.createElement('div');
      nav.style.display = 'flex';
      nav.style.justifyContent = 'space-between';
      nav.style.gap = '8px';

      const btnPrev = document.createElement('button');
      btnPrev.className = 'btn-secondary';
      btnPrev.textContent = '上一题';

      const btnNext = document.createElement('button');
      btnNext.className = 'btn-primary';

      let customRadio = null;
      let customInput = null;

      nav.appendChild(btnPrev);
      nav.appendChild(btnNext);

      content.appendChild(header);
      content.appendChild(optionsWrap);
      content.appendChild(hint);
      content.appendChild(nav);

      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = time;

      body.appendChild(content);
      body.appendChild(timeEl);

      msg.innerHTML = `<div class="message-avatar">${avatarHTML}</div>`;
      msg.appendChild(body);
      if (ownerSession && typeof appendSessionCard === 'function') {
        appendSessionCard(ownerSession, msg);
      } else {
        appendChatElement(msg);
      }

      const baseOptions = ['选项A', '选项B', '选项C'];

      function renderQuestion() {
        const q = questions[currentIndex] || {};
        const rawOptions = Array.isArray(q.options) ? q.options : [];
        const options = baseOptions.map((fallback, i) => rawOptions[i] || fallback);
        const currentAnswer = answers[currentIndex];

        header.textContent = `${currentIndex + 1}/${questions.length} ${q.question || ''}`;
        optionsWrap.innerHTML = '';
        hint.style.display = 'none';

        const radioName = `question-${currentIndex}`;

        options.forEach((opt, idx) => {
          const label = document.createElement('label');
          label.style.display = 'flex';
          label.style.alignItems = 'center';
          label.style.gap = '8px';
          label.style.cursor = 'pointer';

          const input = document.createElement('input');
          input.type = 'radio';
          input.name = radioName;
          input.value = opt;
          input.style.accentColor = 'var(--accent-color, #4f8cff)';
          if (currentAnswer === opt) input.checked = true;

          input.addEventListener('change', () => {
            answers[currentIndex] = opt;
          });

          const text = document.createElement('span');
          const letter = String.fromCharCode(65 + idx);
          text.textContent = `${letter}. ${opt}`;

          label.appendChild(input);
          label.appendChild(text);
          optionsWrap.appendChild(label);
        });

        const customLabel = document.createElement('label');
        customLabel.style.display = 'flex';
        customLabel.style.alignItems = 'center';
        customLabel.style.gap = '8px';

        customRadio = document.createElement('input');
        customRadio.type = 'radio';
        customRadio.name = radioName;
        customRadio.value = '__custom__';
        customRadio.style.accentColor = 'var(--accent-color, #4f8cff)';

        const customPrefix = document.createElement('span');
        customPrefix.textContent = 'D.';

        customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.placeholder = '自定义选项';
        customInput.style.cssText = `
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--border-color);
          border-radius: 6px;
          background-color: var(--bg-secondary);
          color: var(--text-primary);
          font-size: 14px;
          transition: border-color 0.2s, box-shadow 0.2s;
        `;

        // Add focus/blur styling
        customInput.addEventListener('focus', () => {
          customInput.style.borderColor = 'var(--accent-color, #4f8cff)';
          customInput.style.boxShadow = '0 0 0 2px var(--accent-bg, rgba(79, 140, 255, 0.15))';
          customRadio.checked = true;
          if (customInput.value.trim()) {
            answers[currentIndex] = customInput.value.trim();
          }
        });

        customInput.addEventListener('blur', () => {
          customInput.style.borderColor = 'var(--border-color)';
          customInput.style.boxShadow = 'none';
        });

        if (currentAnswer && !options.includes(currentAnswer)) {
          customRadio.checked = true;
          customInput.value = currentAnswer;
        }

        customInput.addEventListener('input', () => {
          if (customRadio.checked) {
            answers[currentIndex] = customInput.value.trim();
          }
        });

        customRadio.addEventListener('change', () => {
          answers[currentIndex] = customInput.value.trim();
        });

        customLabel.appendChild(customRadio);
        customLabel.appendChild(customPrefix);
        customLabel.appendChild(customInput);
        optionsWrap.appendChild(customLabel);

        btnPrev.disabled = currentIndex === 0;
        btnNext.textContent = currentIndex === questions.length - 1 ? '提交' : '下一题';

        // 语音输入钩子：唤醒/听写结果填入本题自定义选项并自动下一题/提交
        window.__activeQuestion = {
          submitAnswer(text) {
            const v = String(text || '').trim();
            if (!v) return;
            customRadio.checked = true;
            customInput.value = v;
            answers[currentIndex] = v;
            btnNext.click();
          },
        };
      }

      function finish() {
        if (window.__sessionManager && ownerSession) window.__sessionManager.setAttention(ownerSession, null);
        window.__activeQuestion = null;
        // Disable all inputs
        const allInputs = optionsWrap.querySelectorAll('input');
        allInputs.forEach(inp => inp.disabled = true);

        // Update buttons to show submitted state
        btnPrev.style.display = 'none';
        btnNext.textContent = '已提交';
        btnNext.disabled = true;
        btnNext.className = 'btn-secondary';

        // Add submitted indicator
        const submittedMsg = document.createElement('div');
        submittedMsg.style.cssText = `
          margin-top: 8px;
          padding: 8px 12px;
          background: var(--success-bg, #d4edda);
          color: var(--success-color, #155724);
          border-radius: 6px;
          font-size: 14px;
          text-align: center;
        `;
        submittedMsg.innerHTML = '<i class="fa-solid fa-check-circle"></i> 问卷已提交';
        content.appendChild(submittedMsg);

        const result = questions.map((q, i) => ({
          question: q.question,
          answer: answers[i]
        }));
        resolve(result);
      }

      btnPrev.addEventListener('click', () => {
        if (currentIndex > 0) {
          currentIndex -= 1;
          renderQuestion();
        }
      });

      btnNext.addEventListener('click', () => {
        const answer = answers[currentIndex];
        if (!answer || !answer.trim()) {
          hint.textContent = '请选择一个选项，或填写自定义选项';
          hint.style.display = 'block';
          return;
        }

        if (currentIndex < questions.length - 1) {
          currentIndex += 1;
          renderQuestion();
          return;
        }

        finish();
      });

      renderQuestion();
    });
  };

  // ---- Confirm Modal ----
  let confirmResolve = null;
  let confirmReject = null;

  window.confirmDialog = function(message, title = '确认操作') {
    return new Promise((resolve, reject) => {
      const modal = document.getElementById('confirm-modal');
      const modalBody = document.querySelector('.confirm-modal-body');
      const modalHeader = modal?.querySelector('.modal-header h3');

      if (!modal || !modalBody) {
        reject(new Error('确认对话框未找到'));
        return;
      }

      confirmResolve = resolve;
      confirmReject = reject;

      if (modalHeader) {
        modalHeader.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${title}`;
      }
      modalBody.textContent = message;
      modal.classList.remove('hidden');
    });
  };

  document.getElementById('btn-close-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  document.getElementById('btn-cancel-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  document.getElementById('btn-accept-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(true);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  // ---- Message Modal ----
  window.showMessageModal = function(message, title = '提示', type = 'info') {
    const modal = document.getElementById('message-modal');
    const modalBody = document.querySelector('.message-modal-body');
    const modalHeader = modal?.querySelector('.modal-header h3');

    if (!modal || !modalBody) {
      console.error('消息对话框未找到');
      return;
    }

    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    else if (type === 'error') iconClass = 'fa-exclamation-triangle';
    else if (type === 'warning') iconClass = 'fa-exclamation-circle';

    if (modalHeader) {
      modalHeader.innerHTML = `<i class="fa-solid ${iconClass}"></i> ${title}`;
    }
    modalBody.innerHTML = message.replace(/\n/g, '<br>');
    modal.classList.remove('hidden');
  };

  document.getElementById('btn-close-message')?.addEventListener('click', () => {
    const modal = document.getElementById('message-modal');
    modal?.classList.add('hidden');
  });

  document.getElementById('btn-ok-message')?.addEventListener('click', () => {
    const modal = document.getElementById('message-modal');
    modal?.classList.add('hidden');
  });

  // ---- 自定义输入/确认模态框（替代 prompt/confirm） ----
  function showInputModal(title, label, defaultValue) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--bg-secondary,#fff);border-radius:12px;padding:24px;min-width:360px;max-width:500px;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
      box.innerHTML = `
        <h3 style="margin:0 0 12px;font-size:16px;color:var(--text-primary,#333);">${escapeHtml(title)}</h3>
        <label style="display:block;font-size:13px;color:var(--text-secondary,#666);margin-bottom:6px;">${escapeHtml(label)}</label>
        <input type="text" style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--border-color,#ddd);border-radius:6px;font-size:14px;background:var(--bg-primary,#fff);color:var(--text-primary,#333);outline:none;" value="${escapeHtml(defaultValue || '')}">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="btn-cancel" style="padding:6px 16px;border:1px solid var(--border-color,#ddd);border-radius:6px;background:transparent;color:var(--text-secondary,#666);cursor:pointer;font-size:14px;">取消</button>
          <button class="btn-ok" style="padding:6px 16px;border:none;border-radius:6px;background:var(--accent-color,#007bff);color:#fff;cursor:pointer;font-size:14px;">确定</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const input = box.querySelector('input');
      input.focus();
      input.select();
      function close(val) {
        overlay.remove();
        resolve(val);
      }
      box.querySelector('.btn-cancel').addEventListener('click', () => close(null));
      box.querySelector('.btn-ok').addEventListener('click', () => close(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  function showConfirmModal(title, message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--bg-secondary,#fff);border-radius:12px;padding:24px;min-width:360px;max-width:500px;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
      box.innerHTML = `
        <h3 style="margin:0 0 12px;font-size:16px;color:var(--text-primary,#333);">${escapeHtml(title)}</h3>
        <p style="margin:0 0 16px;font-size:14px;color:var(--text-secondary,#666);line-height:1.5;">${escapeHtml(message)}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn-cancel" style="padding:6px 16px;border:1px solid var(--border-color,#ddd);border-radius:6px;background:transparent;color:var(--text-secondary,#666);cursor:pointer;font-size:14px;">取消</button>
          <button class="btn-ok" style="padding:6px 16px;border:none;border-radius:6px;background:var(--danger,#dc3545);color:#fff;cursor:pointer;font-size:14px;">确认删除</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      function close(val) {
        overlay.remove();
        resolve(val);
      }
      box.querySelector('.btn-cancel').addEventListener('click', () => close(false));
      box.querySelector('.btn-ok').addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    });
  }

  // ---- Code Mode ----
  // Separate agent instance for Code mode, with workspace-scoped history.
  let codeAgent = null;
  let codeWorkspacePath = null;
  let codeCurrentHistoryId = null;
  let codeMessages = []; // [{role, content}]
  let codeCurrentAttachments = []; // Code mode context attachments [{name, path, isImage, content, ext}]
  // 触发文件树刷新的工具集合（执行后可能增删/移动文件）
  const _fileSystemTools = new Set(['createFile', 'deleteFile', 'moveFile', 'copyFile', 'editFile', 'multiEditFile', 'writeFile', 'renameFile', 'mkdir', 'rmdir']);

  // Monaco Editor state
  let monacoEditor = null;
  let monacoReady = null;
  let codeOpenTabs = [];      // [{path, name, model, originalContent, dirty}]
  let codeActiveTabPath = null;
  let codeEditorModeFilter = 'chat';   // 'chat' | 'code' — tools page mode filter

  async function loadCodePage() {
    // 已有进行中的会话时保留内存中的工作区，避免切到 Chat 再切回时回退到上次持久化的工作区
    let wsPath = codeWorkspacePath;
    if (!wsPath) {
      wsPath = await window.api.codeGetLastWorkspace();
    }
    if (wsPath) {
      codeWorkspacePath = wsPath;
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = wsPath;
      await loadCodeFileTree(wsPath);
    } else {
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = '未选择工作区';
      const treeEl = document.getElementById('code-file-tree');
      if (treeEl) treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-folder-tree"></i><p>打开工作区后显示文件树</p></div>';
      // 无工作区时隐藏 ESLint 面板
      const eslintPanel = document.getElementById('code-eslint-panel');
      const eslintResizer = document.getElementById('code-eslint-resizer');
      if (eslintPanel) eslintPanel.style.display = 'none';
      if (eslintResizer) eslintResizer.style.display = 'none';
    }
    // Pre-warm Monaco loader (don't await — start in background)
    ensureMonaco().catch(err => console.warn('[Monaco] preload failed:', err));
  }

  async function loadCodeFileTree(dirPath) {
    const treeEl = document.getElementById('code-file-tree');
    if (!treeEl) return;
    treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载文件树...</p></div>';
    try {
      const result = await window.api.codeGetFileTree(dirPath);
      if (result.ok && result.tree) {
        renderCodeFileTree(treeEl, result.tree, dirPath);
      } else {
        treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>无法读取文件树</p></div>';
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: treeEl.innerHTML });
      }
    } catch (e) {
      treeEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: treeEl.innerHTML });
    }
    // 自动运行 ESLint（如果是支持的项目）
    if (dirPath) autoRunESLint(dirPath).catch(err => console.warn('[ESLint] auto run failed:', err));
  }

  // ==================== ESLint 状态面板 ====================
  let eslintRunning = false;
  let eslintCurrentWorkspace = null;
  let eslintLastResults = null;
  let eslintEventsBound = false;

  async function autoRunESLint(workspacePath) {
    if (!workspacePath) return;
    eslintCurrentWorkspace = workspacePath;
    // 检测是否为支持的项目
    let lintable = false;
    try {
      const r = await window.api.eslintIsLintable(workspacePath);
      lintable = !!(r.ok && r.lintable);
    } catch (e) {
      console.warn('[ESLint] isLintable failed:', e);
    }
    const panel = document.getElementById('code-eslint-panel');
    const resizer = document.getElementById('code-eslint-resizer');
    if (!lintable) {
      // 不支持：隐藏面板和分割器
      if (panel) panel.style.display = 'none';
      if (resizer) resizer.style.display = 'none';
      const summary = document.getElementById('code-eslint-summary');
      if (summary) summary.innerHTML = '<span class="es-null">不适用（非 JS/TS 项目）</span>';
      return;
    }
    if (panel) panel.style.display = '';
    if (resizer) resizer.style.display = '';
    bindESLintEvents();
    await runESLint(workspacePath);
  }

  async function runESLint(workspacePath) {
    if (!workspacePath) return;
    if (eslintRunning) return;
    eslintRunning = true;
    eslintCurrentWorkspace = workspacePath;
    const summary = document.getElementById('code-eslint-summary');
    const body = document.getElementById('code-eslint-body');
    const refreshBtn = document.getElementById('btn-eslint-refresh');
    if (refreshBtn) refreshBtn.classList.add('spin');
    if (summary) summary.innerHTML = '<span class="es-running"><i class="fa-solid fa-spinner fa-spin"></i> 扫描中…</span>';
    if (body) body.innerHTML = '<div class="code-eslint-empty"><i class="fa-solid fa-spinner fa-spin"></i> 正在扫描工作区…</div>';
    try {
      const result = await window.api.eslintLint(workspacePath, { maxFiles: 500 });
      if (!result.ok) {
        if (summary) summary.innerHTML = `<span class="es-error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtmlSimple(result.error || '失败')}</span>`;
        if (body) body.innerHTML = `<div class="code-eslint-empty" style="color:var(--danger)"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtmlSimple(result.error || '运行失败')}</div>`;
        eslintLastResults = null;
        return;
      }
      eslintLastResults = result;
      renderESLintResults(result);
    } catch (e) {
      if (summary) summary.innerHTML = `<span class="es-error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtmlSimple(e.message)}</span>`;
      if (body) body.innerHTML = `<div class="code-eslint-empty" style="color:var(--danger)">${escapeHtmlSimple(e.message)}</div>`;
      eslintLastResults = null;
    } finally {
      eslintRunning = false;
      if (refreshBtn) refreshBtn.classList.remove('spin');
    }
  }

  function renderESLintResults(result) {
    const summary = document.getElementById('code-eslint-summary');
    const body = document.getElementById('code-eslint-body');
    const sum = result.summary || {};
    if (summary) {
      const parts = [];
      if (sum.errors > 0) parts.push(`<span class="es-badge errors"><i class="fa-solid fa-circle-xmark"></i> ${sum.errors} 错误</span>`);
      if (sum.warnings > 0) parts.push(`<span class="es-badge warnings"><i class="fa-solid fa-triangle-exclamation"></i> ${sum.warnings} 警告</span>`);
      if (sum.infos > 0) parts.push(`<span class="es-badge infos"><i class="fa-solid fa-circle-info"></i> ${sum.infos} 提示</span>`);
      if (parts.length === 0) {
        summary.innerHTML = '<span class="es-badge ok"><i class="fa-solid fa-circle-check"></i> 无问题</span>';
      } else {
        summary.innerHTML = parts.join('') + `<span style="color:var(--text-tertiary);font-size:0.92em;margin-left:4px">扫描 ${sum.scannedFiles || 0} 文件</span>`;
      }
    }
    if (body) {
      const items = result.results || [];
      if (items.length === 0) {
        body.innerHTML = '<div class="code-eslint-empty"><i class="fa-solid fa-circle-check" style="color:#198754"></i> 没有发现问题</div>';
        return;
      }
      body.innerHTML = '';
      for (const item of items) {
        const row = document.createElement('div');
        row.className = `code-eslint-item ${item.severity || 'info'}`;
        const sevLabel = item.severity === 'error' ? 'Error' : (item.severity === 'warning' ? 'Warn' : 'Info');
        const shortPath = makeRelPath(item.filePath, eslintCurrentWorkspace);
        row.innerHTML = `<span class="esev">${sevLabel}</span>` +
          `<span class="eloc" title="${escapeHtmlSimple(item.filePath)}">${escapeHtmlSimple(shortPath)}:${item.line}:${item.column}</span>` +
          `<span class="emsg">${escapeHtmlSimple(item.message || '')}</span>` +
          `<span class="erule">${item.ruleId ? escapeHtmlSimple(item.ruleId) : ''}<button class="code-eslint-add-btn" title="添加到 AI 上下文"><i class="fa-solid fa-comment-dots"></i></button></span>`;
        // 点击行 → 跳转到文件（在 Monaco 编辑器中打开并定位到问题行）
        row.addEventListener('click', (e) => {
          if (e.target.closest('.code-eslint-add-btn')) return;
          const fileName = item.file || (item.filePath || '').split(/[\\/]/).pop() || 'file';
          openFileInMonaco(item.filePath, fileName).then(() => {
            // 切换到该文件后，定位到指定行列
            if (monacoEditor && item.line) {
              try {
                monacoEditor.revealLineInCenter(item.line);
                monacoEditor.setPosition({ lineNumber: item.line, column: item.column || 1 });
                monacoEditor.focus();
              } catch { /* ignore */ }
            }
          }).catch(err => console.warn('[ESLint] openFileInMonaco failed:', err));
        });
        // 点击添加按钮 → 将此条意见作为代码上下文片段注入输入框（用户可编辑后发送）
        const addBtn = row.querySelector('.code-eslint-add-btn');
        if (addBtn) {
          addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // 同时将文件加入 Code 附件（便于 AI 读取上下文）
            await addFileToCodeContext({ path: item.filePath, name: item.file || 'lint-issue', type: 'file' });
            // 把意见本身作为提示文本注入输入框
            const inputEl = document.getElementById('code-chat-input');
            if (inputEl) {
              const note = `请修复以下 ESLint 问题：\n文件：${shortPath}:${item.line}:${item.column}\n严重性：${sevLabel}\n规则：${item.ruleId || '(无)'}\n消息：${item.message}`;
              const cur = inputEl.value || '';
              inputEl.value = cur ? (cur + '\n\n' + note) : note;
              inputEl.focus();
              inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
        }
        body.appendChild(row);
      }
    }
  }

  function bindESLintEvents() {
    if (eslintEventsBound) return;
    eslintEventsBound = true;
    // 刷新
    document.getElementById('btn-eslint-refresh')?.addEventListener('click', () => {
      if (eslintCurrentWorkspace && !eslintRunning) {
        // 清缓存确保结果新鲜
        window.api.eslintClearCache(eslintCurrentWorkspace).finally(() => {
          runESLint(eslintCurrentWorkspace);
        });
      }
    });
    // 折叠/展开
    document.getElementById('btn-eslint-toggle')?.addEventListener('click', () => {
      const panel = document.getElementById('code-eslint-panel');
      const resizer = document.getElementById('code-eslint-resizer');
      if (!panel) return;
      panel.classList.toggle('collapsed');
      const collapsed = panel.classList.contains('collapsed');
      const icon = document.querySelector('#btn-eslint-toggle i');
      if (icon) icon.className = collapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
      if (resizer) resizer.style.display = collapsed ? 'none' : '';
    });
    // 上下拖动调节高度
    initESLintResizer();
  }

  function initESLintResizer() {
    const resizer = document.getElementById('code-eslint-resizer');
    const panel = document.getElementById('code-eslint-panel');
    if (!resizer || !panel) return;
    let dragging = false;
    let startY = 0;
    let startPanelHeight = 0;
    let startTreeHeight = 0;
    const treeEl = document.getElementById('code-file-tree');
    resizer.addEventListener('mousedown', (e) => {
      if (panel.classList.contains('collapsed')) return;
      dragging = true;
      startY = e.clientY;
      startPanelHeight = panel.getBoundingClientRect().height;
      startTreeHeight = treeEl ? treeEl.getBoundingClientRect().height : 0;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // 向上拖动 = panel 高度增加（dy 为负），向下拖动 = panel 高度减少
      const dy = e.clientY - startY;
      const maxPanelHeight = startPanelHeight + startTreeHeight - 60; // 留至少 60px 给文件树
      const newPanelHeight = Math.max(40, Math.min(maxPanelHeight, startPanelHeight - dy));
      panel.style.height = newPanelHeight + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // 格式化 Token 数量：≥1K 用 K，≥1M 用 M，≥1G 用 G，≥1T 用 T，≥1P 用 P
  function makeRelPath(fullPath, base) {
    if (!fullPath) return '';
    if (!base) return fullPath;
    // 规范化路径分隔符
    const norm = String(fullPath).replace(/\\/g, '/');
    const baseNorm = String(base).replace(/\\/g, '/').replace(/\/$/, '');
    if (norm.toLowerCase().startsWith(baseNorm.toLowerCase() + '/')) {
      return norm.slice(baseNorm.length + 1);
    }
    return fullPath;
  }

  // ---- Monaco integration ----
  function ensureMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise((resolve, reject) => {
      if (typeof require === 'undefined' || !require.config) {
        reject(new Error('Monaco loader not available (require.config missing)'));
        return;
      }
      // Configure loader to use local monaco-editor resources (no CDN)
      require.config({ paths: { vs: '../../../node_modules/monaco-editor/min/vs' } });
      // Worker setup for Electron file:// — load worker via blob URL
      window.MonacoEnvironment = {
        getWorkerUrl: function () {
          const base = new URL('../../../node_modules/monaco-editor/min/vs', location.href).href;
          const workerMain = new URL('../../../node_modules/monaco-editor/min/vs/base/worker/workerMain.js', location.href).href;
          const blob = new Blob([
            'self.MonacoEnvironment = { baseUrl: "' + base + '" };',
            'importScripts("' + workerMain + '");'
          ], { type: 'application/javascript' });
          return URL.createObjectURL(blob);
        }
      };
      require(['vs/editor/editor.main'], function () {
        resolve(window.monaco);
      }, function (err) { reject(err); });
    });
    return monacoReady;
  }

  async function initMonacoEditor() {
    if (monacoEditor) return monacoEditor;
    const host = document.getElementById('code-editor-host');
    if (!host) return null;
    await ensureMonaco();
    host.innerHTML = '';
    // 跟随当前主题
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    monacoEditor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      theme: isDark ? 'vs-dark' : 'vs',
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      wordWrap: 'on',
      smoothScrolling: true
    });
    // Ctrl/Cmd+S to save current file
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      await saveCurrentFile();
    });
    return monacoEditor;
  }

  async function openFileInMonaco(filePath, fileName) {
    try {
      await initMonacoEditor();
    } catch (e) {
      window.showMessageModal?.('Monaco 编辑器加载失败: ' + e.message, '错误', 'error');
      return;
    }
    // Switch if already open
    const existing = codeOpenTabs.find(t => t.path === filePath);
    if (existing) {
      switchTab(filePath);
      return;
    }
    const readRes = await window.api.readFile(filePath);
    if (!readRes.ok) {
      window.showMessageModal?.('无法读取文件: ' + (readRes.error || '未知错误'), '错误', 'error');
      return;
    }
    const content = readRes.content || '';
    const lang = detectMonacoLanguage(fileName);
    const model = monaco.editor.createModel(content, lang);
    const tab = { path: filePath, name: fileName, model, originalContent: content, dirty: false };
    model.onDidChangeContent(() => {
      tab.dirty = model.getValue() !== tab.originalContent;
      renderEditorTabs();
    });
    codeOpenTabs.push(tab);
    switchTab(filePath);
  }

  function switchTab(filePath) {
    const tab = codeOpenTabs.find(t => t.path === filePath);
    if (!tab || !monacoEditor) return;
    codeActiveTabPath = filePath;
    monacoEditor.setModel(tab.model);
    renderEditorTabs();
    highlightFileTreeNode(filePath);
    hideEditorEmptyState();
  }

  function closeTab(filePath) {
    const idx = codeOpenTabs.findIndex(t => t.path === filePath);
    if (idx === -1) return;
    const tab = codeOpenTabs[idx];
    if (tab.dirty && !confirm('文件 ' + tab.name + ' 有未保存的更改，确定关闭吗？')) return;
    tab.model.dispose();
    codeOpenTabs.splice(idx, 1);
    if (codeActiveTabPath === filePath) {
      if (codeOpenTabs.length > 0) {
        switchTab(codeOpenTabs[Math.max(0, idx - 1)].path);
      } else {
        codeActiveTabPath = null;
        if (monacoEditor) monacoEditor.setModel(monaco.editor.createModel('', 'plaintext'));
        showEditorEmptyState();
      }
    }
    renderEditorTabs();
  }

  function renderEditorTabs() {
    const tabsEl = document.getElementById('code-editor-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    for (const tab of codeOpenTabs) {
      const el = document.createElement('div');
      el.className = 'editor-tab' + (tab.path === codeActiveTabPath ? ' active' : '');
      const icon = fileIconClass(tab.name);
      el.innerHTML = '<i class="fa-solid ' + icon + '"></i>' +
        '<span>' + escapeHtml(tab.name) + '</span>' +
        (tab.dirty ? '<span style="color:#f59e0b;margin-left:2px">●</span>' : '') +
        '<span class="tab-close" title="关闭"><i class="fa-solid fa-xmark"></i></span>';
      el.addEventListener('click', () => switchTab(tab.path));
      const closeBtn = el.querySelector('.tab-close');
      if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path); });
      tabsEl.appendChild(el);
    }
    // 增量推送：编辑器 tab 栏更新后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-editor-tabs', html: tabsEl.innerHTML });
  }

  function showEditorEmptyState() {
    const host = document.getElementById('code-editor-host');
    if (!host) return;
    let placeholder = host.querySelector('.editor-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'editor-placeholder';
      placeholder.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-secondary);opacity:0.5;pointer-events:none;';
      placeholder.innerHTML = '<i class="fa-solid fa-file-code" style="font-size:32px;margin-bottom:8px;"></i><p>点击文件树中的文件以打开</p>';
      host.appendChild(placeholder);
    }
    placeholder.style.display = 'flex';
  }

  function hideEditorEmptyState() {
    const host = document.getElementById('code-editor-host');
    if (!host) return;
    const placeholder = host.querySelector('.editor-placeholder');
    if (placeholder) placeholder.style.display = 'none';
  }

  async function saveCurrentFile() {
    const tab = codeOpenTabs.find(t => t.path === codeActiveTabPath);
    if (!tab) return;
    const content = tab.model.getValue();
    const result = await window.api.writeFile(tab.path, content);
    if (result && result.ok) {
      tab.originalContent = content;
      tab.dirty = false;
      renderEditorTabs();
    } else {
      window.showMessageModal?.('保存失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  function detectMonacoLanguage(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const map = {
      js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json', json5: 'json',
      html: 'html', htm: 'html', xhtml: 'html',
      css: 'css', scss: 'scss', less: 'less',
      md: 'markdown', markdown: 'markdown',
      xml: 'xml', svg: 'xml',
      py: 'python',
      java: 'java',
      c: 'c', h: 'c',
      cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
      cs: 'csharp',
      go: 'go',
      rb: 'ruby',
      php: 'php',
      rs: 'rust',
      sh: 'shell', bash: 'shell', zsh: 'shell',
      sql: 'sql',
      yaml: 'yaml', yml: 'yaml',
      ini: 'ini', conf: 'ini',
      bat: 'bat',
      ps1: 'powershell',
      kt: 'kotlin', kts: 'kotlin',
      swift: 'swift',
      dart: 'dart',
      r: 'r',
      lua: 'lua',
      pl: 'perl',
      txt: 'plaintext'
    };
    return map[ext] || 'plaintext';
  }

  function fileIconClass(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const map = {
      js: 'fa-file-code', jsx: 'fa-file-code', ts: 'fa-file-code', tsx: 'fa-file-code',
      json: 'fa-file-code', html: 'fa-file-code', css: 'fa-file-code', scss: 'fa-file-code',
      md: 'fa-file-lines', txt: 'fa-file-lines', log: 'fa-file-lines',
      png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image', gif: 'fa-file-image',
      bmp: 'fa-file-image', webp: 'fa-file-image',
      svg: 'fa-file-image',
      pdf: 'fa-file-pdf',
      zip: 'fa-file-zipper', gz: 'fa-file-zipper', tar: 'fa-file-zipper', '7z': 'fa-file-zipper',
      rar: 'fa-file-zipper',
      exe: 'fa-file-exe', msi: 'fa-file-exe',
      mp3: 'fa-file-audio', wav: 'fa-file-audio',
      mp4: 'fa-file-video', avi: 'fa-file-video', mkv: 'fa-file-video',
      xls: 'fa-file-excel', xlsx: 'fa-file-excel',
      doc: 'fa-file-word', docx: 'fa-file-word',
      ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint'
    };
    return map[ext] || 'fa-file';
  }

  function highlightFileTreeNode(filePath) {
    document.querySelectorAll('.code-file-tree .tree-node.active').forEach(el => el.classList.remove('active'));
    const escaped = filePath.replace(/"/g, '\\"');
    const target = document.querySelector('.code-file-tree .tree-node[data-path="' + escaped + '"]');
    if (target) target.classList.add('active');
  }

  // ---- File tree rendering (with collapsible dirs + context menu) ----
  function renderCodeFileTree(container, tree, basePath) {
    container.innerHTML = '';
    function buildNode(node, depth, holder) {
      const row = document.createElement('div');
      row.className = 'tree-node ' + (node.type === 'directory' ? 'dir' : 'file');
      row.style.paddingLeft = (depth * 12 + 8) + 'px';
      row.dataset.path = node.path;
      row.dataset.name = node.name;
      row.dataset.type = node.type;
      if (node.type === 'directory') {
        row.innerHTML = '<i class="fa-solid fa-chevron-right tree-toggle"></i><i class="fa-solid fa-folder"></i> <span>' + escapeHtml(node.name) + '</span>';
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const toggle = row.querySelector('.tree-toggle');
          const folderIcon = row.querySelector('.fa-folder, .fa-folder-open');
          const childHolder = row.nextElementSibling;
          if (childHolder && childHolder.classList.contains('tree-children')) {
            const collapsed = childHolder.style.display === 'none';
            childHolder.style.display = collapsed ? 'block' : 'none';
            if (toggle) toggle.classList.toggle('fa-chevron-right', !collapsed);
            if (toggle) toggle.classList.toggle('fa-chevron-down', collapsed);
            if (folderIcon) folderIcon.className = collapsed ? 'fa-solid fa-folder-open' : 'fa-solid fa-folder';
          }
        });
      } else {
        row.innerHTML = '<span class="tree-toggle"></span><i class="fa-solid ' + fileIconClass(node.name) + '"></i> <span>' + escapeHtml(node.name) + '</span>';
        row.title = node.path;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          openFileInMonaco(node.path, node.name);
        });
      }
      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showCodeFileTreeContextMenu(e, node);
      });
      holder.appendChild(row);
      if (node.children && node.type === 'directory') {
        const childHolder = document.createElement('div');
        childHolder.className = 'tree-children';
        for (const child of node.children) buildNode(child, depth + 1, childHolder);
        holder.appendChild(childHolder);
      }
    }
    if (Array.isArray(tree)) {
      for (const node of tree) buildNode(node, 0, container);
    }
    // 增量推送：文件树渲染后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: container.innerHTML });
  }

  // ---- File tree context menu (Add to context / Rename / Delete) ----
  // 根据平台返回对应文案：macOS → "Finder"，Windows/Linux → "资源管理器"
  function _fileManagerName() {
    try {
      if (window.api?.platform === 'darwin') return 'Finder';
    } catch { /* ignore */ }
    return '资源管理器';
  }
  function showCodeFileTreeContextMenu(e, node) {
    // Remove any existing menu
    const existing = document.querySelector('.file-tree-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'file-tree-context-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:var(--bg-secondary,#fff);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:4px 0;min-width:180px;font-size:0.85em;left:' + e.clientX + 'px;top:' + e.clientY + 'px;';

    const fmName = _fileManagerName();
    const isFile = node.type === 'file';
    const items = [];
    if (isFile) {
      items.push({ icon: 'fa-comment-dots', label: '添加到上下文', action: () => addFileToCodeContext(node) });
      items.push({ icon: 'fa-copy', label: '复制路径', action: () => { navigator.clipboard.writeText(node.path).catch(() => {}); } });
      items.push({ icon: 'fa-folder-open', label: `在${fmName}中显示`, action: () => window.api.openFileExplorer?.(node.path) });
    } else {
      items.push({ icon: 'fa-folder-open', label: `在${fmName}中打开`, action: () => window.api.openFileExplorer?.(node.path) });
    }
    items.push({ icon: 'fa-pen', label: '重命名', action: () => renameTreeNode(node) });
    items.push({ icon: 'fa-trash', label: '删除', danger: true, action: () => deleteTreeNode(node) });

    for (const item of items) {
      const el = document.createElement('div');
      el.style.cssText = 'padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap;' + (item.danger ? 'color:#dc3545;' : '');
      el.innerHTML = '<i class="fa-solid ' + item.icon + '" style="width:14px;"></i><span>' + escapeHtml(item.label) + '</span>';
      el.addEventListener('mouseenter', () => { el.style.background = item.danger ? 'rgba(220,53,69,0.1)' : 'var(--bg-hover,rgba(0,0,0,0.05))'; });
      el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
      el.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(el);
    }
    document.body.appendChild(menu);

    // Adjust position if out of viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    // Close on outside click
    setTimeout(() => {
      const closer = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('click', closer);
          document.removeEventListener('contextmenu', closer);
        }
      };
      document.addEventListener('click', closer);
      document.addEventListener('contextmenu', closer);
    }, 100);
  }

  async function addFileToCodeContext(node) {
    // 避免重复添加
    if (codeCurrentAttachments.some(a => a.path === node.path)) {
      window.showMessageModal?.('该文件已在上下文中', '提示', 'info');
      return;
    }
    const readRes = await window.api.readFile(node.path);
    if (!readRes.ok) {
      window.showMessageModal?.('无法读取文件: ' + (readRes.error || '未知错误'), '错误', 'error');
      return;
    }
    const ext = (node.name.split('.').pop() || '').toLowerCase();
    const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(node.name);
    codeCurrentAttachments.push({
      name: node.name,
      path: node.path,
      isImage,
      content: readRes.content || '',
      ext
    });
    renderCodeAttachments();
  }

  function removeCodeAttachment(index) {
    codeCurrentAttachments.splice(index, 1);
    renderCodeAttachments();
  }

  function clearCodeAttachments() {
    codeCurrentAttachments = [];
    renderCodeAttachments();
  }

  function renderCodeAttachments() {
    const container = document.getElementById('code-attachments-preview');
    if (!container) return;
    if (codeCurrentAttachments.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-attachments-preview', attr: 'class', value: container.className });
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-attachments-preview', html: container.innerHTML });
      return;
    }
    container.classList.remove('hidden');
    container.innerHTML = codeCurrentAttachments.map((att, i) =>
      '<div class="attachment-item">' +
        '<i class="fa-solid ' + (att.isImage ? 'fa-image' : 'fa-file') + '"></i>' +
        '<span class="attachment-name">' + escapeHtml(att.name) + '</span>' +
        '<button class="btn-icon attachment-remove" data-index="' + i + '" title="从上下文移除"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>'
    ).join('');
    container.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => removeCodeAttachment(parseInt(btn.dataset.index)));
    });
    // 增量推送：附件列表更新后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-attachments-preview', attr: 'class', value: container.className });
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-attachments-preview', html: container.innerHTML });
  }

  async function renameTreeNode(node) {
    // 使用自定义输入模态框替代 prompt()（prompt 在 Electron 中不受支持）
    const newName = await showInputModal('重命名', '输入新名称:', node.name);
    if (!newName || newName === node.name) return;
    const dir = node.path.substring(0, node.path.lastIndexOf(node.path.includes('\\') ? '\\' : '/'));
    const sep = node.path.includes('\\') ? '\\' : '/';
    const newPath = dir + sep + newName;
    const result = await window.api.moveFile(node.path, newPath);
    if (result && result.ok) {
      const tab = codeOpenTabs.find(t => t.path === node.path);
      if (tab) {
        tab.path = newPath;
        tab.name = newName;
        renderEditorTabs();
      }
      await loadCodeFileTree(codeWorkspacePath);
    } else {
      window.showMessageModal?.('重命名失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  async function deleteTreeNode(node) {
    const confirmed = await showConfirmModal('确认删除', '确定删除 ' + node.name + ' 吗？此操作不可恢复。');
    if (!confirmed) return;
    const result = node.type === 'directory'
      ? await window.api.deleteDirectory(node.path)
      : await window.api.deleteFile(node.path);
    if (result && result.ok) {
      // Close tab if open
      const idx = codeOpenTabs.findIndex(t => t.path === node.path);
      if (idx !== -1) closeTab(node.path);
      await loadCodeFileTree(codeWorkspacePath);
    } else {
      window.showMessageModal?.('删除失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  // 退订 agent 注册的 LLM 重试/流式事件监听器。
  // 旧监听器挂在 agent 实例上，若实例被置 null 后无法退订，
  // ipcRenderer 监听器会随每次新对话线性累积。
  function unsubscribeAgentStreams(ag) {
    if (!ag) return;
    if (typeof ag.unsubscribeStreams === 'function') {
      try { ag.unsubscribeStreams(); } catch { /* ignore */ }
    }
  }

  function setupAgentStreamSubscriptions(ag, mode) {
    if (!ag || !window.api) return;
    if (window.api.onLLMRetry && !ag._llmRetryUnsub) {
      ag._llmRetryUnsub = window.api.onLLMRetry((info) => {
        if (!info || !ag.onMessage) return;
        // 仅处理属于当前会话的重试事件，避免其他模式会话的重试气泡串进来
        if (info.sessionKey && info.sessionKey !== ag.sessionKey) return;
        const kind = info.kind || 'unknown';
        const delayTxt = info.delayMs ? `，${Math.round(info.delayMs / 100) / 10}s 后重试` : '';
        const reasonTxt = info.reason ? `（${info.reason}）` : '';
        ag.onMessage('system', `LLM 请求失败（${kind}），第 ${info.attempt || 1} 次重试${delayTxt}${reasonTxt}`);
      });
    }
    if (window.api.onStreamChunk && !ag._streamChunkUnsub) {
      ag._streamChunkUnsub = window.api.onStreamChunk((chunk) => {
        if (!chunk || chunk.requestId !== ag._activeStreamRequestId) return;
        if (ag.onMessage) ag.onMessage('stream-chunk', chunk);
        const session = sessionManager?.getByAgent(ag);
        if (window.VoiceUI && chunk.content && (!session || session.active)) {
          window.VoiceUI.feedStreamChunk(chunk.content);
        }
      });
    }
    if (window.api.onStreamEnd && !ag._streamEndUnsub) {
      ag._streamEndUnsub = window.api.onStreamEnd((data) => {
        if (!data || data.requestId !== ag._activeStreamRequestId) return;
        if (ag.onMessage) ag.onMessage('stream-end', data);
        const session = sessionManager?.getByAgent(ag);
        if (window.VoiceUI && (!session || session.active)) {
          window.VoiceUI.feedStreamEnd(data && data.content ? data.content : null);
        }
      });
    }
  }

  function wireCodeAgent(ag) {
    if (!ag) return;
    const isActive = () => {
      const session = sessionManager?.getByAgent(ag);
      return !session || session.active;
    };

    ag.onTitleChange = (title) => {
      if (isActive()) setTitlebarTitle(title);
      if (isActive()) window.api.webControlPushTitle(title);
    };

    ag.onMessage = (type, data) => {
      const msgsEl = document.getElementById('code-chat-messages');
      if (!msgsEl) return;
      if (!isActive()) {
        if (type === 'approval') {
          // SessionManager 已记录等待审批状态，这里只刷新 tab。
          if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
        } else if (type === 'present-file' && sessionManager) {
          const session = sessionManager.getByAgent(ag);
          if (session) sessionManager.bufferUiEvent(session, { type: 'present-file', data });
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
        }
        return;
      }
      switch (type) {
        case 'assistant':
          addCodeMessage('assistant', data);
          break;
        case 'system':
          addCodeMessage('system', data);
          break;
        case 'stream-chunk': {
          const bubble = codeStreamBubble;
          if (!bubble) return;
          if (data.content) {
            const dedup = dedupAppendChunk(bubble.rawContent, bubble._lastChunk, data.content);
            bubble.rawContent = dedup.raw;
            bubble._lastChunk = dedup.lastChunk;
            bubble.contentStarted = true;
            bubble.contentEl.innerHTML = renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor">▋</span>';
            if (bubble.rawReasoning) bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning);
          }
          if (data.reasoning) {
            bubble.rawReasoning += data.reasoning;
            bubble.reasoningSection.style.display = 'block';
            const rCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor">▋</span>';
            bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning) + rCursor;
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          msgsEl.scrollTop = msgsEl.scrollHeight;
          if (!bubble.renderTimer) {
            bubble.renderTimer = setTimeout(() => {
              bubble.renderTimer = null;
              if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
            }, 120);
          }
          break;
        }
        case 'stream-end': {
          const isAuthoritativeFinal = !!(data && typeof data === 'object' && data.content !== undefined);
          const bubble = codeStreamBubble;
          if (!bubble) {
            if (isAuthoritativeFinal && data.requestId) {
              const target = msgsEl.querySelector(`[data-stream-request="${cssEscape(data.requestId)}"]`);
              if (target) {
                const body = target.querySelector('.message-content, .code-msg-content, .message-body');
                const clean = String(data.content || '').trimEnd();
                if (body && clean) body.innerHTML = renderMarkdown(clean);
              }
            }
            codeStreamBubble = null;
            return;
          }
          if (!isAuthoritativeFinal) return;
          if (bubble.renderTimer) { clearTimeout(bubble.renderTimer); bubble.renderTimer = null; }
          const hasReasoning = !!(data.reasoning || bubble.rawReasoning);
          const finalContent = String(data.content || bubble.rawContent).trimEnd();
          const hasContent = !!(finalContent && finalContent.trim());
          if (hasReasoning) {
            bubble.reasoningSection.classList.add('collapsed');
            bubble.reasoningSection.style.display = 'block';
            bubble.reasoningEl.innerHTML = renderMarkdown(data.reasoning || bubble.rawReasoning);
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          if (hasContent) {
            bubble.contentEl.innerHTML = renderMarkdown(finalContent);
          } else if (hasReasoning) {
            bubble.contentEl.style.display = 'none';
            const timeEl = bubble.el.querySelector('.message-time');
            if (timeEl) timeEl.style.display = 'none';
          } else {
            bubble.el.remove();
            if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + bubble.el.id });
            codeStreamBubble = null;
            break;
          }
          bubble.el.classList.remove('streaming');
          if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          codeStreamBubble = null;
          break;
        }
        case 'stream-start':
          codeStreamBubble = createCodeStreamBubble();
          if (codeStreamBubble?.el && data?.requestId) {
            codeStreamBubble.el.setAttribute('data-stream-request', String(data.requestId));
          }
          break;
        case 'tool_call':
          addCodeToolCall(data);
          break;
        case 'approval':
          showCodeApprovalPanel(data.toolName, data.args);
          break;
        case 'tool-auth-required':
          showToolAuthModal(data.toolName, data.category, ag);
          break;
        case 'tool-result':
          addCodeToolResult(data);
          if (data && _fileSystemTools.has(data.name) && codeWorkspacePath) loadCodeFileTree(codeWorkspacePath);
          break;
        case 'present-file':
          addFilePresentCard(data);
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
          break;
      }
    };
  }

  async function initCodeAgent() {
    // 先退订旧实例的监听器，避免 ipcRenderer 监听器累积
    unsubscribeAgentStreams(codeAgent);
    if (codeAgent && sessionManager) {
      const oldSession = sessionManager.getByAgent(codeAgent);
      if (oldSession) sessionManager.close(oldSession);
    }
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区文件夹', '提示', 'warning');
      return false;
    }
    codeAgent = new Agent();
    codeAgent.mode = 'code';
    codeAgent.workspacePath = codeWorkspacePath;
    codeAgent.codeWorkspacePath = codeWorkspacePath; // 用于 saveToHistory 的 code 分支
    codeAgent.settings = await window.api.getSettings();
    if (!codeAgent.settings.tools || typeof codeAgent.settings.tools !== 'object') {
      codeAgent.settings.tools = {};
    }
    codeAgent.systemInfo = await window.api.getFullSystemInfo();
    codeAgent.contextManager = new ContextManager(codeAgent.settings.llm?.maxContextLength || 131072);
    codeAgent.contextManager.setMaxTokens(codeAgent.settings.llm?.maxContextLength || 131072);
    codeAgent.contextManager.setOutputReserve(codeAgent.settings.llm?.maxResponseTokens || 8192);
    codeAgent.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await codeAgent.refreshSkillsCatalog();
    codeAgent.contextManager.setSystemPrompt(codeAgent.getSystemPrompt());
    setupAgentStreamSubscriptions(codeAgent, 'code');
    wireCodeAgent(codeAgent);

    if (sessionManager) {
      const codeSession = sessionManager.registerAgent('code', codeAgent, {
        title: codeAgent.conversationTitle || '未命名 Code 会话'
      });
      sessionManager.activate('code', codeSession.key);
    }
    return true;
  }

  async function createCodeSession() {
    const ag = new Agent();
    ag.mode = 'code';
    ag.workspacePath = codeWorkspacePath || '';
    ag.codeWorkspacePath = codeWorkspacePath || '';
    ag.settings = await window.api.getSettings();
    if (!ag.settings.tools || typeof ag.settings.tools !== 'object') ag.settings.tools = {};
    ag.systemInfo = await window.api.getFullSystemInfo();
    ag.contextManager = new ContextManager(ag.settings.llm?.maxContextLength || 131072);
    ag.contextManager.setMaxTokens(ag.settings.llm?.maxContextLength || 131072);
    ag.contextManager.setOutputReserve(ag.settings.llm?.maxResponseTokens || 8192);
    ag.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await ag.refreshSkillsCatalog();
    ag.contextManager.setSystemPrompt(ag.getSystemPrompt());
    wireCodeAgent(ag);
    setupAgentStreamSubscriptions(ag, 'code');
    if (!sessionManager) return null;
    const session = sessionManager.registerAgent('code', ag, { title: '未命名 Code 会话' });
    activateSession('code', session.key);
    return session;
  }

  /**
   * 对齐 Chat/Babe：首次进入 Code 模式时自动创建第一个会话标签。
   * 不强制要求工作区（工作区缺失只在发送消息时提示），
   * 因此没有工作区也能看到会话标签，交互与其它模式一致。
   */
  async function ensureCodeFirstSession() {
    if (codeAgent) return codeAgent;
    if (sessionManager && sessionManager.list('code').length > 0) return null;
    if (!codeWorkspacePath) {
      try { codeWorkspacePath = await window.api.codeGetLastWorkspace(); } catch { /* ignore */ }
      if (codeWorkspacePath) {
        const wsPathEl = document.getElementById('code-workspace-path');
        if (wsPathEl) wsPathEl.textContent = codeWorkspacePath;
      }
    }
    return createCodeSession();
  }

  async function replayCodeSession(session) {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl || !session?.agent) return;
    codeStreamBubble = null;
    msgsEl.innerHTML = '';
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#code-chat-messages' });
    const messages = session.agent.contextManager?.getHistoryMessages() || [];
    const total = messages.length;
    const chunkSize = 40;
    const toolCallMap = {};
    if (total === 0) {
      msgsEl.innerHTML = `<div class="welcome-message"><div class="welcome-icon"><i class="fa-solid fa-code"></i></div><h2>Code 模式</h2><p>继续编程任务</p></div>`;
      return;
    }
    showHistoryProgress(total);
    try {
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const msg = messages[i];
          if (msg.role === 'user') {
            addCodeMessage('user', extractTextContent(msg.content), false);
          } else if (msg.role === 'assistant') {
            const textContent = extractTextContent(msg.content);
            if (textContent) addCodeMessage('assistant', textContent, false);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                const card = addCodeToolCall({ name: displayName, args, callId: tc.id });
                if (tc.id && card) toolCallMap[tc.id] = { card, name: toolName };
              }
            }
          } else if (msg.role === 'tool') {
            const key = msg.tool_call_id;
            const entry = key ? toolCallMap[key] : null;
            let result = msg.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
            if (entry) {
              addCodeToolResult({ result, name: entry.name, callId: key });
            } else {
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              addCodeMessage('system', `[工具结果] ${msg.name || 'tool'}: ${resultStr.slice(0, 200)}`, false);
            }
          } else if (msg.role === 'system') {
            addCodeMessage('system', typeof msg.content === 'string' ? msg.content : String(msg.content || ''), false);
          }
        }
        updateHistoryProgress(end, total, end >= total ? '渲染完成，正在收尾…' : `已渲染 ${end}/${total} 条消息`);
        await yieldHistoryUI();
      }
    } finally {
      hideHistoryProgress();
    }
    requestAnimationFrame(() => {
      msgsEl.scrollTop = msgsEl.scrollHeight;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-chat-messages', html: msgsEl.innerHTML });
    });
  }

  let codeStreamBubble = null;

  function createCodeStreamBubble() {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return null;
    // Remove welcome message
    const welcome = msgsEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'message assistant streaming';
    msg.id = 'code-stream-' + Date.now();
    msg.innerHTML = `
      <div class="message-avatar"><i class="fa-solid fa-robot"></i></div>
      <div class="message-body">
        <div class="reasoning-section" style="display:none;">
          <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <i class="fa-solid fa-brain"></i><span>推理过程</span>
            <i class="fa-solid fa-chevron-down reasoning-toggle-icon"></i>
          </div>
          <div class="reasoning-content markdown-body"></div>
        </div>
        <div class="message-content markdown-body"></div>
        <div class="message-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：流式气泡创建后追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: msg.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return {
      el: msg,
      contentEl: msg.querySelector('.message-content'),
      reasoningEl: msg.querySelector('.reasoning-content'),
      reasoningSection: msg.querySelector('.reasoning-section'),
      rawContent: '',
      rawReasoning: '',
      contentStarted: false,
      renderTimer: null // 用于流式 chunk 推送节流
    };
  }

  function addCodeMessage(role, content, track = true) {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    const welcome = msgsEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'message ' + role;
    const avatarIcon = role === 'assistant' ? 'fa-robot' : (role === 'system' ? 'fa-info-circle' : 'fa-user');
    const rendered = (role === 'assistant') ? renderMarkdown(content) : escapeHtml(content);
    // 懒渲染用：保留原始内容与角色，离屏折叠后滚回时重新渲染
    msg.dataset.lazyRaw = content;
    msg.dataset.lazyRole = (role === 'assistant') ? 'md' : 'text';
    msg.innerHTML = `
      <div class="message-avatar"><i class="fa-solid ${avatarIcon}"></i></div>
      <div class="message-body">
        <div class="message-content markdown-body">${rendered}</div>
        <div class="message-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：Code 消息追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: msg.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;

    // Track for history
    if (track) codeMessages.push({ role, content });
  }

  function addCodeToolCall(data) {
    // 工具调用 UI（卡片式）— 显示工具名 + 参数
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'tool-call-card';
    div.id = 'code-tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    if (data.callId) div.dataset.callId = data.callId;
    const argsStr = data.args ? JSON.stringify(data.args, null, 2).slice(0, 500) : '';
    div.innerHTML = `<div class="tool-call-header"><i class="fa-solid fa-wrench"></i> <span>${escapeHtml(data.name || 'tool')}</span></div>` +
      (argsStr ? `<pre class="tool-call-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="tool-call-status"><i class="fa-solid fa-spinner fa-spin"></i> 执行中...</div>`;
    msgsEl.appendChild(div);
    // 增量推送：工具调用卡片追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: div.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function addCodeToolResult(data) {
    // 在 tool-call-card 中填充结果
    // 优先通过 callId 精确匹配（历史加载时多个工具调用可能连续出现）
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    let targetCard = null;
    if (data.callId) {
      targetCard = msgsEl.querySelector(`.tool-call-card[data-call-id="${cssEscape(data.callId)}"]`);
    }
    if (!targetCard) {
      // 回退：取最后一个未完成的 card（状态为"执行中"的）
      const cards = msgsEl.querySelectorAll('.tool-call-card');
      for (let i = cards.length - 1; i >= 0; i--) {
        const statusEl = cards[i].querySelector('.tool-call-status');
        if (statusEl && statusEl.innerHTML.includes('fa-spin')) { targetCard = cards[i]; break; }
      }
      // 最终回退：取最后一个 card
      if (!targetCard) targetCard = cards[cards.length - 1];
    }
    if (!targetCard) return;
    const statusEl = targetCard.querySelector('.tool-call-status');
    if (!statusEl) return;
    const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const ok = data.result?.ok !== false;
    statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败') +
      (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
    // 增量推送：更新工具调用卡片结果到 WebUI
    if (targetCard.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + targetCard.id, html: targetCard.outerHTML });
    }
  }

  function showCodeApprovalPanel(toolName, args) {
    // Code 模式独立的 approval UI（在 code-chat-messages 区域内显示，不逃逸到 Chat 模式）
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    // 移除已存在的 approval 面板
    const existing = msgsEl.querySelector('.code-approval-panel');
    if (existing) {
      if (existing.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + existing.id });
      existing.remove();
    }
    const div = document.createElement('div');
    div.className = 'code-approval-panel';
    div.id = 'code-approval-' + Date.now();
    const argsStr = args ? JSON.stringify(args, null, 2) : '';
    div.innerHTML = `<div class="approval-header"><i class="fa-solid fa-shield-halved"></i> 工具审批：${escapeHtml(toolName)}</div>` +
      (argsStr ? `<pre class="approval-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="approval-actions">
        <button class="btn-danger btn-approval-deny"><i class="fa-solid fa-xmark"></i> 拒绝</button>
        <button class="btn-primary btn-approval-approve"><i class="fa-solid fa-check"></i> 批准</button>
      </div>`;
    msgsEl.appendChild(div);
    // 增量推送：审批面板追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: div.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    div.querySelector('.btn-approval-approve').addEventListener('click', () => {
      if (codeAgent) codeAgent.resolveApproval(true);
      div.remove();
      if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id });
    });
    div.querySelector('.btn-approval-deny').addEventListener('click', () => {
      if (codeAgent) codeAgent.resolveApproval(false);
      div.remove();
      if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id });
    });
  }

  async function sendCodeMessage() {
    const input = document.getElementById('code-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text && codeCurrentAttachments.length === 0) return;
    if (!codeAgent) {
      const ok = await initCodeAgent();
      if (!ok) return;
    }
    // 会话可在尚未选择工作区时先行创建（与其他模式对齐），
    // 真正发送时再要求工作区，避免"空工作区"直接进入 Agent。
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区文件夹', '提示', 'warning');
      return;
    }
    if (codeAgent.workspacePath !== codeWorkspacePath || codeAgent.codeWorkspacePath !== codeWorkspacePath) {
      codeAgent.workspacePath = codeWorkspacePath;
      codeAgent.codeWorkspacePath = codeWorkspacePath;
    }
    if (codeAgent.running) return;
    const codeSession = sessionManager?.getByAgent(codeAgent);
    if (codeSession && !sessionManager.requestStart(codeSession)) {
      const queued = codeCurrentAttachments.map(att => ({
        name: att.name,
        path: att.path,
        isImage: att.isImage,
        extractedText: att.content || ''
      }));
      addCodeMessage('user', text);
      input.value = '';
      clearCodeAttachments();
      sessionManager.queue(codeSession, { text, attachments: queued });
      addCodeMessage('system', '当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。', false);
      return;
    }

    // 与 Chat 模式一致：UI 与历史只记录 [附件: 文件名]，文件内容通过 attachments 参数交给 Agent 内部处理
    const attachments = codeCurrentAttachments.map(att => ({
      name: att.name,
      path: att.path,
      isImage: att.isImage,
      extractedText: att.content || ''
    }));

    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += (displayText ? '\n' : '') + `[附件: ${names}]`;
    }

    addCodeMessage('user', displayText);
    input.value = '';
    input.style.height = 'auto';
    clearCodeAttachments();
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#code-chat-input', value: '' });

    // Toggle stop button
    const btnSend = document.getElementById('btn-code-send');
    const btnStop = document.getElementById('btn-code-stop');
    btnSend?.classList.add('hidden');
    btnStop?.classList.remove('hidden');
    // 推送按钮状态变化到 WebUI
    if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-send', attr: 'class', value: btnSend.className });
    if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: btnStop.className });

    try {
      // 与 Chat 模式一致：附件作为独立参数传入，sendMessage 内部负责构造 [附件: xxx] 摘要
      await codeAgent.sendMessage(text, attachments);
    } catch (e) {
      addCodeMessage('system', `错误: ${e.message}`);
    } finally {
      btnSend?.classList.remove('hidden');
      // 仅当 Code Agent 完成 且 语音播报也完成时才隐藏停止按钮
      try { refreshCodeStopButton(); } catch (_) {}
      // 推送按钮状态恢复到 WebUI
      if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-send', attr: 'class', value: btnSend.className });
      if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: btnStop.className });
      // Auto-save history
      await saveCodeHistory();
    }
  }

  async function saveCodeHistory() {
    if (!codeWorkspacePath || codeMessages.length === 0) return;
    // 同步 codeCurrentHistoryId 与 codeAgent.conversationId，避免双重保存产生重复历史条目。
    // 真正的历史持久化由 codeAgent.saveToHistory()（agent.js）负责，它保存完整的 contextManager.messages。
    if (codeAgent && codeAgent.conversationId) {
      codeCurrentHistoryId = codeAgent.conversationId;
      return;
    }
    // Agent 未初始化时的兜底：直接保存 codeMessages
    if (!codeCurrentHistoryId) {
      codeCurrentHistoryId = Date.now().toString(36);
    }
    const title = codeMessages.find(m => m.role === 'user')?.content?.slice(0, 30) || '未命名';
    await window.api.codeSaveHistory(codeWorkspacePath, codeCurrentHistoryId, {
      title,
      ts: Date.now(),
      schemaVersion: 2, // 与 agent.saveToHistory 保持统一的历史格式版本
      messages: codeMessages,
      workspace: codeWorkspacePath
    });
  }

  async function loadCodeHistoryPage() {
    const listEl = document.getElementById('code-history-list');
    const descEl = document.getElementById('code-history-desc');
    if (!listEl) return;
    if (!codeWorkspacePath) {
      listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史（需先打开工作区）</p></div>';
      if (descEl) descEl.textContent = '按工作区隔离的编程对话历史';
      return;
    }
    if (descEl) descEl.textContent = `工作区: ${codeWorkspacePath}`;
    if (typeof HistoryList !== 'undefined') {
      await loadCodeHistoryPageVirtual();
      return;
    }
    listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>';
    try {
      const result = await window.api.codeListHistory(codeWorkspacePath);
      if (result.ok && result.history && result.history.length > 0) {
        // 对齐 Chat 模式结构：history-info(标题+时间) / history-actions(按钮组)
        listEl.innerHTML = result.history.map(item => {
          const date = new Date(item.ts);
          const timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('code', item) : null;
          return `
          <div class="history-item" data-id="${item.id}">
            <div class="history-info">
              <div class="history-title">${escapeHtml(item.title || '未命名')} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
              <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
            </div>
            <div class="history-actions">
              <button class="btn-icon history-continue" data-id="${item.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
              <button class="btn-icon history-delete" data-id="${item.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>`;
        }).join('');
        listEl.querySelectorAll('.history-continue').forEach(btn => {
          btn.addEventListener('click', async () => {
            stopVoicePlayback(); // 切换会话前清空语音播放队列
            const id = btn.dataset.id;
            const loadRes = await window.api.codeLoadHistory(codeWorkspacePath, id);
            if (loadRes.ok && loadRes.data) {
              codeCurrentHistoryId = id;
              const conv = loadRes.data;
              let session = sessionManager ? sessionManager.list('code').find(s => String(s.id) === String(id)) : null;
              if (session) {
                codeAgent = session.agent;
                await codeAgent.loadFromHistory(conv);
                sessionManager.retag(session, id);
                activateSession('code', session.key);
              } else {
                session = await createCodeSession();
                if (!session) return;
                codeAgent = session.agent;
                await codeAgent.loadFromHistory(conv);
                sessionManager.retag(session, id);
              }
              codeMessages = codeAgent.contextManager.getHistoryMessages().slice();
              await replayCodeSession(session);
              document.querySelector('.nav-item[data-page="code"]')?.click();
            }
          });
        });
        listEl.querySelectorAll('.history-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            // 对齐 Babe 模式：删除 Code 历史记录前二次确认，防止误删
            const titleForConfirm = btn.closest('.history-item')?.querySelector('.history-title')?.textContent?.trim() || '此对话';
            const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
            if (!confirmed) return;
            await window.api.codeDeleteHistory(codeWorkspacePath, btn.dataset.id);
            loadCodeHistoryPage();
          });
        });
      } else {
        listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史</p></div>';
      }
      // 推送历史列表到 WebUI/Remote
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: document.getElementById('page-code-history').innerHTML });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: document.getElementById('page-code-history').innerHTML });
    }
  }

  // ============ Code 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let codeHistoryRawItems = [];
  let codeHistorySearch = null;

  function ensureCodeHistoryListAttached() {
    const listEl = document.getElementById('code-history-list');
    if (!listEl || typeof HistoryList === 'undefined') return false;
    if (!listEl.dataset.hlAttached) {
      listEl.dataset.hlAttached = '1';
      HistoryList.attach(listEl, {
        renderItem: renderCodeHistoryItem,
        onAction: handleCodeHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史</p></div>',
        stride: 78,
        overscan: 8
      });
      codeHistorySearch = (typeof window.makeHistorySearchV2 === 'function') ? window.makeHistorySearchV2({
        key: 'code-history',
        inputId: 'code-history-search-input',
        countId: 'code-history-search-count',
        listId: 'code-history-list',
        searchMode: 'code',
        getWorkspacePath: () => codeWorkspacePath,
        getRawItems: () => codeHistoryRawItems,
        getTitleText: (item) => item.title || '',
        renderItem: renderCodeHistoryItem,
        renderContentItem: renderCodeHistoryContentItem,
        onAction: handleCodeHistoryAction,
        restoreItems: () => HistoryList.setItems(listEl, codeHistoryRawItems)
      }) : null;
    }
    return true;
  }

  function renderCodeHistoryItem(item) {
    const date = new Date(item.ts);
    const timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('code', item) : null;
    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名')} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function renderCodeHistoryContentItem(item) {
    const date = new Date(item.updatedAt || item.ts || Date.now());
    const timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('code', item) : null;
    const snippets = Array.isArray(item.snippets) ? item.snippets.slice(0, 10) : [];
    const snippetsHtml = snippets.map(s => `<div class="history-snippet">${(typeof buildSearchSnippetHtml === 'function') ? buildSearchSnippetHtml(s) : escapeHtml(s.hit || '')}</div>`).join('');
    const moreHtml = (item.snippetTotal && item.snippetTotal > 10)
      ? `<div class="history-snippet-more">还有 ${item.snippetTotal - 10} 处命中</div>`
      : '';
    return `
      <div class="history-item history-item-content" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名')} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
          <div class="history-snippets">${snippetsHtml}${moreHtml}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  async function handleCodeHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;
    if (action === 'continue') {
      stopVoicePlayback();
      const loadRes = await window.api.codeLoadHistory(codeWorkspacePath, id);
      if (loadRes.ok && loadRes.data) {
        codeCurrentHistoryId = id;
        const conv = loadRes.data;
        let session = sessionManager ? sessionManager.list('code').find(s => String(s.id) === String(id)) : null;
        if (session) {
          codeAgent = session.agent;
          await codeAgent.loadFromHistory(conv);
          sessionManager.retag(session, id);
          activateSession('code', session.key);
        } else {
          session = await createCodeSession();
          if (!session) return;
          codeAgent = session.agent;
          await codeAgent.loadFromHistory(conv);
          sessionManager.retag(session, id);
        }
        codeMessages = codeAgent.contextManager.getHistoryMessages().slice();
        await replayCodeSession(session);
        document.querySelector('.nav-item[data-page="code"]')?.click();
      }
    } else if (action === 'delete') {
      const titleForConfirm = item.title || '此对话';
      const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
      if (!confirmed) return;
      await window.api.codeDeleteHistory(codeWorkspacePath, id);
      loadCodeHistoryPage();
    }
  }

  async function loadCodeHistoryPageVirtual() {
    const listEl = document.getElementById('code-history-list');
    if (!listEl) return;
    ensureCodeHistoryListAttached();
    HistoryList.showMessage(listEl, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>');
    try {
      const result = await window.api.codeListHistory(codeWorkspacePath);
      if (result.ok && Array.isArray(result.history)) {
        codeHistoryRawItems = result.history;
      } else {
        codeHistoryRawItems = [];
      }
      if (codeHistorySearch) codeHistorySearch.refresh();
      else HistoryList.setItems(listEl, codeHistoryRawItems);
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-code-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(listEl, `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${escapeHtml(e.message)}</p></div>`);
    }
  }

  // Code mode event handlers
  document.getElementById('btn-code-open-workspace')?.addEventListener('click', async () => {
    const result = await window.api.codeOpenWorkspace();
    if (result.ok && result.path) {
      codeWorkspacePath = result.path;
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = result.path;
      await loadCodeFileTree(result.path);
      // 工作区切换：Code 历史按工作区隔离保存，旧工作区的会话一律停止并关闭，
      // 随后立即创建新工作区的第一个会话标签（与其他模式行为对齐）。
      if (sessionManager) {
        const oldSessions = sessionManager.list('code');
        for (const session of oldSessions) {
          try { sessionManager.close(session); } catch { /* ignore */ }
        }
      }
      // Reset current conversation
      unsubscribeAgentStreams(codeAgent);
      codeAgent = null;
      codeCurrentHistoryId = null;
      codeMessages = [];
      const msgsEl = document.getElementById('code-chat-messages');
      if (msgsEl) {
        msgsEl.innerHTML = '<div class="welcome-message"><div class="welcome-icon"><i class="fa-solid fa-code"></i></div><h2>Code 模式</h2><p>工作区已打开，开始编程任务吧。历史记录按工作区隔离保存。</p></div>';
      }
      await createCodeSession();
    }
  });

  document.getElementById('btn-code-new-chat')?.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    createCodeSession().catch(err => console.error('[code] 新建会话失败:', err));
  });

  // 在系统文件管理器中打开当前工作区（Windows 资源管理器 / macOS Finder）
  // 启动时根据平台动态设置按钮 title（Finder / 资源管理器）
  (function _initCodeExplorerBtnTitle() {
    const btn = document.getElementById('btn-code-open-in-explorer');
    if (btn) {
      const fmName = _fileManagerName();
      btn.title = `在${fmName}中打开工作区`;
    }
  })();
  document.getElementById('btn-code-open-in-explorer')?.addEventListener('click', () => {
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区', '提示', 'warning');
      return;
    }
    window.api.openFileExplorer?.(codeWorkspacePath);
  });

  // ---- 终端可见化：模态框 + Ctrl+T + xterm.js ----
  // 让所有 node-pty 终端可见（默认后台监听，Agent 也在操作）
  // 用户可通过 Ctrl+T 或 Code 工具栏的"显示终端"按钮打开终端模态框
  // 不同 terminalID 以标签页形式显示，用户可操作
  (function initTerminalModal() {
    const modal = document.getElementById('terminal-modal');
    const tabsEl = document.getElementById('terminal-tabs');
    const containerEl = document.getElementById('terminal-container');
    if (!modal || !tabsEl || !containerEl) return;
    if (typeof window.Terminal === 'undefined') {
      console.warn('[Terminal] xterm.js 未加载，跳过初始化');
      return;
    }

    // 终端实例缓存：id -> { term, fit, panel, exited }
    const instances = new Map();
    let activeId = null;
    let dataListenerBound = false;

    // 获取当前主题（强调色 + 深浅色）
    function getXtermTheme() {
      const isDark = document.documentElement.dataset.theme !== 'light';
      const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#6366f1';
      return {
        background: isDark ? '#1e1e2e' : '#ffffff',
        foreground: isDark ? '#cdd6f4' : '#1e1e2e',
        cursor: accent,
        cursorAccent: isDark ? '#1e1e2e' : '#ffffff',
        selectionBackground: accent + '40',
        black: '#1e1e2e',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: isDark ? '#cdd6f4' : '#1e1e2e',
        brightBlack: isDark ? '#585b70' : '#a6adc8',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: isDark ? '#ffffff' : '#000000'
      };
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // 创建 xterm 实例并附加到指定面板
    function createTerminalPanel(id) {
      const panel = document.createElement('div');
      panel.className = 'terminal-panel';
      panel.dataset.terminalId = String(id);
      panel.style.display = 'none';
      containerEl.appendChild(panel);

      const term = new window.Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", Menlo, monospace',
        theme: getXtermTheme(),
        allowProposedApi: true,
        scrollback: 5000
      });

      let fit = null;
      const FitCtor = (window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon)) || null;
      if (FitCtor) {
        try {
          fit = new FitCtor();
          term.loadAddon(fit);
        } catch (e) { console.warn('[Terminal] FitAddon load failed:', e); }
      }

      term.open(panel);

      // 用户输入回写到 pty
      term.onData(data => {
        window.api.writeTerminal?.(id, data).catch(() => {});
      });
      // 调整大小时通知 pty
      term.onResize(({ cols, rows }) => {
        window.api.resizeTerminal?.(id, cols, rows).catch(() => {});
      });

      // 异步加载历史并 fit
      setTimeout(() => {
        if (fit) { try { fit.fit(); } catch {} }
        window.api.getTerminalHistory?.(id).then(result => {
          if (result && result.ok && result.history) {
            try { term.write(result.history); } catch {}
          }
        }).catch(() => {});
      }, 50);

      instances.set(id, { term, fit, panel, exited: false });
      return instances.get(id);
    }

    function createTabElement(meta) {
      const tab = document.createElement('div');
      tab.className = 'terminal-tab';
      tab.dataset.terminalId = String(meta.id);
      const label = meta.lastCommand || `终端 ${meta.id}`;
      const cwdName = meta.cwd ? meta.cwd.split(/[/\\]/).pop() : '';
      tab.innerHTML = `<i class="fa-solid fa-terminal"></i>
        <span class="terminal-tab-label">${escapeHtml(label)}</span>
        ${cwdName ? `<span class="terminal-tab-cwd" title="${escapeHtml(meta.cwd)}">${escapeHtml(cwdName)}</span>` : ''}
        <button class="terminal-tab-close" title="关闭此终端" type="button"><i class="fa-solid fa-xmark"></i></button>`;
      // 点击 tab 本身：切换终端
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.terminal-tab-close')) return; // 关闭按钮单独处理
        switchToTerminal(meta.id);
      });
      // 关闭按钮：杀掉该终端，并阻止冒泡
      const closeBtn = tab.querySelector('.terminal-tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.api.killTerminal(meta.id);
          // onTerminalExit 会触发 refreshTerminalList
        });
      }
      return tab;
    }

    function switchToTerminal(id) {
      activeId = id;
      tabsEl.querySelectorAll('.terminal-tab').forEach(t => {
        t.classList.toggle('active', String(t.dataset.terminalId) === String(id));
      });
      containerEl.querySelectorAll('.terminal-panel').forEach(p => {
        p.style.display = String(p.dataset.terminalId) === String(id) ? 'block' : 'none';
      });
      const inst = instances.get(id);
      if (inst) {
        if (inst.fit) { try { inst.fit.fit(); } catch {} }
        try { inst.term.focus(); } catch {}
      }
    }

    function showEmptyState() {
      let empty = containerEl.querySelector('.terminal-empty');
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'terminal-empty';
        empty.innerHTML = `<i class="fa-solid fa-terminal"></i>
          <p class="terminal-empty-title">暂无终端</p>
          <p class="terminal-empty-hint">点击右上角 <i class="fa-solid fa-plus"></i> 新建终端，或 Agent 调用终端工具时会自动出现</p>`;
        containerEl.appendChild(empty);
      }
      empty.style.display = 'flex';
    }
    function hideEmptyState() {
      const empty = containerEl.querySelector('.terminal-empty');
      if (empty) empty.style.display = 'none';
    }

    async function refreshTerminalList() {
      if (typeof window.api.listTerminals !== 'function') return;
      const result = await window.api.listTerminals();
      if (!result || !result.ok) return;
      const existingTabs = new Set(Array.from(tabsEl.querySelectorAll('.terminal-tab')).map(t => t.dataset.terminalId));
      const currentIds = new Set(result.terminals.map(t => String(t.id)));

      // 添加新终端的 tab + panel
      for (const meta of result.terminals) {
        const sid = String(meta.id);
        if (!existingTabs.has(sid)) {
          tabsEl.appendChild(createTabElement(meta));
          createTerminalPanel(meta.id);
        } else {
          // 更新现有 tab 的标签
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${sid}"]`);
          if (tab) {
            const label = meta.lastCommand || `终端 ${meta.id}`;
            const labelEl = tab.querySelector('.terminal-tab-label');
            if (labelEl) labelEl.textContent = label;
          }
        }
      }

      // 移除已退出的 tab + panel
      for (const existingId of existingTabs) {
        if (!currentIds.has(existingId)) {
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${existingId}"]`);
          if (tab) tab.remove();
          const inst = instances.get(Number(existingId));
          if (inst) {
            try { inst.term.dispose(); } catch {}
            instances.delete(Number(existingId));
          }
          const panel = containerEl.querySelector(`.terminal-panel[data-terminal-id="${existingId}"]`);
          if (panel) panel.remove();
        }
      }

      // 若无激活终端，激活第一个；若激活的已退出，切换到第一个
      if (activeId === null || !currentIds.has(String(activeId))) {
        if (result.terminals.length > 0) {
          switchToTerminal(result.terminals[0].id);
          hideEmptyState();
        } else {
          activeId = null;
          showEmptyState();
        }
      } else {
        hideEmptyState();
      }
    }

    async function openTerminalModal() {
      modal.classList.remove('hidden');
      await refreshTerminalList();
      setTimeout(() => {
        const inst = instances.get(activeId);
        if (inst) {
          if (inst.fit) { try { inst.fit.fit(); } catch {} }
          try { inst.term.focus(); } catch {}
        }
      }, 100);
    }
    function closeTerminalModal() {
      modal.classList.add('hidden');
    }

    document.getElementById('btn-code-show-terminals')?.addEventListener('click', openTerminalModal);
    document.getElementById('btn-chat-show-terminals')?.addEventListener('click', openTerminalModal);
    document.getElementById('btn-close-terminal-modal')?.addEventListener('click', closeTerminalModal);

    document.getElementById('btn-terminal-new')?.addEventListener('click', async () => {
      // 优先使用 Code 模式工作区，其次 Chat 模式工作目录
      let cwd = codeWorkspacePath || null;
      if (!cwd && typeof agent !== 'undefined' && agent && agent.workspacePath) {
        cwd = agent.workspacePath;
      }
      const result = await window.api.makeTerminal(cwd);
      if (result && result.ok) {
        await refreshTerminalList();
        switchToTerminal(result.terminalId);
      } else {
        const msg = '创建终端失败：' + (result?.error || '未知错误');
        if (window.showMessageModal) window.showMessageModal(msg, '错误', 'error');
        else console.error('[Terminal]', msg);
      }
    });

    // 实时数据推送：仅当模态框打开时才写入 xterm（数据已在主进程的 fullHistory 中累积）
    function bindDataListener() {
      if (dataListenerBound) return;
      dataListenerBound = true;
      window.api.onTerminalData?.(({ id, data }) => {
        if (modal.classList.contains('hidden')) return; // 模态框关闭时不渲染（节省性能）
        const inst = instances.get(id);
        if (inst && inst.term) {
          try { inst.term.write(data); } catch {}
        }
      });
      window.api.onTerminalExit?.(({ id }) => {
        const inst = instances.get(id);
        if (inst) {
          inst.exited = true;
          try { inst.term.write('\r\n\x1b[33m[终端已退出]\x1b[0m\r\n'); } catch {}
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${id}"]`);
          if (tab) tab.classList.add('terminal-tab-exited');
        }
        setTimeout(refreshTerminalList, 200);
      });
    }
    bindDataListener();

    // Ctrl+T 快捷键：模态框关闭时打开，已打开时新建终端
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        // 避免与输入框冲突
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        if (modal.classList.contains('hidden')) {
          openTerminalModal();
        } else {
          document.getElementById('btn-terminal-new')?.click();
        }
      }
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeTerminalModal();
      }
    });

    // 主题切换时刷新所有 xterm 实例
    const themeObserver = new MutationObserver(() => {
      if (instances.size === 0) return;
      const theme = getXtermTheme();
      for (const { term } of instances.values()) {
        try { term.options.theme = theme; } catch {}
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // 模态框尺寸变化时触发 fit
    const resizeObserver = new ResizeObserver(() => {
      const inst = instances.get(activeId);
      if (inst && inst.fit) { try { inst.fit.fit(); } catch {} }
    });
    resizeObserver.observe(containerEl);
  })();

  document.getElementById('btn-code-send')?.addEventListener('click', sendCodeMessage);
  document.getElementById('btn-code-stop')?.addEventListener('click', () => {
    stopVoicePlayback();
    const session = sessionManager?.getActive('code');
    if (session) sessionManager.stop(session);
  });
  document.getElementById('code-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCodeMessage();
    }
  });
  document.getElementById('code-chat-input')?.addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });

  // Code 模式面板折叠/恢复逻辑
  function updateCodePanelRestoreBar() {
    const fileTree = document.getElementById('code-file-tree-panel');
    const editor = document.getElementById('code-editor-panel');
    const chat = document.getElementById('code-chat');
    const r1 = document.getElementById('btn-restore-file-tree');
    const r2 = document.getElementById('btn-restore-editor');
    const r3 = document.getElementById('btn-restore-chat');
    const s1 = document.getElementById('code-resizer-1');
    const s2 = document.getElementById('code-resizer-2');
    r1?.classList.toggle('hidden', !fileTree?.classList.contains('collapsed'));
    r2?.classList.toggle('hidden', !editor?.classList.contains('collapsed'));
    r3?.classList.toggle('hidden', !chat?.classList.contains('collapsed'));
    // 隐藏相邻的分割器
    s1?.classList.toggle('hidden', fileTree?.classList.contains('collapsed'));
    s2?.classList.toggle('hidden', editor?.classList.contains('collapsed'));
    // 增量推送：面板折叠状态变更同步到 WebUI（推送相关元素的 class 属性）
    if (fileTree) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-file-tree-panel', attr: 'class', value: fileTree.className });
    if (editor) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-editor-panel', attr: 'class', value: editor.className });
    if (chat) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-chat', attr: 'class', value: chat.className });
    if (r1) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-file-tree', attr: 'class', value: r1.className });
    if (r2) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-editor', attr: 'class', value: r2.className });
    if (r3) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-chat', attr: 'class', value: r3.className });
    if (s1) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-resizer-1', attr: 'class', value: s1.className });
    if (s2) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-resizer-2', attr: 'class', value: s2.className });
  }
  document.getElementById('btn-close-file-tree')?.addEventListener('click', () => {
    document.getElementById('code-file-tree-panel')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-close-editor')?.addEventListener('click', () => {
    document.getElementById('code-editor-panel')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-close-chat')?.addEventListener('click', () => {
    document.getElementById('code-chat')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  // 恢复按钮
  document.getElementById('btn-restore-file-tree')?.addEventListener('click', () => {
    document.getElementById('code-file-tree-panel')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-restore-editor')?.addEventListener('click', () => {
    document.getElementById('code-editor-panel')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-restore-chat')?.addEventListener('click', () => {
    document.getElementById('code-chat')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });

  // ---- 可拖动分割器 ----
  function initCodeResizers() {
    document.querySelectorAll('.code-resizer').forEach(resizer => {
      let dragging = false;
      let startX = 0;
      let p1, p2, p1Width, p2Width, p2Flex = false, p1Flex = false;

      resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        p1 = document.getElementById(resizer.dataset.panel1);
        p2 = document.getElementById(resizer.dataset.panel2);
        if (!p1 || !p2) return;
        p1Width = p1.getBoundingClientRect().width;
        p2Width = p2.getBoundingClientRect().width;
        p1Flex = false;
        p2Flex = false;
        // 如果 p2 是 flex 布局中的弹性项，改为固定宽度
        if (getComputedStyle(p2).flexGrow !== '0') {
          p2Flex = true;
          p2.style.flex = 'none';
          p2.style.width = p2Width + 'px';
        }
        if (getComputedStyle(p1).flexGrow !== '0') {
          p1Flex = true;
          p1.style.flex = 'none';
          p1.style.width = p1Width + 'px';
        }
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging || !p1 || !p2) return;
        const dx = e.clientX - startX;
        let newP1Width = p1Width + dx;
        let newP2Width = p2Width - dx;
        // 限制最小宽度
        const p1Min = parseInt(getComputedStyle(p1).minWidth) || 100;
        const p2Min = parseInt(getComputedStyle(p2).minWidth) || 100;
        const p1Max = parseInt(getComputedStyle(p1).maxWidth) || 9999;
        const p2Max = parseInt(getComputedStyle(p2).maxWidth) || 9999;
        if (newP1Width < p1Min) { newP1Width = p1Min; newP2Width = p1Width + p2Width - p1Min; }
        if (newP2Width < p2Min) { newP2Width = p2Min; newP1Width = p1Width + p2Width - p2Min; }
        if (newP1Width > p1Max) { newP1Width = p1Max; newP2Width = p1Width + p2Width - p1Max; }
        if (newP2Width > p2Max) { newP2Width = p2Max; newP1Width = p1Width + p2Width - p2Max; }
        p1.style.width = newP1Width + 'px';
        p2.style.width = newP2Width + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // 还原原本是弹性项的面板：清除拖拽期间钉死的内联 flex/width，
        // 让布局重新吸收容器剩余宽度，实现窗口拉大/缩小时实时匹配
        if (p1Flex && p1) {
          p1.style.removeProperty('flex');
          p1.style.removeProperty('width');
        }
        if (p2Flex && p2) {
          p2.style.removeProperty('flex');
          p2.style.removeProperty('width');
        }
        p1 = null;
        p2 = null;
        p1Flex = false;
        p2Flex = false;
      });
    });
  }
  initCodeResizers();

  // ---- Code 模式文件选择按钮 ----
  document.getElementById('btn-code-attach-file')?.addEventListener('click', async () => {
    const result = await window.api.openFileDialog({ multiple: true, title: '添加文件到上下文' });
    if (result.ok && result.paths) {
      for (const p of result.paths) {
        const name = p.split(/[\\/]/).pop();
        await addFileToCodeContext({ path: p, name: name, type: 'file' });
      }
    }
  });

  // WebUI 上传文件后通知 Code 模式刷新附件（与 Chat 模式的 onWebControlFileUploaded 对齐）
  if (typeof window.api?.onWebControlFileUploaded === 'function') {
    window.api.onWebControlFileUploaded(async (data) => {
      if (data && data.path && document.getElementById('page-code')?.classList.contains('active')) {
        await addFileToCodeContext({ path: data.path, name: data.name, type: 'file' });
      }
    });
  }

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

  // ==================== Babe Mode (恋爱模式) ====================
  let babeAgent = null;
  let babeMessages = [];
  let babeCurrentHistoryId = null;
  let babeStreamBubble = null;
  let babeProactiveTimer = null;
  // 主动消息追踪：标记当前是否为主动消息回合，以及是否已产生内容
  let babeProactiveActive = false;
  let babeProactiveProduced = false;

  // 初始化 Babe Agent
  function wireBabeAgent(ag) {
    if (!ag) return;
    const isActive = () => {
      const session = sessionManager?.getByAgent(ag);
      return !session || session.active;
    };

    ag.onTitleChange = (title) => {
      if (isActive()) setTitlebarTitle(title);
      if (isActive()) window.api.webControlPushTitle(title);
    };

    ag.onMessage = (type, data) => {
      const msgsEl = document.getElementById('babe-chat-messages');
      if (!msgsEl) return;
      if (!isActive()) {
        if (type === 'approval' && typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
        else if (type === 'present-file' && sessionManager) {
          const session = sessionManager.getByAgent(ag);
          if (session) sessionManager.bufferUiEvent(session, { type: 'present-file', data });
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
        }
        return;
      }
      switch (type) {
        case 'assistant':
          addBabeMessage('assistant', data);
          if (babeProactiveActive) babeProactiveProduced = true;
          break;
        case 'system':
          addBabeMessage('system', data);
          break;
        case 'stream-chunk': {
          const bubble = babeStreamBubble;
          if (!bubble) return;
          if (data.content) {
            const cleanContent = data.content.replace(/【好感度[+-]?\d+】/g, '');
            const dedup = dedupAppendChunk(bubble.rawContent, bubble._lastChunk, cleanContent);
            bubble.rawContent = dedup.raw;
            bubble._lastChunk = dedup.lastChunk;
            bubble.contentStarted = true;
            bubble.contentEl.innerHTML = renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor">▋</span>';
            if (bubble.rawReasoning) bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning);
          }
          if (data.reasoning) {
            bubble.rawReasoning += data.reasoning;
            bubble.reasoningSection.style.display = 'block';
            const rCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor">▋</span>';
            bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning) + rCursor;
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          msgsEl.scrollTop = msgsEl.scrollHeight;
          if (!bubble.renderTimer) {
            bubble.renderTimer = setTimeout(() => {
              bubble.renderTimer = null;
              if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
            }, 120);
          }
          break;
        }
        case 'stream-end': {
          const isAuthoritativeFinal = !!(data && typeof data === 'object' && data.content !== undefined);
          const bubble = babeStreamBubble;
          if (!bubble) {
            if (isAuthoritativeFinal && data.requestId) {
              const target = msgsEl.querySelector(`[data-stream-request="${cssEscape(data.requestId)}"]`);
              if (target) {
                const body = target.querySelector('.babe-msg-content, .babe-msg-body, .message-content');
                const clean = String(data.content || '').replace(/【好感度[+-]?\d+】/g, '').trimEnd();
                if (body && clean) body.innerHTML = renderMarkdown(clean);
              }
            }
            babeStreamBubble = null;
            return;
          }
          if (!isAuthoritativeFinal) return;
          if (bubble.renderTimer) { clearTimeout(bubble.renderTimer); bubble.renderTimer = null; }
          const hasReasoning = !!(data.reasoning || bubble.rawReasoning);
          const finalContent = (data.content || bubble.rawContent).replace(/【好感度[+-]?\d+】/g, '').trimEnd();
          bubble.rawContent = finalContent;
          const hasContent = !!(finalContent && finalContent.trim());
          if (babeProactiveActive && hasContent) babeProactiveProduced = true;
          if (hasReasoning) {
            bubble.reasoningSection.classList.add('collapsed');
            bubble.reasoningSection.style.display = 'block';
            bubble.reasoningEl.innerHTML = renderMarkdown(data.reasoning || bubble.rawReasoning);
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          if (hasContent) {
            bubble.contentEl.innerHTML = renderMarkdown(finalContent);
          } else if (hasReasoning) {
            bubble.contentEl.style.display = 'none';
            const timeEl = bubble.el.querySelector('.babe-msg-time');
            if (timeEl) timeEl.style.display = 'none';
          } else {
            bubble.el.remove();
            if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + bubble.el.id });
            babeStreamBubble = null;
            break;
          }
          bubble.el.classList.remove('streaming');
          if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          babeStreamBubble = null;
          break;
        }
        case 'stream-start':
          babeStreamBubble = createBabeStreamBubble();
          if (babeStreamBubble?.el && data?.requestId) {
            babeStreamBubble.el.setAttribute('data-stream-request', String(data.requestId));
          }
          break;
        case 'tool_call':
          addBabeToolCall(data);
          break;
        case 'tool-result':
          addBabeToolResult(data);
          break;
        case 'present-file':
          addFilePresentCard(data);
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
          break;
        case 'affection-change':
          showBabeAffectionChange(data.delta, data.value);
          updateBabeAffection(data.value);
          break;
        case 'error':
          addBabeMessage('system', '错误: ' + (typeof data === 'string' ? data : (data?.error || JSON.stringify(data))));
          break;
      }
    };

    ag.onStatusChange = (status) => {
      if (!isActive()) {
        if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
        return;
      }
      const sendBtn = document.getElementById('btn-babe-send');
      const stopBtn = document.getElementById('btn-babe-stop');
      if (status === 'working') {
        sendBtn?.classList.add('hidden');
        stopBtn?.classList.remove('hidden');
      } else {
        sendBtn?.classList.remove('hidden');
        if (stopBtn) stopBtn.classList.toggle('hidden', !voiceSpeakingNow());
      }
      if (sendBtn) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-babe-send', attr: 'class', value: sendBtn.className });
      if (stopBtn) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-babe-stop', attr: 'class', value: stopBtn.className });
    };
  }

  async function initBabeAgent() {
    if (babeAgent) {
      // 已初始化，仅更新显示
      updateBabeAffection(babeAgent.babeAffection);
      updateBabePersonaDisplay();
      return true;
    }
    try {
      babeAgent = new Agent();
      babeAgent.mode = 'babe';
      babeAgent.settings = await window.api.getSettings();
      if (!babeAgent.settings.tools || typeof babeAgent.settings.tools !== 'object') {
        babeAgent.settings.tools = {};
      }
      babeAgent.systemInfo = await window.api.getFullSystemInfo();
      const maxCtx = babeAgent.settings.llm?.maxContextLength || 131072;
      babeAgent.contextManager = new ContextManager(maxCtx);
      babeAgent.contextManager.setMaxTokens(maxCtx);
      babeAgent.contextManager.setOutputReserve(babeAgent.settings.llm?.maxResponseTokens || 8192);
      babeAgent.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      // 初始好感度
      babeAgent.babeAffection = babeAgent.settings.babe?.initialAffection ?? 30;
      await babeAgent.refreshSkillsCatalog();
      babeAgent.contextManager.setSystemPrompt(babeAgent.getSystemPrompt());
      setupAgentStreamSubscriptions(babeAgent, 'babe');
      wireBabeAgent(babeAgent);
      updateBabeAffection(babeAgent.babeAffection);
      updateBabePersonaDisplay();
      // 启动主动消息定时器
      restartBabeProactiveTimer();
      if (sessionManager) {
        const babeSession = sessionManager.registerAgent('babe', babeAgent, {
          title: babeAgent.conversationTitle || '未命名 Babe 会话'
        });
        sessionManager.activate('babe', babeSession.key);
      }
      return true;
    } catch (e) {
      console.error('[Babe] initBabeAgent failed:', e);
      addBabeMessage('system', '初始化 Babe 模式失败: ' + e.message);
      return false;
    }
  }

  async function createBabeSession() {
    const ag = new Agent();
    ag.mode = 'babe';
    ag.settings = await window.api.getSettings();
    if (!ag.settings.tools || typeof ag.settings.tools !== 'object') ag.settings.tools = {};
    ag.systemInfo = await window.api.getFullSystemInfo();
    const maxCtx = ag.settings.llm?.maxContextLength || 131072;
    ag.contextManager = new ContextManager(maxCtx);
    ag.contextManager.setMaxTokens(maxCtx);
    ag.contextManager.setOutputReserve(ag.settings.llm?.maxResponseTokens || 8192);
    ag.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    ag.babeAffection = ag.settings.babe?.initialAffection ?? 30;
    await ag.refreshSkillsCatalog();
    ag.contextManager.setSystemPrompt(ag.getSystemPrompt());
    wireBabeAgent(ag);
    setupAgentStreamSubscriptions(ag, 'babe');
    if (!sessionManager) return null;
    const session = sessionManager.registerAgent('babe', ag, { title: '未命名 Babe 会话' });
    activateSession('babe', session.key);
    return session;
  }

  async function replayBabeSession(session) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl || !session?.agent) return;
    babeStreamBubble = null;
    msgsEl.innerHTML = '';
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#babe-chat-messages' });
    const messages = session.agent.contextManager?.getHistoryMessages() || [];
    if (messages.length === 0) {
      msgsEl.innerHTML = `<div class="babe-welcome"><div class="babe-welcome-icon"><i class="fa-solid fa-heart"></i></div><h2>新的开始</h2><p>开始一段新的对话吧~</p></div>`;
      updateBabeAffection(session.agent.babeAffection);
      return;
    }
    const total = messages.length;
    const chunkSize = 30;
    const toolCallMap = {};
    showHistoryProgress(total);
    try {
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const m = messages[i];
          if (m.role === 'user') {
            addBabeMessage('user', extractTextContent(m.content) || '[多模态内容]');
          } else if (m.role === 'assistant') {
            const textContent = extractTextContent(m.content);
            if (textContent) addBabeMessage('assistant', textContent);
            if (m.tool_calls && m.tool_calls.length > 0) {
              for (const tc of m.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                const card = addBabeToolCall({ name: displayName, args, callId: tc.id });
                if (tc.id && card) toolCallMap[tc.id] = { card, name: toolName };
              }
            }
          } else if (m.role === 'tool') {
            const key = m.tool_call_id;
            const entry = key ? toolCallMap[key] : null;
            let result = m.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
            if (entry) {
              const statusEl = entry.card.querySelector('.tool-call-status');
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              const ok = (result && typeof result === 'object') ? result.ok !== false : true;
              if (statusEl) {
                statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败')
                  (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
              }
            } else {
              addBabeMessage('system', `[工具结果] ${m.name || 'tool'}: ${String(result).slice(0, 200)}`);
            }
          } else if (m.role === 'system') {
            addBabeMessage('system', typeof m.content === 'string' ? m.content : String(m.content || ''));
          }
        }
        updateHistoryProgress(end, total, end >= total ? '渲染完成，正在收尾…' : `已渲染 ${end}/${total} 条消息`);
        await yieldHistoryUI();
      }
    } finally {
      hideHistoryProgress();
    }
    requestAnimationFrame(() => {
      msgsEl.scrollTop = msgsEl.scrollHeight;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#babe-chat-messages', html: msgsEl.innerHTML });
    });
    updateBabeAffection(session.agent.babeAffection);
  }

  function createBabeStreamBubble() {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return null;
    const welcome = msgsEl.querySelector('.babe-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'babe-message assistant streaming';
    msg.id = 'babe-stream-' + Date.now();
    // Babe 流式气泡头像：使用 Babe 头像（含头像框）
    const babeAvatar = babeAgent?.settings?.babe?.avatar || '';
    const avatarHTML = makeBabeFramedAvatarHTML(babeAvatar, 'babe');
    msg.innerHTML = `
      <div class="babe-msg-avatar">${avatarHTML}</div>
      <div class="babe-msg-body">
        <div class="reasoning-section" style="display:none;">
          <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <i class="fa-solid fa-brain"></i><span>TA 的心声</span>
            <i class="fa-solid fa-chevron-down reasoning-toggle-icon"></i>
          </div>
          <div class="reasoning-content markdown-body"></div>
        </div>
        <div class="babe-msg-bubble markdown-body"></div>
        <div class="babe-msg-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：Babe 流式气泡创建后追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: msg.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return {
      el: msg,
      contentEl: msg.querySelector('.babe-msg-bubble'),
      reasoningEl: msg.querySelector('.reasoning-content'),
      reasoningSection: msg.querySelector('.reasoning-section'),
      rawContent: '',
      rawReasoning: '',
      contentStarted: false,
      renderTimer: null // 用于流式 chunk 推送节流
    };
  }

  function addBabeMessage(role, content) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    const welcome = msgsEl.querySelector('.babe-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'babe-message ' + role;
    const rendered = (role === 'assistant' || role === 'system') ? renderMarkdown(content) : escapeHtml(content);
    // 懒渲染用：保留原始内容与角色，离屏折叠后滚回时重新渲染
    msg.dataset.lazyRaw = content;
    msg.dataset.lazyRole = (role === 'assistant' || role === 'system') ? 'md' : 'text';
    // 头像：assistant 用 Babe 头像（含头像框），user 用用户头像（含头像框），system 用图标
    let avatarHTML;
    if (role === 'assistant') {
      const babeAvatar = babeAgent?.settings?.babe?.avatar || '';
      avatarHTML = makeBabeFramedAvatarHTML(babeAvatar, 'babe');
    } else if (role === 'user') {
      const userAvatar = babeAgent?.settings?.userProfile?.avatar || '';
      avatarHTML = makeBabeFramedAvatarHTML(userAvatar, 'user');
    } else {
      avatarHTML = '<i class="fa-solid fa-info-circle"></i>';
    }
    msg.innerHTML = `
      <div class="babe-msg-avatar">${avatarHTML}</div>
      <div class="babe-msg-body">
        <div class="babe-msg-bubble markdown-body">${rendered}</div>
        <div class="babe-msg-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：Babe 消息追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: msg.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    babeMessages.push({ role, content });
  }

  function addBabeToolCall(data) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'tool-call-card';
    div.id = 'babe-tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    if (data.callId) div.dataset.callId = data.callId;
    const argsStr = data.args ? JSON.stringify(data.args, null, 2).slice(0, 500) : '';
    div.innerHTML = `<div class="tool-call-header"><i class="fa-solid fa-wrench"></i> <span>${escapeHtml(data.name || 'tool')}</span></div>` +
      (argsStr ? `<pre class="tool-call-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="tool-call-status"><i class="fa-solid fa-spinner fa-spin"></i> 执行中...</div>`;
    msgsEl.appendChild(div);
    // 增量推送：Babe 工具调用卡片追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: div.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function addBabeToolResult(data) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    let targetCard = null;
    if (data.callId) {
      targetCard = msgsEl.querySelector(`.tool-call-card[data-call-id="${cssEscape(data.callId)}"]`);
    }
    if (!targetCard) {
      const cards = msgsEl.querySelectorAll('.tool-call-card');
      for (let i = cards.length - 1; i >= 0; i--) {
        const statusEl = cards[i].querySelector('.tool-call-status');
        if (statusEl && statusEl.innerHTML.includes('fa-spin')) { targetCard = cards[i]; break; }
      }
      if (!targetCard) targetCard = cards[cards.length - 1];
    }
    if (!targetCard) return;
    const statusEl = targetCard.querySelector('.tool-call-status');
    if (!statusEl) return;
    const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const ok = data.result?.ok !== false;
    statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败') +
      (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
    // 增量推送：更新 Babe 工具调用卡片结果到 WebUI
    if (targetCard.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + targetCard.id, html: targetCard.outerHTML });
    }
  }

  // 更新好感度显示
  function updateBabeAffection(value) {
    const v = Math.max(0, Math.min(100, value || 0));
    const valueEl = document.getElementById('babe-affection-value');
    const fillEl = document.getElementById('babe-affection-fill');
    if (valueEl) valueEl.textContent = v;
    if (fillEl) fillEl.style.width = v + '%';
    // 增量推送：好感度数值与进度条更新同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#babe-affection-value', text: String(v) });
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#babe-affection-fill', attr: 'style', value: 'width: ' + v + '%' });
  }

  // 显示好感度变化提示
  function showBabeAffectionChange(delta, newValue) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'babe-affection-change ' + (delta > 0 ? 'up' : 'down');
    div.id = 'babe-aff-change-' + Date.now();
    const icon = delta > 0 ? 'fa-heart' : 'fa-heart-crack';
    const sign = delta > 0 ? '+' : '';
    div.innerHTML = `<i class="fa-solid ${icon}"></i> 好感度 ${sign}${delta} → ${newValue}`;
    msgsEl.appendChild(div);
    // 增量推送：好感度变化提示追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: div.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    // 2秒后淡出
    setTimeout(() => { div.style.opacity = '0'; if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + div.id, attr: 'style', value: div.getAttribute('style') || '' }); }, 2000);
    setTimeout(() => { div.remove(); if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id }); }, 3000);
  }

  // 更新 Babe persona 显示（姓名、头像、头像框）
  // babeOverride: 可选，传入最新的 babe 设置对象（用于尚未初始化 babeAgent 时）
  function updateBabePersonaDisplay(babeOverride) {
    const babe = babeOverride || babeAgent?.settings?.babe;
    if (!babe) return;
    const nameEl = document.getElementById('babe-name-display');
    if (nameEl) nameEl.textContent = babe.name || 'Babe';
    // 增量推送：Babe 名称更新同步到 WebUI
    if (nameEl) WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#babe-name-display', text: babe.name || 'Babe' });
    // Hero 头像（含头像框叠加层）
    const avatarEl = document.getElementById('babe-avatar');
    if (avatarEl) {
      const frameId = _avatarFrameState.babe;
      const hasFrame = !!(frameId && _avatarFrameCache[frameId]);
      // 有头像框时不设置 inline 尺寸，让 CSS .has-frame > img 控制
      const avatarSize = hasFrame
        ? 'border-radius:50%;object-fit:cover'
        : 'width:100%;height:100%;border-radius:50%;object-fit:cover';
      // 使用 makeAvatarHTML（直接子元素 img/i），与 AI Hero 头像结构一致
      // Babe 无头像时使用心形图标作为默认
      let inner;
      if (babe.avatar) {
        inner = makeAvatarHTML(babe.avatar, true, avatarSize);
      } else {
        inner = '<i class="fa-solid fa-heart" style="' + avatarSize + '"></i>';
      }
      avatarEl.innerHTML = inner;
      if (hasFrame) {
        avatarEl.classList.add('has-frame');
        avatarEl.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
      } else {
        avatarEl.classList.remove('has-frame');
      }
      // 增量推送：Babe Hero 头像更新同步到 WebUI
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#babe-avatar', html: avatarEl.innerHTML, attr: 'class', value: avatarEl.className });
    }
  }

  // ---- Babe 模式附件功能（与 Chat 模式独立，避免冲突）----
  let babeAttachments = [];
  const babeAttachmentsPreview = document.getElementById('babe-attachments-preview');

  function renderBabeAttachments() {
    if (!babeAttachmentsPreview) return;
    if (babeAttachments.length === 0) {
      babeAttachmentsPreview.classList.add('hidden');
      babeAttachmentsPreview.innerHTML = '';
      return;
    }
    babeAttachmentsPreview.classList.remove('hidden');
    babeAttachmentsPreview.innerHTML = babeAttachments.map((att, i) => `
      <div class="attachment-item">
        <i class="fa-solid ${att.isImage ? 'fa-image' : 'fa-file'}"></i>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="btn-icon attachment-remove" data-index="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `).join('');
    babeAttachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        babeAttachments.splice(parseInt(btn.dataset.index), 1);
        renderBabeAttachments();
      });
    });
  }

  async function copyBabeAttachmentsToWorkspace(attachments) {
    const workspacePath = babeAgent?.workspacePath;
    if (!workspacePath || !attachments || attachments.length === 0) return;
    const normalizePath = (p) => (p || '').replace(/\//g, '\\');
    const normalizedWorkspace = normalizePath(workspacePath);
    await window.api.makeDirectory(normalizedWorkspace);
    const pending = attachments.map(att => att.pendingSave).filter(Boolean);
    if (pending.length > 0) await Promise.all(pending);
    for (const att of attachments) {
      if (!att.path) continue;
      const normalizedPath = normalizePath(att.path);
      if (normalizedPath.startsWith(normalizedWorkspace + '\\')) continue;
      const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const destPath = `${normalizedWorkspace}\\${safeName}`;
      const copyResult = await window.api.copyFile(att.path, destPath);
      if (copyResult.ok) { att.originalPath = att.path; att.path = destPath; }
    }
  }

  // Babe 附件按钮
  document.getElementById('btn-babe-attach-file')?.addEventListener('click', async () => {
    const result = await window.api.openFileDialog({ multiple: true });
    if (result.ok && result.paths) {
      for (const p of result.paths) {
        const name = p.split(/[\\/]/).pop();
        const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name);
        babeAttachments.push({ name, path: p, isImage });
      }
      renderBabeAttachments();
    }
  });

  // Babe 输入框粘贴图片
  document.getElementById('babe-chat-input')?.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const name = `paste-${Date.now()}.png`;
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.api.saveUploadedFile(name, arrayBuffer);
          if (result.ok) {
            babeAttachments.push({ name, path: result.path, isImage: true });
            renderBabeAttachments();
          }
        }
      }
    }
  });

  // 发送 Babe 消息
  async function sendBabeMessage() {
    const input = document.getElementById('babe-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text && babeAttachments.length === 0) return;
    if (!babeAgent) {
      const ok = await initBabeAgent();
      if (!ok) return;
    }
    if (babeAgent.running) {
      window.showMessageModal('TA 还在回复中，请稍等...', '提示', 'warning');
      return;
    }
    if (!babeAgent.settings?.llm?.apiUrl) {
      window.showMessageModal('请先在设置中配置 LLM API', '提示', 'warning');
      return;
    }
    const babeSession = sessionManager?.getByAgent(babeAgent);
    if (babeSession && !babeAgent.running && !sessionManager.requestStart(babeSession)) {
      const queued = babeAttachments.map(att => ({
        name: att.name,
        path: att.path,
        isImage: att.isImage
      }));
      addBabeMessage('user', text);
      input.value = '';
      babeAttachments = [];
      renderBabeAttachments();
      sessionManager.queue(babeSession, { text, attachments: queued });
      addBabeMessage('system', '当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。');
      return;
    }
    // 复制附件到工作区并处理（OCR/文本提取）
    const attachments = [...babeAttachments];
    babeAttachments = [];
    renderBabeAttachments();
    await copyBabeAttachmentsToWorkspace(attachments);
    for (const att of attachments) {
      if (att.isImage && att.path) {
        try {
          const ocrResult = await window.api.ocrRecognize(att.path);
          if (ocrResult.ok && ocrResult.text) att.ocrText = ocrResult.text;
        } catch (e) { console.error('OCR error:', e); }
      } else if (att.path) {
        const ext = att.name.split('.').pop().toLowerCase();
        const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
        if (officeFormats.includes(ext)) {
          try {
            const importResult = await window.api.knowledgeImportFile(att.path, babeAgent.workspacePath);
            if (importResult.ok && importResult.content) att.extractedText = importResult.content;
          } catch (e) { console.error('Document extraction error:', e); }
        }
      }
    }
    // 显示用户消息（含附件标记）
    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += `\n[附件: ${names}]`;
    }
    addBabeMessage('user', displayText);
    input.value = '';
    input.style.height = 'auto';
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#babe-chat-input', value: '' });
    // 发送给 Agent（带附件，复用 Agent.sendMessage 的多模态注入逻辑）
    try {
      await babeAgent.sendMessage(text, attachments);
    } catch (e) {
      addBabeMessage('system', '发送失败: ' + e.message);
    }
  }

  // Babe 历史页面
  async function loadBabeHistoryPage() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl) return;
    if (typeof HistoryList !== 'undefined') {
      await loadBabeHistoryPageVirtual();
      return;
    }
    try {
      const items = await window.api.babeHistoryList();
      if (!items || items.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-heart"></i><p>暂无 Babe 历史</p><p class="setting-hint">在 Babe 模式中开始对话后会自动保存</p></div>`;
        return;
      }
      // 对齐 Chat 模式结构：history-info(标题+时间) / history-actions(按钮组)
      listEl.innerHTML = items.map(item => {
        const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
        const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
        const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
        const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
        return `
        <div class="history-item" data-id="${item.id}">
          <div class="history-info">
            <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
            <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
          </div>
          <div class="history-actions">
            <button class="btn-icon history-continue" data-id="${item.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
            <button class="btn-icon history-delete" data-id="${item.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
      }).join('');
      // 绑定按钮（复用 Chat 模式的 class，但 Babe 历史需要走 Babe API）
      listEl.querySelectorAll('.history-continue').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          stopVoicePlayback(); // 切换会话前清空语音播放队列
          const id = btn.dataset.id;
          const existing = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
          if (existing) {
            babeAgent = existing.agent;
            const conversation = await window.api.babeHistoryGet(id);
            if (conversation) {
              babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
              await babeAgent.loadFromHistory(conversation);
              sessionManager.retag(existing, id);
            }
            activateSession('babe', existing.key);
          } else {
            await loadBabeConversation(id);
          }
        });
      });
      listEl.querySelectorAll('.history-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (!await window.confirmDialog('确定删除这段和 TA 的回忆吗？', '删除确认')) return;
          const result = await window.api.babeHistoryDelete(id);
          if (result.ok) loadBabeHistoryPage();
        });
      });
      // 推送历史列表到 WebUI/Remote
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: document.getElementById('page-babe-history').innerHTML });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message)}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: document.getElementById('page-babe-history').innerHTML });
    }
  }

  // ============ Babe 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let babeHistoryRawItems = [];
  let babeHistorySearch = null;

  function ensureBabeHistoryListAttached() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl || typeof HistoryList === 'undefined') return false;
    if (!listEl.dataset.hlAttached) {
      listEl.dataset.hlAttached = '1';
      HistoryList.attach(listEl, {
        renderItem: renderBabeHistoryItem,
        onAction: handleBabeHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-heart"></i><p>暂无 Babe 历史</p><p class="setting-hint">在 Babe 模式中开始对话后会自动保存</p></div>',
        stride: 78,
        overscan: 8
      });
      babeHistorySearch = (typeof window.makeHistorySearchV2 === 'function') ? window.makeHistorySearchV2({
        key: 'babe-history',
        inputId: 'babe-history-search-input',
        countId: 'babe-history-search-count',
        listId: 'babe-history-list',
        searchMode: 'babe',
        getRawItems: () => babeHistoryRawItems,
        getTitleText: (item) => item.title || '',
        renderItem: renderBabeHistoryItem,
        renderContentItem: renderBabeHistoryContentItem,
        onAction: handleBabeHistoryAction,
        restoreItems: () => HistoryList.setItems(listEl, babeHistoryRawItems)
      }) : null;
    }
    return true;
  }

  function renderBabeHistoryItem(item) {
    const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
    const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
    const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function renderBabeHistoryContentItem(item) {
    const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
    const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
    const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
    const snippets = Array.isArray(item.snippets) ? item.snippets.slice(0, 10) : [];
    const snippetsHtml = snippets.map(s => `<div class="history-snippet">${(typeof buildSearchSnippetHtml === 'function') ? buildSearchSnippetHtml(s) : escapeHtml(s.hit || '')}</div>`).join('');
    const moreHtml = (item.snippetTotal && item.snippetTotal > 10)
      ? `<div class="history-snippet-more">还有 ${item.snippetTotal - 10} 处命中</div>`
      : '';
    return `
      <div class="history-item history-item-content" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
          <div class="history-snippets">${snippetsHtml}${moreHtml}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  async function handleBabeHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;
    if (action === 'continue') {
      stopVoicePlayback();
      const existing = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
      if (existing) {
        babeAgent = existing.agent;
        const conversation = await window.api.babeHistoryGet(id);
        if (conversation) {
          babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
          await babeAgent.loadFromHistory(conversation);
          sessionManager.retag(existing, id);
        }
        activateSession('babe', existing.key);
      } else {
        await loadBabeConversation(id);
      }
    } else if (action === 'delete') {
      if (!await window.confirmDialog('确定删除这段和 TA 的回忆吗？', '删除确认')) return;
      const result = await window.api.babeHistoryDelete(id);
      if (result.ok) loadBabeHistoryPage();
    }
  }

  async function loadBabeHistoryPageVirtual() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl) return;
    ensureBabeHistoryListAttached();
    HistoryList.showMessage(listEl, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>');
    try {
      const items = await window.api.babeHistoryList();
      babeHistoryRawItems = Array.isArray(items) ? items : [];
      if (babeHistorySearch) babeHistorySearch.refresh();
      else HistoryList.setItems(listEl, babeHistoryRawItems);
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-babe-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(listEl, `<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message)}</p></div>`);
    }
  }

  // 加载 Babe 历史
  async function loadBabeConversation(id) {
    const conversation = await window.api.babeHistoryGet(id);
    if (!conversation) {
      window.showMessageModal('找不到该对话', '错误', 'error');
      return;
    }
    let session = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
    if (!session) {
      session = await createBabeSession();
      if (!session) return;
    }
    babeAgent = session.agent;
    babeCurrentHistoryId = id;
    babeMessages = conversation.messages || [];
    babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
    await babeAgent.loadFromHistory(conversation);
    sessionManager.retag(session, id);
    activateSession('babe', session.key);
    await replayBabeSession(session);
    updateBabeAffection(babeAgent.babeAffection);
    // 切换到 Babe 页面
    document.querySelector('.nav-item[data-page="babe"]')?.click();
  }

  // 主动消息定时器
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

  // ---- Babe Mode 事件绑定 ----
  document.getElementById('btn-babe-send')?.addEventListener('click', sendBabeMessage);
  document.getElementById('btn-babe-stop')?.addEventListener('click', () => {
    stopVoicePlayback();
    const session = sessionManager?.getActive('babe');
    if (session) sessionManager.stop(session);
  });
  document.getElementById('btn-babe-new')?.addEventListener('click', async () => {
    stopVoicePlayback(); // 清空语音播放队列
    await createBabeSession();
  });
  document.getElementById('btn-babe-proactive')?.addEventListener('click', () => {
    if (!babeAgent) {
      window.showMessageModal('请先初始化 Babe 模式', '提示', 'warning');
      return;
    }
    babeProactiveMessage();
  });
  document.getElementById('babe-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBabeMessage();
    }
  });
  document.getElementById('babe-chat-input')?.addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });

  /* ==================== 屏幕软键盘 (OSK) ==================== */
  function getOskCore() {
    return window.OskCoreInstance || null;
  }
  function toggleOsk() {
    const osk = getOskCore();
    if (!osk) return;
    if (osk.visible) osk.hide();
    else { osk._ensureDict().catch(() => {}); osk.show(); }
    syncOskBtn();
  }

  function syncOskBtn() {
    const osk = getOskCore();
    const btn = document.getElementById('osk-toggle-btn');
    if (btn && osk) {
      btn.classList.toggle('active', osk.visible);
      btn.setAttribute('data-active', osk.visible ? '1' : '0');
    }
  }

  // 标题栏按钮
  const oskToggleBtn = document.getElementById('osk-toggle-btn');
  if (oskToggleBtn) {
    oskToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOsk();
    });
  }

  // 快捷键 F8
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F8') {
      e.preventDefault();
      toggleOsk();
    }
  });

  // WebUI → 切换屏幕软键盘
  if (typeof window.api?.onWebControlToggleOsk === 'function') {
    window.api.onWebControlToggleOsk(() => { toggleOsk(); syncOskBtn(); });
  }

  // OSK 状态变化 → 同步标题栏按钮 + WebUI
  function oskStateObserver() {
    const osk = getOskCore();
    if (!osk) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(oskStateObserver, 50));
      } else {
        setTimeout(oskStateObserver, 100);
      }
      return;
    }
    const origPush = osk._pushWebState.bind(osk);
    osk._pushWebState = () => {
      syncOskBtn();
      origPush();
    };
  }
  oskStateObserver();

  // 设置变化 → 同步到 OSK（含子页面 settings:changed 广播）
  if (typeof window.api?.onSettingsChanged === 'function') {
    window.api.onSettingsChanged((s) => {
      if (s && s.ime && getOskCore()) getOskCore().applySettings(s.ime);
      // 托盘语音唤醒开关 → 设置页勾选状态联动回显
      if (s && s.voice && typeof s.voice.wakeEnabled === 'boolean') {
        const wakeEl = document.getElementById('setting-voice-wake');
        if (wakeEl && wakeEl.checked !== s.voice.wakeEnabled) wakeEl.checked = s.voice.wakeEnabled;
      }
    });
  }

  /* ==================== 设置页：输入法标签 ==================== */
  async function loadImeSettings() {
    const s = await window.api.getSettings();
    const ime = s.ime || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    set('setting-ime-mode', ime.mode || 'zh');
    set('setting-ime-candidate-count', ime.candidateCount ?? 9);
    setChk('setting-ime-enabled', ime.enabled);
    const opEl = document.getElementById('setting-ime-opacity');
    const opVal = document.getElementById('setting-ime-opacity-val');
    const opPct = Math.round((ime.opacity ?? 1) * 100);
    if (opEl) { opEl.value = Math.max(30, Math.min(100, opPct)); if (opVal) opVal.textContent = opEl.value + '%'; }
  }

  function bindImeSettings() {
    const els = {
      'setting-ime-mode': (v) => ({ mode: v }),
      'setting-ime-candidate-count': (v) => ({ candidateCount: parseInt(v) || 9 }),
      'setting-ime-enabled': (v) => ({ enabled: !!v }),
      'setting-ime-opacity': (v) => ({ opacity: (parseInt(v) || 100) / 100 }),
    };
    Object.keys(els).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const build = els[id];
      const handler = async (e) => {
        let val = e.target.value;
        if (e.target.type === 'checkbox') val = e.target.checked;
        const s = await window.api.getSettings();
        s.ime = Object.assign({}, s.ime || {}, build(val));
        await saveSettings(s);
        if (getOskCore()) getOskCore().applySettings(s.ime);
        if (id === 'setting-ime-enabled') {
          const osk = getOskCore();
          if (val && osk) { osk._ensureDict().catch(() => {}); osk.show(); }
          if (!val && osk) osk.hide();
        }
        window.showToast?.('输入法设置已保存', 'success', 2000);
      };
      el.addEventListener('change', handler);
      if (el.type === 'range') {
        el.addEventListener('input', () => {
          const valId = id + '-val';
          const valEl = document.getElementById(valId);
          if (valEl) valEl.textContent = (id === 'setting-ime-opacity') ? el.value + '%' : el.value + 'px';
        });
      }
    });
  }

  // 挂载到 loadSettingsPage：每次打开设置页时刷新输入法设置
  bindImeSettings();
  loadImeSettings();

  /* ==================== 设置页：语音标签 ==================== */
  async function loadVoiceSettings() {
    const s = await window.api.getSettings();
    const v = s.voice || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    setChk('setting-voice-stt', v.sttEnabled !== false);
    set('setting-voice-stt-model', (v.sttModel === 'tiny' ? 'tiny' : 'base'));
    set('setting-voice-stt-send-keywords', (v.sttSendKeywords || []).join('、'));
    setChk('setting-voice-tts', v.ttsEnabled === true);
    setChk('setting-voice-tts-auto', v.ttsAutoSpeak === true);
    set('setting-voice-tts-lang', v.ttsLang || 'auto');
    set('setting-voice-zh', (v.ttsVoices && v.ttsVoices.zh) || 'zf_xiaoxiao');
    set('setting-voice-en', (v.ttsVoices && v.ttsVoices.en) || 'af_heart');
    const speedEl = document.getElementById('setting-voice-speed');
    const speedValEl = document.getElementById('setting-voice-speed-val');
    const speed = Math.round((v.ttsSpeed != null ? v.ttsSpeed : 1.0) * 100);
    if (speedEl) { speedEl.value = Math.max(50, Math.min(200, speed)); if (speedValEl) speedValEl.textContent = (speed / 100).toFixed(2) + 'x'; }
    const volEl = document.getElementById('setting-voice-volume');
    const volValEl = document.getElementById('setting-voice-volume-val');
    const vol = Math.round((v.ttsVolume != null ? v.ttsVolume : 1.0) * 100);
    if (volEl) { volEl.value = Math.max(10, Math.min(100, vol)); if (volValEl) volValEl.textContent = vol + '%'; }
    const chunkEl = document.getElementById('setting-voice-tts-chunk');
    const chunkSizeEl = document.getElementById('setting-voice-tts-chunk-size');
    const chunkSizeValEl = document.getElementById('setting-voice-tts-chunk-size-val');
    const chunkEnabled = v.ttsAutoChunk !== false;
    if (chunkEl) chunkEl.checked = chunkEnabled;
    const chunkChars = v.ttsChunkChars != null ? Math.round(v.ttsChunkChars) : 120;
    if (chunkSizeEl) {
      chunkSizeEl.value = Math.max(40, Math.min(300, chunkChars));
      if (chunkSizeValEl) chunkSizeValEl.textContent = Math.max(40, Math.min(300, chunkChars)) + '字';
    }
    const chunkRow = chunkSizeEl && chunkSizeEl.closest('.setting-item');
    if (chunkRow) chunkRow.style.opacity = chunkEnabled ? '1' : '0.4';
    setChk('setting-voice-wake', v.wakeEnabled === true);
    set('setting-voice-kws-threshold', (v.kws && v.kws.threshold != null) ? String(v.kws.threshold) : '0.25');
    set('setting-voice-hotkey', v.hotkey || 'Control+Shift+Space');
    renderWakeWordsList(s);
    refreshVoiceModelStatus();
  }

  async function renderWakeWordsList(s) {
    const listEl = document.getElementById('voice-wake-words-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const words = (s && s.voice && s.voice.wakeWords) || [];
    if (words.length === 0) {
      listEl.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary)">暂无唤醒词</span>';
      return;
    }
    words.forEach((w, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;';
      const tag = document.createElement('span');
      tag.textContent = w.phrase;
      tag.style.cssText = 'flex:1;padding:2px 8px;background:var(--surface-alt);border-radius:4px;';
      const actLabel = w.action === 'mainwindow' ? '弹主窗' : '语音条';
      const actEl = document.createElement('span');
      actEl.textContent = actLabel;
      actEl.style.cssText = 'font-size:10px;color:var(--text-tertiary);min-width:40px;text-align:right;';
      const enChk = document.createElement('input');
      enChk.type = 'checkbox';
      enChk.checked = w.enabled !== false;
      enChk.title = '启用';
      enChk.style.cssText = 'margin:0;cursor:pointer';
      enChk.addEventListener('change', async () => {
        const currentS = await window.api.getSettings();
        const currentW = (currentS.voice && currentS.voice.wakeWords) || [];
        if (currentW[idx]) currentW[idx].enabled = enChk.checked;
        if (!currentS.voice) currentS.voice = {};
        currentS.voice.wakeWords = currentW;
        await saveVoiceSettings(currentS, '唤醒词已更新');
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon';
      delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      delBtn.style.cssText = 'font-size:10px;padding:0;width:18px;height:18px';
      delBtn.addEventListener('click', async () => {
        const currentS = await window.api.getSettings();
        const currentW = (currentS.voice && currentS.voice.wakeWords) || [];
        currentW.splice(idx, 1);
        if (!currentS.voice) currentS.voice = {};
        currentS.voice.wakeWords = currentW;
        await saveVoiceSettings(currentS, '唤醒词已删除');
        renderWakeWordsList(currentS);
      });
      row.appendChild(tag);
      row.appendChild(actEl);
      row.appendChild(enChk);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  async function saveVoiceSettings(s, toast) {
    if (typeof s === 'string') { toast = s; s = await window.api.getSettings(); }
    if (!s) s = await window.api.getSettings();
    try {
      await saveSettings(s);
      if (toast && typeof window.showToast === 'function') window.showToast(toast, 'success', 2000);
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('保存失败: ' + (e && e.message), 'error', 3000);
    }
  }

  async function refreshVoiceModelStatus() {
    const el = document.getElementById('voice-model-status');
    if (!el) return;
    try {
      const r = await window.api.voiceGetStatus();
      if (r && r.ok) {
        if (r.missing && r.missing.length) {
          el.textContent = '缺失模型: ' + r.missing.join(', ');
        } else {
          el.textContent = '内置模型就绪（whisper-base + Kokoro 中英 + Piper 德语）';
        }
      } else {
        el.textContent = '语音引擎未启动或模型缺失';
      }
    } catch {
      el.textContent = '无法查询引擎状态';
    }
  }

  function bindVoiceSettings() {
    const setChkId = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice[key] = el.checked;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    };
    setChkId('setting-voice-stt', 'sttEnabled');
    setChkId('setting-voice-tts', 'ttsEnabled');
    setChkId('setting-voice-tts-auto', 'ttsAutoSpeak');

    const bind = (id, key, transform) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        const val = el.type === 'checkbox' ? el.checked : el.value;
        if (transform) transform(s.voice, val);
        else s.voice[key] = val;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    };
    bind('setting-voice-tts-lang', 'ttsLang');
    bind('setting-voice-stt-model', 'sttModel');
    bind('setting-voice-kws-threshold', 'threshold', (voice, val) => { if (!voice.kws) voice.kws = {}; voice.kws.threshold = parseFloat(val) || 0.25; });
    bind('setting-voice-stt-send-keywords', 'sttSendKeywords', (voice, val) => {
      voice.sttSendKeywords = String(val || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    });

    // 中文音色
    const zhEl = document.getElementById('setting-voice-zh');
    if (zhEl) zhEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.ttsVoices) s.voice.ttsVoices = {};
      s.voice.ttsVoices.zh = zhEl.value;
      await saveVoiceSettings(s);
      try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
    });
    const enEl = document.getElementById('setting-voice-en');
    if (enEl) enEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.ttsVoices) s.voice.ttsVoices = {};
      s.voice.ttsVoices.en = enEl.value;
      await saveVoiceSettings(s);
      try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
    });

    // 长文本自动分块开关
    const chunkToggleEl = document.getElementById('setting-voice-tts-chunk');
    if (chunkToggleEl) {
      chunkToggleEl.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice.ttsAutoChunk = chunkToggleEl.checked;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
        const sizeEl = document.getElementById('setting-voice-tts-chunk-size');
        const row = sizeEl && sizeEl.closest('.setting-item');
        if (row) row.style.opacity = chunkToggleEl.checked ? '1' : '0.4';
      });
    }
    const chunkSizeEl = document.getElementById('setting-voice-tts-chunk-size');
    if (chunkSizeEl) {
      chunkSizeEl.addEventListener('input', () => {
        const valEl = document.getElementById('setting-voice-tts-chunk-size-val');
        if (valEl) valEl.textContent = chunkSizeEl.value + '字';
      });
      chunkSizeEl.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice.ttsChunkChars = parseInt(chunkSizeEl.value) || 80;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    }
    // 语速/音量 range
    for (const [id, key, label] of [['setting-voice-speed', 'ttsSpeed', 'x'], ['setting-voice-volume', 'ttsVolume', '%']]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        const valEl = document.getElementById(id + '-val');
        if (valEl) valEl.textContent = key === 'ttsSpeed' ? (parseInt(el.value) / 100).toFixed(2) + label : el.value + label;
      });
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice[key] = parseInt(el.value) / 100;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    }
    // 唤醒
    setChkId('setting-voice-wake', 'wakeEnabled');
    // 热键
    const hotkeyEl = document.getElementById('setting-voice-hotkey');
    if (hotkeyEl) hotkeyEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      s.voice.hotkey = hotkeyEl.value;
      await saveVoiceSettings(s);
    });
    // 试听按钮
    const testBtn = document.getElementById('btn-voice-test');
    if (testBtn) testBtn.addEventListener('click', () => {
      const lang = document.getElementById('setting-voice-tts-lang')?.value || 'zh';
      const testTexts = { zh: '你好，我是你的AI伙伴，很高兴能为你服务！', en: 'Hello! I am your AI partner, ready to assist you.', de: 'Hallo! Ich bin dein KI-Partner und helfe dir gerne.' };
      try { if (window.VoiceUI) window.VoiceUI.speakText(testTexts[lang] || testTexts.zh, lang); } catch (_) {}
    });
    // 添加唤醒词
    const addBtn = document.getElementById('btn-voice-add-wake');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const phrase = document.getElementById('voice-new-wake-phrase')?.value?.trim();
      const action = document.getElementById('voice-new-wake-action')?.value || 'voicebar';
      if (!phrase) return;
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.wakeWords) s.voice.wakeWords = [];
      s.voice.wakeWords.push({ phrase, action, enabled: true });
      document.getElementById('voice-new-wake-phrase').value = '';
      await saveVoiceSettings(s, '唤醒词已添加');
      renderWakeWordsList(s);
    });
    // 录制热键
    const recBtn = document.getElementById('btn-voice-record-hotkey');
    if (recBtn) {
      recBtn.addEventListener('click', () => {
        const input = document.getElementById('setting-voice-hotkey');
        if (!input) return;
        const origText = recBtn.textContent;
        const origDisabled = recBtn.disabled;
        recBtn.textContent = '按下组合键（松开结束）…';
        recBtn.disabled = true;

        // 归一化按键名（修饰键统一命名，字母大写，空格映射为 Space）
        const norm = (e) => {
          const k = e.key || '';
          if (k === 'Control' || k === 'Ctrl') return 'Control';
          if (k === 'Shift') return 'Shift';
          if (k === 'Alt') return 'Alt';
          if (k === 'Meta') return 'Command';
          if (k === ' ') return 'Space';
          if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase();
          return k;
        };

        const pressed = new Set();   // 当前按住的键（归一化）
        const recorded = new Set();  // 本次录制出现过的键（用于最终组合）
        const isModifier = (n) => ['Control', 'Shift', 'Alt', 'Command'].includes(n);

        const render = () => {
          // 修饰键按固定顺序排列在前，主键在后
          const mods = ['Control', 'Command', 'Shift', 'Alt'].filter((m) => recorded.has(m));
          const main = [...recorded].find((n) => !isModifier(n));
          const parts = main ? [...mods, main] : mods;
          input.value = parts.join('+');
        };

        const cleanup = (commit) => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('keyup', onKeyUp, true);
          window.removeEventListener('blur', onBlur, true);
          recBtn.textContent = origText;
          recBtn.disabled = origDisabled;
          // 提交录制结果：触发 change 事件以持久化到设置
          if (commit && recorded.size > 0) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };

        const onKeyDown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') { cleanup(false); return; }
          const n = norm(e);
          if (!n) return;
          pressed.add(n);
          recorded.add(n);
          render();
        };

        const onKeyUp = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const n = norm(e);
          if (!n) return;
          pressed.delete(n);
          // 全部松开且本次已录入至少一个键 → 完成
          if (pressed.size === 0 && recorded.size > 0) {
            cleanup(true);
          }
        };

        const onBlur = () => {
          if (recorded.size > 0 && pressed.size === 0) {
            cleanup(true);
          }
        };

        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur, true);
      });
    }
    // 刷新模型状态
    const refreshBtn = document.getElementById('btn-voice-refresh-status');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshVoiceModelStatus());
  }

  bindVoiceSettings();
  loadVoiceSettings();
  // 启动时将语音设置同步给 VoiceUI（试听/自动朗读依赖 settings 判开关）
  window.api.getSettings().then((s) => {
    if (window.VoiceUI) {
      try { window.VoiceUI.applySettings(s); } catch (_) {}
    }
  });

})();
