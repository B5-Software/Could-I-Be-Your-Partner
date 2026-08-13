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
      if (btn.dataset.page === 'code') pushPageAfterLoad(loadCodePage);
      if (btn.dataset.page === 'code-history') pushPageAfterLoad(loadCodeHistoryPage);
      if (btn.dataset.page === 'babe') pushPageAfterLoad(() => initBabeAgent());
      if (btn.dataset.page === 'babe-history') pushPageAfterLoad(loadBabeHistoryPage);
      // i18n: re-apply translations to the newly activated page (after dynamic content loads)
      if (typeof i18nApplyToDOM === 'function') {
        setTimeout(() => i18nApplyToDOM(page), 100);
      }
    });
  });
