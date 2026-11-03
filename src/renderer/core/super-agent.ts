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
  tokens: number;
  attempts: number;
  updatedAt: number;
  workerKey: string;
  mode: string;
};
type Interaction = { id: string; revision: number; kind: string; payload: Record<string, unknown> };
type Detail = {
  task: Task;
  events: { id: string; text: string; source: string; at: number }[];
  view: { pendingInteraction?: Interaction } | null;
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
  }>;
  language: () => string;
  subscribe: (fn: (event: unknown) => void) => unknown;
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class SuperAgentPanel {
  private root: HTMLElement;
  private offset = 0;
  private detailId = '';
  private loading = false;
  private again = false;
  private detail?: HTMLDialogElement;
  private status?: Status;
  private errorText = '';
  constructor(private options: Options) {
    this.root = document.getElementById('page-superagent')!;
    this.root.classList.add('superagent-page');
    this.root.innerHTML = `<div class="super-shell"><header class="super-heading"><div><span class="super-eyebrow">CIBYP</span><h1>SuperAgent</h1><p>${esc(this.t('subtitle'))}</p></div><div class="super-actions"><button data-refresh>${esc(this.t('refresh'))}</button><button data-pause>${esc(this.t('pause'))}</button></div></header><form class="super-composer"><textarea aria-label="${esc(this.t('new'))}" placeholder="${esc(this.t('placeholder'))}" maxlength="16000" required></textarea><footer><select name="mode" aria-label="Mode"><option value="chat">Chat</option><option value="code">Code</option></select><button type="submit">${esc(this.t('send'))}<span aria-hidden="true">↗</span></button></footer></form><p class="super-notice">${esc(this.t('notice'))}</p><p class="super-error" role="alert" hidden></p><div class="super-counts"></div><div class="super-tasks"></div><nav class="super-pagination"><button data-prev>${esc(this.t('previous'))}</button><button data-next>${esc(this.t('next'))}</button></nav><details class="super-preferences"><summary>${esc(this.t('settings'))}</summary><form data-preferences></form></details><details class="super-pending"><summary>${esc(this.t('pending'))}</summary><div data-events></div></details></div>`;
    this.root.querySelector<HTMLFormElement>('.super-composer')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.currentTarget as HTMLFormElement,
        area = form.querySelector('textarea')!,
        button = form.querySelector('button')!;
      const operationId = (form.dataset.operationId ||= crypto.randomUUID());
      button.disabled = true;
      void this.run(async () => {
        await this.call('submit', {
          text: area.value,
          mode: (form.elements.namedItem('mode') as HTMLSelectElement).value,
          operationId,
        });
        area.value = '';
        delete form.dataset.operationId;
        await this.refresh();
      }).finally(() => {
        button.disabled = false;
      });
    });
    this.root.querySelector('.super-composer textarea')!.addEventListener('input', () => {
      delete this.root.querySelector<HTMLElement>('.super-composer')!.dataset.operationId;
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
    options.subscribe((event) => {
      const e = event as { channel?: string; payload?: { type?: string } };
      if (e.channel === 'agent:session-event' && e.payload?.type === 'superagent') {
        if (
          this.detail?.open &&
          this.detailId &&
          !(
            this.detail.contains(document.activeElement) &&
            document.activeElement?.matches('input,textarea,select')
          )
        )
          void this.show(this.detailId, true);
        if (this.root.classList.contains('active')) void this.refresh();
      }
    });
    window.addEventListener('cibyp:page-changed', (e) => {
      if ((e as CustomEvent<{ page: string }>).detail?.page === 'superagent') void this.refresh();
    });
    void this.refresh();
  }
  private t(key: string): string {
    return superText(this.options.language(), key);
  }
  private taskSummary(task: Task): string {
    return [task.reason ? this.t(task.reason) : '', task.summary].filter(Boolean).join('\n\n');
  }
  private call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.options.request(action, input) as Promise<T>;
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
      const [status, page, events] = await Promise.all([
        this.call<Status>('status'),
        this.call<{ items: Task[]; next: number | null }>('list', {
          offset: this.offset,
          limit: 24,
        }),
        this.call<{ items: { id: string; text: string; status: string; reason?: string }[] }>(
          'events',
          { limit: 100 },
        ),
      ]);
      this.status = status;
      this.root.querySelector('[data-pause]')!.textContent = this.t(
        status.paused ? 'resume' : 'pause',
      );
      this.root.querySelector('.super-counts')!.innerHTML = Object.entries(status.counts)
        .map(([key, n]) => `<span data-state="${esc(key)}"><b>${n}</b>${esc(this.t(key))}</span>`)
        .join('');
      this.root.querySelector('.super-tasks')!.innerHTML = page.items.length
        ? page.items
            .map(
              (t) =>
                `<button class="super-task" data-task="${esc(t.id)}"><span class="super-state" data-state="${esc(t.status)}">${esc(this.t(t.status))}</span><h3>${esc(t.title)}</h3><p>${esc(this.taskSummary(t))}</p><footer><time>${esc(new Date(t.updatedAt).toLocaleString(this.options.language()))}</time><span>${esc(this.t('attempts'))} ${t.attempts}</span></footer></button>`,
            )
            .join('')
        : `<div class="super-empty">✦<p>${esc(this.t('empty'))}</p></div>`;
      this.root
        .querySelectorAll<HTMLElement>('[data-task]')
        .forEach((b) => (b.onclick = () => void this.run(() => this.show(b.dataset.task!))));
      const prev = this.root.querySelector<HTMLButtonElement>('[data-prev]')!,
        next = this.root.querySelector<HTMLButtonElement>('[data-next]')!;
      prev.disabled = this.offset === 0;
      next.disabled = page.next === null;
      prev.onclick = () => {
        this.offset = Math.max(0, this.offset - 24);
        void this.refresh();
      };
      next.onclick = () => {
        this.offset = page.next!;
        void this.refresh();
      };
      this.root.querySelector('[data-events]')!.innerHTML = events.items
        .filter((e) => ['pending', 'routing', 'needs_attention'].includes(e.status))
        .map(
          (e) =>
            `<article><p>${esc(e.text)}</p><small>${esc(this.t(e.reason || e.status))}</small>${e.status === 'needs_attention' ? `<button data-retry-event="${esc(e.id)}">${esc(this.t('retryEvent'))}</button>` : ''}</article>`,
        )
        .join('');
      this.root.querySelectorAll<HTMLElement>('[data-retry-event]').forEach(
        (b) =>
          (b.onclick = () =>
            void this.run(async () => {
              await this.call('retry-event', { id: b.dataset.retryEvent });
              await this.refresh();
            })),
      );
      if (!this.root.querySelector('[data-preferences]')!.hasChildNodes())
        await this.preferences(status);
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
  private async preferences(status: Status): Promise<void> {
    const s = await this.options.settings(),
      form = this.root.querySelector<HTMLFormElement>('[data-preferences]')!,
      c = status.config;
    form.innerHTML = `<div class="super-preference-grid">${['enabled', 'watchdog', 'proactive'].map((k) => `<label class="super-switch"><span>${esc(this.t(k))}</span><input type="checkbox" role="switch" name="${k}" ${c[k] ? 'checked' : ''}></label>`).join('')}${['maxWorkers', 'maxAttempts', 'maxTokens'].map((k, i) => `<label>${esc(this.t(k))}<input type="number" name="${k}" min="${i === 2 ? 1000 : 1}" max="${[8, 100, 10000000][i]}" value="${c[k]}" required></label>`).join('')}${[
      'routerModel',
      'workerModel',
    ]
      .map(
        (k) =>
          `<label>${esc(this.t(k))}<select name="${k}"><option value="">${esc(this.t('defaultModel'))}</option>${(
            s.llm?.pool || []
          )
            .filter((r) => r.enabled !== false)
            .map(
              (r) =>
                `<option value="${esc(r.id)}" ${r.id === c[k] ? 'selected' : ''}>${esc(r.label || r.model)}</option>`,
            )
            .join('')}</select></label>`,
      )
      .join(
        '',
      )}<label class="super-wide">${esc(this.t('rules'))}<textarea name="rules" maxlength="4000">${esc(c.rules)}</textarea></label><label class="super-wide">${esc(this.t('sources'))}<select name="sources" multiple>${['github', 'automation', 'notification'].map((v) => `<option ${(c.sources as string[]).includes(v) ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div><button type="submit">${esc(this.t('save'))}</button>`;
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.run(async () => {
        const values = new FormData(form),
          input: Record<string, unknown> = {
            rules: values.get('rules'),
            sources: values.getAll('sources'),
          };
        for (const k of ['enabled', 'watchdog', 'proactive']) input[k] = values.has(k);
        for (const k of ['maxWorkers', 'maxAttempts', 'maxTokens'])
          input[k] = Number(values.get(k));
        for (const k of ['routerModel', 'workerModel']) input[k] = values.get(k);
        await this.call('configure', input);
        await this.refresh();
      });
    };
  }
  private async show(id: string, refresh = false): Promise<void> {
    const data = await this.call<Detail>('get', { id });
    if (refresh && (!this.detail?.open || this.detailId !== id)) return;
    if (!refresh) {
      this.detail?.close();
      this.detail = document.createElement('dialog');
      this.detail.className = 'super-dialog';
      document.body.append(this.detail);
      this.detail.showModal();
      this.detailId = id;
      const dialog = this.detail;
      dialog.onclose = () => {
        dialog.remove();
        if (this.detail === dialog) this.detailId = '';
      };
    }
    const d = this.detail!,
      t = data.task;
    d.innerHTML = `<header><div><small>${esc(this.t(t.status))}</small><h2>${esc(t.title)}</h2></div><button data-close aria-label="${esc(this.t('close'))}">×</button></header><div class="super-detail-body"><p class="super-summary">${esc(this.taskSummary(t))}</p><div class="super-metrics"><span>${esc(this.t('attempts'))} ${t.attempts}</span><span>${esc(this.t('tokenUsage'))} ${t.tokens}</span></div>${t.evidence.length ? `<h3>${esc(this.t('evidence'))}</h3><ul>${t.evidence.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : ''}<section data-interaction></section><h3>${esc(this.t('activity'))}</h3>${data.events.map((e) => `<article class="super-input"><small>${esc(e.source)} · ${esc(new Date(e.at).toLocaleString(this.options.language()))}</small><p>${esc(e.text)}</p></article>`).join('')}<p data-error role="alert"></p></div><footer><button data-refresh-detail>${esc(this.t('refresh'))}</button>${t.status !== 'stopped' ? `<button data-stop>${esc(this.t('stop'))}</button>` : ''}${!['running', 'queued'].includes(t.status) ? `<button data-retry>${esc(this.t('retry'))}</button>` : ''}</footer>${t.status !== 'stopped' ? `<form class="super-followup"><textarea required placeholder="${esc(this.t('followup'))}" maxlength="16000"></textarea><button type="submit">${esc(this.t('add'))}</button></form>` : ''}`;
    const act = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await this.show(id, true);
        await this.refresh();
      } catch (e) {
        d.querySelector('[data-error]')!.textContent = String((e as Error).message || e);
      }
    };
    d.querySelector('[data-close]')!.addEventListener('click', () => d.close());
    d.querySelector('[data-refresh-detail]')!.addEventListener(
      'click',
      () => void act(async () => {}),
    );
    for (const action of ['stop', 'retry'])
      d.querySelector('[data-' + action + ']')?.addEventListener(
        'click',
        () => void act(() => this.call(action, { id, generation: t.generation })),
      );
    d.querySelector<HTMLFormElement>('.super-followup')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.currentTarget as HTMLFormElement;
      const operationId = (form.dataset.operationId ||= crypto.randomUUID());
      void act(() =>
        this.call('submit', {
          taskId: id,
          mode: t.mode,
          text: form.querySelector('textarea')!.value,
          operationId,
        }),
      );
    });
    if (data.view?.pendingInteraction)
      this.interaction(
        d.querySelector('[data-interaction]')!,
        id,
        data.view.pendingInteraction,
        act,
      );
  }
  private interaction(
    root: Element,
    id: string,
    pending: Interaction,
    act: (fn: () => Promise<unknown>) => Promise<void>,
  ): void {
    const payload = pending.payload;
    root.className = 'super-interaction';
    root.innerHTML = `<h3>${esc(this.t('interaction'))}</h3><p>${esc(payload.description || payload.message || payload.toolName || payload.tool || '')}</p>`;
    if (payload.args) {
      const args = document.createElement('pre');
      args.className = 'super-approval-args';
      args.textContent = JSON.stringify(payload.args, null, 2);
      root.append(args);
    }
    const reply = (response: unknown) =>
      this.call('respond', { id, interactionId: pending.id, revision: pending.revision, response });
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
      form.innerHTML =
        qs
          .map(
            (q, i) =>
              `<fieldset><legend>${esc(q.question || q.header)}</legend>${(q.options || []).map((o) => `<label><input type="${q.multiple || q.multi_select ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(o.label)}">${esc(o.label)} <small>${esc(o.description)}</small></label>`).join('')}<input name="text${i}" placeholder="${esc(this.t('questionPlaceholder'))}"></fieldset>`,
          )
          .join('') + `<button type="submit">${esc(this.t('questions'))}</button>`;
      form.onsubmit = (e) => {
        e.preventDefault();
        const values = new FormData(form);
        void act(() =>
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
      for (const [label, value] of [
        [this.t('deny'), pending.kind === 'tool-auth' ? 'deny' : false],
        [this.t('allow'), pending.kind === 'tool-auth' ? 'allow-once' : true],
      ] as const) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => void act(() => reply(value));
        root.append(b);
      }
    }
  }
}
