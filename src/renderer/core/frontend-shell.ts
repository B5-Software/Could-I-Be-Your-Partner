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
  models: () => Promise<ModelChoices>;
  selectModel: (id: string) => Promise<unknown>;
  setEffort: (value: string | null) => Promise<unknown>;
  reportError: (error: unknown) => void;
};

const labels = {
  toggle: '切换会话侧栏',
  close: '收起侧栏',
  new: '新对话',
  search: '搜索会话',
  open: '会话',
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
  resize: '调整会话侧栏宽度',
  welcomeHint: '从一个想法开始。',
  inputHint: 'Enter 发送 · Shift+Enter 换行',
} as const;
type Label = keyof typeof labels;

// A small, consistent outline set for the shell; the shared V1 icons stay intact.
const iconPaths: Record<string, string> = {
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  heart:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-4v5l3 2"/>',
  tools:
    '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12h18m-11 0v3h4v-3"/>',
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
  new: '<path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l2.5-.5L22 4a2.1 2.1 0 0 0-3-3l-9.5 9.5L9 14Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
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
};
const icon = (name: string) =>
  `<svg class="v2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.plus}</svg>`;

/** Two shells, one set of feature components. Moving nodes preserves listeners,
 * input/IME state, media streams, docks, Agent views and native IDE controllers. */
export class FrontendShell {
  private readonly root = document.documentElement;
  private readonly sidebar = document.getElementById('sidebar')!;
  private readonly rail = document.createElement('aside');
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
  private readonly resizer = document.createElement('div');
  private readonly backdrop = document.createElement('button');
  private readonly mobile = matchMedia('(max-width: 900px)');
  private frontend = '';
  private collapsed = false;
  private drawerOpen = false;
  private recent: Recent[] = [];
  private historyKey = '';
  private historyGeneration = 0;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private language = '';
  private width = 256;

  constructor(private readonly actions: ShellActions) {
    this.rail.id = 'v2-rail';
    this.rail.className = 'v2-only';
    this.rail.innerHTML =
      '<div class="v2-rail-top"></div><div class="v2-rail-nav"></div><div class="v2-rail-footer"></div>';
    this.toggle = this.button('panel', 'toggle', 'v2-sidebar-toggle');
    this.toggle.setAttribute('aria-controls', 'sidebar');
    this.toggle.addEventListener('click', () => this.toggleSidebar());
    this.rail.firstElementChild!.appendChild(this.toggle);
    this.sidebar.before(this.rail);
    const close = this.button('panel', 'close', 'v2-sidebar-close');
    close.classList.add('v2-only');
    close.addEventListener('click', () => this.toggleSidebar());
    this.sidebar.querySelector('.sidebar-header')!.appendChild(close);
    this.body.className = 'v2-sidebar-body v2-only';
    this.body.innerHTML = `
      <div class="v2-sidebar-actions"></div>
      <label class="v2-session-search">${icon('search')}<input type="search" id="v2-session-search"></label>
      <div class="v2-mode-slot"></div>
      <button class="v2-workspace" type="button">${icon('folder')}<span></span>${icon('external')}</button>
      <div class="v2-sidebar-scroll">
        <section class="v2-open-sessions"><header><h2 data-v2-text="open"></h2></header><div class="v2-sessions-slot"></div></section>
        <section class="v2-recents"><header><h2 data-v2-text="recent"></h2></header><div class="v2-recent-list"></div></section>
      </div>`;
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
    const all = this.button('history', 'all', 'v2-all-history');
    all.addEventListener('click', () => {
      const mode = this.actions.mode();
      this.actions.navigate(mode === 'chat' ? 'history' : `${mode}-history`);
      this.closeDrawer();
    });
    this.body.querySelector('.v2-open-sessions header')!.appendChild(all);
    this.search = this.body.querySelector('input')!;
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
    this.installComposerMetadata();
    this.installIcons();
    this.welcomeBrand.className = 'v2-welcome-brand v2-only';
    this.welcomeBrand.innerHTML =
      '<strong>CIBYP</strong><span>Could I Be Your Partner</span><p data-v2-text="welcomeHint"></p>';
    new MutationObserver(() => this.syncWelcome()).observe(
      document.getElementById('chat-messages')!,
      { childList: true },
    );
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
      if (this.frontend === 'v2' && event.key === 'Escape' && this.drawerOpen) {
        this.closeDrawer();
        this.toggle.focus();
      }
    });
    this.mobile.addEventListener('change', () => {
      this.drawerOpen = false;
      this.applyGeometry();
    });
    this.apply();
  }

  private text(key: Label): string {
    return this.actions.translate(`ui.frontend.${key}`, labels[key]);
  }

  private button(icon: string, label: Label, id: string, withText = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'v2-button';
    button.dataset.v2Title = label;
    button.innerHTML = `<svg class="v2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[icon] || iconPaths.plus}</svg>`;
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
        this.move('#sidebar .app-logo', this.rail.querySelector('.v2-rail-top')!);
        this.move('#sidebar > .sidebar-nav', this.rail.querySelector('.v2-rail-nav')!);
        this.move('#sidebar > .sidebar-footer', this.rail.querySelector('.v2-rail-footer')!);
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
    const workspace = this.body.querySelector<HTMLElement>('.v2-workspace span')!;
    workspace.textContent =
      context.workspaceName || this.basename(context.workspace) || this.text('chooseWorkspace');
    workspace.parentElement!.title = context.workspace || this.text('chooseWorkspace');
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
      workspaceButton.title = context.workspace || this.text('chooseWorkspace');
    }
    const key = `${this.actions.mode()}:${context.workspace || ''}`;
    if (this.historyKey !== key || this.language !== language) {
      this.language = language;
      void this.loadHistory(true);
    }
    this.filter();
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
      location.querySelector('button')!.addEventListener('click', () => {
        void this.actions.openWorkspace().catch(this.actions.reportError);
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
    welcome.prepend(this.welcomeBrand);
    this.welcomeBrand.querySelector<HTMLElement>('[data-v2-text]')!.textContent =
      this.text('welcomeHint');
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
      this.width = Math.max(
        220,
        Math.min(380, Number(localStorage.getItem('cibyp.v2.sidebar-width')) || 256),
      );
    } catch {
      /* Storage may be unavailable in restricted browser profiles. */
    }
    this.root.style.setProperty('--v2-sidebar-width', `${this.width}px`);
    this.resizer.setAttribute('aria-valuenow', String(this.width));
  }

  private toggleSidebar(): void {
    if (this.mobile.matches) this.drawerOpen = !this.drawerOpen;
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

  private applyGeometry(): void {
    const open = this.mobile.matches ? this.drawerOpen : !this.collapsed;
    this.root.dataset.v2Sidebar = open ? 'open' : 'closed';
    this.toggle.setAttribute('aria-expanded', String(open));
    if (this.frontend === 'v2') {
      this.sidebar.inert = !open;
      this.sidebar.setAttribute('aria-hidden', String(!open));
    }
    window.dispatchEvent(new Event('resize'));
  }

  private installResizer(): void {
    this.resizer.id = 'v2-sidebar-resizer';
    this.resizer.className = 'v2-only';
    this.resizer.tabIndex = 0;
    this.resizer.setAttribute('role', 'separator');
    this.resizer.setAttribute('aria-orientation', 'vertical');
    this.resizer.setAttribute('aria-valuemin', '220');
    this.resizer.setAttribute('aria-valuemax', '380');
    const setWidth = (width: number, save = false) => {
      this.width = Math.max(220, Math.min(380, width));
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
          ? 220
          : event.key === 'End'
            ? 380
            : this.width + (event.key === 'ArrowLeft' ? -16 : 16),
        true,
      );
    });
    this.resizer.addEventListener('dblclick', () => setWidth(256, true));
    this.sidebar.appendChild(this.resizer);
  }
}
