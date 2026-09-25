  const streamingBubbles = new Map();

  // ---- WebUI 事件驱动镜像控制器 ----
  // 不再使用 MutationObserver 全量推送（导致死循环刷新 + 输入框被打断）。
  // 改为：WS 连接时推送完整 mirror_head + mirror_body 快照（界面与 Local 一致），
  // 之后由渲染器关键 UI 函数主动推送增量事件（dom_append/dom_clear/dom_replace/dom_remove/dom_update/dom_text）。
  // WebUI 端按事件更新对应 DOM 部分，输入框等用户交互元素不受影响。
  // 主题/头像/标题/模式等仍走原有 push 通道。
  const WebUIMirror = {
    _applyingRemote: false,

    /**
     * WebUI/Remote 页面运行在 http(s)://host，无法加载宿主 file:// 图片。
     * 镜像前把本地图片 src 重写为 /api/local-image?path=...（主进程带目录白名单代理）。
     */
    _mirrorHtml(html) {
      if (!html || typeof html !== 'string') return html;
      const rewritten = html.replace(/(src|data-src|href)=("|')(file:\/\/[^"']+)\2/gi, (m, attr, q, url) => {
        let p = url.replace(/^file:\/\/\/?/i, '');
        try { p = decodeURIComponent(p); } catch (_) {}
        return `${attr}=${q}/api/local-image?path=${encodeURIComponent(p)}${q}`;
      });
      // 超长内联 data URL（历史图片等）镜像时剥离，避免 WS 消息体积爆炸
      return rewritten.replace(/(src|data-src|href)=("|')(data:[^"']{2048,})\2/gi, '$1=$2$2');
    },

    init() {
      // 镜像开关：未运行 Web 控制时不产生任何序列化/IPC 开销
      refreshWebControlMirrorEnabled().then((enabled) => {
        if (enabled) {
          setTimeout(() => {
            pushThemeToWebControl();
            this.sendMirrorHead();
            this.sendMirrorBody();
            pushAvatarsToWeb();
          }, 50);
        }
      });
      // Web 控制启停时刷新开关：启动后补推主题/头像/快照
      if (typeof window.api?.onWebControlRunning === 'function') {
        window.api.onWebControlRunning((running) => {
          webControlMirrorEnabled = !!running;
          if (running) {
            pushThemeToWebControl();
            pushAvatarsToWeb();
            setTimeout(() => { this.sendMirrorHead(); this.sendMirrorBody(); }, 50);
          }
        });
      }

      // 监听主进程的 mirrorInit 请求：新 WS 客户端连接时主进程会触发此信号，
      // 要求渲染器推送最新快照（确保新客户端拿到当前界面而非过期缓存）
      if (typeof window.api?.webControlMirrorInit === 'function') {
        window.api.webControlMirrorInit(() => {
          if (!webControlMirrorEnabled) return;
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
        modals.push(this._mirrorHtml(m.outerHTML));
      });
      const snapshot = {
        type: 'mirror_body',
        html: this._mirrorHtml(app ? app.innerHTML : ''),
        titlebar: titlebar ? titlebar.outerHTML : '',
        modals: modals.join('')
      };
      if (typeof window.HistoryList === 'object' && typeof window.HistoryList.restoreAll === 'function') {
        window.HistoryList.restoreAll();
      }
      return snapshot;
    },

    sendMirrorHead() {
      if (isRemoteMode || !webControlMirrorEnabled) return; // Remote 模式/未运行 Web 控制不推送
      try { if (typeof window.api?.webControlMirrorUpdate === 'function') window.api.webControlMirrorUpdate(this.buildMirrorHead()); } catch (e) {}
    },

    _bodySendTimer: null,
    // 分块传输阈值：超过此大小则拆分为多个 chunk 发送（保证完整性，避免单条 WS 消息过大）
    _chunkSize: 256 * 1024, // 256KB per chunk
    sendMirrorBody() {
      if (isRemoteMode || !webControlMirrorEnabled) return; // Remote 模式/未运行 Web 控制不推送
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
      if (isRemoteMode || !webControlMirrorEnabled) return; // Remote 模式/未运行 Web 控制不推送
      // 本地图片 src 重写为 WebUI 可访问的 HTTP 代理地址
      if (event && typeof event.html === 'string') {
        event = { ...event, html: this._mirrorHtml(event.html) };
      }
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
