/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
import { SETTINGS_ICON } from './generated-shell-icons';
import { type ModelChoices } from './model-picker';
import { openReasoningPicker, effortLabel } from './reasoning-picker';

type Mode = 'chat' | 'code' | 'babe';
type Recent = { id: string; title?: string; timestamp?: string | number; ts?: number };
type Context = {
  sessionKey?: string;
  workspace?: string;
  workspaceName?: string;
  model?: string;
  modelLabel?: string;
  effort?: string;
  runtime?: string;
};
type ShellActions = {
  mode: () => Mode;
  context: () => Context;
  translate: (key: string, fallback: string) => string;
  create: (mode: Mode) => Promise<unknown>;
  history: (mode: Mode) => Promise<Recent[]>;
  resume: (mode: Mode, item: Recent) => Promise<unknown>;
  navigate: (page: string) => unknown;
  settings: () => unknown;
  openWorkspace: () => Promise<unknown>;
  chooseChatWorkspace: () => Promise<unknown>;
  models: () => Promise<ModelChoices>;
  selectModel: (id: string) => Promise<unknown>;
  setEffort: (value: string | null) => Promise<unknown>;
  reportError: (error: unknown) => void;
};

type CommandEntry = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => unknown;
};

const labels = {
  toggle: '切换侧栏',
  close: '收起侧栏',
  new: '新对话',
  search: '搜索会话',
  open: '活跃会话',
  recent: '更早的对话',
  all: '全部历史',
  empty: '还没有历史对话',
  noMatches: '没有匹配的会话',
  loading: '正在加载…',
  failed: '无法加载历史，点击重试',
  untitled: '未命名对话',
  workspace: '工作目录',
  chooseWorkspace: '打开工作区',
  model: '选择会话模型',
  resize: '调整侧栏宽度',
  welcomeHint: '冷峻精密的工程工作台：对话、编码与多智能体任务。',
  inputHint: 'Enter 发送 · Shift+Enter 换行 · Ctrl+K 命令',
  commands: '快捷命令',
  commandPlaceholder: '跳转页面、切换会话或执行操作…',
  commandEmpty: '没有匹配的命令',
  workspaceNav: '工作台',
  moreTools: '工具与能力',
  inspector: '上下文检查器',
  inspectorOverview: '概览',
  inspectorActivity: '轨迹',
  inspectorActions: '面板',
  inspectorEmpty: '当前会话尚无思考或工具调用轨迹。',
  openTerminal: '终端',
  openTodo: '待办事项',
  openDownloads: '下载管理',
  searchChat: '搜索消息',
  manageMessages: '消息管理',
  contextLabel: '上下文窗口',
  messagesCount: '消息数',
  stepsCount: '工具步数',
  modeSwitch: '模式',
  pageNav: '导航',
  sessionNav: '会话',
} as const;
type Label = keyof typeof labels;

const iconPaths: Record<string, string> = {
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  inspector: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  heart:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-4v5l3 2"/>',
  tools:
    '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12h18m-11 0v3h4v-3"/>',
  quant: '<path d="M4 3v17h17M8 12v4m4-9v6m4-9v12m4-8v3"/>',
  superagent:
    '<rect x="3" y="9" width="6" height="6" rx="2"/><rect x="15" y="3" width="6" height="6" rx="2"/><rect x="15" y="15" width="6" height="6" rx="2"/><path d="M9 12h3V6h3M12 12v6h3"/>',
  skills:
    '<path d="M9 18h6m-5 3h4M8.1 14.4a6 6 0 1 1 7.8 0c-.9.8-.9 1.6-.9 2.6H9c0-1 0-1.8-.9-2.6Z"/>',
  knowledge: '<path d="M12 7C8 4 5 4 2 5v15c3-1 6-1 10 2 4-3 7-3 10-2V5c-3-1-6-1-10 2Zm0 0v15"/>',
  memory:
    '<path d="M12 4v16M8 4a3 3 0 0 0-5 3 4 4 0 0 0 0 7 4 4 0 0 0 5 5c2 3 4 1 4-1m4-14a3 3 0 0 1 5 3 4 4 0 0 1 0 7 4 4 0 0 1-5 5c-2 3-4 1-4-1M6 9l3 1m9-1-3 1M5 15l3-1m11 1-3-1"/>',
  automation: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  todo: '<path d="m3 6 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2M10 6h11m-11 6h11m-11 6h11"/>',
  settings: SETTINGS_ICON,
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  command:
    '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  external:
    '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  attach:
    '<path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5L13 2a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.4-8.4"/>',
  camera:
    '<path d="M8 5 10 2h4l2 3h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/>',
  send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  terminal: '<path d="m4 5 6 6-6 6m9 1h7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/>',
  sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/>',
};

const icon = (name: string) =>
  `<svg class="v2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.plus}</svg>`;

const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

/** Precision engineering single-sidebar V2 shell.
 * Shares every feature node with V1 via comment anchors so switching preserves
 * active tasks, IME/draft state, media streams, docks, and native IDE hosts. */
export class FrontendShell {
  private readonly root = document.documentElement;
  private readonly sidebar = document.getElementById('sidebar')!;
  private readonly body = document.createElement('div');
  private readonly anchors = new Map<HTMLElement, Comment>();
  private readonly metadata: HTMLElement[] = [];
  private readonly locations: HTMLElement[] = [];
  private readonly welcomeBrand = document.createElement('div');
  private welcomeActions?: HTMLElement;
  private welcomeAnchor?: Comment;
  private readonly search: HTMLInputElement;
  private readonly recentList: HTMLElement;
  private readonly status: HTMLButtonElement;
  private readonly toggle: HTMLButtonElement;
  private readonly inspectorToggle: HTMLButtonElement;
  private readonly inspector = document.createElement('aside');
  private readonly resizer = document.createElement('div');
  private readonly backdrop = document.createElement('button');
  private readonly mobile = matchMedia('(max-width: 900px)');
  private cmdDialog?: HTMLDialogElement;
  private cmdSelected = 0;
  private cmdEntries: CommandEntry[] = [];
  private frontend = '';
  private collapsed = false;
  private drawerOpen = false;
  private inspectorOpen = false;
  private inspectorTab: 'overview' | 'activity' | 'actions' = 'overview';
  private moreNavOpen = false;
  private recent: Recent[] = [];
  private historyKey = '';
  private historyGeneration = 0;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private inspectorTimer?: ReturnType<typeof setTimeout>;
  private language = '';
  private width = 264;

  constructor(private readonly actions: ShellActions) {
    // Titlebar sidebar toggle (replaces the removed 48px icon rail)
    this.toggle = this.button('panel', 'toggle', 'v2-sidebar-toggle');
    this.toggle.classList.add('v2-only');
    this.toggle.setAttribute('aria-controls', 'sidebar');
    this.toggle.addEventListener('click', () => this.toggleSidebar());
    document.querySelector('#titlebar .titlebar-drag')?.prepend(this.toggle);

    // Sidebar header close button
    const close = this.button('panel', 'close', 'v2-sidebar-close');
    close.classList.add('v2-only');
    close.addEventListener('click', () => this.toggleSidebar());
    this.sidebar.querySelector('.sidebar-header')?.appendChild(close);

    // Unified single-column sidebar body
    this.body.className = 'v2-sidebar-body v2-only';
    this.body.innerHTML = `
      <div class="v2-sidebar-top">
        <div class="v2-sidebar-actions"></div>
        <label class="v2-session-search">${icon('search')}<input type="search" id="v2-session-search"><button type="button" class="v2-kbd-chip" id="v2-cmd-trigger" tabindex="-1">Ctrl K</button></label>
        <div class="v2-mode-slot"></div>
        <button class="v2-workspace" type="button">${icon('folder')}<span class="v2-workspace-name"></span><em class="v2-workspace-env"></em>${icon('external')}</button>
      </div>
      <div class="v2-sidebar-scroll">
        <section class="v2-nav-section">
          <div class="v2-nav-slot"></div>
          <button type="button" class="v2-more-nav-toggle" aria-expanded="false">
            <span data-v2-text="moreTools"></span>${icon('chevron')}
          </button>
        </section>
        <section class="v2-open-sessions"><header><h2 data-v2-text="open"></h2></header><div class="v2-sessions-slot"></div></section>
        <section class="v2-recents"><header><h2 data-v2-text="recent"></h2></header><div class="v2-recent-list"></div></section>
      </div>
      <div class="v2-sidebar-bottom"></div>`;
    this.sidebar.appendChild(this.body);

    const newButton = this.button('plus', 'new', 'v2-new-session', true);
    newButton.addEventListener('click', async () => {
      newButton.disabled = true;
      try {
        await this.actions.create(this.actions.mode());
        this.actions.navigate(this.actions.mode());
        this.closeDrawer();
      } catch (error) {
        this.actions.reportError(error);
      } finally {
        newButton.disabled = false;
      }
    });
    this.body.querySelector('.v2-sidebar-actions')!.appendChild(newButton);

    const cmdBtn = this.body.querySelector<HTMLButtonElement>('#v2-cmd-trigger')!;
    cmdBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openCommandPalette();
    });

    const moreToggle = this.body.querySelector<HTMLButtonElement>('.v2-more-nav-toggle')!;
    moreToggle.addEventListener('click', () => {
      this.moreNavOpen = !this.moreNavOpen;
      this.syncMoreNav();
    });

    const all = this.button('history', 'all', 'v2-all-history');
    all.addEventListener('click', () => {
      const mode = this.actions.mode();
      this.actions.navigate(mode === 'chat' ? 'history' : `${mode}-history`);
      this.closeDrawer();
    });
    this.body.querySelector('.v2-open-sessions header')!.appendChild(all);

    this.search = this.body.querySelector('#v2-session-search')!;
    this.search.addEventListener('input', () => this.filter());
    this.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.search.value = '';
        this.filter();
      } else if (event.key === 'ArrowDown') {
        const first = this.body.querySelector<HTMLElement>(
          `#${this.actions.mode()}-session-tabs .session-tab:not(.v2-filtered), .v2-recent-item`,
        );
        first?.focus();
        event.preventDefault();
      }
    });

    this.recentList = this.body.querySelector('.v2-recent-list')!;
    this.status = document.createElement('button');
    this.status.type = 'button';
    this.status.className = 'v2-history-status';
    this.status.addEventListener('click', () => void this.loadHistory(true));

    this.body.querySelector('.v2-workspace')!.addEventListener('click', () => {
      void this.actions.openWorkspace().catch(this.actions.reportError);
    });

    // Right-hand Inspector Drawer (Chat page)
    this.inspectorToggle = this.button('inspector', 'inspector', 'v2-inspector-toggle');
    this.inspectorToggle.classList.add('btn-icon', 'v2-only');
    this.inspectorToggle.setAttribute('aria-controls', 'v2-inspector');
    this.inspectorToggle.addEventListener('click', () => this.toggleInspector());
    document.querySelector('#page-chat .chat-actions')?.appendChild(this.inspectorToggle);
    this.installInspector();

    this.installComposerMetadata();
    this.installIcons();

    this.welcomeBrand.className = 'v2-welcome-brand v2-only';
    this.welcomeBrand.innerHTML =
      '<div class="v2-welcome-eyebrow">AUTONOMOUS WORKSPACE</div><strong>CIBYP</strong><p data-v2-text="welcomeHint"></p>';

    const chatMessagesEl = document.getElementById('chat-messages')!;
    new MutationObserver(() => this.syncWelcome()).observe(chatMessagesEl, { childList: true });
    new MutationObserver(() => this.scheduleInspectorRefresh()).observe(chatMessagesEl, {
      childList: true,
      subtree: true,
    });

    this.installResizer();
    this.backdrop.className = 'v2-sidebar-backdrop v2-only';
    this.backdrop.type = 'button';
    this.backdrop.addEventListener('click', () => this.closeDrawer());
    document.getElementById('app')!.appendChild(this.backdrop);

    this.restoreGeometry();
    window.addEventListener('cibyp:appearance-changed', () => this.apply());
    window.addEventListener('cibyp:sessions-rendered', () => this.refresh());
    window.addEventListener('cibyp:page-changed', () => {
      this.refresh();
      this.closeDrawer();
    });
    window.addEventListener('languagechange', () => this.refresh());
    window.addEventListener('focus', () => {
      if (this.frontend === 'v2') void this.loadHistory(true);
    });
    document.addEventListener('keydown', (event) => {
      if (this.frontend !== 'v2') return;
      if (event.key === 'Escape' && this.drawerOpen) {
        this.closeDrawer();
        this.toggle.focus();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        this.toggleSidebar();
      } else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.openCommandPalette();
      } else if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'i') {
        if (document.getElementById('page-chat')?.classList.contains('active')) {
          event.preventDefault();
          this.toggleInspector();
        }
      }
    });
    this.mobile.addEventListener('change', () => {
      this.drawerOpen = false;
      this.applyGeometry();
    });
    window.addEventListener('resize', () => {
      if (this.frontend === 'v2') this.applyGeometry(false);
    });
    this.apply();
  }

  private text(key: Label): string {
    return this.actions.translate(`ui.frontend.${key}`, labels[key]);
  }

  private button(name: string, label: Label, id: string, withText = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'v2-button';
    button.dataset.v2Title = label;
    button.innerHTML = icon(name);
    if (withText) {
      const text = document.createElement('span');
      text.dataset.v2Text = label;
      button.appendChild(text);
    }
    return button;
  }

  private move(selector: string, destination: Element): void {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) return;
    if (!this.anchors.has(node)) {
      const marker = document.createComment(`v1:${selector}`);
      node.before(marker);
      this.anchors.set(node, marker);
    }
    destination.appendChild(node);
  }

  apply(): void {
    const next = this.root.dataset.frontend === 'v2' ? 'v2' : 'v1';
    if (next !== this.frontend) {
      this.frontend = next;
      if (next === 'v2') {
        this.historyKey = '';
        this.move('#sidebar > .sidebar-nav', this.body.querySelector('.v2-nav-slot')!);
        this.move('#sidebar > .sidebar-footer', this.body.querySelector('.v2-sidebar-bottom')!);
        this.move('.mode-switcher', this.body.querySelector('.v2-mode-slot')!);
        this.move('#session-tabs-host', this.body.querySelector('.v2-sessions-slot')!);
        this.move(
          '#attachments-preview',
          document.querySelector('.chat-input-area .input-wrapper')!,
        );
        const babeComposer = document.querySelector('.v2-babe-composer')!;
        this.move('#babe-attachments-preview', babeComposer);
        for (const id of [
          'babe-chat-input',
          'btn-babe-attach-file',
          'btn-babe-camera',
          'btn-babe-mic',
          'btn-babe-send',
          'btn-babe-stop',
        ])
          this.move('#' + id, babeComposer);
      } else {
        this.cmdDialog?.close();
        for (const [node, marker] of this.anchors) marker.after(node);
        this.drawerOpen = false;
        this.historyGeneration++;
        clearTimeout(this.historyTimer);
        this.sidebar.inert = false;
        this.sidebar.removeAttribute('aria-hidden');
        document
          .querySelectorAll('.session-tab.v2-filtered')
          .forEach((node) => node.classList.remove('v2-filtered'));
      }
      window.dispatchEvent(new Event('resize'));
      document
        .querySelectorAll('.session-tabs')
        .forEach((node) =>
          node.setAttribute('aria-orientation', next === 'v2' ? 'vertical' : 'horizontal'),
        );
    }
    this.syncMoreNav();
    this.applyGeometry();
    this.syncWelcome();
    this.refresh();
  }

  refresh(): void {
    if (this.frontend !== 'v2') return;
    const language = this.root.lang;
    document.querySelectorAll<HTMLElement>('[data-v2-text]').forEach((node) => {
      const value = this.text(node.dataset.v2Text as Label);
      if (node.textContent !== value) node.textContent = value;
    });
    document.querySelectorAll<HTMLElement>('[data-v2-title]').forEach((node) => {
      const value = this.text(node.dataset.v2Title as Label);
      if (node.title !== value) {
        node.title = value;
        node.setAttribute('aria-label', value);
      }
    });
    this.search.placeholder = this.text('search');
    this.search.setAttribute('aria-label', this.text('search'));
    this.backdrop.setAttribute('aria-label', this.text('close'));
    this.resizer.setAttribute('aria-label', this.text('resize'));

    const context = this.actions.context();
    const workspaceName = this.body.querySelector<HTMLElement>('.v2-workspace-name')!;
    const workspaceEnv = this.body.querySelector<HTMLElement>('.v2-workspace-env')!;
    workspaceName.textContent =
      context.workspaceName || this.basename(context.workspace) || this.text('chooseWorkspace');
    workspaceEnv.textContent = context.runtime || '';
    workspaceName.parentElement!.title = context.workspace || this.text('chooseWorkspace');

    for (const metadata of this.metadata) {
      metadata.querySelector<HTMLElement>('.v2-composer-runtime')!.textContent =
        context.runtime || '';
      const model = metadata.querySelector<HTMLButtonElement>('.v2-composer-model')!;
      model.querySelector('span')!.textContent =
        context.modelLabel || context.model || this.text('model');
      model.querySelector('small')!.textContent = context.effort
        ? effortLabel(context.effort, this.actions.translate)
        : '';
      model.title = this.text('model');
    }
    for (const location of this.locations) {
      const workspaceButton = location.querySelector<HTMLButtonElement>('.v2-composer-workspace')!;
      workspaceButton.querySelector('span')!.textContent =
        context.workspaceName || this.basename(context.workspace) || this.text('workspace');
      if (workspaceButton.hasAttribute('data-choose-chat-workspace')) {
        const label = this.actions.translate('ui.workspace.chooseChat', '选择 Chat 工作目录');
        workspaceButton.title = context.workspace ? label + ' · ' + context.workspace : label;
        workspaceButton.setAttribute('aria-label', workspaceButton.title);
      } else workspaceButton.title = context.workspace || this.text('chooseWorkspace');
    }

    // Auto-expand secondary capability nav if one of those pages is currently active
    const activeSecondary = this.body.querySelector(
      '.v2-nav-slot .nav-item.active:is([data-page="tools"],[data-page="skills"],[data-page="knowledge"],[data-page="memory"])',
    );
    if (activeSecondary && !this.moreNavOpen) {
      this.moreNavOpen = true;
      this.syncMoreNav();
    }

    const key = `${this.actions.mode()}:${context.workspace || ''}`;
    if (this.historyKey !== key || this.language !== language) {
      this.language = language;
      void this.loadHistory(true);
    }
    this.filter();
    this.scheduleInspectorRefresh();
  }

  private syncMoreNav(): void {
    const section = this.body.querySelector<HTMLElement>('.v2-nav-section');
    const toggle = this.body.querySelector<HTMLButtonElement>('.v2-more-nav-toggle');
    if (!section || !toggle) return;
    section.dataset.expanded = this.moreNavOpen ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', String(this.moreNavOpen));
  }

  private basename(value?: string): string {
    return (
      value
        ?.replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || ''
    );
  }

  private filter(): void {
    const query = this.search.value.trim().toLocaleLowerCase();
    this.body.querySelectorAll<HTMLElement>('.session-tab').forEach((tab) => {
      const title = tab.querySelector('.session-tab-title')?.textContent || '';
      tab.classList.toggle('v2-filtered', !title.toLocaleLowerCase().includes(query));
    });
    this.renderRecent();
  }

  private renderRecent(): void {
    const query = this.search.value.trim().toLocaleLowerCase();
    const live = new Set(
      [
        ...this.body.querySelectorAll<HTMLElement>(
          `#${this.actions.mode()}-session-tabs .session-tab`,
        ),
      ].map((tab) => tab.dataset.historyId),
    );
    const fragment = document.createDocumentFragment();
    for (const item of this.recent
      .filter(
        (row) =>
          !live.has(String(row.id)) &&
          (row.title || this.text('untitled')).toLocaleLowerCase().includes(query),
      )
      .slice(0, 30)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'v2-recent-item';
      row.dataset.historyId = String(item.id);
      row.dataset.i18nSkip = '';
      row.textContent = item.title || this.text('untitled');
      row.title = row.textContent;
      row.addEventListener('click', async () => {
        row.disabled = true;
        try {
          await this.actions.resume(this.actions.mode(), item);
          this.closeDrawer();
        } catch (error) {
          this.actions.reportError(error);
        } finally {
          row.disabled = false;
        }
      });
      fragment.appendChild(row);
    }
    if (!fragment.childNodes.length) {
      if (this.status.dataset.state !== 'loading' && this.status.dataset.state !== 'error') {
        this.status.textContent = this.text(query ? 'noMatches' : 'empty');
        this.status.disabled = true;
      }
      fragment.appendChild(this.status);
    }
    this.recentList.closest<HTMLElement>('.v2-recents')!.hidden =
      !query && this.status.dataset.state === 'ready' && !fragment.querySelector('.v2-recent-item');
    this.recentList.replaceChildren(fragment);
  }

  private async loadHistory(force = false): Promise<void> {
    if (this.frontend !== 'v2') return;
    const mode = this.actions.mode();
    const key = `${mode}:${this.actions.context().workspace || ''}`;
    if (!force && this.historyKey === key) return;
    this.historyKey = key;
    const generation = ++this.historyGeneration;
    this.recent = [];
    this.status.dataset.state = 'loading';
    this.status.textContent = this.text('loading');
    this.status.disabled = true;
    this.renderRecent();
    try {
      const items = await this.actions.history(mode);
      if (generation !== this.historyGeneration || this.frontend !== 'v2') return;
      this.recent = items;
      this.status.dataset.state = 'ready';
    } catch (error) {
      if (generation !== this.historyGeneration) return;
      console.error('[frontend] History unavailable', error);
      this.status.dataset.state = 'error';
      this.status.textContent = this.text('failed');
      this.status.disabled = false;
    }
    this.renderRecent();
  }

  /** Called only for durable session changes, never for individual streamed tokens. */
  invalidateHistory(): void {
    clearTimeout(this.historyTimer);
    if (this.frontend === 'v2')
      this.historyTimer = setTimeout(() => void this.loadHistory(true), 400);
  }

  private installInspector(): void {
    const pageChat = document.getElementById('page-chat');
    if (!pageChat) return;
    this.inspector.id = 'v2-inspector';
    this.inspector.className = 'v2-inspector v2-only';
    this.inspector.setAttribute('aria-label', this.text('inspector'));
    this.inspector.innerHTML = `
      <header class="v2-inspector-header">
        <div class="v2-inspector-tabs" role="tablist">
          <button type="button" role="tab" data-inspector-tab="overview" aria-selected="true" data-v2-text="inspectorOverview"></button>
          <button type="button" role="tab" data-inspector-tab="activity" aria-selected="false" data-v2-text="inspectorActivity"></button>
          <button type="button" role="tab" data-inspector-tab="actions" aria-selected="false" data-v2-text="inspectorActions"></button>
        </div>
        <button type="button" class="v2-button v2-inspector-close" aria-label="Close">×</button>
      </header>
      <div class="v2-inspector-body"></div>`;
    pageChat.appendChild(this.inspector);
    this.inspector.querySelector('.v2-inspector-close')!.addEventListener('click', () => {
      this.inspectorOpen = false;
      this.applyGeometry();
    });
    this.inspector.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.inspectorTab = tab.dataset.inspectorTab as 'overview' | 'activity' | 'actions';
        this.inspector
          .querySelectorAll<HTMLButtonElement>('[data-inspector-tab]')
          .forEach((b) => b.setAttribute('aria-selected', String(b === tab)));
        this.renderInspector();
      });
    });
  }

  private toggleInspector(): void {
    this.inspectorOpen = !this.inspectorOpen;
    try {
      localStorage.setItem('cibyp.v2.inspector-open', String(this.inspectorOpen));
    } catch {
      /* optional */
    }
    this.applyGeometry();
    if (this.inspectorOpen) this.renderInspector();
  }

  private scheduleInspectorRefresh(): void {
    if (this.frontend !== 'v2' || !this.inspectorOpen) return;
    clearTimeout(this.inspectorTimer);
    this.inspectorTimer = setTimeout(() => this.renderInspector(), 160);
  }

  private renderInspector(): void {
    if (this.frontend !== 'v2' || !this.inspectorOpen) return;
    const body = this.inspector.querySelector<HTMLElement>('.v2-inspector-body');
    if (!body) return;
    const context = this.actions.context();
    const chatMessages = document.getElementById('chat-messages');
    const messageNodes = [
      ...(chatMessages?.querySelectorAll<HTMLElement>('.message.user, .message.assistant') || []),
    ];
    const stepNodes = [
      ...(chatMessages?.querySelectorAll<HTMLElement>(
        '.reasoning-section, .tool-call-card, .tool-call',
      ) || []),
    ];
    const ctxEl = document.getElementById('chat-context-indicator');
    const used = Number(ctxEl?.dataset.used || 0);
    const max = Math.max(1, Number(ctxEl?.dataset.max || 8192));
    const pct = Math.min(100, Math.round((used / max) * 100));
    const ctxText = document.getElementById('context-progress-text')?.textContent || `${pct}%`;

    if (this.inspectorTab === 'overview') {
      const wsLabel =
        context.workspaceName || this.basename(context.workspace) || this.text('chooseWorkspace');
      const modelLabel = context.modelLabel || context.model || this.text('model');
      const effort = context.effort ? effortLabel(context.effort, this.actions.translate) : '';
      body.innerHTML = `
        <div class="v2-insp-section">
          <div class="v2-insp-kv">
            <button type="button" class="v2-insp-card" data-insp-model>
              <span class="v2-insp-label">${icon('cpu')}<span>${esc(this.text('model'))}</span></span>
              <strong>${esc(modelLabel)}</strong>
              ${effort ? `<small>${esc(effort)}</small>` : ''}
            </button>
            <button type="button" class="v2-insp-card" data-insp-workspace title="${esc(context.workspace || '')}">
              <span class="v2-insp-label">${icon('folder')}<span>${esc(this.text('workspace'))}</span></span>
              <strong>${esc(wsLabel)}</strong>
              ${context.runtime ? `<small>${esc(context.runtime)}</small>` : ''}
            </button>
          </div>
        </div>
        <div class="v2-insp-section">
          <div class="v2-insp-meter-head">
            <span>${esc(this.text('contextLabel'))}</span>
            <code>${esc(ctxText)} (${pct}%)</code>
          </div>
          <div class="v2-insp-meter"><span style="width:${pct}%"></span></div>
          <div class="v2-insp-stats">
            <div><span>${esc(this.text('messagesCount'))}</span><strong>${messageNodes.length}</strong></div>
            <div><span>${esc(this.text('stepsCount'))}</span><strong>${stepNodes.length}</strong></div>
          </div>
        </div>`;
      body.querySelector('[data-insp-model]')?.addEventListener('click', (e) => {
        this.openModels(e.currentTarget as HTMLButtonElement);
      });
      body.querySelector('[data-insp-workspace]')?.addEventListener('click', () => {
        void this.actions.openWorkspace().catch(this.actions.reportError);
      });
      return;
    }

    if (this.inspectorTab === 'activity') {
      if (!stepNodes.length) {
        body.innerHTML = `<p class="v2-insp-empty">${esc(this.text('inspectorEmpty'))}</p>`;
        return;
      }
      const list = document.createElement('div');
      list.className = 'v2-insp-timeline';
      stepNodes.slice(-80).forEach((node, idx) => {
        const isReasoning = node.classList.contains('reasoning-section');
        const headerText = (
          node.querySelector('.reasoning-header, .tool-call-header')?.textContent || ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        const statusText = (node.querySelector('.tool-call-status')?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'v2-insp-step';
        row.innerHTML = `<span class="v2-insp-step-idx">${String(idx + 1).padStart(2, '0')}</span><span class="v2-insp-step-copy"><strong>${esc(headerText || (isReasoning ? 'Reasoning' : 'Tool'))}</strong>${statusText ? `<small>${esc(statusText)}</small>` : ''}</span>`;
        row.addEventListener('click', () => {
          node.classList.remove('collapsed');
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          node.classList.add('v2-step-highlight');
          setTimeout(() => node.classList.remove('v2-step-highlight'), 1200);
        });
        list.appendChild(row);
      });
      body.replaceChildren(list);
      return;
    }

    const actionsList = [
      { id: 'btn-chat-show-terminals', icon: 'terminal', label: this.text('openTerminal') },
      { id: 'btn-todo-toggle', icon: 'todo', label: this.text('openTodo') },
      { id: 'btn-show-downloads', icon: 'download', label: this.text('openDownloads') },
      { id: 'btn-chat-search', icon: 'search', label: this.text('searchChat') },
    ];
    body.innerHTML = `<div class="v2-insp-action-grid">${actionsList
      .map(
        (item) =>
          `<button type="button" class="v2-insp-action" data-trigger-id="${esc(item.id)}">${icon(item.icon)}<span>${esc(item.label)}</span></button>`,
      )
      .join('')}</div>`;
    body.querySelectorAll<HTMLButtonElement>('[data-trigger-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.triggerId!)?.click();
      });
    });
  }

  private openCommandPalette(): void {
    if (this.frontend !== 'v2') return;
    this.cmdDialog?.close();
    const dialog = document.createElement('dialog');
    dialog.className = 'v2-cmd-dialog';
    dialog.innerHTML = `
      <div class="v2-cmd-shell">
        <div class="v2-cmd-input-row">
          ${icon('search')}
          <input type="search" class="v2-cmd-input" placeholder="${esc(this.text('commandPlaceholder'))}" autocomplete="off" spellcheck="false">
          <kbd>ESC</kbd>
        </div>
        <div class="v2-cmd-list" role="listbox"></div>
      </div>`;
    document.body.append(dialog);
    this.cmdDialog = dialog;
    dialog.showModal();
    const input = dialog.querySelector<HTMLInputElement>('.v2-cmd-input')!;
    const list = dialog.querySelector<HTMLElement>('.v2-cmd-list')!;

    const buildEntries = (): CommandEntry[] => {
      const entries: CommandEntry[] = [
        {
          id: 'action:new',
          group: this.text('commands'),
          label: this.text('new'),
          icon: 'plus',
          run: async () => {
            await this.actions.create(this.actions.mode());
            this.actions.navigate(this.actions.mode());
          },
        },
        {
          id: 'action:workspace',
          group: this.text('commands'),
          label: this.text('chooseWorkspace'),
          icon: 'folder',
          run: () => this.actions.openWorkspace(),
        },
        {
          id: 'action:sidebar',
          group: this.text('commands'),
          label: this.text('toggle'),
          hint: 'Ctrl+B',
          icon: 'panel',
          run: () => this.toggleSidebar(),
        },
        {
          id: 'action:inspector',
          group: this.text('commands'),
          label: this.text('inspector'),
          hint: 'Ctrl+Shift+I',
          icon: 'inspector',
          run: () => {
            this.actions.navigate('chat');
            this.toggleInspector();
          },
        },
      ];
      const pageItems: [string, string, string][] = [
        ['chat', 'chat', 'Chat'],
        ['code', 'code', 'Code'],
        ['superagent', 'superagent', 'SuperAgent'],
        ['quant', 'quant', 'Quant'],
        ['babe', 'heart', 'Babe'],
        ['automation', 'automation', 'Automation'],
        ['tools', 'tools', 'Tools'],
        ['skills', 'skills', 'Skills'],
        ['knowledge', 'knowledge', 'Knowledge'],
        ['memory', 'memory', 'Memory'],
        ['settings', 'settings', 'Settings'],
      ];
      for (const [page, ic, fallback] of pageItems) {
        const navBtn = document.querySelector<HTMLElement>(`.nav-item[data-page="${page}"]`);
        if (navBtn?.hidden) continue;
        const label = navBtn?.querySelector('span')?.textContent?.trim() || fallback;
        entries.push({
          id: `page:${page}`,
          group: this.text('pageNav'),
          label,
          icon: ic,
          run: () => this.actions.navigate(page),
        });
      }
      for (const item of this.recent.slice(0, 12)) {
        entries.push({
          id: `recent:${item.id}`,
          group: this.text('sessionNav'),
          label: item.title || this.text('untitled'),
          icon: 'history',
          run: () => this.actions.resume(this.actions.mode(), item),
        });
      }
      return entries;
    };

    const allEntries = buildEntries();
    const render = () => {
      const q = input.value.trim().toLocaleLowerCase();
      this.cmdEntries = q
        ? allEntries.filter(
            (e) =>
              e.label.toLocaleLowerCase().includes(q) ||
              e.group.toLocaleLowerCase().includes(q) ||
              e.id.toLocaleLowerCase().includes(q),
          )
        : allEntries;
      this.cmdSelected = Math.max(0, Math.min(this.cmdSelected, this.cmdEntries.length - 1));
      if (!this.cmdEntries.length) {
        list.innerHTML = `<div class="v2-cmd-empty">${esc(this.text('commandEmpty'))}</div>`;
        return;
      }
      let lastGroup = '';
      list.innerHTML = this.cmdEntries
        .map((entry, index) => {
          const head =
            entry.group !== lastGroup ? `<div class="v2-cmd-group">${esc(entry.group)}</div>` : '';
          lastGroup = entry.group;
          return `${head}<button type="button" role="option" class="v2-cmd-item${index === this.cmdSelected ? ' active' : ''}" data-cmd-idx="${index}">${icon(entry.icon)}<span>${esc(entry.label)}</span>${entry.hint ? `<kbd>${esc(entry.hint)}</kbd>` : ''}</button>`;
        })
        .join('');
      list.querySelectorAll<HTMLButtonElement>('[data-cmd-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const entry = this.cmdEntries[Number(btn.dataset.cmdIdx)];
          dialog.close();
          if (entry) void Promise.resolve(entry.run()).catch(this.actions.reportError);
        });
      });
    };

    input.addEventListener('input', () => {
      this.cmdSelected = 0;
      render();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.cmdSelected = (this.cmdSelected + 1) % Math.max(1, this.cmdEntries.length);
        render();
        list.querySelector('.v2-cmd-item.active')?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.cmdSelected =
          (this.cmdSelected - 1 + Math.max(1, this.cmdEntries.length)) %
          Math.max(1, this.cmdEntries.length);
        render();
        list.querySelector('.v2-cmd-item.active')?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const entry = this.cmdEntries[this.cmdSelected];
        dialog.close();
        if (entry) void Promise.resolve(entry.run()).catch(this.actions.reportError);
      }
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.onclose = () => {
      dialog.remove();
      if (this.cmdDialog === dialog) this.cmdDialog = undefined;
    };
    render();
    input.focus();
  }

  private installComposerMetadata(): void {
    for (const selector of ['.chat-input-area', '.babe-chat-input', '.code-agent-composer']) {
      const composer = document.querySelector<HTMLElement>(selector);
      if (!composer) continue;
      const metadata = document.createElement('div');
      metadata.className = 'v2-composer-meta v2-only';
      metadata.innerHTML = `<button type="button" class="v2-composer-model" aria-haspopup="dialog"><span></span><small></small>${icon('chevron')}</button><span class="v2-composer-runtime"></span>`;
      const modelButton = metadata.querySelector('button')!;
      modelButton.addEventListener('click', () => this.openModels(modelButton));
      if (selector === '.chat-input-area')
        composer.querySelector('.input-actions')!.prepend(metadata);
      else if (selector === '.code-agent-composer')
        composer.querySelector('.code-agent-composer-actions')!.prepend(metadata);
      else {
        const surface = document.createElement('div');
        surface.className = 'v2-babe-composer v2-only';
        surface.append(metadata);
        composer.prepend(surface);
      }
      this.metadata.push(metadata);
      const location = document.createElement('div');
      location.className = 'v2-composer-location v2-only';
      location.innerHTML = `<button type="button" class="v2-composer-workspace">${icon('folder')}<span></span></button><span data-v2-text="inputHint"></span>`;
      const workspaceButton = location.querySelector('button')!;
      const choose = selector === '.chat-input-area';
      if (choose) {
        workspaceButton.setAttribute('data-choose-chat-workspace', '');
        workspaceButton.setAttribute('aria-haspopup', 'dialog');
      }
      workspaceButton.addEventListener('click', () => {
        const run = choose ? this.actions.chooseChatWorkspace : this.actions.openWorkspace;
        void run().catch(this.actions.reportError);
      });
      composer.append(location);
      this.locations.push(location);
    }
  }

  private openModels(button: HTMLButtonElement): void {
    const session = this.actions.context().sessionKey;
    const guard = () => {
      if (session !== this.actions.context().sessionKey)
        throw new Error(
          this.actions.translate('ui.models.sessionChanged', '会话已切换，请重新打开模型选择器。'),
        );
    };
    openReasoningPicker(button, {
      list: async () => {
        guard();
        const choices = await this.actions.models();
        guard();
        return choices;
      },
      select: async (id) => {
        guard();
        return this.actions.selectModel(id);
      },
      setEffort: async (value) => {
        guard();
        return this.actions.setEffort(value);
      },
      manage: this.actions.settings,
      text: this.actions.translate,
    });
  }

  private installIcons(): void {
    const names: Record<string, string> = {
      chat: 'chat',
      code: 'code',
      babe: 'heart',
      history: 'history',
      'code-history': 'history',
      'babe-history': 'history',
      tools: 'tools',
      quant: 'quant',
      superagent: 'superagent',
      skills: 'skills',
      knowledge: 'knowledge',
      memory: 'memory',
      automation: 'automation',
      settings: 'settings',
      about: 'about',
    };
    document.querySelectorAll<HTMLElement>('.nav-item, .mode-btn').forEach((button) => {
      const name =
        names[button.dataset.page || button.dataset.mode || ''] ||
        (button.hasAttribute('data-todo-toggle') ? 'todo' : 'chat');
      button.querySelector('i')?.classList.add('v2-original-icon');
      button.insertAdjacentHTML('afterbegin', icon(name));
    });
    const buttons: Record<string, string> = {
      'btn-attach-file': 'attach',
      'btn-camera': 'camera',
      'btn-todo-toggle': 'todo',
      'btn-send': 'send',
      'btn-chat-search': 'search',
      'btn-show-downloads': 'download',
      'btn-chat-show-terminals': 'terminal',
      'btn-open-workspace': 'folder',
      'btn-new-chat': 'plus',
      'btn-clear-chat': 'trash',
      'btn-babe-attach-file': 'attach',
      'btn-babe-camera': 'camera',
      'btn-babe-send': 'send',
    };
    for (const [id, name] of Object.entries(buttons)) {
      const button = document.getElementById(id);
      if (!button) continue;
      button.querySelector('i')?.classList.add('v2-original-icon');
      button.insertAdjacentHTML('afterbegin', icon(name));
    }
  }

  private syncWelcome(): void {
    const welcome = document.querySelector<HTMLElement>('#chat-messages > .welcome-message');
    if (this.frontend !== 'v2' || !welcome) {
      if (this.welcomeActions && this.welcomeAnchor?.isConnected)
        this.welcomeAnchor.after(this.welcomeActions);
      else this.welcomeActions?.remove();
      this.welcomeActions = undefined;
      this.welcomeAnchor?.remove();
      this.welcomeAnchor = undefined;
      this.welcomeBrand.remove();
      return;
    }
    if (this.welcomeBrand.parentElement !== welcome) welcome.prepend(this.welcomeBrand);
    const hintNode = this.welcomeBrand.querySelector<HTMLElement>('[data-v2-text]')!;
    const hintText = this.text('welcomeHint');
    if (hintNode.textContent !== hintText) hintNode.textContent = hintText;
    const quick = welcome.querySelector<HTMLElement>('.quick-actions');
    if (!quick) return;
    this.welcomeActions?.remove();
    this.welcomeAnchor?.remove();
    this.welcomeAnchor = document.createComment('v1:welcome-actions');
    quick.before(this.welcomeAnchor);
    this.welcomeActions = quick;
    document.querySelector('.chat-input-area')!.append(quick);
  }

  private restoreGeometry(): void {
    try {
      this.collapsed = localStorage.getItem('cibyp.v2.sidebar-collapsed') === 'true';
      this.inspectorOpen = localStorage.getItem('cibyp.v2.inspector-open') === 'true';
      this.width = Math.max(
        228,
        Math.min(380, Number(localStorage.getItem('cibyp.v2.sidebar-width')) || 264),
      );
    } catch {
      /* Storage may be unavailable in restricted browser profiles. */
    }
    this.root.style.setProperty('--v2-sidebar-width', `${this.width}px`);
    this.resizer.setAttribute('aria-valuenow', String(this.width));
  }

  private isNarrow(): boolean {
    return window.innerWidth <= 900;
  }

  private toggleSidebar(): void {
    if (this.isNarrow()) this.drawerOpen = !this.drawerOpen;
    else {
      this.collapsed = !this.collapsed;
      try {
        localStorage.setItem('cibyp.v2.sidebar-collapsed', String(this.collapsed));
      } catch {
        /* optional */
      }
    }
    this.applyGeometry();
  }

  private closeDrawer(): void {
    if (!this.drawerOpen) return;
    this.drawerOpen = false;
    this.applyGeometry();
  }

  private applyGeometry(emitResize = true): void {
    const narrow = this.isNarrow();
    if (!narrow && this.drawerOpen) this.drawerOpen = false;
    const open = narrow ? this.drawerOpen : !this.collapsed;
    this.root.dataset.v2Sidebar = open ? 'open' : 'closed';
    this.root.dataset.v2Inspector = this.inspectorOpen && !narrow ? 'open' : 'closed';
    this.toggle.setAttribute('aria-expanded', String(open));
    this.inspectorToggle.setAttribute('aria-expanded', String(this.inspectorOpen));
    this.inspectorToggle.classList.toggle('active', this.inspectorOpen);
    if (this.frontend === 'v2') {
      this.sidebar.inert = !open;
      this.sidebar.setAttribute('aria-hidden', String(!open));
    }
    if (emitResize) window.dispatchEvent(new Event('resize'));
  }

  private installResizer(): void {
    this.resizer.id = 'v2-sidebar-resizer';
    this.resizer.className = 'v2-only';
    this.resizer.tabIndex = 0;
    this.resizer.setAttribute('role', 'separator');
    this.resizer.setAttribute('aria-orientation', 'vertical');
    this.resizer.setAttribute('aria-valuemin', '228');
    this.resizer.setAttribute('aria-valuemax', '380');
    const setWidth = (width: number, save = false) => {
      this.width = Math.max(228, Math.min(380, width));
      this.root.style.setProperty('--v2-sidebar-width', `${this.width}px`);
      this.resizer.setAttribute('aria-valuenow', String(this.width));
      if (save) {
        try {
          localStorage.setItem('cibyp.v2.sidebar-width', String(this.width));
        } catch {
          /* optional */
        }
      }
    };
    this.resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startWidth = this.width;
      this.resizer.setPointerCapture(event.pointerId);
      this.resizer.onpointermove = (move) => setWidth(startWidth + move.clientX - startX);
      const end = () => {
        this.resizer.onpointermove = null;
        setWidth(this.width, true);
      };
      this.resizer.onpointerup = end;
      this.resizer.onpointercancel = end;
      event.preventDefault();
    });
    this.resizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setWidth(
        event.key === 'Home'
          ? 228
          : event.key === 'End'
            ? 380
            : this.width + (event.key === 'ArrowLeft' ? -16 : 16),
        true,
      );
    });
    this.resizer.addEventListener('dblclick', () => setWidth(264, true));
    this.sidebar.appendChild(this.resizer);
  }
}
