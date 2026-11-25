/* SPDX-License-Identifier: GPL-3.0-or-later */
import { superText } from '../../shared/super-agent-text';

type Task = {
  id: string;
  title: string;
  status: string;
  generation: number;
  summary: string;
  evidence: string[];
  reason?: string;
  watchdogNote?: string;
  observation?: boolean;
  tokens: number;
  attempts: number;
  updatedAt: number;
  createdAt?: number;
  workerKey: string;
  workspacePath?: string;
  hostWorkspacePath?: string;
  mode: string;
};

type Interaction = {
  id: string;
  revision: number;
  kind: string;
  payload: Record<string, unknown>;
};

type ViewMessage = {
  id?: string;
  role: string;
  name?: string;
  content?: string;
  reasoning?: string;
  reasoningKind?: string;
};

type SubAgentView = {
  id: string;
  task: string;
  status: string;
  iterations?: number;
  toolUseCount?: number;
};

type WorkerView = {
  pendingInteraction?: Interaction | null;
  displayMessages?: ViewMessage[];
  messages?: ViewMessage[];
  subAgents?: SubAgentView[];
  session?: { busy?: boolean; workspacePath?: string; model?: string };
};

type Detail = {
  task: Task;
  events: { id: string; text: string; source: string; at: number }[];
  view: WorkerView | null;
};

type Delivery = {
  id: string;
  taskId: string;
  generation: number;
  summary: string;
  status: string;
  at: number;
  read: boolean;
};

type PendingEvent = {
  id: string;
  text: string;
  status: string;
  reason?: string;
  at?: number;
};

type Status = {
  config: Record<string, unknown>;
  paused: boolean;
  error?: string;
  pending: number;
  counts: Record<string, number>;
};

type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  settings: () => Promise<{
    llm?: { pool?: { id: string; label?: string; model: string; enabled?: boolean }[] };
    runtime?: { location?: string };
    codeMode?: { lastWorkspace?: string };
  }>;
  language: () => string;
  subscribe: (fn: (event: unknown) => void) => unknown;
  markdown?: (text: string) => string;
  openWorkspace?: (dir: string) => Promise<unknown>;
  pickWorkspace?: (title?: string) => Promise<string | null>;
  pickHostWorkspace?: () => Promise<string | null>;
};

const workspaceBasename = (dir?: string): string => {
  if (!dir) return '';
  const trimmed = dir.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
};

const makeOperationId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const STATUS_ORDER: Record<string, number> = {
  needs_attention: 0,
  running: 1,
  queued: 2,
  waiting: 3,
  completed: 4,
  stopped: 5,
};

const SOURCE_OPTIONS = ['github', 'automation', 'notification'] as const;

const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const formatTokens = (n: number): string => {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
};

const formatRelative = (ts: number, lang: string): string => {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return new Date(ts).toLocaleDateString(lang);
};

const unwrapWorkerPrompt = (raw: string): { texts: string[]; isFollowup: boolean } | null => {
  const cleaned = raw.replace(/^【用户追加消息】/, '').trim();
  if (!cleaned.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(cleaned) as {
      superAgentInput?: boolean;
      events?: { text?: string }[];
      instruction?: string;
    };
    if (parsed.superAgentInput !== true || !Array.isArray(parsed.events)) return null;
    const texts = parsed.events
      .map((e) => (typeof e?.text === 'string' ? e.text.trim() : ''))
      .filter(Boolean);
    if (!texts.length) return null;
    return {
      texts,
      isFollowup: Boolean(parsed.instruction && /follow-?up/i.test(parsed.instruction)),
    };
  } catch {
    return null;
  }
};

export class SuperAgentPanel {
  private root: HTMLElement;
  private offset = 0;
  private selectedId = '';
  private selectedDetail: Detail | null = null;
  private tasks: Task[] = [];
  private nextOffset: number | null = null;
  private totalTasks = 0;
  private pendingEvents: PendingEvent[] = [];
  private deliveries: Delivery[] = [];
  private status?: Status;
  private filterState = 'all';
  private searchQuery = '';
  private sortMode: 'priority' | 'updated' = 'priority';
  private inspectorTab: 'config' | 'deliveries' | 'queue' = 'config';
  private inspectorOpen = true;
  private loading = false;
  private again = false;
  private errorText = '';
  private savedNotice = false;
  private lastInteractionKey = '';
  private followupDrafts = new Map<string, string>();
  private selectedSources = new Set<string>();
  private runtimeLocation: 'host' | 'vm' = 'host';

  constructor(private options: Options) {
    this.root = document.getElementById('page-superagent')!;
    this.root.classList.add('superagent-page');
    this.inspectorOpen = window.innerWidth >= 1180;
    this.mountShell();
    this.bindEvents();
    options.subscribe((event) => {
      const e = event as { type?: string; channel?: string; payload?: { type?: string } };
      const isSuperEvent =
        e?.type === 'superagent' ||
        (e?.channel === 'agent:session-event' && e?.payload?.type === 'superagent');
      if (isSuperEvent) {
        if (this.selectedId) void this.loadDetail(this.selectedId, true);
        if (this.root.classList.contains('active')) void this.refresh();
      }
    });
    window.addEventListener('cibyp:page-changed', (e) => {
      if ((e as CustomEvent<{ page: string }>).detail?.page === 'superagent') void this.refresh();
    });
    window.addEventListener('languagechange', () => {
      this.syncStaticLabels();
      this.renderAll();
      if (this.status) void this.preferences(this.status);
    });
    void this.refresh();
  }

  private t(key: string): string {
    return superText(this.options.language(), key);
  }

  private call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.options.request(action, input) as Promise<T>;
  }

  private taskSummary(task: Task): string {
    return [task.reason ? this.t(task.reason) : '', task.summary].filter(Boolean).join('\n\n');
  }

  private renderRichText(text: string): string {
    if (this.options.markdown) return this.options.markdown(text);
    return `<p class="super-plain-text">${esc(text)}</p>`;
  }

  private mountShell(): void {
    this.root.innerHTML = `
      <div class="super-shell" data-inspector="${this.inspectorOpen ? 'open' : 'closed'}">
        <header class="super-topbar">
          <div class="super-topbar-brand">
            <span class="super-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="6" height="6" rx="1.8"/><rect x="15" y="3" width="6" height="6" rx="1.8"/><rect x="15" y="15" width="6" height="6" rx="1.8"/><path d="M9 12h3V6h3M12 12v6h3"/></svg>
            </span>
            <div>
              <div class="super-brand-row">
                <h1>SuperAgent</h1>
                <span class="super-live-pill" data-live-pill></span>
              </div>
              <p class="super-subtitle" data-label="subtitle"></p>
            </div>
          </div>
          <div class="super-counts" role="toolbar"></div>
          <div class="super-actions">
            <button type="button" class="super-btn-primary" data-new-task><span aria-hidden="true">+</span><span data-label="new"></span></button>
            <button type="button" data-refresh data-label="refresh"></button>
            <button type="button" data-pause></button>
            <button type="button" class="super-btn-inspector" data-toggle-inspector aria-expanded="${this.inspectorOpen}">
              <span data-label="inspector"></span>
              <b class="super-inspector-badge" data-inspector-badge hidden>0</b>
            </button>
          </div>
        </header>

        <div class="super-body">
          <aside class="super-list-pane">
            <div class="super-list-controls">
              <label class="super-search-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
                <input type="search" data-task-search autocomplete="off" spellcheck="false">
              </label>
              <button type="button" class="super-sort-btn" data-sort-toggle></button>
            </div>
            <div class="super-filters" role="tablist"></div>
            <div class="super-tasks" role="listbox"></div>
            <nav class="super-pagination">
              <span class="super-total" data-total></span>
              <div class="super-page-btns">
                <button type="button" data-prev data-label="previous"></button>
                <button type="button" data-next data-label="next"></button>
              </div>
            </nav>
          </aside>

          <section class="super-stage-pane">
            <p class="super-error" role="alert" hidden></p>

            <div class="super-compose-stage" data-compose-stage>
              <div class="super-compose-inner">
                <div class="super-compose-head">
                  <span class="super-eyebrow">MISSION DISPATCH</span>
                  <h2 data-label="new"></h2>
                  <p data-label="subtitle"></p>
                </div>
                <form class="super-composer">
                  <textarea maxlength="16000" required></textarea>
                  <div class="super-workspace-bar" data-workspace-bar hidden>
                    <span class="super-workspace-env" data-workspace-env data-env="host"></span>
                    <label class="super-workspace-field">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
                      <input type="text" name="workspacePath" data-workspace-input autocomplete="off" spellcheck="false" maxlength="1024">
                      <button type="button" class="super-workspace-clear" data-clear-workspace hidden>×</button>
                    </label>
                    <div class="super-workspace-actions">
                      <button type="button" data-pick-workspace></button>
                      <button type="button" data-pick-host-workspace hidden></button>
                    </div>
                  </div>
                  <footer>
                    <div class="super-composer-left">
                      <select name="mode" aria-label="Mode">
                        <option value="chat">Chat</option>
                        <option value="code">Code</option>
                      </select>
                      <span class="super-kbd-hint" data-label="ctrlEnterHint"></span>
                    </div>
                    <button type="submit" class="super-btn-primary">
                      <span data-label="send"></span><span aria-hidden="true">↗</span>
                    </button>
                  </footer>
                </form>
                <div class="super-templates">
                  <div class="super-templates-label" data-label="templatesTitle"></div>
                  <div class="super-template-grid" data-template-grid></div>
                </div>
                <p class="super-notice" data-label="notice"></p>
              </div>
            </div>

            <div class="super-detail-stage" data-detail-stage hidden>
              <header class="super-detail-header" data-detail-header></header>
              <div class="super-detail-scroll">
                <div class="super-interaction-host" data-interaction-host></div>
                <div class="super-detail-content" data-detail-content></div>
              </div>
              <p class="super-detail-error" data-detail-error role="alert" hidden></p>
              <form class="super-followup" data-followup-form>
                <div class="super-followup-meta" data-followup-meta></div>
                <div class="super-followup-row">
                  <textarea required maxlength="16000" rows="2"></textarea>
                  <button type="submit" class="super-btn-primary" data-label="add"></button>
                </div>
              </form>
            </div>
          </section>

          <aside class="super-inspector-pane" data-inspector-pane>
            <div class="super-inspector-tabs" role="tablist">
              <button type="button" role="tab" data-insp-tab="config" aria-selected="true" data-label="settings"></button>
              <button type="button" role="tab" data-insp-tab="deliveries" aria-selected="false">
                <span data-label="deliveries"></span><b data-deliveries-badge hidden>0</b>
              </button>
              <button type="button" role="tab" data-insp-tab="queue" aria-selected="false">
                <span data-label="pending"></span><b data-queue-badge hidden>0</b>
              </button>
            </div>
            <div class="super-inspector-body">
              <div class="super-insp-panel" data-insp-panel="config">
                <form data-preferences></form>
              </div>
              <div class="super-insp-panel" data-insp-panel="deliveries" hidden>
                <div class="super-deliveries-list" data-deliveries></div>
              </div>
              <div class="super-insp-panel" data-insp-panel="queue" hidden>
                <div class="super-events-list" data-events></div>
              </div>
            </div>
          </aside>
        </div>
      </div>`;
    this.syncStaticLabels();
    this.renderTemplates();
  }

  private syncStaticLabels(): void {
    this.root.querySelectorAll<HTMLElement>('[data-label]').forEach((el) => {
      const key = el.dataset.label!;
      el.textContent = this.t(key);
    });
    const composeArea = this.root.querySelector<HTMLTextAreaElement>('.super-composer textarea')!;
    composeArea.setAttribute('aria-label', this.t('new'));
    composeArea.placeholder = this.t('placeholder');
    const searchInput = this.root.querySelector<HTMLInputElement>('[data-task-search]')!;
    searchInput.placeholder = this.t('searchTasks');
    searchInput.setAttribute('aria-label', this.t('searchTasks'));
    const followupArea = this.root.querySelector<HTMLTextAreaElement>('.super-followup textarea')!;
    followupArea.placeholder = this.t('followup');
    const sortBtn = this.root.querySelector<HTMLButtonElement>('[data-sort-toggle]')!;
    sortBtn.textContent = this.t(this.sortMode === 'priority' ? 'sortPriority' : 'sortUpdated');
    this.syncWorkspaceBar();
  }

  private syncWorkspaceBar(): void {
    const bar = this.root.querySelector<HTMLElement>('[data-workspace-bar]');
    const modeSelect = this.root.querySelector<HTMLSelectElement>(
      '.super-composer select[name="mode"]',
    );
    const input = this.root.querySelector<HTMLInputElement>('[data-workspace-input]');
    const clearBtn = this.root.querySelector<HTMLButtonElement>('[data-clear-workspace]');
    const envBadge = this.root.querySelector<HTMLElement>('[data-workspace-env]');
    const pickBtn = this.root.querySelector<HTMLButtonElement>('[data-pick-workspace]');
    const pickHostBtn = this.root.querySelector<HTMLButtonElement>('[data-pick-host-workspace]');
    if (!bar || !modeSelect || !input || !clearBtn || !envBadge || !pickBtn || !pickHostBtn) return;

    const isCode = modeSelect.value === 'code';
    const isVm = this.runtimeLocation === 'vm';
    bar.hidden = !isCode;
    bar.title = isVm ? this.t('workspaceVmHint') : '';
    input.placeholder = this.t('workspaceAutoPlaceholder');
    input.setAttribute('aria-label', this.t('workspaceLabel'));
    clearBtn.title = this.t('clearWorkspace');
    clearBtn.setAttribute('aria-label', this.t('clearWorkspace'));
    clearBtn.hidden = !input.value.trim();

    envBadge.dataset.env = isVm ? 'vm' : 'host';
    envBadge.textContent = this.t(isVm ? 'workspaceRuntimeVm' : 'workspaceRuntimeHost');

    if (isVm) {
      pickBtn.textContent = this.t('chooseVmWorkspace');
      pickBtn.hidden = !this.options.pickWorkspace;
      pickHostBtn.textContent = this.t('chooseHostWorkspace');
      pickHostBtn.hidden = !this.options.pickHostWorkspace;
    } else {
      pickBtn.textContent = this.t('chooseWorkspace');
      pickBtn.hidden = !(this.options.pickHostWorkspace || this.options.pickWorkspace);
      pickHostBtn.hidden = true;
    }
  }

  private renderTemplates(): void {
    const grid = this.root.querySelector<HTMLElement>('[data-template-grid]')!;
    const templates = [
      { key: 'Audit', mode: 'code' },
      { key: 'Research', mode: 'chat' },
      { key: 'Refactor', mode: 'code' },
      { key: 'Ops', mode: 'chat' },
    ];
    grid.innerHTML = templates
      .map(
        (tpl) => `
      <button type="button" class="super-template-card" data-tpl-mode="${tpl.mode}" data-tpl-prompt="${esc(this.t(`tpl${tpl.key}Prompt`))}">
        <span class="super-mode-tag" data-mode="${tpl.mode}">${tpl.mode.toUpperCase()}</span>
        <strong>${esc(this.t(`tpl${tpl.key}Title`))}</strong>
        <p>${esc(this.t(`tpl${tpl.key}Prompt`))}</p>
      </button>`,
      )
      .join('');
    grid.querySelectorAll<HTMLButtonElement>('.super-template-card').forEach((card) => {
      card.addEventListener('click', () => {
        const area = this.root.querySelector<HTMLTextAreaElement>('.super-composer textarea')!;
        const select = this.root.querySelector<HTMLSelectElement>(
          '.super-composer select[name="mode"]',
        )!;
        area.value = card.dataset.tplPrompt || '';
        select.value = card.dataset.tplMode || 'chat';
        this.syncWorkspaceBar();
        delete this.root.querySelector<HTMLElement>('.super-composer')!.dataset.operationId;
        area.focus();
      });
    });
  }

  private bindEvents(): void {
    const composer = this.root.querySelector<HTMLFormElement>('.super-composer')!;
    const composeArea = composer.querySelector<HTMLTextAreaElement>('textarea')!;
    const modeSelect = composer.querySelector<HTMLSelectElement>('select[name="mode"]')!;
    const workspaceInput = composer.querySelector<HTMLInputElement>('[data-workspace-input]')!;
    const clearWsBtn = composer.querySelector<HTMLButtonElement>('[data-clear-workspace]')!;
    const pickWsBtn = composer.querySelector<HTMLButtonElement>('[data-pick-workspace]')!;
    const pickHostWsBtn = composer.querySelector<HTMLButtonElement>('[data-pick-host-workspace]')!;

    modeSelect.addEventListener('change', () => {
      delete composer.dataset.operationId;
      this.syncWorkspaceBar();
    });
    workspaceInput.addEventListener('input', () => {
      delete composer.dataset.operationId;
      this.syncWorkspaceBar();
    });
    clearWsBtn.addEventListener('click', () => {
      workspaceInput.value = '';
      delete composer.dataset.operationId;
      this.syncWorkspaceBar();
      workspaceInput.focus();
    });
    pickWsBtn.addEventListener('click', () => {
      void this.run(async () => {
        const picker =
          this.runtimeLocation === 'vm'
            ? this.options.pickWorkspace
            : this.options.pickHostWorkspace || this.options.pickWorkspace;
        if (!picker) return;
        const chosen = await picker(
          this.t(this.runtimeLocation === 'vm' ? 'chooseVmWorkspace' : 'chooseWorkspace'),
        );
        if (chosen) {
          workspaceInput.value = chosen;
          delete composer.dataset.operationId;
          this.syncWorkspaceBar();
        }
      });
    });
    pickHostWsBtn.addEventListener('click', () => {
      void this.run(async () => {
        if (!this.options.pickHostWorkspace) return;
        const chosen = await this.options.pickHostWorkspace();
        if (chosen) {
          workspaceInput.value = chosen;
          delete composer.dataset.operationId;
          this.syncWorkspaceBar();
        }
      });
    });

    composer.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!composeArea.value.trim()) return;
      const button = composer.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const operationId = (composer.dataset.operationId ||= makeOperationId());
      const mode = modeSelect.value;
      const workspacePath = mode === 'code' ? workspaceInput.value.trim() : '';
      button.disabled = true;
      void this.run(async () => {
        const res = await this.call<{ taskId?: string }>('submit', {
          text: composeArea.value,
          mode,
          ...(workspacePath ? { workspacePath } : {}),
          operationId,
        });
        composeArea.value = '';
        delete composer.dataset.operationId;
        await this.refresh();
        if (res?.taskId) await this.selectTask(res.taskId);
      }).finally(() => {
        button.disabled = false;
      });
    });
    composeArea.addEventListener('input', () => {
      delete composer.dataset.operationId;
    });
    composeArea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        composer.requestSubmit();
      }
    });

    const followupForm = this.root.querySelector<HTMLFormElement>('[data-followup-form]')!;
    const followupArea = followupForm.querySelector<HTMLTextAreaElement>('textarea')!;
    followupArea.addEventListener('input', () => {
      delete followupForm.dataset.operationId;
      if (this.selectedId) this.followupDrafts.set(this.selectedId, followupArea.value);
    });
    followupArea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        followupForm.requestSubmit();
      }
    });
    followupForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const task = this.selectedDetail?.task;
      if (!task || !followupArea.value.trim()) return;
      const button = followupForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const operationId = (followupForm.dataset.operationId ||= makeOperationId());
      button.disabled = true;
      void this.actDetail(async () => {
        await this.call('submit', {
          taskId: task.id,
          mode: task.mode,
          text: followupArea.value,
          operationId,
        });
        followupArea.value = '';
        this.followupDrafts.delete(task.id);
        delete followupForm.dataset.operationId;
      }).finally(() => {
        button.disabled = false;
      });
    });

    this.root.querySelector('[data-new-task]')!.addEventListener('click', () => {
      this.clearSelection();
      composeArea.focus();
    });
    this.root.querySelector('[data-refresh]')!.addEventListener('click', () => void this.refresh());
    this.root.querySelector('[data-pause]')!.addEventListener(
      'click',
      () =>
        void this.run(async () => {
          await this.call(this.status?.paused ? 'resume' : 'pause');
          await this.refresh();
        }),
    );
    this.root.querySelector('[data-toggle-inspector]')!.addEventListener('click', () => {
      this.inspectorOpen = !this.inspectorOpen;
      this.syncInspectorState();
    });

    const searchInput = this.root.querySelector<HTMLInputElement>('[data-task-search]')!;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLocaleLowerCase();
      this.renderTaskList();
    });
    this.root.querySelector('[data-sort-toggle]')!.addEventListener('click', () => {
      this.sortMode = this.sortMode === 'priority' ? 'updated' : 'priority';
      this.syncStaticLabels();
      this.renderTaskList();
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-insp-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.inspectorTab = tab.dataset.inspTab as 'config' | 'deliveries' | 'queue';
        this.syncInspectorTabs();
      });
    });

    this.root.querySelector<HTMLElement>('.super-tasks')!.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...this.root.querySelectorAll<HTMLButtonElement>('.super-task[data-task]')];
      if (!items.length) return;
      e.preventDefault();
      const idx = items.findIndex((el) => el === document.activeElement);
      const nextIdx =
        idx < 0 ? 0 : (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      const target = items[nextIdx];
      if (!target) return;
      target.focus();
      if (target.dataset.task) void this.selectTask(target.dataset.task);
    });
  }

  private syncInspectorState(): void {
    const shell = this.root.querySelector<HTMLElement>('.super-shell')!;
    const btn = this.root.querySelector<HTMLButtonElement>('[data-toggle-inspector]')!;
    shell.dataset.inspector = this.inspectorOpen ? 'open' : 'closed';
    btn.setAttribute('aria-expanded', String(this.inspectorOpen));
  }

  private syncInspectorTabs(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-insp-tab]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.inspTab === this.inspectorTab));
    });
    this.root.querySelectorAll<HTMLElement>('[data-insp-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.inspPanel !== this.inspectorTab;
    });
  }

  private async run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      this.errorText = '';
    } catch (e) {
      this.errorText = String((e as Error).message || e);
    }
    this.renderError();
  }

  private async actDetail(fn: () => Promise<unknown>): Promise<void> {
    const errEl = this.root.querySelector<HTMLElement>('[data-detail-error]')!;
    try {
      await fn();
      errEl.hidden = true;
      errEl.textContent = '';
      if (this.selectedId) await this.loadDetail(this.selectedId, true);
      await this.refresh();
    } catch (e) {
      errEl.textContent = this.t(String((e as Error).message || e));
      errEl.hidden = false;
    }
  }

  private renderError(): void {
    const n = this.root.querySelector<HTMLElement>('.super-error')!;
    n.hidden = !this.errorText;
    n.textContent = this.t(this.errorText);
  }

  async refresh(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    try {
      const [status, page, events, deliveriesRes, appSettings] = await Promise.all([
        this.call<Status>('status'),
        this.call<{ items: Task[]; total?: number; next: number | null }>('list', {
          offset: this.offset,
          limit: 40,
        }),
        this.call<{ items: PendingEvent[] }>('events', { limit: 100 }),
        this.call<{ items?: Delivery[] }>('deliveries', { limit: 40 }).catch(() => ({ items: [] })),
        this.options.settings().catch(() => null),
      ]);
      if (appSettings?.runtime?.location) {
        this.runtimeLocation = appSettings.runtime.location === 'vm' ? 'vm' : 'host';
        this.syncWorkspaceBar();
      }
      this.status = status;
      this.tasks = Array.isArray(page?.items) ? page.items : [];
      this.totalTasks = typeof page?.total === 'number' ? page.total : this.tasks.length;
      this.nextOffset = page?.next ?? null;
      this.pendingEvents = Array.isArray(events?.items)
        ? events.items.filter((e) => ['pending', 'routing', 'needs_attention'].includes(e.status))
        : [];
      this.deliveries = Array.isArray(deliveriesRes?.items) ? deliveriesRes.items : [];

      this.renderAll();

      if (!this.root.querySelector('[data-preferences]')!.hasChildNodes()) {
        await this.preferences(status);
      }
      if (this.selectedId) {
        const stillExists = this.tasks.some((t) => t.id === this.selectedId);
        if (stillExists) void this.loadDetail(this.selectedId, true);
      }
      this.errorText = status.error || '';
      this.renderError();
    } catch (e) {
      this.errorText = String((e as Error).message || e);
      this.renderError();
    } finally {
      this.loading = false;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    }
  }

  private renderAll(): void {
    const status = this.status;
    if (!status) return;
    const pauseBtn = this.root.querySelector<HTMLButtonElement>('[data-pause]')!;
    pauseBtn.textContent = this.t(status.paused ? 'resume' : 'pause');

    const livePill = this.root.querySelector<HTMLElement>('[data-live-pill]')!;
    const running = status.counts?.running || 0;
    const maxWorkers = Number(status.config?.maxWorkers || 2);
    livePill.dataset.state = status.paused ? 'paused' : running > 0 ? 'running' : 'idle';
    livePill.textContent = status.paused
      ? this.t('pausedBadge')
      : `${this.t('liveBadge')} · ${running}/${maxWorkers} ${this.t('activeWorkers')}`;

    // Topbar clickable status counts
    const countsEl = this.root.querySelector<HTMLElement>('.super-counts')!;
    countsEl.innerHTML = Object.entries(status.counts || {})
      .map(
        ([key, n]) =>
          `<button type="button" class="super-count-chip${this.filterState === key ? ' active' : ''}" data-state="${esc(key)}" data-filter="${esc(key)}"><b>${n}</b><span>${esc(this.t(key))}</span></button>`,
      )
      .join('');
    countsEl.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const state = chip.dataset.filter!;
        this.filterState = this.filterState === state ? 'all' : state;
        this.renderAll();
      });
    });

    // Left sidebar filter strip
    const filterKeys = ['all', 'needs_attention', 'running', 'queued', 'completed', 'stopped'];
    const filtersEl = this.root.querySelector<HTMLElement>('.super-filters')!;
    filtersEl.innerHTML = filterKeys
      .map((key) => {
        const count = key === 'all' ? this.totalTasks : Number((status.counts || {})[key] || 0);
        return `<button type="button" role="tab" class="super-filter-pill${this.filterState === key ? ' active' : ''}" data-filter="${key}" data-state="${key}" aria-selected="${this.filterState === key}"><span>${esc(this.t(key))}</span><b>${count}</b></button>`;
      })
      .join('');
    filtersEl.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((pill) => {
      pill.addEventListener('click', () => {
        this.filterState = pill.dataset.filter!;
        this.renderAll();
      });
    });

    // Badges
    const unreadDeliveries = this.deliveries.filter((d) => !d.read).length;
    const queueCount = this.pendingEvents.length;
    const totalAlerts = unreadDeliveries + queueCount;
    const inspBadge = this.root.querySelector<HTMLElement>('[data-inspector-badge]')!;
    inspBadge.hidden = totalAlerts === 0;
    inspBadge.textContent = String(totalAlerts);
    const delBadge = this.root.querySelector<HTMLElement>('[data-deliveries-badge]')!;
    delBadge.hidden = unreadDeliveries === 0;
    delBadge.textContent = String(unreadDeliveries);
    const qBadge = this.root.querySelector<HTMLElement>('[data-queue-badge]')!;
    qBadge.hidden = queueCount === 0;
    qBadge.textContent = String(queueCount);

    this.renderTaskList();
    this.renderQueue();
    this.renderDeliveries();
  }

  private renderTaskList(): void {
    const lang = this.options.language();
    const list = this.root.querySelector<HTMLElement>('.super-tasks')!;
    const filtered = this.tasks
      .filter((t) => this.filterState === 'all' || t.status === this.filterState)
      .filter((t) => {
        if (!this.searchQuery) return true;
        return (
          t.title.toLocaleLowerCase().includes(this.searchQuery) ||
          t.summary.toLocaleLowerCase().includes(this.searchQuery) ||
          t.id.toLocaleLowerCase().includes(this.searchQuery)
        );
      })
      .slice()
      .sort((a, b) => {
        if (this.sortMode === 'priority') {
          const pa = STATUS_ORDER[a.status] ?? 9;
          const pb = STATUS_ORDER[b.status] ?? 9;
          if (pa !== pb) return pa - pb;
        }
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });

    if (!filtered.length) {
      const msg = this.tasks.length ? this.t('noMatchingTasks') : this.t('empty');
      list.innerHTML = `<div class="super-empty"><span>✦</span><p>${esc(msg)}</p></div>`;
    } else {
      list.innerHTML = filtered
        .map(
          (t) => `
          <button type="button" role="option" class="super-task${this.selectedId === t.id ? ' active' : ''}" data-task="${esc(t.id)}" data-state="${esc(t.status)}" aria-selected="${this.selectedId === t.id}">
            <div class="super-task-top">
              <span class="super-state" data-state="${esc(t.status)}"><i class="super-dot"></i>${esc(this.t(t.status))}</span>
              <span class="super-mode-tag" data-mode="${esc(t.mode)}">${esc(t.mode.toUpperCase())}</span>
              ${t.mode === 'code' && t.workspacePath ? `<span class="super-ws-tag" title="${esc(t.workspacePath)}">${esc(workspaceBasename(t.workspacePath))}</span>` : ''}
              ${t.observation ? `<span class="super-ro-tag">${esc(this.t('readonlyBadge'))}</span>` : ''}
            </div>
            <h3>${esc(t.title)}</h3>
            <p>${esc(this.taskSummary(t))}</p>
            <footer>
              <time>${esc(formatRelative(t.updatedAt, lang))}</time>
              <span>${esc(this.t('attempts'))} ${t.attempts}</span>
              <span>${esc(formatTokens(t.tokens))} tok</span>
            </footer>
          </button>`,
        )
        .join('');
      list.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((btn) => {
        btn.addEventListener(
          'click',
          () => void this.run(() => this.selectTask(btn.dataset.task!)),
        );
      });
    }

    const totalEl = this.root.querySelector<HTMLElement>('[data-total]')!;
    totalEl.textContent = `${filtered.length} / ${this.totalTasks}`;
    const prev = this.root.querySelector<HTMLButtonElement>('[data-prev]')!;
    const next = this.root.querySelector<HTMLButtonElement>('[data-next]')!;
    prev.disabled = this.offset === 0;
    next.disabled = this.nextOffset === null;
    prev.onclick = () => {
      this.offset = Math.max(0, this.offset - 40);
      void this.refresh();
    };
    next.onclick = () => {
      if (this.nextOffset !== null) {
        this.offset = this.nextOffset;
        void this.refresh();
      }
    };
  }

  private renderQueue(): void {
    const container = this.root.querySelector<HTMLElement>('[data-events]')!;
    if (!this.pendingEvents.length) {
      container.innerHTML = `<p class="super-insp-empty">${esc(this.t('noPendingEvents'))}</p>`;
      return;
    }
    container.innerHTML = this.pendingEvents
      .map(
        (e) => `
        <article class="super-queue-card" data-state="${esc(e.status)}">
          <p>${esc(e.text)}</p>
          <footer>
            <small>${esc(this.t(e.reason || e.status))}</small>
            ${e.status === 'needs_attention' ? `<button type="button" data-retry-event="${esc(e.id)}">${esc(this.t('retryEvent'))}</button>` : ''}
          </footer>
        </article>`,
      )
      .join('');
    container.querySelectorAll<HTMLButtonElement>('[data-retry-event]').forEach((btn) => {
      btn.addEventListener(
        'click',
        () =>
          void this.run(async () => {
            await this.call('retry-event', { id: btn.dataset.retryEvent });
            await this.refresh();
          }),
      );
    });
  }

  private renderDeliveries(): void {
    const lang = this.options.language();
    const container = this.root.querySelector<HTMLElement>('[data-deliveries]')!;
    if (!this.deliveries.length) {
      container.innerHTML = `<p class="super-insp-empty">${esc(this.t('noDeliveries'))}</p>`;
      return;
    }
    container.innerHTML = this.deliveries
      .map(
        (d) => `
        <article class="super-delivery-card${d.read ? '' : ' unread'}" data-state="${esc(d.status)}">
          <header>
            <span class="super-state" data-state="${esc(d.status)}">${esc(this.t(d.status))}</span>
            <time>${esc(formatRelative(d.at, lang))}</time>
          </header>
          <p>${esc(this.t(d.summary))}</p>
          <footer>
            <button type="button" data-open-task="${esc(d.taskId)}">${esc(this.t('activity'))}</button>
            ${!d.read ? `<button type="button" data-ack="${esc(d.id)}">${esc(this.t('markRead'))}</button>` : ''}
          </footer>
        </article>`,
      )
      .join('');
    container.querySelectorAll<HTMLButtonElement>('[data-open-task]').forEach((btn) => {
      btn.addEventListener(
        'click',
        () => void this.run(() => this.selectTask(btn.dataset.openTask!)),
      );
    });
    container.querySelectorAll<HTMLButtonElement>('[data-ack]').forEach((btn) => {
      btn.addEventListener(
        'click',
        () =>
          void this.run(async () => {
            await this.call('ack', { id: btn.dataset.ack });
            await this.refresh();
          }),
      );
    });
  }

  private async preferences(status: Status): Promise<void> {
    const s = await this.options.settings();
    const form = this.root.querySelector<HTMLFormElement>('[data-preferences]')!;
    const c = status.config;
    const activeSources = Array.isArray(c.sources) ? (c.sources as string[]) : [];
    this.selectedSources = new Set(activeSources);

    form.innerHTML = `
      <div class="super-pref-group">
        ${['enabled', 'watchdog', 'proactive']
          .map(
            (k) =>
              `<label class="super-switch"><span>${esc(this.t(k))}</span><input type="checkbox" role="switch" name="${k}" ${c[k] ? 'checked' : ''}></label>`,
          )
          .join('')}
      </div>
      <div class="super-pref-group">
        ${['routerModel', 'workerModel']
          .map(
            (k) => `
          <label class="super-field">
            <span>${esc(this.t(k))}</span>
            <select name="${k}">
              <option value="">${esc(this.t('defaultModel'))}</option>
              ${(s.llm?.pool || [])
                .filter((r) => r.enabled !== false)
                .map(
                  (r) =>
                    `<option value="${esc(r.id)}" ${r.id === c[k] ? 'selected' : ''}>${esc(r.label || r.model)}</option>`,
                )
                .join('')}
            </select>
          </label>`,
          )
          .join('')}
      </div>
      <div class="super-pref-grid">
        ${['maxWorkers', 'maxAttempts', 'maxTokens']
          .map(
            (k, i) => `
          <label class="super-field">
            <span>${esc(this.t(k))}</span>
            <input type="number" name="${k}" min="${i === 2 ? 1000 : 1}" max="${[8, 100, 10000000][i]}" value="${c[k]}" required>
          </label>`,
          )
          .join('')}
      </div>
      <div class="super-pref-group">
        <label class="super-field">
          <span>${esc(this.t('rules'))}</span>
          <textarea name="rules" rows="3" maxlength="4000">${esc(c.rules)}</textarea>
        </label>
        <div class="super-field">
          <span>${esc(this.t('sources'))}</span>
          <div class="super-source-chips">
            ${SOURCE_OPTIONS.map(
              (src) =>
                `<button type="button" class="super-source-chip" data-source="${src}" aria-pressed="${this.selectedSources.has(src)}">${src}</button>`,
            ).join('')}
          </div>
        </div>
      </div>
      <div class="super-pref-footer">
        <button type="submit" class="super-btn-primary">${esc(this.t('save'))}</button>
        <span class="super-saved-badge" data-saved-badge ${this.savedNotice ? '' : 'hidden'}>${esc(this.t('saved'))}</span>
      </div>`;

    form.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const src = chip.dataset.source!;
        if (this.selectedSources.has(src)) this.selectedSources.delete(src);
        else this.selectedSources.add(src);
        chip.setAttribute('aria-pressed', String(this.selectedSources.has(src)));
      });
    });

    form.onsubmit = (e) => {
      e.preventDefault();
      void this.run(async () => {
        const values = new FormData(form);
        const input: Record<string, unknown> = {
          rules: values.get('rules'),
          sources: [...this.selectedSources],
        };
        for (const k of ['enabled', 'watchdog', 'proactive']) input[k] = values.has(k);
        for (const k of ['maxWorkers', 'maxAttempts', 'maxTokens'])
          input[k] = Number(values.get(k));
        for (const k of ['routerModel', 'workerModel']) input[k] = values.get(k);
        await this.call('configure', input);
        this.savedNotice = true;
        const badge = form.querySelector<HTMLElement>('[data-saved-badge]');
        if (badge) {
          badge.hidden = false;
          setTimeout(() => {
            this.savedNotice = false;
            badge.hidden = true;
          }, 2200);
        }
        await this.refresh();
      });
    };
  }

  private clearSelection(): void {
    this.selectedId = '';
    this.selectedDetail = null;
    this.lastInteractionKey = '';
    this.root.querySelector<HTMLElement>('[data-compose-stage]')!.hidden = false;
    this.root.querySelector<HTMLElement>('[data-detail-stage]')!.hidden = true;
    this.renderTaskList();
  }

  private async selectTask(id: string): Promise<void> {
    const prevId = this.selectedId;
    this.selectedId = id;
    this.lastInteractionKey = '';
    this.root.querySelector<HTMLElement>('[data-compose-stage]')!.hidden = true;
    this.root.querySelector<HTMLElement>('[data-detail-stage]')!.hidden = false;
    const followupArea = this.root.querySelector<HTMLTextAreaElement>('.super-followup textarea')!;
    if (prevId !== id) {
      followupArea.value = this.followupDrafts.get(id) || '';
      delete this.root.querySelector<HTMLElement>('[data-followup-form]')!.dataset.operationId;
    }
    this.renderTaskList();
    await this.loadDetail(id, false);
  }

  private async loadDetail(id: string, refresh: boolean): Promise<void> {
    const data = await this.call<Detail>('get', { id });
    if (this.selectedId !== id) return;
    this.selectedDetail = data;
    this.renderDetail(data, refresh);
  }

  private renderDetail(data: Detail, refresh: boolean): void {
    const t = data.task;
    const lang = this.options.language();
    const header = this.root.querySelector<HTMLElement>('[data-detail-header]')!;
    const wsPath =
      t.workspacePath || data.view?.session?.workspacePath || t.hostWorkspacePath || '';

    header.innerHTML = `
      <div class="super-detail-title">
        <div class="super-detail-badges">
          <button type="button" class="super-back-btn" data-close-detail>← ${esc(this.t('back'))}</button>
          <span class="super-state" data-state="${esc(t.status)}"><i class="super-dot"></i>${esc(this.t(t.status))}</span>
          <span class="super-mode-tag" data-mode="${esc(t.mode)}">${esc(t.mode.toUpperCase())}</span>
          ${t.mode === 'code' && wsPath ? `<span class="super-ws-tag" title="${esc(wsPath)}">${esc(workspaceBasename(wsPath))}</span>` : ''}
          ${t.observation ? `<span class="super-ro-tag">${esc(this.t('readonlyBadge'))}</span>` : ''}
          <code class="super-task-id">#${esc(t.id.slice(0, 8))}</code>
        </div>
        <h2>${esc(t.title)}</h2>
        <div class="super-metrics">
          <span>${esc(this.t('attempts'))} <b>${t.attempts}</b></span>
          <span>${esc(this.t('tokenUsage'))} <b>${esc(formatTokens(t.tokens))}</b></span>
          <span>${esc(this.t('generation'))} <b>v${t.generation}</b></span>
          <time>${esc(new Date(t.updatedAt).toLocaleString(lang))}</time>
        </div>
      </div>
      <div class="super-detail-actions">
        ${wsPath && this.options.openWorkspace ? `<button type="button" data-open-ws title="${esc(wsPath)}">${esc(this.t('openWorkspace'))}</button>` : ''}
        <button type="button" data-refresh-detail>${esc(this.t('refresh'))}</button>
        ${!['running', 'queued'].includes(t.status) ? `<button type="button" class="super-btn-primary" data-retry>${esc(this.t('retry'))}</button>` : ''}
        ${t.status !== 'stopped' ? `<button type="button" class="super-btn-danger" data-stop>${esc(this.t('stop'))}</button>` : ''}
      </div>`;

    header.querySelector('[data-close-detail]')!.addEventListener('click', () => {
      this.clearSelection();
    });
    header
      .querySelector('[data-refresh-detail]')!
      .addEventListener('click', () => void this.actDetail(async () => {}));
    header.querySelector('[data-open-ws]')?.addEventListener(
      'click',
      () =>
        void this.actDetail(async () => {
          if (wsPath) await this.options.openWorkspace?.(wsPath);
        }),
    );
    for (const action of ['stop', 'retry']) {
      header
        .querySelector(`[data-${action}]`)
        ?.addEventListener(
          'click',
          () =>
            void this.actDetail(() => this.call(action, { id: t.id, generation: t.generation })),
        );
    }

    // Inline interaction (never overwrite active questionnaire input during background refresh)
    const interactionHost = this.root.querySelector<HTMLElement>('[data-interaction-host]')!;
    const pending = data.view?.pendingInteraction || null;
    const interactionKey = pending ? `${pending.id}:${pending.revision}` : '';
    const editingInteraction =
      refresh &&
      interactionHost.contains(document.activeElement) &&
      document.activeElement?.matches('input,textarea,select') &&
      interactionKey === this.lastInteractionKey;
    if (!editingInteraction) {
      this.lastInteractionKey = interactionKey;
      interactionHost.innerHTML = '';
      if (pending) {
        const card = document.createElement('section');
        this.renderInteraction(card, t.id, pending);
        interactionHost.append(card);
      }
    }

    // Main detail body (report, subagents, live stream, input events)
    const content = this.root.querySelector<HTMLElement>('[data-detail-content]')!;
    const parts: string[] = [];

    const summaryText = this.taskSummary(t);
    if (summaryText || t.evidence.length || t.watchdogNote) {
      parts.push(`
        <section class="super-report-card" data-state="${esc(t.status)}">
          <header>
            <h3>${esc(this.t('evidence'))}</h3>
            <span class="super-state" data-state="${esc(t.status)}">${esc(this.t(t.status))}</span>
          </header>
          ${summaryText ? `<div class="super-summary">${this.renderRichText(summaryText)}</div>` : ''}
          ${
            t.evidence.length
              ? `<ul class="super-evidence-list">${t.evidence.map((v) => `<li><code>✓</code><span>${esc(v)}</span></li>`).join('')}</ul>`
              : ''
          }
          ${
            t.watchdogNote
              ? `<div class="super-watchdog-note"><strong>${esc(this.t('watchdogNote'))}</strong><p>${esc(t.watchdogNote)}</p></div>`
              : ''
          }
        </section>`);
    }

    const subAgents = data.view?.subAgents || [];
    if (subAgents.length) {
      parts.push(`
        <section class="super-section">
          <h3>${esc(this.t('subagents'))} <span>${subAgents.length}</span></h3>
          <div class="super-subagents">
            ${subAgents
              .map(
                (sa) => `
              <article class="super-subagent-card" data-state="${esc(sa.status)}">
                <header><strong>${esc(sa.task)}</strong><span class="super-state" data-state="${esc(sa.status)}">${esc(sa.status)}</span></header>
                <footer><span>${esc(this.t('attempts'))} ${sa.iterations || 0}</span><span>${esc(this.t('toolOutput'))} ${sa.toolUseCount || 0}</span></footer>
              </article>`,
              )
              .join('')}
          </div>
        </section>`);
    }

    const viewMessages = data.view?.displayMessages || data.view?.messages || [];
    if (viewMessages.length) {
      parts.push(`
        <section class="super-section">
          <h3>${esc(this.t('liveStream'))} <span>${viewMessages.length}</span></h3>
          <div class="super-messages">
            ${viewMessages.map((m) => this.renderStreamMessage(m)).join('')}
          </div>
        </section>`);
    }

    if (data.events.length) {
      const eventRows = data.events
        .map(
          (ev) => `
          <article class="super-input">
            <header><span class="super-source-tag">${esc(ev.source)}</span><time>${esc(new Date(ev.at).toLocaleString(lang))}</time></header>
            <p>${esc(ev.text)}</p>
          </article>`,
        )
        .join('');
      if (viewMessages.length) {
        parts.push(`
          <details class="super-raw-events">
            <summary>${esc(this.t('rawInputs'))} (${data.events.length})</summary>
            <div>${eventRows}</div>
          </details>`);
      } else {
        parts.push(`
          <section class="super-section">
            <h3>${esc(this.t('activity'))} <span>${data.events.length}</span></h3>
            <div class="super-events-timeline">${eventRows}</div>
          </section>`);
      }
    }

    content.innerHTML = parts.join('');

    // Follow-up form visibility & hint (never reset textarea value during refresh)
    const followupForm = this.root.querySelector<HTMLFormElement>('[data-followup-form]')!;
    followupForm.hidden = t.status === 'stopped';
    const meta = this.root.querySelector<HTMLElement>('[data-followup-meta]')!;
    meta.textContent = t.status === 'running' ? this.t('hotFollowupHint') : this.t('ctrlEnterHint');
  }

  private renderStreamMessage(m: ViewMessage): string {
    if (m.role === 'system') return '';
    if (m.role === 'tool') {
      const preview = String(m.content || '').slice(0, 2400);
      return `
        <details class="super-step super-step-tool">
          <summary><span class="super-step-badge">TOOL</span><code>${esc(m.name || 'tool')}</code></summary>
          <pre>${esc(preview)}${String(m.content || '').length > 2400 ? '\n…' : ''}</pre>
        </details>`;
    }
    if (m.role === 'user') {
      const raw = String(m.content || '');
      const unwrapped = unwrapWorkerPrompt(raw);
      const body = unwrapped ? unwrapped.texts.join('\n\n') : raw;
      return `
        <article class="super-msg super-msg-user">
          <header>
            <strong>USER</strong>
            ${unwrapped?.isFollowup ? `<span class="super-followup-tag">${esc(this.t('followupTag'))}</span>` : ''}
          </header>
          <div class="super-msg-body"><p>${esc(body)}</p></div>
        </article>`;
    }
    const reasoningBlock = m.reasoning
      ? `<details class="super-step super-step-reasoning"><summary><span class="super-step-badge">THINK</span><span>${esc(this.t('reasoning'))}</span></summary><div class="super-reasoning-body">${this.renderRichText(m.reasoning)}</div></details>`
      : '';
    const contentHtml = m.content ? this.renderRichText(String(m.content)) : '';
    if (!reasoningBlock && !contentHtml) return '';
    return `
      <article class="super-msg super-msg-assistant">
        <header><strong>WORKER</strong></header>
        ${reasoningBlock}
        ${contentHtml ? `<div class="super-msg-body markdown-body">${contentHtml}</div>` : ''}
      </article>`;
  }

  private renderInteraction(root: HTMLElement, id: string, pending: Interaction): void {
    const payload = pending.payload || {};
    root.className = 'super-interaction';
    root.innerHTML = `
      <header class="super-interaction-head">
        <span class="super-interaction-dot"></span>
        <h3>${esc(this.t('interaction'))}</h3>
        ${payload.toolName || payload.tool ? `<code>${esc(payload.toolName || payload.tool)}</code>` : ''}
      </header>
      <p class="super-interaction-desc">${esc(payload.description || payload.message || payload.toolName || payload.tool || '')}</p>`;

    if (payload.args) {
      const args = document.createElement('pre');
      args.className = 'super-approval-args';
      args.textContent = JSON.stringify(payload.args, null, 2);
      root.append(args);
    }

    const reply = (response: unknown) =>
      this.call('respond', {
        id,
        interactionId: pending.id,
        revision: pending.revision,
        response,
      });

    if (pending.kind === 'questions') {
      const qs = (payload.questions || []) as {
        id: string;
        question?: string;
        header?: string;
        options?: { label: string; description?: string }[];
        multi_select?: boolean;
        multiple?: boolean;
      }[];
      const form = document.createElement('form');
      form.className = 'super-question-form';
      form.innerHTML =
        qs
          .map(
            (q, i) => `
          <fieldset>
            <legend>${esc(q.question || q.header)}</legend>
            <div class="super-q-options">
              ${(q.options || [])
                .map(
                  (o) =>
                    `<label class="super-q-option"><input type="${q.multiple || q.multi_select ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(o.label)}"><span><strong>${esc(o.label)}</strong>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`,
                )
                .join('')}
            </div>
            <input name="text${i}" placeholder="${esc(this.t('questionPlaceholder'))}">
          </fieldset>`,
          )
          .join('') +
        `<div class="super-interaction-actions"><button type="submit" class="super-btn-primary">${esc(this.t('questions'))}</button></div>`;
      form.onsubmit = (e) => {
        e.preventDefault();
        const values = new FormData(form);
        void this.actDetail(() =>
          reply({
            answers: qs.map((q, i) => ({
              id: q.id,
              selected: values.getAll('q' + i),
              custom: values.get('text' + i),
            })),
          }),
        );
      };
      root.append(form);
    } else {
      // Existing runtime approval policy is authoritative; permission decisions are once-only.
      const bar = document.createElement('div');
      bar.className = 'super-interaction-actions';
      for (const [label, value, cls] of [
        [this.t('deny'), pending.kind === 'tool-auth' ? 'deny' : false, 'super-btn-ghost'],
        [this.t('allow'), pending.kind === 'tool-auth' ? 'allow-once' : true, 'super-btn-primary'],
      ] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = label;
        b.onclick = () => void this.actDetail(() => reply(value));
        bar.append(b);
      }
      root.append(bar);
    }
  }
}
