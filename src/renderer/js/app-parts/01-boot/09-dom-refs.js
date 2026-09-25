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
