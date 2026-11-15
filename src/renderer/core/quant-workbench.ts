/* SPDX-License-Identifier: GPL-3.0-or-later */
import type {
  Candle,
  QuantChatView,
  QuantBaseTrade,
  QuantBaseRecorder,
  QuantDataset,
  QuantRun,
  QuantSummary,
  QuantWorkspace,
  QuantNativeStatus,
  QuantNativeSource,
  QuantNativeBook,
} from '../../shared/quant-types';
import { QuantChart } from './quant-chart';
import { openNativePaper } from './quant-native-paper';
import { openStrategies } from './quant-strategies';
import { openEventData } from './quant-events';
import { openLiveExecution } from './quant-execution';
import { quantText, type QuantLabel } from './quant-text';
import { executionAmount, signedAmount } from '../../shared/quant-execution-format';
import { approvalCard, type WalletIntent } from './wallet-panel';

type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  backend: (method: string, ...args: unknown[]) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
  language: () => string;
  markdown: (text: string) => string;
};
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const paths: Record<string, string> = {
  chart: '<path d="M4 3v17h17M8 12v4m4-9v6m4-9v12m4-8v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 8A8 8 0 1 0 20 16M20 3v5h-5"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0Z"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4"/>',
  download: '<path d="M12 3v14m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
};
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chart}</svg>`;

export class QuantWorkbench {
  private workspace?: QuantWorkspace;
  private projects: QuantSummary[] = [];
  private currentId = '';
  private tab = 'experiments';
  private offset = 0;
  private selectedRun?: QuantRun;
  private chat?: QuantChatView;
  private stream = '';
  private chatLimit = 100;
  private active = false;
  private refreshBusy = false;
  private chatBusy = false;
  private marketLoading = false;
  private nativeGeneration = 0;
  private chartData = new Map<string, Candle[]>();
  private eventTimer?: ReturnType<typeof setTimeout>;
  private chatTimer?: ReturnType<typeof setTimeout>;
  private readonly chart: QuantChart;
  private readonly root: HTMLElement;
  private readonly chartCard: HTMLElement;
  private focusExpanded = false;
  constructor(private readonly options: Options) {
    this.root = document.getElementById('page-quant')!;
    this.root.innerHTML = this.template();
    this.root
      .querySelector('.quant-top-actions')!
      .insertAdjacentHTML('afterbegin', this.button('leTitle', 'live-execution', 'chart'));
    this.chartCard = this.el('[data-chart-card]');
    this.chart = new QuantChart(
      this.el('[data-chart-canvas]'),
      this.el('[data-chart-readout]'),
      () => void this.expandChart(),
    );
    this.root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (button && !button.hasAttribute('disabled'))
        void this.action(button).catch((error) => this.error(error));
    });
    this.root.addEventListener('change', (event) => {
      const target = event.target as HTMLSelectElement;
      if (target.matches('[data-project-select]'))
        void this.select(target.value).catch((error) => this.error(error));
      if (target.matches('[data-dataset]'))
        void this.update({ preferences: { datasetId: target.value || null } }).catch((error) =>
          this.error(error),
        );
      if (target.matches('[data-model]') && this.chat)
        void this.options
          .backend('selectSessionModel', this.chat.session.key, target.value)
          .then(() => this.loadChat())
          .catch((error) => this.error(error));
      if (target.matches('[data-interval]'))
        void this.update({ market: { interval: Number(target.value) } })
          .then(() => this.refreshMarket())
          .catch((error) => this.error(error));
    });
    this.el<HTMLFormElement>('[data-chat-form]').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send().catch((error) => this.error(error));
    });
    this.el<HTMLTextAreaElement>('[data-chat-input]').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send().catch((error) => this.error(error));
      }
    });
    window.addEventListener('cibyp:wallet-updated', (event) => {
      const intents = (event as CustomEvent<{ intents: WalletIntent[] }>).detail.intents;
      this.renderApprovals(intents);
    });
    this.el<HTMLInputElement>('[data-file]').addEventListener(
      'change',
      (event) => void this.importFile(event).catch((error) => this.error(error)),
    );
    document.addEventListener('fullscreenchange', () => {
      this.chartCard.classList.toggle(
        'quant-native-fullscreen',
        document.fullscreenElement === this.chartCard,
      );
      this.chart.schedule();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.focusExpanded) this.exitChart();
    });
    options.subscribe((event) => this.onEvent(event));
    window.addEventListener('cibyp:page-changed', (event) => {
      const page = (event as CustomEvent<{ page: string }>).detail.page;
      this.active = page === 'quant';
      document.body.classList.toggle('quant-open', this.active);
      if (this.active) void this.open().catch((error) => this.error(error));
      else this.exitChart();
    });
    window.addEventListener('languagechange', () => {
      this.localize();
      if (this.workspace) this.render();
    });
    setInterval(() => {
      if (this.active && !document.hidden && this.workspace)
        void this.refreshMarket().catch(() => {});
    }, 10000);
    this.installResize();
    this.localize();
  }
  private text(key: QuantLabel): string {
    return quantText(this.options.language(), key);
  }
  private el<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }
  private async call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return (await this.options.request(action, input)) as T;
  }
  private button(key: QuantLabel, action: string, glyph = '', extra = ''): string {
    return `<button type="button" data-action="${action}" ${extra} title="${escape(this.text(key))}">${glyph ? icon(glyph) : ''}<span data-q="${key}">${escape(this.text(key))}</span></button>`;
  }
  private template(): string {
    return `<div class="quant-topbar"><div class="quant-brand">${icon('chart')}<div><h1 data-q="title"></h1><span data-q="subtitle"></span></div></div>
      <select data-project-select aria-label="${escape(this.text('projects'))}"></select><span class="quant-mode-badge" data-q="paper"></span>
        <div class="quant-top-actions">${this.button('professional', 'professional', 'chart')}${this.button('immersive', 'immersive', 'chat')}${this.button('qeTitle', 'event-data', 'chart') + this.button('nsTitle', 'strategies', 'chart') + this.button('npTitle', 'native-paper', 'chart')}${this.button('wallet', 'wallet', 'settings')}${this.button('new', 'new', 'plus')}${this.button('settings', 'settings', 'settings')}</div></div>
      <div class="quant-notice" data-notice role="status" hidden></div>
      <div class="quant-welcome" data-welcome><div class="quant-welcome-mark">${icon('chart')}</div><h2 data-q="noProjects"></h2><p data-q="noProjectsHint"></p>${this.button('new', 'new', 'plus')}</div>
      <div class="quant-layout" data-layout="professional" hidden>
        <aside class="quant-projects"><div class="quant-section-label"><span data-q="projects"></span>${this.button('new', 'new', 'plus', 'class="quant-icon-button"')}</div><div data-projects></div>
          <div class="quant-project-note">Base · 8453<br>Base Sepolia · 84532<hr><span data-q="liveUnavailable"></span></div></aside>
        <div class="quant-center"><div data-chart-home></div><section class="quant-bottom">
          <div class="quant-tabs" role="tablist">${(['experiments', 'orders', 'research', 'risk', 'audit', 'book'] as QuantLabel[]).map((key) => this.button(key, 'tab:' + key)).join('')}</div>
          <div class="quant-bottom-content"><div data-experiments>
            <div class="quant-research-controls"><label><span data-q="strategy"></span><select data-param="strategy"><option value="sma-cross" data-q="sma"></option><option value="buy-hold" data-q="hold"></option></select></label>
              <label><span data-q="fast"></span><input data-param="fast" type="number" min="2" max="200" value="9"></label><label><span data-q="slow"></span><input data-param="slow" type="number" min="3" max="500" value="21"></label>
              <label><span data-q="feeBps"></span><input data-param="feeBps" type="number" min="0" max="1000" value="10"></label><label><span data-q="slippageBps"></span><input data-param="slippageBps" type="number" min="0" max="1000" value="5"></label>
              ${this.button('backtest', 'backtest', 'chart', 'class="quant-primary"')}${this.button('walkForward', 'walk-forward', 'chart')}${this.button('ammReplay', 'amm-replay', 'history', 'hidden')}${this.button('ammScenario', 'amm-scenario', 'chart', 'hidden')}${this.button('export', 'export', 'download')}</div>
            <p class="quant-hint" data-q="candleHint"></p><div data-run-report></div><div data-run-list></div></div>
            <div data-orders hidden><div class="quant-order-entry"><select data-order="side" aria-label="${escape(this.text('side'))}"><option value="buy" data-q="buy"></option><option value="sell" data-q="sell"></option></select>
              <select data-order="type" aria-label="${escape(this.text('strategy'))}"><option value="market" data-q="market"></option><option value="limit" data-q="limit"></option></select>
              <input data-order="quantity" inputmode="decimal" placeholder="${escape(this.text('quantity'))}" aria-label="${escape(this.text('quantity'))}">
              <input data-order="limitPrice" inputmode="decimal" placeholder="${escape(this.text('limitPrice'))}" aria-label="${escape(this.text('limitPrice'))}">
              ${this.button('placeOrder', 'order', 'plus', 'class="quant-primary"')}${this.button('cancelAll', 'cancelAll')}</div><p class="quant-hint" data-q="paperHint"></p><div data-order-list></div></div>
            <div data-risk hidden><p class="quant-hint" data-q="configHint"></p><div class="quant-risk-fields">${(['maxOrder', 'maxExposure', 'maxPosition', 'feeBps', 'slippageBps'] as QuantLabel[]).map((key) => `<label><span data-q="${key}"></span><input data-risk-field="${key}" inputmode="decimal"></label>`).join('')}${this.button('save', 'save-risk', 'settings', 'class="quant-primary"')}</div></div>
            <div data-audit hidden></div><div data-book hidden></div><div data-research hidden></div>
          </div><div class="quant-pagination" data-pagination hidden>${this.button('previous', 'previous')}<span data-page-count></span>${this.button('next', 'next')}</div>
        </section></div>
        <div class="quant-chat-resizer" role="separator" aria-orientation="vertical" tabindex="0" aria-label="${escape(this.text('assistant'))}"></div>
        <section class="quant-conversation"><header><div>${icon('chat')}<strong data-q="assistant"></strong></div><select data-model aria-label="${escape(this.text('model'))}" disabled><option data-q="model"></option></select>${this.button('exportChat', 'export-chat', 'download', 'class="quant-icon-button"')}</header>
          <div data-immersive-chart></div><div class="quant-chat-messages" data-chat-messages role="log" aria-live="polite"></div>
          <div class="quant-chat-working" data-chat-working hidden></div>
          <div class="quant-live-approvals" data-live-approvals></div><form class="quant-composer" data-chat-form><textarea data-chat-input rows="3" aria-label="${escape(this.text('message'))}"></textarea><footer><button type="button" data-action="autonomous" data-autonomous aria-pressed="true">Agent · Goal</button><span data-q="assistantHint"></span><button type="submit" data-send title="${escape(this.text('send'))}">${icon('send')}</button><button type="button" data-action="stop" data-stop title="${escape(this.text('stop'))}" hidden>${icon('stop')}</button></footer></form>
        </section>
      </div><input data-file type="file" accept=".csv,.json" hidden>
      <section class="quant-chart-card" data-chart-card><div class="quant-market-head"><div><span class="quant-venue" data-venue></span><h2 data-product></h2><span class="quant-price" data-price>—</span></div>
        <div class="quant-health"><span data-health></span><time data-updated></time></div><div class="quant-chart-actions">
          ${this.button('refresh', 'refresh', 'refresh')}${this.button('ammHistory', 'base-history', 'history', 'hidden')}${this.button('import', 'import', 'upload')}${this.button('fullscreen', 'fullscreen', 'expand', 'class="quant-icon-button"')}</div></div>
        <div class="quant-kpis">${(['equity', 'cash', 'position', 'fees'] as QuantLabel[]).map((key) => `<div><span data-q="${key}"></span><strong data-kpi="${key}">—</strong></div>`).join('')}<div class="quant-paper-actions">${this.button('start', 'start')}${this.button('pause', 'pause')}</div></div>
        <div class="quant-chart-toolbar"><select data-interval aria-label="${escape(this.text('interval'))}">${[
          [60, '1m'],
          [300, '5m'],
          [900, '15m'],
          [3600, '1h'],
          [21600, '6h'],
          [86400, '1d'],
        ]
          .map(([value, label]) => `<option value="${value}">${label}</option>`)
          .join('')}</select>
          <select data-dataset aria-label="${escape(this.text('source'))}"></select><div class="quant-chart-tools">${this.button('zoomOut', 'zoom-out', '', 'class="quant-icon-button" aria-label="Zoom out"')}${this.button('zoomIn', 'zoom-in', '', 'class="quant-icon-button" aria-label="Zoom in"')}${this.button('fit', 'fit')}</div></div>
        <div class="quant-chart-readout" data-chart-readout></div><div class="quant-chart-surface"><div data-chart-canvas></div><div class="quant-chart-empty" data-chart-empty><strong data-q="noData"></strong><p data-q="noDataHint"></p></div></div>
        <footer class="quant-chart-source"><span data-source></span><span data-q="sampleHint"></span></footer></section>`;
  }
  private localize(): void {
    this.root.querySelectorAll<HTMLElement>('[data-q]').forEach((node) => {
      node.textContent = this.text(node.dataset.q as QuantLabel);
    });
    this.el<HTMLTextAreaElement>('[data-chat-input]').placeholder = this.text('message');
    this.el('[data-action="zoom-out"]').textContent = '−';
    this.el('[data-action="zoom-in"]').textContent = '+';
    this.el('[data-chart-home]').append(this.chartCard);
    if (this.workspace?.preferences.layout === 'immersive')
      this.el('[data-immersive-chart]').append(this.chartCard);
  }
  async open(): Promise<void> {
    this.projects = await this.call<QuantSummary[]>('workspace.list');
    this.renderProjects();
    if (!this.currentId && this.projects.length) {
      let preferred = '';
      try {
        preferred = localStorage.getItem('cibyp.quant.project') || '';
      } catch {
        /* Optional view hint. */
      }
      await this.select(
        this.projects.some((p) => p.id === preferred) ? preferred : this.projects[0]!.id,
      );
    } else if (this.currentId) await this.pull();
  }
  private async select(id: string): Promise<void> {
    this.currentId = id;
    this.selectedRun = undefined;
    this.chat = undefined;
    this.stream = '';
    this.chatLimit = 100;
    this.offset = 0;
    try {
      localStorage.setItem('cibyp.quant.project', id);
    } catch {
      /* Optional view hint. */
    }
    const w = await this.call<QuantWorkspace>('workspace.get', { id });
    if (this.currentId !== id) return;
    this.workspace = w;
    this.renderProjects();
    this.populateRisk();
    await this.render();
    void this.loadChat().catch((error) => this.error(error));
    if (!w.quote) void this.refreshMarket().catch(() => {});
  }
  private async pull(): Promise<void> {
    if (this.refreshBusy || !this.currentId) return;
    this.refreshBusy = true;
    const id = this.currentId;
    try {
      const workspace = await this.call<QuantWorkspace>('workspace.get', { id });
      if (id === this.currentId) {
        this.workspace = workspace;
        await this.render();
      }
    } finally {
      this.refreshBusy = false;
    }
  }
  private renderProjects(): void {
    this.el('[data-projects]').innerHTML = this.projects
      .map(
        (p) =>
          `<button type="button" class="quant-project ${p.id === this.currentId ? 'active' : ''}" data-action="project:${escape(p.id)}"><span class="quant-project-network">${escape(p.venue === 'coinbase' ? 'C' : 'B')}</span><span><strong>${escape(p.name)}</strong><small>${escape(p.product)} · ${escape(p.venue)}</small></span></button>`,
      )
      .join('');
    const select = this.el<HTMLSelectElement>('[data-project-select]');
    select.innerHTML = this.projects
      .map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`)
      .join('');
    select.value = this.currentId;
    this.el('[data-welcome]').hidden = this.projects.length > 0;
    this.el('[data-layout]').hidden = !this.workspace;
  }
  private async render(): Promise<void> {
    const w = this.workspace;
    if (!w) return;
    this.el('[data-welcome]').hidden = true;
    this.el('[data-layout]').hidden = false;
    this.el('[data-layout]').dataset.layout = w.preferences.layout;
    this.el('[data-layout]').style.setProperty(
      '--quant-chat-width',
      w.preferences.chatWidth + 'px',
    );
    this.el(
      w.preferences.layout === 'immersive' ? '[data-immersive-chart]' : '[data-chart-home]',
    ).append(this.chartCard);
    for (const mode of ['professional', 'immersive'])
      this.el(`[data-action="${mode}"]`).setAttribute(
        'aria-pressed',
        String(w.preferences.layout === mode),
      );
    this.el('[data-product]').textContent = w.market.product;
    this.el('[data-venue]').textContent =
      w.market.venue === 'coinbase'
        ? 'COINBASE · PUBLIC REST'
        : w.market.venue === 'base'
          ? 'BASE · 8453 · UNISWAP V3'
          : 'BASE SEPOLIA · 84532 · TESTNET';
    this.el('[data-price]').textContent = w.quote ? this.number(w.quote.price) : '—';
    this.el('[data-health]').textContent = this.marketLoading
      ? this.text('loading')
      : w.lastError
        ? this.text('offline')
        : w.quote
          ? this.text('ready')
          : this.text('noData');
    this.el('[data-health]').className = w.lastError ? 'quant-negative' : '';
    this.el('[data-updated]').textContent = w.quote
      ? new Date(w.quote.observedAt).toLocaleTimeString()
      : '';
    for (const key of ['equity', 'cash', 'position', 'fees'])
      this.el(`[data-kpi="${key}"]`).textContent = this.number(
        key === 'cash' ? w.paper.availableCash : w.paper[key as keyof typeof w.paper],
      );
    this.el('[data-action="start"]').toggleAttribute('disabled', w.paper.status === 'running');
    this.el('[data-action="pause"]').toggleAttribute('disabled', w.paper.status !== 'running');
    this.el('.quant-mode-badge').textContent =
      this.text('paper') + ' · ' + this.text(w.paper.status === 'running' ? 'running' : 'paused');
    this.el<HTMLSelectElement>('[data-interval]').value = String(w.market.interval);
    this.el('[data-action="base-history"]').hidden = !w.network;
    const dataset = this.el<HTMLSelectElement>('[data-dataset]');
    dataset.innerHTML =
      `<option value="">${escape(this.text('liveData'))}</option>` +
      w.datasets
        .map((d) => `<option value="${d.id}">${escape(d.label)} · ${d.count}</option>`)
        .join('');
    dataset.value = w.preferences.datasetId || '';
    let bars = w.candles;
    if (w.preferences.datasetId) {
      const id = w.preferences.datasetId;
      if (!this.chartData.has(id)) {
        const data = await this.call<{ candles: Candle[] }>('dataset.get', {
          id: w.id,
          datasetId: id,
        });
        this.chartData.set(id, data.candles);
      }
      if (this.workspace?.id !== w.id || this.workspace.preferences.datasetId !== id) return;
      bars = this.chartData.get(id)!;
    }
    const selectedDataset = w.datasets.find((dataset) => dataset.id === w.preferences.datasetId);
    this.el('[data-action="amm-replay"]').hidden =
      !selectedDataset?.amm && !selectedDataset?.series;
    this.el('[data-action="amm-scenario"]').hidden =
      !selectedDataset?.amm && !selectedDataset?.series;
    const series = selectedDataset?.series;
    this.chart.setData(bars, series?.interval);
    this.el('[data-chart-empty]').hidden = bars.length > 0;
    this.el('[data-source]').textContent =
      this.text('source') +
      ' · ' +
      (w.preferences.datasetId
        ? selectedDataset?.source === 'user-import-unverified'
          ? this.text('imported')
          : selectedDataset?.amm || series
            ? this.text('ammSource')
            : this.text('history')
        : this.text(w.market.venue === 'coinbase' ? 'exchange' : 'sampled')) +
      (!w.preferences.datasetId && w.quote?.block ? ' · #' + w.quote.block : '');
    this.el('.quant-chart-source > span:last-child').textContent = series
      ? `${this.text('ammSeriesSegments')} ${series.segmentCount} · ${this.text('ammSeriesGaps')} ${series.gaps} / ${series.slots}${(selectedDataset?.start ?? series.requestedStart) > series.requestedStart ? ' · ' + this.text('ammSeriesShort') : ''}`
      : this.text(
          selectedDataset?.amm
            ? 'ammHint'
            : !w.preferences.datasetId && w.market.venue !== 'coinbase'
              ? 'sampleHint'
              : 'candleHint',
        );
    for (const key of ['experiments', 'orders', 'research', 'risk', 'audit', 'book'])
      this.el(`[data-${key}]`).hidden = this.tab !== key;
    this.root.querySelectorAll<HTMLElement>('.quant-tabs button').forEach((b) => {
      const selected = b.dataset.action === 'tab:' + this.tab;
      b.classList.toggle('active', selected);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(selected));
    });
    this.renderRuns();
    this.renderBook();
    await this.renderHistory();
  }
  private async update(values: Record<string, unknown>): Promise<void> {
    const id = this.currentId,
      w = await this.call<QuantWorkspace>('workspace.update', { ...values, id });
    if (id !== this.currentId) return;
    this.workspace = w;
    this.projects = await this.call<QuantSummary[]>('workspace.list');
    this.renderProjects();
    await this.render();
  }
  private async refreshMarket(): Promise<void> {
    if (!this.currentId || this.marketLoading) return;
    this.marketLoading = true;
    const id = this.currentId;
    this.el('[data-health]').textContent = this.text('loading');
    try {
      await this.call('market.refresh', { id });
    } catch (error) {
      if (this.active && id === this.currentId) this.error(error);
    } finally {
      this.marketLoading = false;
      if (id === this.currentId) await this.pull();
    }
  }
  private renderRuns(): void {
    const w = this.workspace!;
    this.el('[data-run-list]').innerHTML = w.runs.length
      ? `<table><thead><tr><th>${escape(this.text('time'))}</th><th>${escape(this.text('strategy'))}</th><th>${escape(this.text('return'))}</th><th>${escape(this.text('drawdown'))}</th><th>${escape(this.text('fills'))}</th></tr></thead><tbody>${w.runs.map((run) => `<tr data-action="run:${run.id}" tabindex="0"><td><button type="button" data-action="run:${run.id}">${escape(new Date(run.createdAt).toLocaleString())}</button></td><td>${escape(run.config.strategy === 'sma-walk-forward' ? this.text('walkForward') : run.config.strategy)}</td><td class="${run.metrics.returnPct >= 0 ? 'quant-positive' : 'quant-negative'}">${this.number(run.metrics.returnPct)}%</td><td>${this.number(run.metrics.maxDrawdownPct)}%</td><td>${run.metrics.fills}</td></tr>`).join('')}</tbody></table>`
      : `<p class="quant-empty-inline">${escape(this.text('noRuns'))}</p>`;
    const run = this.selectedRun || w.runs[0];
    const container = this.el('[data-run-report]');
    const expanded =
      container.dataset.runId === run?.id
        ? new Set(
            [...container.querySelectorAll<HTMLDetailsElement>('details[data-fold][open]')].map(
              (detail) => detail.dataset.fold,
            ),
          )
        : new Set<string>();
    container.dataset.runId = run?.id || '';
    container.innerHTML = run
      ? `<div class="quant-report-kpis">${[
          ['return', run.metrics.returnPct.toFixed(2) + '%'],
          ['drawdown', run.metrics.maxDrawdownPct.toFixed(2) + '%'],
          ['fills', run.metrics.fills],
          ['fees', run.metrics.fees],
        ]
          .map(
            ([key, value]) =>
              `<div><span>${escape(this.text(key as QuantLabel))}</span><strong>${escape(value)}</strong></div>`,
          )
          .join(
            '',
          )}</div>${run.equity?.length ? this.sparkline(run.equity) : ''}${run.dataSeries ? `<p class="quant-hint">${escape(new Date(run.dataSeries.startTime * 1000).toLocaleString())} – ${escape(new Date(run.dataSeries.endTime * 1000).toLocaleString())} · ${escape(this.text('ammSeriesSegments'))} ${run.dataSeries.segments.length} · ${escape(this.text('ammSeriesGaps'))} ${run.dataSeries.gaps} / ${run.dataSeries.slots}</p>` : ''}${run.walkForward ? this.walkForwardReport(run.walkForward) : run.ammScenario ? this.ammScenarioReport(run.ammScenario) : run.ammReplay ? this.ammReplayReport(run.ammReplay) : run.dataSeries ? `<p class="quant-hint">${escape(this.text('ammSeriesExecution'))}</p>` : ''}`
      : '';
    for (const detail of container.querySelectorAll<HTMLDetailsElement>('details[data-fold]'))
      detail.open = expanded.has(detail.dataset.fold!);
  }
  private walkForwardReport(report: NonNullable<QuantRun['walkForward']>): string {
    const range = ({ start, end }: { start: number; end: number }) =>
      `${new Date(start * 1000).toLocaleString()} – ${new Date(end * 1000).toLocaleString()}`;
    const header = (keys: QuantLabel[]) =>
      `<thead><tr>${keys.map((key) => `<th scope="col">${escape(this.text(key))}</th>`).join('')}</tr></thead>`;
    const percentage = (value: number) => escape(this.number(value)) + '%';
    const rows = report.windows.map(
      (window) =>
        `<tr><th scope="row">${window.index}</th><td>${escape(range(window.training))}</td><td>${escape(range(window.testing))}</td><td>${window.selected.fast} / ${window.selected.slow}</td><td>${percentage(window.metrics.returnPct)}</td><td>${percentage(window.metrics.maxDrawdownPct)}</td><td>${window.metrics.fills}</td></tr>`,
    );
    const rankings = report.windows.map(
      (window) =>
        `<details class="quant-amm-trades" data-fold="${window.index}"><summary>${escape(this.text('wfRound').replace('{n}', String(window.index)))} · ${escape(this.text('wfRanking'))}</summary><div data-trades><table>${header(['fast', 'slow', 'return', 'drawdown', 'fills'])}<tbody>${window.trainingScores.map((candidate) => `<tr><td>${candidate.fast}</td><td>${candidate.slow}</td><td>${percentage(candidate.returnPct)}</td><td>${percentage(candidate.maxDrawdownPct)}</td><td>${candidate.fills}</td></tr>`).join('')}</tbody></table></div></details>`,
    );
    return `<section data-walk-forward-report><p class="quant-hint">${escape(this.text('wfHint'))}</p><p class="quant-hint">${escape(this.text('wfCandidates'))} ${report.candidateCount}${report.discardedPrefixBars ? ` · ${escape(this.text('wfPrefix'))} ${report.discardedPrefixBars}` : ''}</p><div class="quant-amm-trades"><div data-trades><table>${header(['wfFolds', 'wfTraining', 'wfTesting', 'wfSelected', 'return', 'drawdown', 'fills'])}<tbody>${rows.join('')}</tbody></table></div></div>${rankings.join('')}</section>`;
  }
  private ammReplayReport(replay: NonNullable<QuantRun['ammReplay']>): string {
    const rows = replay.attempts
      .map((quote) => {
        const buy = quote.side === 'buy';
        const from = executionAmount(quote.amountInAtoms, buy ? 6 : 18) + (buy ? ' USDC' : ' WETH');
        const to = executionAmount(quote.amountOutAtoms, buy ? 18 : 6) + (buy ? ' WETH' : ' USDC');
        const labels = {
          filled: 'ammReplayFilled',
          'adverse-price': 'ammReplayRejected',
          'network-cost-limit': 'ammFeeRejected',
        } as const;
        const fee = quote.networkFee;
        const cost = fee
          ? `<small>${escape(executionAmount(fee.usdcAtoms, 6))} USDC<br>L2 ${escape(fee.l2Wei)} · L1 ${escape(fee.l1Wei)} · ${escape(this.text('ammFeeOperator'))} ${escape(fee.operatorWei)} wei</small>`
          : '';
        return `<tr title="${escape(quote.execution.blockHash)}"><td>#${quote.signal.block}/${quote.signal.logIndex} → #${quote.execution.block}</td><td>${escape(from)} → ${escape(to)}</td><td>${escape(this.text(labels[quote.status]))}${cost}</td></tr>`;
      })
      .join('');
    const network = replay.networkFees;
    const total = network
      ? `<p class="quant-hint">${escape(this.text(network.mode === 'historical' ? 'ammFeeEvidence' : 'ammFeeFixed'))} · ${escape(executionAmount(network.usdcAtoms, 6))} USDC${network.totalWei === undefined ? '' : ` · ${escape(executionAmount(network.totalWei, 18))} ETH`}</p>`
      : '';
    return `<p class="quant-hint">${escape(this.text('ammReplayModel'))}</p>${total}<details class="quant-amm-trades"><summary>${escape(this.text('ammReplayQuotes'))} · ${replay.attempts.length}</summary><div data-trades><table><tbody>${rows}</tbody></table></div></details>`;
  }
  private ammScenarioReport(scenario: NonNullable<QuantRun['ammScenario']>): string {
    const rows = scenario.legs
      .map((leg) => {
        const buy = leg.side === 'buy';
        const output =
          leg.amountOutAtoms === undefined
            ? '—'
            : `${executionAmount(leg.amountOutAtoms, buy ? 18 : 6)} ${buy ? 'WETH' : 'USDC'}`;
        const delta =
          leg.deltaOutAtoms === undefined ? '—' : signedAmount(leg.deltaOutAtoms, buy ? 18 : 6);
        const state =
          leg.status === 'reverted'
            ? 'ammScenarioRevert'
            : leg.status === 'partial-input'
              ? 'ammScenarioPartial'
              : 'ammReplayFilled';
        return `<tr title="${escape(`${leg.sqrtBeforeX96} → ${leg.sqrtAfterX96}`)}"><td>${leg.index} · ${escape(this.text(buy ? 'buy' : 'sell'))}</td><td>${escape(output)}</td><td>${escape(delta)}</td><td>${escape(this.text(state))}</td></tr>`;
      })
      .join('');
    return `<p class="quant-hint">${escape(this.text('ammScenarioModel'))}</p><p class="quant-hint" title="${escape(scenario.anchor.blockHash)}">#${scenario.anchor.block} · ${escape(this.text('ammScenarioGas'))} ${escape(scenario.totalSwapGas)}</p><div class="quant-amm-trades"><div data-trades><table><thead><tr><th>${escape(this.text('side'))}</th><th>${escape(this.text('amount'))}</th><th>${escape(this.text('ammScenarioBaseline'))}</th><th>${escape(this.text('state'))}</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  private sparkline(equity: { time: number; value: number }[]): string {
    const min = Math.min(...equity.map((p) => p.value)),
      max = Math.max(...equity.map((p) => p.value));
    const points = equity
      .map(
        (p, i) =>
          `${(i / Math.max(1, equity.length - 1)) * 1000},${54 - ((p.value - min) / Math.max(1, max - min)) * 48}`,
      )
      .join(' ');
    return `<svg class="quant-equity-line" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-label="${escape(this.text('equity'))}"><polyline fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${points}"/></svg>`;
  }
  private async renderHistory(): Promise<void> {
    const w = this.workspace!;
    const paged = ['orders', 'audit', 'research'].includes(this.tab);
    this.el('[data-pagination]').hidden = !paged;
    if (!paged) return;
    const kind = this.tab,
      id = w.id;
    const page = await this.call<{
      items: Record<string, unknown>[];
      total: number;
      nextOffset: number | null;
    }>('history.list', { id, kind, offset: this.offset, limit: 20 });
    if (this.currentId !== id || this.tab !== kind) return;
    this.el('[data-page-count]').textContent =
      `${Math.min(page.total, this.offset + 1)}–${Math.min(page.total, this.offset + 20)} / ${page.total}`;
    this.el('[data-action="previous"]').toggleAttribute('disabled', this.offset === 0);
    this.el('[data-action="next"]').toggleAttribute('disabled', page.nextOffset === null);
    if (kind === 'research')
      this.el('[data-research]').innerHTML =
        `<p class="quant-hint">${escape(this.text('evidenceHint'))}</p>` +
        (page.items.length
          ? page.items
              .map(
                (row) =>
                  `<article class="quant-evidence-row"><div>${icon('history')}</div><div><span class="quant-evidence-kind">${escape(this.text(row.kind === 'search' ? 'evidenceSearch' : 'evidenceArticle'))}</span><strong>${escape(row.title)}</strong><small>${escape(this.text('evidenceRetrieved'))} · ${escape(new Date(String(row.retrievedAt)).toLocaleString())}</small></div>${this.button('evidenceView', 'evidence:' + row.evidenceId)}</article>`,
              )
              .join('')
          : `<p class="quant-empty-inline">${escape(this.text('researchEmpty'))}</p>`);
    else if (kind === 'audit')
      this.el('[data-audit]').innerHTML = page.items
        .map(
          (row) =>
            `<div class="quant-audit-row">${icon('history')}<time>${escape(new Date(Number(row.time)).toLocaleString())}</time><span>${escape(row.type)}${row.reason ? ' · ' + escape(row.reason) : ''}</span></div>`,
        )
        .join('');
    else
      this.el('[data-order-list]').innerHTML = page.items.length
        ? `<table><thead><tr>${(['time', 'side', 'amount', 'orderPrice', 'state'] as QuantLabel[]).map((k) => `<th>${escape(this.text(k))}</th>`).join('')}<th></th></tr></thead><tbody>${page.items.map((row) => `<tr><td>${escape(new Date(Number(row.createdAt)).toLocaleTimeString())}</td><td class="${row.side === 'buy' ? 'quant-positive' : 'quant-negative'}">${escape(this.text(row.side === 'buy' ? 'buy' : 'sell'))}</td><td>${escape(row.quantity)}</td><td>${escape(row.fillPrice || row.limitPrice || '—')}</td><td>${escape(this.text(['filled', 'open', 'cancelled'].includes(String(row.status)) ? (row.status as QuantLabel) : 'state'))}</td><td>${row.status === 'open' ? this.button('cancel', 'cancel:' + row.id) : ''}</td></tr>`).join('')}</tbody></table>`
        : `<p class="quant-empty-inline">${escape(this.text('noOrders'))}</p>`;
  }
  private async evidenceDialog(evidenceId: string): Promise<void> {
    const id = this.currentId,
      dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog quant-evidence-dialog';
    dialog.innerHTML = `<header><h2>${escape(this.text('research'))}</h2><button type="button" data-close aria-label="${escape(this.text('close'))}">${icon('close')}</button></header><div data-evidence-body>${escape(this.text('evidenceLoading'))}</div><footer><button data-evidence-prev>${escape(this.text('previous'))}</button><button data-evidence-next>${escape(this.text('next'))}</button></footer>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    const sourceLink = (value: unknown, title: unknown): string => {
      try {
        const url = new URL(String(value));
        if (url.protocol !== 'https:' || url.username || url.password) return '';
        return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(title || url.hostname)} ↗</a>`;
      } catch {
        return '';
      }
    };
    const show = async (offset: number): Promise<void> => {
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('footer button');
      buttons.forEach((button) => {
        button.disabled = true;
      });
      try {
        const page = await this.call<Record<string, unknown>>('research.read', {
          id,
          evidenceId,
          offset,
          maxChars: 5000,
        });
        if (!dialog.isConnected) return;
        const rows = Array.isArray(page.results) ? (page.results as Record<string, unknown>[]) : [];
        dialog.querySelector('[data-evidence-body]')!.innerHTML =
          `<h3>${escape(page.title || page.query)}</h3><p class="quant-hint">${escape(this.text('evidenceRetrieved'))} · ${escape(page.retrievedAt)}<br>${escape(this.text('evidencePublished'))} · ${escape(page.publishedAtReported || this.text('evidenceUnknown'))}</p>${sourceLink(page.url, page.url)}<p class="quant-hint">${escape(this.text('evidenceHint'))}${page.kind === 'article' && !page.archiveCompleteDocument ? '<br>' + escape(this.text('evidencePartial')) : ''}</p>${rows.map((row) => `<article class="quant-evidence-source">${sourceLink(row.url, row.title)}<small>${escape(row.publishedAtReported || this.text('evidenceUnknown'))}</small><p>${escape(row.snippet)}</p></article>`).join('')}<pre class="quant-evidence-content">${escape(page.content)}</pre>`;
        buttons[0]!.disabled = offset === 0;
        buttons[1]!.disabled = page.nextOffset === null;
        buttons[0]!.onclick = () => void show(Math.max(0, offset - 5000));
        buttons[1]!.onclick = () => void show(Number(page.nextOffset));
      } catch (error) {
        if (dialog.isConnected)
          dialog.querySelector('[data-evidence-body]')!.textContent = String(error);
      }
    };
    dialog.showModal();
    await show(0);
  }
  private renderBook(): void {
    const book = this.workspace!.quote?.book;
    this.el('[data-book]').innerHTML = book
      ? `<div class="quant-orderbook">${[book.bids, book.asks]
          .map(
            (levels, index) =>
              `<div>${levels
                .slice(0, 12)
                .map(
                  (row) =>
                    `<div class="${index ? 'quant-negative' : 'quant-positive'}"><span>${escape(row.price)}</span><span>${escape(row.quantity)}</span></div>`,
                )
                .join('')}</div>`,
          )
          .join('')}</div>`
      : `<p class="quant-empty-inline">${escape(this.text('noBook'))}</p>`;
  }
  private populateRisk(): void {
    if (!this.workspace) return;
    this.root.querySelectorAll<HTMLInputElement>('[data-risk-field]').forEach((input) => {
      input.value = String(
        this.workspace!.risk[input.dataset.riskField as keyof QuantWorkspace['risk']],
      );
    });
  }
  private async loadChat(): Promise<void> {
    const id = this.currentId;
    const view = await this.call<QuantChatView>('chat.open', { id });
    if (this.currentId !== id) return;
    this.chat = view;
    this.stream = '';
    this.renderChat();
    try {
      const models = (await this.options.backend('getSessionModels', view.session.key)) as {
        entries?: { id: string; label: string; model: string; default?: boolean }[];
        selected?: string;
      };
      if (this.currentId !== id) return;
      const select = this.el<HTMLSelectElement>('[data-model]');
      select.innerHTML = (models.entries || [])
        .map(
          (model) =>
            `<option value="${escape(model.id)}">${escape(model.label || model.model)}</option>`,
        )
        .join('');
      select.value = models.selected || models.entries?.find((entry) => entry.default)?.id || '';
      select.disabled = !models.entries?.length || view.session.busy;
    } catch {
      this.el<HTMLSelectElement>('[data-model]').innerHTML =
        `<option>${escape(view.session.model || this.text('model'))}</option>`;
    }
  }
  private renderChat(): void {
    const hiddenIds = new Set(
      this.chat?.messages
        ?.filter((message) => message.metadata?.kind === 'context-update')
        .map((message) => message.metadata?.messageId),
    );
    const messages = (this.chat?.displayMessages || []).filter(
        (message) => !message.id || !hiddenIds.has(message.id),
      ),
      host = this.el('[data-chat-messages]');
    const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 80;
    const content = (value: unknown): string =>
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value
              .filter((p) => p?.type === 'text')
              .map((p) => p.text)
              .join('\n')
          : '';
    host.innerHTML = messages.length
      ? (messages.length > this.chatLimit ? this.button('history', 'older', 'history') : '') +
        messages
          .slice(-this.chatLimit)
          .filter(
            (m) =>
              ['user', 'assistant', 'tool'].includes(m.role) &&
              (m.role !== 'assistant' || content(m.content).trim()),
          )
          .map((message) => {
            if (message.role === 'tool')
              return `<details class="quant-tool-record"><summary>${icon('settings')}${escape(message.name || 'Tool')}</summary><pre>${escape(content(message.content).slice(0, 12000))}</pre></details>`;
            return `<article class="quant-chat-message ${message.role}"><span class="quant-chat-author">${message.role === 'user' ? 'You' : escape(this.text('assistant'))}</span><div>${this.safeMarkdown(content(message.content))}</div></article>`;
          })
          .join('')
      : `<div class="quant-chat-empty">${icon('chat')}<h3>${escape(this.text('chatEmpty'))}</h3><p>${escape(this.text('chatHint'))}</p>${this.button('promptCompare', 'prompt-compare', 'chart')}${this.button('promptBase', 'prompt-base', 'settings')}</div>`;
    if (this.stream) {
      const draft = document.createElement('article');
      draft.className = 'quant-chat-message assistant quant-stream';
      draft.textContent = this.stream;
      host.append(draft);
    }
    if (atBottom) host.scrollTop = host.scrollHeight;
    const busy = Boolean(this.chatBusy || this.chat?.session.busy);
    this.el('[data-send]').hidden = busy;
    this.el('[data-stop]').hidden = !busy;
    this.el('[data-chat-working]').hidden = !busy;
    this.el('[data-chat-working]').textContent = this.text('thinking');
  }
  private safeMarkdown(text: string): string {
    const template = document.createElement('template');
    template.innerHTML = this.options.markdown(text);
    const allowed = new Set(
      'P DIV SPAN BR HR STRONG EM B I S DEL PRE CODE BLOCKQUOTE UL OL LI H1 H2 H3 H4 H5 H6 TABLE THEAD TBODY TR TD TH A'.split(
        ' ',
      ),
    );
    template.content.querySelectorAll('*').forEach((node) => {
      if (!allowed.has(node.tagName)) {
        node.replaceWith(document.createTextNode(node.textContent || ''));
        return;
      }
      const href = node.getAttribute('href');
      for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      if (node.tagName === 'A' && href && /^https?:\/\//i.test(href)) {
        node.setAttribute('href', href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return template.innerHTML;
  }
  private async send(): Promise<void> {
    const input = this.el<HTMLTextAreaElement>('[data-chat-input]'),
      message = input.value.trim();
    if (!message || this.chatBusy) return;
    this.chatBusy = true;
    this.renderChat();
    try {
      let result: { ok: boolean; error?: string };
      if (message.startsWith('/goal')) {
        await this.call('chat.open', { id: this.currentId });
        const value = message.slice(5).trim();
        const action = !value
          ? 'status'
          : ['status', 'pause', 'resume', 'clear'].includes(value)
            ? value
            : 'set';
        const goal = await this.options.backend(
          'goalCommand',
          'quant:' + this.currentId,
          action,
          action === 'set' ? value : '',
        );
        this.notice(JSON.stringify(goal));
        result = { ok: true };
      } else
        result = await this.call<{ ok: boolean; error?: string }>('chat.send', {
          id: this.currentId,
          message,
          autonomous: this.el('[data-autonomous]').getAttribute('aria-pressed') === 'true',
        });
      if (result?.ok === false) throw new Error(result.error);
      input.value = '';
      await this.loadChat();
    } finally {
      this.chatBusy = false;
      this.renderChat();
    }
  }
  private onEvent(event: Record<string, unknown>): void {
    if (
      [
        'quant-native-changed',
        'quant-market-source-changed',
        'quant-market-sources-changed',
      ].includes(String(event.type))
    ) {
      void this.renderNativeStatus();
      const book = document.querySelector<HTMLDialogElement>('.quant-source-book-dialog');
      if (book) void this.renderSourceBook(book);
      return;
    }
    if (event.type === 'wallet-changed' && this.active)
      void this.options
        .backend('wallet:request', 'list')
        .then((data) => this.renderApprovals((data as { intents: WalletIntent[] }).intents))
        .catch((error) => this.error(error));
    if (event.type === 'quant-changed' && this.active) {
      clearTimeout(this.eventTimer);
      this.eventTimer = setTimeout(() => void this.pull().catch((error) => this.error(error)), 180);
    }
    if (event.key !== 'quant:' + this.currentId) return;
    if (event.type === 'agent-message' && event.messageType === 'stream-chunk') {
      const data = event.data as { content?: string };
      if (typeof data?.content === 'string') this.stream += data.content;
    }
    clearTimeout(this.chatTimer);
    this.chatTimer = setTimeout(() => {
      if (this.stream && event.type === 'agent-message' && event.messageType === 'stream-chunk')
        this.renderChat();
      else void this.loadChat().catch((error) => this.error(error));
    }, 120);
  }
  private async action(button: HTMLElement): Promise<void> {
    const action = button.dataset.action || '';
    if (action.startsWith('project:')) return this.select(action.slice(8));
    if (action.startsWith('evidence:')) return this.evidenceDialog(action.slice(9));
    if (action.startsWith('tab:')) {
      this.tab = action.slice(4);
      this.offset = 0;
      await this.render();
      return;
    }
    if (action.startsWith('run:')) {
      const id = this.currentId;
      const run = await this.call<QuantRun>('run.get', {
        id,
        runId: action.slice(4),
      });
      if (this.currentId !== id) return;
      this.selectedRun = run;
      this.renderRuns();
      if (run.walkForward) this.el('[data-run-report]').scrollIntoView({ block: 'start' });
      return;
    }
    if (action.startsWith('cancel:')) {
      await this.call('paper.cancel', { id: this.currentId, orderId: action.slice(7) });
      await this.pull();
      return;
    }
    switch (action) {
      case 'native-paper':
        if (this.currentId)
          openNativePaper({
            id: this.currentId,
            language: this.options.language,
            request: this.options.request,
            subscribe: this.options.subscribe,
          });
        return;
      case 'live-execution':
        if (this.currentId && this.workspace)
          openLiveExecution({
            id: this.currentId,
            venue: this.workspace.market.venue,
            language: this.options.language,
            request: this.options.request,
            backend: this.options.backend,
            subscribe: this.options.subscribe,
          });
        return;
      case 'strategies':
        if (this.currentId)
          openStrategies({
            id: this.currentId,
            language: this.options.language,
            request: this.options.request,
            subscribe: this.options.subscribe,
          });
        return;
      case 'event-data':
        if (this.currentId)
          openEventData({
            id: this.currentId,
            language: this.options.language,
            request: this.options.request,
            subscribe: this.options.subscribe,
          });
        return;
      case 'wallet':
        window.dispatchEvent(new CustomEvent('cibyp:quant-open-wallet'));
        return;
      case 'autonomous':
        button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
        return;
      case 'new':
        this.dialog(false);
        return;
      case 'settings':
        if (this.workspace) this.dialog(true);
        return;
      case 'professional':
      case 'immersive':
        if (this.workspace) await this.update({ preferences: { layout: action } });
        return;
      case 'refresh':
        return this.refreshMarket();
      case 'base-history':
        if (this.workspace) this.baseHistoryDialog(this.workspace);
        return;
      case 'amm-replay':
      case 'amm-scenario': {
        const w = this.workspace;
        const dataset = w?.datasets.find((item) => item.id === w.preferences.datasetId);
        if (w && dataset && (dataset.amm || dataset.series)) {
          if (action === 'amm-scenario') this.ammScenarioDialog(w.id, dataset);
          else this.ammReplayDialog(w.id, dataset);
        }
        return;
      }
      case 'fullscreen':
        return this.expandChart();
      case 'fit':
        this.chart.fit();
        return;
      case 'zoom-in':
        this.chart.zoom(1 / 1.2);
        return;
      case 'zoom-out':
        this.chart.zoom(1.2);
        return;
      case 'import':
        this.el<HTMLInputElement>('[data-file]').click();
        return;
      case 'walk-forward':
        if (this.workspace) this.walkForwardDialog(this.workspace);
        return;
      case 'backtest': {
        button.setAttribute('disabled', '');
        try {
          const config = Object.fromEntries(
            [
              ...this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-param]'),
            ].map((input) => [
              input.dataset.param!,
              input.dataset.param === 'strategy' ? input.value : Number(input.value),
            ]),
          );
          this.selectedRun = await this.call<QuantRun>('run.backtest', {
            id: this.currentId,
            config,
          });
          await this.pull();
          this.notice(this.text('saved'));
        } finally {
          button.removeAttribute('disabled');
        }
        return;
      }
      case 'start':
      case 'pause':
      case 'cancelAll':
        await this.call('paper.' + action, { id: this.currentId });
        await this.pull();
        return;
      case 'save-risk': {
        const risk = Object.fromEntries(
          [...this.root.querySelectorAll<HTMLInputElement>('[data-risk-field]')].map((input) => [
            input.dataset.riskField!,
            input.dataset.riskField!.endsWith('Bps') ? Number(input.value) : input.value,
          ]),
        );
        await this.update({ risk });
        this.notice(this.text('saved'));
        return;
      }
      case 'order': {
        const values = Object.fromEntries(
          [...this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-order]')].map(
            (input) => [input.dataset.order!, input.value],
          ),
        );
        const commandId = button.dataset.commandId || crypto.randomUUID();
        button.dataset.commandId = commandId;
        button.setAttribute('disabled', '');
        try {
          await this.call('paper.order', { ...values, id: this.currentId, commandId });
          delete button.dataset.commandId;
          await this.pull();
        } finally {
          button.removeAttribute('disabled');
        }
        return;
      }
      case 'previous':
        this.offset = Math.max(0, this.offset - 20);
        return this.renderHistory();
      case 'next':
        this.offset += 20;
        return this.renderHistory();
      case 'older':
        this.chatLimit += 200;
        this.renderChat();
        return;
      case 'stop':
        await this.call('chat.stop', { id: this.currentId });
        await this.loadChat();
        return;
      case 'prompt-base':
      case 'prompt-compare':
        this.el<HTMLTextAreaElement>('[data-chat-input]').value = this.text(
          action === 'prompt-base' ? 'promptBase' : 'promptCompare',
        );
        this.el('[data-chat-input]').focus();
        return;
      case 'export': {
        const summary = this.selectedRun || this.workspace?.runs[0];
        if (!summary) return;
        this.download(
          'quant-experiment-' + summary.id + '.json',
          await this.call('run.get', { id: this.currentId, runId: summary.id }),
        );
        return;
      }
      case 'export-chat':
        this.download('quant-research.json', this.chat?.displayMessages || []);
        return;
    }
  }
  private renderApprovals(intents: WalletIntent[]): void {
    this.el('[data-live-approvals]').innerHTML = intents
      .filter(
        (intent) => intent.workspaceId === this.currentId && intent.status === 'approval-required',
      )
      .map((intent) => approvalCard(intent, this.options.language()))
      .join('');
  }
  private async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 6 * 1024 * 1024) throw new Error('IMPORT_SIZE_LIMIT');
      await this.call<QuantDataset>('dataset.import', {
        id: this.currentId,
        label: file.name,
        text: await file.text(),
      });
      await this.pull();
      this.chart.fit();
    } finally {
      input.value = '';
    }
  }
  private dialog(settings: boolean): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog';
    const w = this.workspace;
    dialog.innerHTML = `<form method="dialog"><header><h2>${escape(this.text(settings ? 'settings' : 'new'))}</h2><button type="button" data-close aria-label="${escape(this.text('close'))}">${icon('close')}</button></header>
      <label>${escape(this.text('name'))}<input name="name" maxlength="100" value="${escape(settings ? w?.name : '')}"></label>
      ${
        settings
          ? `<p class="quant-hint">${escape(this.text('configHint'))}</p><label>${escape(this.text('rpc'))}<input name="rpc" type="url" autocomplete="off" placeholder="${w?.market.customRpc ? 'Custom RPC configured' : 'https://mainnet.base.org'}"></label><p class="quant-hint">${escape(this.text('rpcHint'))}</p><label>${escape(this.text('pool'))}<input name="pool" value="${escape(w?.market.pool || '')}" autocomplete="off"></label><p class="quant-hint">${escape(this.text('poolHint'))}</p><label>${escape(this.text('poolFee'))}<input name="poolFee" type="number" min="1" max="999999" step="1" required value="${w?.market.poolFee ?? 500}"></label>${this.button('network', 'inspect', 'settings')}`
          : `<label>${escape(this.text('venue'))}<select name="venue"><option value="base">Base · 8453</option><option value="base-sepolia">Base Sepolia · 84532</option><option value="coinbase">Coinbase · Public REST</option></select></label><label>${escape(this.text('product'))}<select name="product"><option>ETH-USD</option><option>BTC-USD</option><option>SOL-USD</option></select></label>`
      }
      ${settings ? `<section class="quant-native-engine" data-native-engine><strong>${escape(this.text('nativeTitle'))}</strong><p>${escape(this.text('nativeHint'))}</p><span data-native-status role="status"></span><div><button type="button" data-native="start">${escape(this.text('nativeStart'))}</button><button type="button" data-native="stop">${escape(this.text('nativeStop'))}</button></div><section class="quant-source-controls"><strong>${escape(this.text('sourceTitle'))}</strong><p>${escape(this.text('sourceHint'))}</p><div><label>${escape(this.text('sourceProduct'))}<select data-source-product><option>ETH-USD</option><option>BTC-USD</option><option>SOL-USD</option></select></label><label>${escape(this.text('sourceFee'))}<input data-source-fee type="number" min="0" max="1000" step="1" value="10"></label></div><span data-source-status role="status" aria-live="polite"></span><div><button type="button" data-source="start">${escape(this.text('sourceConnect'))}</button><button type="button" data-source="stop">${escape(this.text('sourceStop'))}</button><button type="button" data-source="book">${escape(this.text('sourceBook'))}</button></div></section></section>` : ''}
      <pre class="quant-network-result" hidden></pre><p class="quant-dialog-error" role="alert" hidden></p><footer><button type="button" data-close>${escape(this.text('cancel'))}</button><button type="submit" class="quant-primary">${escape(this.text(settings ? 'save' : 'create'))}</button></footer></form>`;
    document.body.append(dialog);
    dialog.showModal();
    if (settings) {
      void this.renderNativeStatus();
      dialog.querySelector('[data-source-product]')!.addEventListener('change', () => {
        delete dialog.querySelector<HTMLInputElement>('[data-source-fee]')!.dataset.loaded;
        void this.renderNativeStatus();
      });
      dialog.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((button) =>
        button.addEventListener('click', () => {
          const product = dialog.querySelector<HTMLSelectElement>('[data-source-product]')!.value;
          if (button.dataset.source === 'book') {
            this.sourceBookDialog(product);
            return;
          }
          button.disabled = true;
          void this.call('native.source.' + button.dataset.source, {
            product,
            feeBps: Number(dialog.querySelector<HTMLInputElement>('[data-source-fee]')!.value),
          })
            .catch((error) => this.error(error))
            .finally(() => this.renderNativeStatus());
        }),
      );
      dialog.querySelectorAll<HTMLButtonElement>('[data-native]').forEach((button) =>
        button.addEventListener('click', () => {
          dialog.querySelectorAll<HTMLButtonElement>('[data-native]').forEach((item) => {
            item.disabled = true;
          });
          void this.call('native.' + button.dataset.native)
            .catch((error) => this.error(error))
            .finally(() => this.renderNativeStatus());
        }),
      );
    }
    dialog
      .querySelectorAll('[data-close]')
      .forEach((button) => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    const form = dialog.querySelector('form')!;
    const field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    const fail = (error: unknown) => {
      const node = dialog.querySelector<HTMLElement>('[role="alert"]')!;
      node.hidden = false;
      node.textContent = this.errorText(error);
    };
    dialog.querySelector('[data-action="inspect"]')?.addEventListener(
      'click',
      () =>
        void this.call('base.inspect', { id: this.currentId })
          .then((value) => {
            const output = dialog.querySelector<HTMLPreElement>('pre')!;
            output.hidden = false;
            output.textContent = JSON.stringify(value, null, 2);
          })
          .catch(fail),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      submit.disabled = true;
      void (async () => {
        if (settings) {
          const market: Record<string, string | number> = {
            pool: field('pool'),
            poolFee: Number(field('poolFee')),
          };
          if (field('rpc')) market.rpcUrl = field('rpc');
          await this.update({ name: field('name'), market });
        } else {
          const created = await this.call<QuantWorkspace>('workspace.create', {
            name: field('name') || undefined,
            venue: field('venue'),
            product: field('product'),
          });
          this.projects = await this.call('workspace.list');
          this.renderProjects();
          await this.select(created.id);
        }
        dialog.close();
      })()
        .catch(fail)
        .finally(() => {
          submit.disabled = false;
        });
    });
  }
  private async renderNativeStatus(): Promise<void> {
    const card = document.querySelector<HTMLElement>('[data-native-engine]');
    if (!card) return;
    const generation = ++this.nativeGeneration;
    try {
      const status = await this.call<QuantNativeStatus>('native.status');
      if (generation !== this.nativeGeneration || !card.isConnected) return;
      const label = !status.available
        ? 'nativeUnavailable'
        : status.lastError === 'NATIVE_STORAGE_FAULT' || status.summary?.faulted
          ? 'nativeRecovery'
          : status.state === 'connected'
            ? 'nativeConnected'
            : status.state === 'failed'
              ? 'nativeFailed'
              : status.state === 'stopped'
                ? 'nativeStopped'
                : 'nativeStarting';
      card.querySelector<HTMLElement>('[data-native-status]')!.textContent =
        this.text(label) +
        (status.development ? ' · ' + this.text('nativeDev') : '') +
        (status.version ? ' · ' + status.version : '');
      card.querySelector<HTMLButtonElement>('[data-native="start"]')!.disabled =
        !status.available || ['starting', 'connected', 'stopping'].includes(status.state);
      card.querySelector<HTMLButtonElement>('[data-native="stop"]')!.disabled =
        status.state !== 'connected';
      const data = await this.call<{ sources: QuantNativeSource[] }>('native.source.status');
      if (generation !== this.nativeGeneration || !card.isConnected) return;
      const product = card.querySelector<HTMLSelectElement>('[data-source-product]')!.value;
      const source = data.sources.find((s) => s.product === product);
      const labels: Record<QuantNativeSource['phase'], QuantLabel> = {
        stopped: 'nativeStopped',
        resolving: 'sourceResolving',
        connecting: 'nativeStarting',
        snapshot: 'sourceSnapshot',
        ready: 'sourceReady',
        delayed: 'sourceDelayed',
        reconnecting: 'sourceReconnect',
        blocked: 'sourceBlocked',
        failed: 'nativeFailed',
      };
      card.querySelector<HTMLElement>('[data-source-status]')!.textContent =
        this.text(labels[source?.phase || 'stopped']) +
        (typeof source?.sourceLagMs === 'number'
          ? ' · ' + Math.round(source.sourceLagMs) + ' ms'
          : '') +
        (source?.lastError ? ' · ' + source.lastError : '');
      const fee = card.querySelector<HTMLInputElement>('[data-source-fee]')!;
      if (!fee.dataset.loaded) {
        fee.value = String(source?.assumptions?.feeBps ?? 10);
        fee.dataset.loaded = 'true';
      }
      card.querySelector<HTMLButtonElement>('[data-source="start"]')!.disabled =
        status.state !== 'connected' || !!source?.desired;
      card.querySelector<HTMLButtonElement>('[data-source="stop"]')!.disabled = !source?.desired;
      card.querySelector<HTMLButtonElement>('[data-source="book"]')!.disabled =
        status.state !== 'connected' || !source?.instrument;
    } catch {
      if (generation === this.nativeGeneration && card.isConnected)
        card.querySelector<HTMLElement>('[data-native-status]')!.textContent =
          this.text('nativeFailed');
    }
  }
  private walkForwardDialog(workspace: QuantWorkspace): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog quant-amm-dialog quant-walk-forward-dialog';
    const field = (label: QuantLabel, name: string, attrs: string) =>
      `<label>${escape(this.text(label))}<input name="${name}" ${attrs} required></label>`;
    dialog.innerHTML = `<header><h2>${escape(this.text('walkForward'))}</h2><button type="button" data-close aria-label="${escape(this.text('close'))}">${icon('close')}</button></header>
      <p class="quant-hint">${escape(this.text('wfHint'))}</p>
      <form><div class="quant-amm-grid">
      ${field('wfTrainBars', 'trainBars', 'type="number" min="5" max="5000" value="120"')}
      ${field('wfTestBars', 'testBars', 'type="number" min="2" max="2500" value="30"')}
      ${field('wfFolds', 'folds', 'type="number" min="1" max="8" value="3"')}
      ${field('wfFast', 'fastPeriods', 'inputmode="text" value="5, 9, 15" maxlength="40"')}
      ${field('wfSlow', 'slowPeriods', 'inputmode="text" value="21, 34, 55" maxlength="40"')}
      ${field('initialCash', 'initialCash', 'inputmode="decimal" value="10000"')}
      ${field('feeBps', 'feeBps', `type="number" min="0" max="1000" value="${escape(workspace.risk.feeBps)}"`)}
      ${field('slippageBps', 'slippageBps', `type="number" min="0" max="1000" value="${escape(workspace.risk.slippageBps)}"`)}
      ${field('ammReplayAllocation', 'allocationBps', 'type="number" min="1" max="9500" value="2500"')}</div>
      <p role="alert" class="quant-dialog-error" hidden></p><footer><span role="status"></span><button type="submit" class="quant-primary">${escape(this.text('walkForward'))}</button></footer></form>`;
    const form = dialog.querySelector('form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    const status = form.querySelector<HTMLElement>('[role="status"]')!;
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const config = Object.fromEntries(
        [...new FormData(form)].map(([key, value]) => [
          key,
          key.endsWith('Periods')
            ? String(value)
                .split(/[,，]/)
                .map((period) => Number(period.trim()))
            : key === 'initialCash'
              ? value
              : Number(value),
        ]),
      );
      submit.disabled = true;
      alert.hidden = true;
      status.textContent = this.text('loading');
      try {
        const run = await this.call<QuantRun>('run.walk-forward', {
          id: workspace.id,
          datasetId: workspace.preferences.datasetId ?? undefined,
          config,
        });
        if (dialog.open) dialog.close();
        if (this.currentId === workspace.id) {
          this.selectedRun = run;
          await this.pull();
          if (this.currentId === workspace.id)
            this.el('[data-run-report]').scrollIntoView({ block: 'start' });
        }
      } catch (error) {
        alert.textContent = this.errorText(error);
        alert.hidden = false;
      } finally {
        submit.disabled = false;
        status.textContent = '';
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  private ammScenarioDialog(id: string, dataset: QuantDataset): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog quant-amm-dialog quant-amm-scenario-dialog';
    dialog.innerHTML = `<header><h2>${escape(this.text('ammScenario'))}</h2><button type="button" data-close aria-label="${escape(this.text('close'))}">${icon('close')}</button></header><p class="quant-hint">${escape(dataset.label)}</p><p class="quant-hint">${escape(this.text('ammScenarioHint'))}</p>
      <form><div class="quant-amm-grid"><label>${escape(this.text('ammScenarioFunds'))}<input name="initialWeth" inputmode="decimal" value="1" required></label><label>${escape(this.text('ammScenarioAnchor'))}<input name="anchorBlock" type="number" min="0"></label></div>
      <div data-scenario-legs></div><button type="button" data-add>${escape(this.text('ammScenarioAdd'))}</button><p role="alert" class="quant-dialog-error" hidden></p><footer><span role="status"></span><button type="submit" class="quant-primary">${escape(this.text('ammScenario'))}</button></footer></form>`;
    const form = dialog.querySelector('form')!;
    const rows = form.querySelector<HTMLElement>('[data-scenario-legs]')!;
    const add = form.querySelector<HTMLButtonElement>('[data-add]')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    const status = form.querySelector<HTMLElement>('[role="status"]')!;
    const controls = (busy: boolean) => {
      submit.disabled = busy || rows.children.length === 0;
      add.disabled = busy || rows.children.length >= 8;
      for (const button of rows.querySelectorAll('button'))
        button.disabled = busy || rows.children.length === 1;
    };
    const addLeg = () => {
      const row = document.createElement('div');
      row.className = 'quant-amm-scenario-leg';
      row.innerHTML = `<label>${escape(this.text('side'))}<select name="side"><option value="sell">${escape(this.text('sell'))} WETH</option><option value="buy">${escape(this.text('buy'))} WETH</option></select></label><label><span data-amount></span><input name="amountIn" inputmode="decimal" required></label><label><span data-minimum></span><input name="minimumOut" inputmode="decimal"></label><button type="button" aria-label="${escape(this.text('ammScenarioRemove'))}">${icon('close')}</button>`;
      const side = row.querySelector('select')!;
      const units = () => {
        const buy = side.value === 'buy';
        row.querySelector('[data-amount]')!.textContent =
          `${this.text('ammScenarioAmount')} · ${buy ? 'USDC' : 'WETH'}`;
        row.querySelector('[data-minimum]')!.textContent =
          `${this.text('ammScenarioMinimum')} · ${buy ? 'WETH' : 'USDC'}`;
      };
      side.addEventListener('change', units);
      row.querySelector('button')!.addEventListener('click', () => {
        row.remove();
        controls(false);
      });
      if (!rows.children.length)
        row.querySelector<HTMLInputElement>('[name="amountIn"]')!.value = '0.1';
      rows.append(row);
      units();
      controls(false);
    };
    add.addEventListener('click', addLeg);
    addLeg();
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const minimums = data.getAll('minimumOut');
      const inputs = data.getAll('amountIn');
      const legs = data
        .getAll('side')
        .map((side, i) => ({ side, amountIn: inputs[i], minimumOut: minimums[i] || undefined }));
      const anchor = data.get('anchorBlock');
      controls(true);
      alert.hidden = true;
      status.textContent = this.text('loading');
      try {
        const run = await this.call<QuantRun>('run.amm.scenario', {
          id,
          datasetId: dataset.id,
          config: {
            legs,
            initialWeth: data.get('initialWeth'),
            anchorBlock: anchor ? Number(anchor) : undefined,
          },
        });
        if (dialog.open) dialog.close();
        if (this.currentId === id) {
          this.selectedRun = run;
          await this.pull();
          this.renderRuns();
        }
      } catch (error) {
        if (dialog.open) {
          alert.textContent = this.errorText(error);
          alert.hidden = false;
        }
      } finally {
        controls(false);
        status.textContent = '';
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  private ammReplayDialog(id: string, dataset: QuantDataset): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog quant-amm-dialog quant-amm-replay-dialog';
    const field = (label: QuantLabel, name: string, attrs: string) =>
      `<label>${escape(this.text(label))}<input name="${name}" ${attrs}></label>`;
    dialog.innerHTML = `<header><h2>${escape(this.text('ammReplay'))}</h2><button type="button" data-close aria-label="${escape(this.text('close'))}">${icon('close')}</button></header><p>${escape(dataset.label)}</p><p class="quant-hint">${escape(this.text('ammReplayHint'))}</p>
      <form><div class="quant-amm-grid"><label>${escape(this.text('strategy'))}<select name="strategy"><option value="buy-hold">${escape(this.text('hold'))}</option><option value="sma-cross">${escape(this.text('sma'))}</option></select></label>
      ${field('ammReplayCash', 'initialCash', 'inputmode="decimal" value="10000" required')}${field('fast', 'fast', 'type="number" min="2" max="200" value="9" required')}${field('slow', 'slow', 'type="number" min="3" max="500" value="21" required')}
      ${field('ammReplayAllocation', 'allocationBps', 'type="number" min="1" max="10000" value="2500" required')}${field('ammReplayDelay', 'delayBlocks', 'type="number" min="1" max="10000" value="1" required')}${field('ammReplayLimit', 'maxQuotes', 'type="number" min="1" max="32" value="16" required')}${field('ammReplayAdverse', 'maxAdverseBps', 'type="number" min="0" max="10000"')}
      <label>${escape(this.text('ammFeeMode'))}<select name="feeMode"><option value="fixed">${escape(this.text('ammFeeFixed'))}</option><option value="historical">${escape(this.text('ammFeeHistorical'))}</option></select></label>
      ${field('ammReplayFee', 'fixedFeeUsdc', 'data-fee-mode="fixed" inputmode="decimal" value="0" required')}${field('ammFeeCap', 'networkFeeCapUsdc', 'data-fee-mode="historical" inputmode="decimal" value="1" required')}${field('ammFeeTip', 'tipGwei', 'data-fee-mode="historical" inputmode="decimal" value="0" required')}${field('ammFeeOverhead', 'routerOverheadGas', 'data-fee-mode="historical" type="number" min="21000" max="500000" value="55000" required')}</div>
      <p role="alert" class="quant-dialog-error" hidden></p><footer><span role="status"></span><button type="submit" class="quant-primary">${escape(this.text('ammReplay'))}</button></footer></form>`;
    const form = dialog.querySelector('form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    const status = form.querySelector<HTMLElement>('[role="status"]')!;
    const strategy = form.querySelector<HTMLSelectElement>('[name="strategy"]')!;
    const updatePeriods = () => {
      for (const input of form.querySelectorAll<HTMLInputElement>('[name="fast"], [name="slow"]')) {
        input.disabled = strategy.value !== 'sma-cross';
        input.closest('label')!.hidden = input.disabled;
      }
    };
    strategy.addEventListener('change', updatePeriods);
    updatePeriods();
    const feeMode = form.querySelector<HTMLSelectElement>('[name="feeMode"]')!;
    const updateFeeMode = () => {
      for (const input of form.querySelectorAll<HTMLInputElement>('[data-fee-mode]')) {
        input.disabled = input.dataset.feeMode !== feeMode.value;
        input.closest('label')!.hidden = input.disabled;
      }
    };
    feeMode.addEventListener('change', updateFeeMode);
    updateFeeMode();
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const config = Object.fromEntries(
        [...new FormData(form)]
          .filter(([, value]) => value !== '')
          .map(([key, value]) => [
            key,
            [
              'strategy',
              'feeMode',
              'initialCash',
              'fixedFeeUsdc',
              'networkFeeCapUsdc',
              'tipGwei',
            ].includes(key)
              ? value
              : Number(value),
          ]),
      );
      submit.disabled = true;
      alert.hidden = true;
      status.textContent = this.text('loading');
      try {
        const run = await this.call<QuantRun>('run.amm', { id, datasetId: dataset.id, config });
        if (dialog.open) dialog.close();
        if (this.currentId === id) {
          this.selectedRun = run;
          await this.pull();
          this.renderRuns();
        }
      } catch (error) {
        if (dialog.open) {
          alert.textContent = this.errorText(error);
          alert.hidden = false;
        }
      } finally {
        submit.disabled = false;
        status.textContent = '';
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  private baseHistoryDialog(w: QuantWorkspace): void {
    if (!w.network) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog quant-amm-dialog';
    const selected = w.datasets.find((d) => d.id === w.preferences.datasetId && d.amm);
    const { maxCount, defaultCount } = w.network.historyWindow;
    const canContinue =
      selected?.amm?.chainId === w.network?.id &&
      selected?.amm?.fee === w.market.poolFee &&
      selected?.amm?.interval === w.market.interval;
    dialog.innerHTML = `<header><h2>${escape(this.text('ammHistory'))}</h2><button type="button" data-close aria-label="${escape(this.text('close'))}">${icon('close')}</button></header>
      <p class="quant-hint">${escape(this.text('ammHint'))}</p>
      <section class="quant-amm-recorder"><h3>${escape(this.text('ammRecord'))}</h3><p data-record-status role="status"></p><p data-record-detail></p><div class="quant-amm-record-actions">${(['Start', 'Selected', 'Resume', 'Stop', 'Latest'] as const).map((key) => `<button type="button" data-record="${key}" hidden>${escape(this.text(`ammRecord${key}`))}</button>`).join('')}</div></section>
      ${selected ? `<div class="quant-amm-trades"><p>${escape(new Date(selected.start * 1000).toLocaleString())} – ${escape(new Date(selected.end * 1000).toLocaleString())}</p><div data-trades role="region" aria-label="${escape(this.text('ammDeltas'))}"></div><div class="quant-amm-pagination"><button type="button" data-prev>${escape(this.text('previous'))}</button><span data-trade-page aria-live="polite"></span><button type="button" data-next>${escape(this.text('next'))}</button></div></div>` : ''}
      ${selected?.amm ? `<form class="quant-amm-series" data-series-form><label>${escape(this.text('ammSeriesWindow'))}<input name="windows" type="number" min="1" max="10000" value="${Math.ceil(86400 / selected.amm.interval)}" required></label><button type="submit">${escape(this.text('ammSeriesCreate'))}</button></form>` : ''}
      <form data-capture-form>${maxCount ? `<label>${escape(this.text('ammWindow'))}<input name="count" type="number" min="1" max="${maxCount}" value="${defaultCount}" required></label>` : `<p>${escape(this.text('ammTooWide'))}</p>`}
      <footer><span class="quant-hint" data-capture-progress role="status"></span>${canContinue && maxCount ? `<button type="submit" value="continue">${escape(this.text('ammContinue'))}</button>` : ''}${maxCount ? `<button class="quant-primary" type="submit" value="recent">${escape(this.text('ammCapture'))}</button>` : ''}</footer></form><p class="quant-dialog-error" role="alert" hidden></p>`;
    const alert = dialog.querySelector<HTMLElement>('[role="alert"]')!;
    const showError = (error: unknown) => {
      alert.textContent = /BASE_HISTORY_UP_TO_DATE/.test(String(error))
        ? this.text('ammUpToDate')
        : /BASE_HISTORY_TIMEOUT|EXECUTION_PROFILE_LIMIT|EXECUTION_PROFILE_RATE_LIMIT/.test(
              String(error),
            )
          ? this.text('ammRetryShorter')
          : /BASE_SERIES_READ_LIMIT/.test(String(error))
            ? this.text('ammSeriesLimit')
            : this.errorText(error);
      alert.hidden = false;
    };
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    this.bindBaseRecorder(dialog, w, canContinue ? selected?.id : undefined, showError);
    const seriesForm = dialog.querySelector<HTMLFormElement>('[data-series-form]');
    seriesForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = seriesForm.querySelector('button')!;
      button.disabled = true;
      alert.hidden = true;
      try {
        await this.call<QuantDataset>('base.history.series', {
          id: w.id,
          datasetId: selected?.id,
          windows: Number(new FormData(seriesForm).get('windows')),
          select: true,
        });
        if (dialog.open) dialog.close();
        await this.pull();
      } catch (error) {
        if (dialog.open) showError(error);
      } finally {
        button.disabled = false;
      }
    });
    const form = dialog.querySelector<HTMLFormElement>('[data-capture-form]')!;
    const progress = form.querySelector<HTMLElement>('[data-capture-progress]')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const buttons = [...form.querySelectorAll<HTMLButtonElement>('button')];
      buttons.forEach((button) => (button.disabled = true));
      progress.textContent = this.text('loading');
      alert.hidden = true;
      const next = (event.submitter as HTMLButtonElement | null)?.value === 'continue';
      void this.call('base.history.capture', {
        id: w.id,
        count: Number(new FormData(form).get('count')),
        afterDatasetId: next ? selected?.id : undefined,
        select: true,
      })
        .then(async () => {
          if (dialog.open) dialog.close();
          await this.pull();
        })
        .catch(showError)
        .finally(() => {
          progress.textContent = '';
          buttons.forEach((button) => (button.disabled = false));
        });
    });
    if (!selected) return;
    const previous = dialog.querySelector<HTMLButtonElement>('[data-prev]')!;
    const next = dialog.querySelector<HTMLButtonElement>('[data-next]')!;
    let offset = 0;
    const limit = 12;
    const render = async (at: number) => {
      previous.disabled = next.disabled = true;
      try {
        const { items, total } = await this.call<{ items: QuantBaseTrade[]; total: number }>(
          'base.history.trades',
          { id: w.id, datasetId: selected.id, offset: at, limit },
        );
        if (!dialog.open) return;
        offset = at;
        dialog.querySelector('[data-trade-page]')!.textContent = total
          ? `${offset + 1}–${offset + items.length} / ${total}`
          : '0';
        const headers = ['WETH', 'USDC', this.text('ammBlockLog')];
        dialog.querySelector('[data-trades]')!.innerHTML = items.length
          ? `<table><caption>${escape(this.text('ammDeltas'))}</caption><thead><tr>${headers.map((label) => `<th scope="col">${escape(label)}</th>`).join('')}</tr></thead><tbody>${items.map((trade) => `<tr title="${escape(new Date(trade.time * 1000).toLocaleString() + ' · ' + trade.transactionHash)}"><td>${escape(signedAmount(trade.wethDeltaAtoms, 18))}</td><td>${escape(signedAmount(trade.usdcDeltaAtoms, 6))}</td><td>${trade.block} / ${trade.logIndex}</td></tr>`).join('')}</tbody></table>`
          : `<p>${escape(this.text('ammEmpty'))}</p>`;
        previous.disabled = offset === 0;
        next.disabled = offset + items.length >= total;
      } catch (error) {
        showError(error);
      }
    };
    previous.addEventListener('click', () => void render(Math.max(0, offset - limit)));
    next.addEventListener('click', () => void render(offset + limit));
    void render(0);
  }
  private bindBaseRecorder(
    dialog: HTMLDialogElement,
    workspace: QuantWorkspace,
    selectedId: string | undefined,
    showError: (error: unknown) => void,
  ): void {
    const { id } = workspace;
    const { recorder, historyWindow } = workspace.network!;
    const statusNode = dialog.querySelector<HTMLElement>('[data-record-status]')!;
    const detail = dialog.querySelector<HTMLElement>('[data-record-detail]')!;
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-record]'));
    let current = recorder,
      busy = false,
      reading = false,
      requestVersion = 0;
    const labels = {
      idle: 'ammRecordIdle',
      waiting: 'ammRecordWaiting',
      capturing: 'ammRecordCapturing',
      retrying: 'ammRecordRetrying',
      paused: 'ammRecordPaused',
    } as const;
    const render = (status: QuantBaseRecorder) => {
      if (!dialog.open) return;
      current = status;
      const statusText = this.text(labels[status.phase]);
      if (statusText !== statusNode.textContent) statusNode.textContent = statusText;
      const details: string[] = [];
      if (status.startTime != null && status.endTime != null)
        details.push(
          `${new Date(status.startTime * 1000).toLocaleString()} – ${new Date(status.endTime * 1000).toLocaleString()}`,
        );
      if (status.lastError) details.push(status.lastError);
      if (status.pauseReason === 'market-changed')
        details.push(this.text('ammRecordMarketChanged'));
      if (status.pauseReason === 'review') details.push(this.text('ammRecordReview'));
      if (status.nextAt && status.phase !== 'capturing')
        details.push(
          `${this.text('ammRecordNext')} ${new Date(status.nextAt).toLocaleTimeString()}`,
        );
      detail.textContent = details.join(' · ');
      detail.hidden = !details.length;
      const inactive = status.phase === 'paused' || status.phase === 'idle';
      const visible = {
        Start: inactive && historyWindow.maxCount > 0,
        Selected: inactive && historyWindow.maxCount > 0 && Boolean(selectedId),
        Resume: inactive && status.canResume === true,
        Stop: !inactive,
        Latest: Boolean(status.datasetId),
      };
      for (const button of buttons)
        button.hidden = !visible[button.dataset.record as keyof typeof visible];
    };
    const read = async () => {
      if (busy || reading || !dialog.open) return;
      reading = true;
      const version = requestVersion;
      try {
        const status = await this.call<QuantBaseRecorder>('base.history.record.status', { id });
        if (version === requestVersion) render(status);
      } catch (error) {
        if (dialog.open && version === requestVersion) showError(error);
      } finally {
        reading = false;
      }
    };
    render(recorder);
    const timer = setInterval(() => void read(), 2500);
    dialog.addEventListener('close', () => clearInterval(timer), { once: true });
    for (const button of buttons)
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        requestVersion++;
        buttons.forEach((control) => (control.disabled = true));
        try {
          const action = button.dataset.record;
          if (action === 'Latest') {
            const next = await this.call<QuantWorkspace>('workspace.update', {
              id,
              preferences: { datasetId: current.datasetId },
            });
            if (!dialog.open) return;
            dialog.close();
            if (this.currentId === id) {
              await this.pull();
              this.baseHistoryDialog(next);
            }
          } else {
            render(
              await this.call<QuantBaseRecorder>(
                action === 'Stop' ? 'base.history.record.stop' : 'base.history.record.start',
                {
                  id,
                  resume: action === 'Resume',
                  afterDatasetId: action === 'Selected' ? selectedId : undefined,
                },
              ),
            );
          }
        } catch (error) {
          if (dialog.open) showError(error);
        } finally {
          busy = false;
          buttons.forEach((control) => (control.disabled = false));
        }
      });
  }
  private sourceBookDialog(product: string): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog quant-source-book-dialog';
    dialog.dataset.product = product;
    dialog.innerHTML = `<header><h2>${escape(this.text('sourceBook'))} · ${escape(product)}</h2><button type="button" data-close aria-label="${escape(this.text('close'))}">${icon('close')}</button></header><p class="quant-hint">${escape(this.text('sourceHint'))}</p><div data-source-book role="status">${escape(this.text('nativeStarting'))}</div>`;
    document.body.append(dialog);
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
    void this.renderSourceBook(dialog);
  }
  private async renderSourceBook(dialog: HTMLDialogElement): Promise<void> {
    try {
      const book = await this.call<QuantNativeBook>('native.source.book', {
        product: dialog.dataset.product,
      });
      if (!dialog.isConnected) return;
      const levels = (items: [string, string][], key: QuantLabel) =>
        `<section><h3>${escape(this.text(key))} · ${escape(book.assumptions.quoteCurrency)}</h3><table><thead><tr><th>${escape(this.text('orderPrice'))}</th><th>${escape(this.text('amount'))}</th></tr></thead><tbody>${items
          .slice(0, 12)
          .map(([price, size]) => `<tr><td>${escape(price)}</td><td>${escape(size)}</td></tr>`)
          .join('')}</tbody></table></section>`;
      dialog.querySelector('[data-source-book]')!.innerHTML =
        `<p>${escape(this.text(book.eligible ? 'sourceEligible' : 'sourceIneligible'))} · ${escape(book.assumptions.feeBps)} bps</p>${book.source.clock ? `<p class="quant-hint">${escape(this.text('sourceClock'))} ${Math.round(book.source.clock.estimatedOffsetMs)} ms · ±${Math.ceil(book.source.clock.uncertaintyMs)} ms</p>` : ''}<div class="quant-source-book-columns">${levels(book.bids, 'sourceBid')}${levels(book.asks, 'sourceAsk')}</div>`;
    } catch (error) {
      if (dialog.isConnected)
        dialog.querySelector('[data-source-book]')!.textContent = String(error);
    }
  }
  private async expandChart(): Promise<void> {
    if (document.fullscreenElement === this.chartCard) {
      await document.exitFullscreen();
      return;
    }
    if (this.focusExpanded) {
      this.exitChart();
      return;
    }
    try {
      await this.chartCard.requestFullscreen();
    } catch {
      this.focusExpanded = true;
      this.chartCard.classList.add('quant-focus-fullscreen');
      this.chart.schedule();
    }
  }
  private exitChart(): void {
    if (document.fullscreenElement === this.chartCard) void document.exitFullscreen();
    this.focusExpanded = false;
    this.chartCard.classList.remove('quant-focus-fullscreen');
    this.chart.schedule();
  }
  private installResize(): void {
    const bar = this.el('.quant-chat-resizer');
    let drag = false,
      width = 360;
    bar.addEventListener('pointerdown', (event) => {
      drag = true;
      width = this.workspace?.preferences.chatWidth || 360;
      bar.setPointerCapture(event.pointerId);
    });
    bar.addEventListener('pointermove', (event) => {
      if (!drag) return;
      width = Math.max(280, Math.min(600, this.root.getBoundingClientRect().right - event.clientX));
      this.el('[data-layout]').style.setProperty('--quant-chat-width', width + 'px');
    });
    bar.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = false;
      void this.update({ preferences: { chatWidth: Math.round(width) } }).catch((error) =>
        this.error(error),
      );
    });
    bar.addEventListener('pointercancel', () => {
      drag = false;
    });
    bar.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      void this.update({
        preferences: {
          chatWidth: Math.max(
            280,
            Math.min(
              600,
              (this.workspace?.preferences.chatWidth || 360) +
                (event.key === 'ArrowLeft' ? 20 : -20),
            ),
          ),
        },
      }).catch((error) => this.error(error));
    });
  }
  private number(value: unknown): string {
    const n = Number(value);
    return Number.isFinite(n)
      ? n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 1 ? 6 : 2 })
      : '—';
  }
  private errorText(error: unknown): string {
    const code = error instanceof Error ? error.message : String(error);
    if (/WALK_FORWARD_MORE_CANDLES/.test(code)) return this.text('wfMore');
    if (/WALK_FORWARD_GRID|WALK_FORWARD_PARAMETERS/.test(code)) return this.text('wfInvalid');
    const key: QuantLabel | undefined = /FRESH_MARKET/.test(code)
      ? 'errorFresh'
      : /INSUFFICIENT/.test(code)
        ? 'errorFunds'
        : /PAPER_PAUSED/.test(code)
          ? 'errorPaused'
          : /MORE_CANDLES|CANDLES_LIMIT/.test(code)
            ? 'errorData'
            : /MAX_ORDER|MAX_POSITION/.test(code)
              ? 'errorRisk'
              : /PAUSE_AND_CANCEL/.test(code)
                ? 'errorConfig'
                : /BASE_POOL_NOT_FOUND/.test(code)
                  ? 'errorBase'
                  : undefined;
    return key ? this.text(key) : this.text('invalid') + ' · ' + code;
  }
  private notice(message: string): void {
    const node = this.el('[data-notice]');
    node.hidden = false;
    node.textContent = message;
    node.classList.remove('error');
  }
  private error(error: unknown): void {
    this.notice(this.errorText(error));
    this.el('[data-notice]').classList.add('error');
  }
  private download(name: string, data: unknown): void {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
