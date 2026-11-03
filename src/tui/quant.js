/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { getLanguage } = require('./text');
const { stripAnsi } = require('./ansi');
const sourceLabels = require('../shared/quant-source-labels.json');
const nativePaperLabels = require('../shared/quant-native-paper-labels.json');
const strategyLabels = require('../shared/quant-strategy-labels.json');
const eventLabels = require('../shared/quant-event-labels.json');
const executionLabels = require('../shared/quant-execution-labels.json');
const fs = require('node:fs/promises'),
  path = require('node:path');
const labels = {
  zh: {
    ...strategyLabels.zh,
    ...eventLabels.zh,
    ...executionLabels.zh,
    ...nativePaperLabels.zh,
    ...sourceLabels.zh,
    import: '导入本机 CSV / JSON',
    parent: '上级目录',
    title: '量化项目',
    native: '原生执行进程 · 仿真基础服务',
    nativeStart: '连接原生进程',
    nativeStop: '停止原生进程',
    nativeNote: sourceLabels.zh.nativeHint,
    nativeReady: '已连接',
    nativeStopped: '已停止',
    nativeWorking: '正在连接或停止',
    nativeFailed: '连接失败',
    nativeRecovery: '执行账本已暂停，需要检查存储并恢复',
    nativeUnavailable: '当前构建没有可用的原生进程',
    close: '关闭',
    back: '返回',
    create: '新建项目',
    name: '项目名称',
    market: '选择市场',
    chat: '进入研究对话',
    goal: '设置持续目标',
    wallet: '钱包与实盘授权',
    refresh: '刷新行情',
    paperStart: '开始仿真',
    paperPause: '暂停新仿真订单',
    orders: '仿真订单',
    runs: '回测实验',
    audit: '活动审计',
    research: '研究证据',
    researchHint: '保留实际读到的资料；来源说法仍需核实。',
    source: '来源',
    retrieved: '检索于',
    published: '来源自报发布时间',
    unknown: '未提供',
    partial: '这是原文片段的归档，并非全文。',
    run: '运行回测',
    risk: '仿真风控',
    cash: '初始模拟资金',
    fast: '快均线周期',
    slow: '慢均线周期',
    feeBps: '费率（基点）',
    slippageBps: '滑点（基点）',
    maxOrder: '单笔名义额上限',
    maxExposure: '总敞口上限',
    maxPosition: '持仓数量上限',
    dataset: '选择数据集',
    current: '当前市场快照',
    next: '下一页',
    previous: '上一页',
    saved: '已保存',
    empty: '暂无记录',
  },
  en: {
    ...strategyLabels.en,
    ...eventLabels.en,
    ...executionLabels.en,
    ...nativePaperLabels.en,
    ...sourceLabels.en,
    import: 'Import local CSV / JSON',
    parent: 'Parent folder',
    title: 'Quant projects',
    native: 'Native execution · paper foundation',
    nativeStart: 'Connect native process',
    nativeStop: 'Stop native process',
    nativeNote: sourceLabels.en.nativeHint,
    nativeReady: 'Connected',
    nativeStopped: 'Stopped',
    nativeWorking: 'Connecting or stopping',
    nativeFailed: 'Connection failed',
    nativeRecovery: 'Execution ledger paused; inspect storage and recover',
    nativeUnavailable: 'No usable native process in this build',
    close: 'Close',
    back: 'Back',
    create: 'New project',
    name: 'Project name',
    market: 'Choose market',
    chat: 'Open research chat',
    goal: 'Set a continuous goal',
    wallet: 'Wallet and live approvals',
    refresh: 'Refresh market',
    paperStart: 'Start paper mode',
    paperPause: 'Pause new paper orders',
    orders: 'Paper orders',
    runs: 'Experiments',
    audit: 'Audit history',
    research: 'Research evidence',
    researchHint: 'Preserves what was actually read. Source claims still need verification.',
    source: 'Source',
    retrieved: 'Retrieved',
    published: 'Source-reported publication',
    unknown: 'Not provided',
    partial: 'This archive is a slice, not the whole article.',
    run: 'Run backtest',
    risk: 'Paper risk',
    cash: 'Initial simulated cash',
    fast: 'Fast moving-average period',
    slow: 'Slow moving-average period',
    feeBps: 'Fee (basis points)',
    slippageBps: 'Slippage (basis points)',
    maxOrder: 'Maximum order notional',
    maxExposure: 'Maximum exposure',
    maxPosition: 'Maximum position quantity',
    dataset: 'Choose dataset',
    current: 'Current market snapshot',
    next: 'Next page',
    previous: 'Previous page',
    saved: 'Saved',
    empty: 'No records',
  },
  de: {
    ...strategyLabels.de,
    ...eventLabels.de,
    ...executionLabels.de,
    ...nativePaperLabels.de,
    ...sourceLabels.de,
    import: 'Lokale CSV / JSON importieren',
    parent: 'Übergeordneter Ordner',
    title: 'Quant-Projekte',
    native: 'Native Ausführung · Simulationsbasis',
    nativeStart: 'Nativen Prozess verbinden',
    nativeStop: 'Nativen Prozess stoppen',
    nativeNote: sourceLabels.de.nativeHint,
    nativeReady: 'Verbunden',
    nativeStopped: 'Gestoppt',
    nativeWorking: 'Verbindung oder Stopp läuft',
    nativeFailed: 'Verbindung fehlgeschlagen',
    nativeRecovery: 'Ausführungsbuch pausiert; Speicher prüfen und wiederherstellen',
    nativeUnavailable: 'Kein verwendbarer nativer Prozess in diesem Build',
    close: 'Schließen',
    back: 'Zurück',
    create: 'Neues Projekt',
    name: 'Projektname',
    market: 'Markt auswählen',
    chat: 'Forschungsdialog öffnen',
    goal: 'Fortlaufendes Ziel festlegen',
    wallet: 'Wallet und Live-Freigaben',
    refresh: 'Marktdaten aktualisieren',
    paperStart: 'Simulation starten',
    paperPause: 'Neue Simulationsaufträge pausieren',
    orders: 'Simulationsaufträge',
    runs: 'Experimente',
    audit: 'Prüfprotokoll',
    research: 'Recherchebelege',
    researchHint: 'Bewahrt tatsächlich gelesene Inhalte. Aussagen müssen weiterhin geprüft werden.',
    source: 'Quelle',
    retrieved: 'Abgerufen',
    published: 'Veröffentlichung laut Quelle',
    unknown: 'Nicht angegeben',
    partial: 'Dieses Archiv ist ein Ausschnitt, nicht der vollständige Artikel.',
    run: 'Backtest ausführen',
    risk: 'Simulationsrisiko',
    cash: 'Anfängliches Simulationskapital',
    fast: 'Kurzer gleitender Durchschnitt',
    slow: 'Langer gleitender Durchschnitt',
    feeBps: 'Gebühr (Basispunkte)',
    slippageBps: 'Slippage (Basispunkte)',
    maxOrder: 'Maximaler Auftragswert',
    maxExposure: 'Maximales Exposure',
    maxPosition: 'Maximale Positionsmenge',
    dataset: 'Datensatz auswählen',
    current: 'Aktueller Marktschnappschuss',
    next: 'Nächste Seite',
    previous: 'Vorherige Seite',
    saved: 'Gespeichert',
    empty: 'Keine Einträge',
  },
};
class QuantBrowser {
  constructor(app) {
    this.app = app;
    this.ui = app.walletBrowser;
    this.strategiesBrowser = new (require('./quant-strategies').NativeStrategyBrowser)(this);
  }
  text(key) {
    return (labels[getLanguage()] || labels.zh)[key] || key;
  }
  call(action, input = {}) {
    return this.app.runtime.api.backendRequest('quant:request', action, input);
  }
  menu(title, options, choose, body = '', back = () => this.open()) {
    this.ui.menu(title, options, choose, body, back);
    this.app.state.modal.colorKey = 'code';
  }
  async native() {
    const status = await this.call('native.status');
    const label = !status.available
      ? 'nativeUnavailable'
      : status.lastError === 'NATIVE_STORAGE_FAULT'
        ? 'nativeRecovery'
        : status.state === 'connected'
          ? 'nativeReady'
          : status.state === 'stopped'
            ? 'nativeStopped'
            : status.state === 'failed'
              ? 'nativeFailed'
              : 'nativeWorking';
    const options = [
      { label: this.text('back'), value: 'back' },
      { label: this.text('refresh'), value: 'refresh' },
    ];
    if (status.available && ['stopped', 'failed'].includes(status.state))
      options.push({ label: this.text('nativeStart'), value: 'start' });
    if (status.state === 'connected')
      options.push(
        { label: this.text('nativeStop'), value: 'stop' },
        { label: this.text('sourceTitle'), value: 'sources' },
      );
    this.menu(
      this.text('native'),
      options,
      async (action) => {
        if (action === 'back') return this.open();
        if (action === 'sources') return this.sources();
        if (action !== 'refresh') await this.call('native.' + action);
        await this.native();
      },
      this.text(label) + '\n\n' + this.text('nativeNote'),
    );
  }
  async nativePaper(id) {
    const status = await this.call('native.paper.status', { id }),
      a = status.account;
    const options = [
      { label: this.text('npBack'), value: 'back' },
      { label: this.text('npRefresh'), value: 'refresh' },
    ];
    if (!status.connected) options.push({ label: this.text('npStart'), value: 'start' });
    else {
      if (!status.pendingOrder)
        options.push(
          { label: this.text('npCreate'), value: 'create' },
          { label: this.text('npSelect'), value: 'select' },
        );
      options.push({ label: this.text('npConnect'), value: 'source' });
      if (a)
        options.push(
          {
            label: this.text(a.active ? 'npPause' : 'npEnable'),
            value: a.active ? 'pause' : 'enable',
          },
          { label: this.text('npOrders'), value: 'orders' },
          { label: this.text('npFills'), value: 'executions' },
        );
      if (a?.active && !status.pendingOrder)
        options.push({ label: this.text('npSubmit'), value: 'submit' });
      if (status.pendingOrder)
        options.push({ label: this.text('npReconcile'), value: 'reconcile' });
    }
    const body = [
      this.text('npHint'),
      this.text('npShare'),
      a
        ? `${a.name} · ${this.text(a.active ? 'npActive' : 'npPaused')}\n${Object.entries(a.assets)
            .map(
              ([asset, b]) =>
                `${asset}  ${this.text('npTotal')}: ${b.total}  ${this.text('npReserved')}: ${b.reserved}`,
            )
            .join('\n')}`
        : this.text('npNone'),
      status.pendingOrder ? this.text('npUncertain') : '',
      a?.halt ? this.text('npHalted') + '\n' + this.text('npHaltHint') : '',
    ].join('\n\n');
    if (a && status.connected) {
      if (a.halt) {
        const enable = options.findIndex((o) => o.value === 'enable');
        if (enable >= 0) options.splice(enable, 1);
        options.push({ label: this.text('npResetHalt'), value: 'reset-halt' });
      }
      options.push({ label: this.text('npHalt'), value: 'halt' });
    }
    const haltOperation = require('node:crypto').randomUUID();
    this.menu(
      this.text('npTitle'),
      options,
      async (action) => {
        if (action === 'back') return this.project(id);
        if (action === 'halt') {
          await this.call('native.paper.halt', { id, accountId: a.id, operationId: haltOperation });
          return this.nativePaper(id);
        }
        if (action === 'reset-halt' && a?.halt)
          return this.menu(
            this.text('npResetHalt'),
            [
              { label: this.text('npStayHalted'), value: 'cancel' },
              { label: this.text('npResetHalt'), value: 'confirm' },
            ],
            async (choice) => {
              if (choice === 'confirm')
                await this.call('native.paper.reset-halt', {
                  id,
                  accountId: a.id,
                  expectedHalt: a.halt.id,
                  confirmed: true,
                });
              return this.nativePaper(id);
            },
            this.text('npConfirmReset') + '\n\n' + this.text('npShare'),
            () => this.nativePaper(id),
          );
        if (action === 'create') return this.nativePaperCreate(id);
        if (action === 'select') return this.nativePaperAccounts(id);
        if (action === 'source' || action === 'submit')
          return this.menu(
            this.text('npProduct'),
            ['ETH-USD', 'BTC-USD', 'SOL-USD'].map((value) => ({ label: value, value })),
            async (product) => {
              if (action === 'source') {
                await this.call('native.source.start', { product });
                return this.nativePaper(id);
              }
              return this.menu(
                this.text('npSide'),
                ['buy', 'sell'].map((value) => ({
                  label: this.text(value === 'buy' ? 'npBuy' : 'npSell'),
                  value,
                })),
                (side) =>
                  this.fields(
                    ['npPrice', 'npQuantity'],
                    { npPrice: '', npQuantity: '' },
                    async (values) => {
                      await this.call('native.paper.submit', {
                        id,
                        operationId: require('node:crypto').randomUUID(),
                        product,
                        side,
                        price: values.npPrice,
                        quantity: values.npQuantity,
                      });
                      return this.nativePaper(id);
                    },
                    () => this.nativePaper(id),
                  ),
                this.text('npLimitHint'),
                () => this.nativePaper(id),
              );
            },
            '',
            () => this.nativePaper(id),
          );
        if (action === 'orders' || action === 'executions')
          return this.nativePaperHistory(id, action);
        if (action === 'start') await this.call('native.start');
        else if (action !== 'refresh') await this.call('native.paper.' + action, { id });
        return this.nativePaper(id);
      },
      body,
      () => this.project(id),
    );
  }
  async nativePaperAccounts(id, offset = 0) {
    const page = await this.call('native.paper.accounts', { id, offset, limit: 20 });
    const options = [
      { label: this.text('npBack'), value: 'back' },
      ...page.items.map((a) => ({ label: `${a.name} · ${a.id.slice(-6)}`, value: a.id })),
    ];
    if (offset) options.push({ label: this.text('npPrevious'), value: 'previous' });
    if (page.next !== null) options.push({ label: this.text('npNext'), value: 'next' });
    this.menu(
      this.text('npSelect'),
      options,
      async (value) => {
        if (value === 'back') return this.nativePaper(id);
        if (value === 'next' || value === 'previous')
          return this.nativePaperAccounts(
            id,
            value === 'next' ? page.next : Math.max(0, offset - 20),
          );
        await this.call('native.paper.bind', { id, accountId: value });
        return this.nativePaper(id);
      },
      this.text('npShare'),
      () => this.nativePaper(id),
    );
  }
  nativePaperCreate(id) {
    const operationId = require('node:crypto').randomUUID(),
      values = {};
    const steps = [
      ['name', this.text('npName'), 'Paper'],
      ['cash', this.text('npCash'), '10000'],
      ['maxOrder', this.text('npMaxOrder'), '1000'],
      ['maxOrders', this.text('npMaxOrders'), '20'],
      ...['ETH', 'BTC', 'SOL'].map((asset) => [
        'fund' + asset,
        this.text('npInitial') + ' · ' + asset,
        '0',
      ]),
      ...['ETH', 'BTC', 'SOL'].map((asset, i) => [
        'cap' + asset,
        this.text('npPositionLimit') + ' · ' + asset,
        ['10', '1', '100'][i],
      ]),
    ];
    const step = (index) => {
      if (index === steps.length)
        return this.call('native.paper.create', {
          id,
          operationId,
          name: values.name,
          assets: {
            USD: values.cash,
            ETH: values.fundETH,
            BTC: values.fundBTC,
            SOL: values.fundSOL,
          },
          maxOrderNotional: { USD: values.maxOrder },
          maxAssetPosition: { ETH: values.capETH, BTC: values.capBTC, SOL: values.capSOL },
          maxOpenOrders: Number(values.maxOrders),
        }).then(() => this.nativePaper(id));
      const [key, title, initial] = steps[index];
      return this.ui.input(
        title,
        (value) => {
          values[key] = value;
          return step(index + 1);
        },
        {
          value: values[key] ?? initial,
          back: () => (index ? step(index - 1) : this.nativePaper(id)),
        },
      );
    };
    return step(0);
  }
  async nativePaperHistory(id, kind, offset = 0) {
    const orderStatus = (item) =>
      this.text(
        item.execution.held
          ? 'npHeld'
          : item.status === 'filled'
            ? 'npOrderFilled'
            : item.status === 'cancelled'
              ? 'npOrderCancelled'
              : item.status === 'partially-filled'
                ? 'npOrderPartial'
                : 'npAttached',
      );
    const page = await this.call('native.paper.' + kind, { id, offset, limit: 15 });
    const options = [
      { label: this.text('npBack'), value: 'back' },
      ...page.items.map((item, index) => ({
        label:
          kind === 'orders'
            ? `${this.text(item.request.side === 'buy' ? 'npBuy' : 'npSell')} ${item.request.quantity} @ ${item.request.price} · ${item.filled} · ${orderStatus(item)}`
            : `${this.text(item.side === 'buy' ? 'npBuy' : 'npSell')} ${item.fill.quantity} @ ${item.fill.price}`,
        value: index,
      })),
    ];
    if (offset) options.push({ label: this.text('npPrevious'), value: 'previous' });
    if (page.next !== null) options.push({ label: this.text('npNext'), value: 'next' });
    this.menu(
      this.text(kind === 'orders' ? 'npOrders' : 'npFills'),
      options,
      async (value) => {
        if (value === 'back') return this.nativePaper(id);
        if (value === 'next' || value === 'previous')
          return this.nativePaperHistory(
            id,
            kind,
            value === 'next' ? page.next : Math.max(0, offset - 15),
          );
        const item = page.items[value],
          actions = [{ label: this.text('npBack'), value: 'back' }];
        if (kind === 'orders' && ['open', 'partially-filled'].includes(item.status))
          actions.push({ label: this.text('npCancel'), value: 'cancel' });
        const body =
          kind === 'orders'
            ? `${item.request.id}\n${this.text('npAccount')}: ${item.request.account}\n${this.text('npFilled')}: ${item.filled}\n${this.text('npFees')}: ${item.fees}\n${this.text('npReserved')}: ${item.reserved} ${item.reserved_asset}\n${orderStatus(item)}`
            : `${this.text('npPrice')}: ${item.fill.price}\n${this.text('npQuantity')}: ${item.fill.quantity}\n${this.text('npFillFee')}: ${item.fees}\n${this.text('npSource')}: ${item.fill.source?.venue ?? '—'} / ${item.fill.source?.event_id ?? item.fill.id}\n${this.text('npTime')}: ${new Date(Number(BigInt(item.recorded_at_ns) / 1000000n)).toLocaleString()}`;
        return this.menu(
          this.text(kind === 'orders' ? 'npOrders' : 'npFills'),
          actions,
          async (action) => {
            if (action === 'cancel')
              await this.call('native.paper.cancel', { id, orderId: item.request.id });
            return this.nativePaperHistory(id, kind, offset);
          },
          body,
          () => this.nativePaperHistory(id, kind, offset),
        );
      },
      `${page.total}`,
      () => this.nativePaper(id),
    );
  }
  async sources() {
    const status = await this.call('native.source.status');
    this.menu(
      this.text('sourceTitle'),
      [
        { label: this.text('back'), value: 'back' },
        ...(status.products || []).map((product) => ({ label: product, value: product })),
      ],
      (product) => (product === 'back' ? this.native() : this.source(product)),
      this.text('sourceHint'),
      () => this.native(),
    );
  }
  async source(product) {
    const status = await this.call('native.source.status'),
      source = status.sources.find((s) => s.product === product);
    const labels = {
      stopped: 'nativeStopped',
      resolving: 'sourceResolving',
      connecting: 'nativeWorking',
      snapshot: 'sourceSnapshot',
      ready: 'sourceReady',
      delayed: 'sourceDelayed',
      reconnecting: 'sourceReconnect',
      blocked: 'sourceBlocked',
      failed: 'nativeFailed',
    };
    const options = [
      { label: this.text('back'), value: 'back' },
      { label: this.text('refresh'), value: 'refresh' },
    ];
    options.push({
      label: this.text(source?.desired ? 'sourceStop' : 'sourceConnect'),
      value: source?.desired ? 'stop' : 'start',
    });
    if (source?.instrument) options.push({ label: this.text('sourceBook'), value: 'book' });
    this.menu(
      product,
      options,
      async (action) => {
        if (action === 'back') return this.sources();
        if (action === 'book') return this.sourceBook(product);
        if (action === 'start')
          return this.ui.input(
            this.text('sourceFee'),
            async (value) => {
              await this.call('native.source.start', { product, feeBps: Number(value) });
              return this.source(product);
            },
            { value: String(source?.assumptions?.feeBps ?? 10), back: () => this.source(product) },
          );
        if (action === 'stop') await this.call('native.source.stop', { product });
        return this.source(product);
      },
      this.text(labels[source?.phase || 'stopped']) +
        (source?.lastError ? ' · ' + source.lastError : '') +
        '\n\n' +
        this.text('sourceHint'),
      () => this.sources(),
    );
  }
  async sourceBook(product) {
    const book = await this.call('native.source.book', { product });
    const side = (rows, key) =>
      this.text(key) +
      ' · ' +
      book.assumptions.quoteCurrency +
      '\n' +
      rows
        .slice(0, 12)
        .map(([price, size]) => String(price).padStart(14) + '  ' + size)
        .join('\n');
    const clock = book.source.clock;
    const details = [
      this.text(book.eligible ? 'sourceEligible' : 'sourceIneligible'),
      this.text('sourceFee') + ': ' + book.assumptions.feeBps,
      clock
        ? this.text('sourceClock') +
          ': ' +
          Math.round(clock.estimatedOffsetMs) +
          ' ms ±' +
          Math.ceil(clock.uncertaintyMs) +
          ' ms'
        : '',
      side(book.bids, 'sourceBid'),
      side(book.asks, 'sourceAsk'),
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.menu(
      product,
      [
        { label: this.text('back'), value: 'back' },
        { label: this.text('refresh'), value: 'refresh' },
      ],
      (action) => (action === 'back' ? this.source(product) : this.sourceBook(product)),
      details,
      () => this.source(product),
    );
  }
  async open() {
    const projects = await this.call('workspace.list');
    this.menu(
      this.text('title'),
      [
        { label: this.text('close'), value: 'close' },
        { label: this.text('create'), value: 'create' },
        { label: this.text('wallet'), value: 'wallet' },
        { label: this.text('native'), value: 'native' },
        ...projects.map((project) => ({
          label: `${project.name} · ${project.venue} · ${project.paperStatus}`,
          value: project.id,
        })),
      ],
      async (value) => {
        if (value === 'close') return;
        if (value === 'wallet') return this.ui.open();
        if (value === 'native') return this.native();
        if (value === 'create')
          return this.ui.input(
            this.text('name'),
            (name) =>
              this.menu(
                this.text('market'),
                ['base', 'base-sepolia', 'coinbase'].map((venue) => ({
                  label:
                    venue === 'coinbase'
                      ? 'Coinbase · ETH-USD'
                      : venue === 'base'
                        ? 'Base · WETH-USDC'
                        : 'Base Sepolia · WETH-USDC',
                  value: venue,
                })),
                async (venue) => {
                  const project = await this.call('workspace.create', { name, venue });
                  return this.project(project.id);
                },
              ),
            { back: () => this.open() },
          );
        return this.project(value);
      },
      '',
      () => {},
    );
  }
  async attach(id) {
    const view = await this.call('chat.open', { id });
    await this.app.runtime.refresh?.();
    const key = view.key || 'quant:' + id;
    await this.app._switchSession(key, { reload: true });
    return key;
  }
  async project(id) {
    const project = await this.call('workspace.get', { id });
    const actions = [
      'back',
      'chat',
      'goal',
      'wallet',
      'leTitle',
      'npTitle',
      'nsTitle',
      'qeTitle',
      'refresh',
      'import',
      project.paper.status === 'running' ? 'paperPause' : 'paperStart',
      'orders',
      'runs',
      'audit',
      'research',
      'run',
      'dataset',
      'risk',
    ];
    const details = `${project.market.venue} · ${project.market.product}\n${project.quote?.price || '—'} · ${project.paper.status}\n${project.paper.cash} / ${project.paper.position}`;
    this.menu(
      project.name,
      actions.map((value) => ({ label: this.text(value), value })),
      async (action) => {
        if (action === 'back') return this.open();
        if (action === 'wallet') return this.ui.open();
        if (action === 'leTitle')
          return new (require('./quant-execution').LiveExecutionBrowser)(this).open(id);
        if (action === 'npTitle') return this.nativePaper(id);
        if (action === 'nsTitle') return this.strategiesBrowser.open(id);
        if (action === 'qeTitle')
          return new (require('./quant-events').EventDataBrowser)(this).open(id);
        if (action === 'chat') return this.attach(id);
        if (action === 'goal') {
          await this.attach(id);
          return this.ui.input(
            this.text('goal'),
            async (objective) => {
              await this.app.runtime.goalCommand(this.app.activeKey, 'set', objective);
            },
            { back: () => this.project(id) },
          );
        }
        if (action === 'orders' || action === 'runs' || action === 'audit' || action === 'research')
          return this.history(id, action);
        if (action === 'import') return this.importFile(id);
        if (action === 'dataset')
          return this.menu(
            this.text('dataset'),
            [
              { label: this.text('back'), value: 'back' },
              { label: this.text('current'), value: null },
              ...project.datasets.map((dataset) => ({
                label: `${dataset.label} · ${dataset.count}`,
                value: dataset.id,
              })),
            ],
            async (datasetId) => {
              if (datasetId !== 'back')
                await this.call('workspace.update', { id, preferences: { datasetId } });
              return this.project(id);
            },
          );
        if (action === 'risk')
          return this.fields(
            ['maxOrder', 'maxExposure', 'maxPosition', 'feeBps', 'slippageBps'],
            project.risk,
            async (risk) => {
              await this.call('workspace.update', { id, risk });
              return this.project(id);
            },
            () => this.project(id),
          );
        if (action === 'run')
          return this.fields(
            ['fast', 'slow', 'cash', 'feeBps', 'slippageBps'],
            {
              fast: 9,
              slow: 21,
              cash: '10000',
              feeBps: project.risk.feeBps,
              slippageBps: project.risk.slippageBps,
            },
            async (values) => {
              const result = await this.call('run.backtest', {
                id,
                config: {
                  strategy: 'sma-cross',
                  fast: Number(values.fast),
                  slow: Number(values.slow),
                  initialCash: values.cash,
                  feeBps: Number(values.feeBps),
                  slippageBps: Number(values.slippageBps),
                },
              });
              this.menu(
                this.text('run'),
                [{ label: this.text('back'), value: 0 }],
                () => this.project(id),
                JSON.stringify(
                  { metrics: result.metrics, assumptions: result.assumptions },
                  null,
                  2,
                ),
              );
            },
            () => this.project(id),
          );
        await this.call(
          action === 'refresh'
            ? 'market.refresh'
            : action === 'paperStart'
              ? 'paper.start'
              : 'paper.pause',
          { id },
        );
        return this.project(id);
      },
      details,
    );
  }
  fields(names, initial, done, back, values = {}) {
    const [field, ...rest] = names;
    if (!field) return done(values);
    this.ui.input(
      this.text(field),
      (value) => {
        values[field] = ['fast', 'slow', 'feeBps', 'slippageBps'].includes(field)
          ? Number(value)
          : value;
        return this.fields(rest, initial, done, back, values);
      },
      { value: String(initial[field]), back },
    );
  }
  async importFile(id, directory = process.cwd(), offset = 0) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() || (entry.isFile() && /\.(csv|json)$/i.test(entry.name)),
      )
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
    const options = [
      { label: this.text('back'), value: 'back' },
      { label: this.text('parent'), value: 'parent' },
      ...entries
        .slice(offset, offset + 40)
        .map((entry) => ({ label: (entry.isDirectory() ? '▸ ' : '') + entry.name, value: entry })),
    ];
    if (offset) options.push({ label: this.text('previous'), value: 'previous' });
    if (offset + 40 < entries.length) options.push({ label: this.text('next'), value: 'next' });
    this.menu(
      this.text('import'),
      options,
      async (value) => {
        if (value === 'back') return this.project(id);
        if (value === 'parent') return this.importFile(id, path.dirname(directory));
        if (value === 'next' || value === 'previous')
          return this.importFile(
            id,
            directory,
            Math.max(0, offset + (value === 'next' ? 40 : -40)),
          );
        const file = path.join(directory, value.name);
        if (value.isDirectory()) return this.importFile(id, file);
        const handle = await fs.open(file, 'r'),
          limit = 6 * 1024 * 1024;
        let text;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > limit) throw Error('IMPORT_SIZE_LIMIT');
          const buffer = Buffer.alloc(limit + 1);
          let count = 0;
          while (count < buffer.length) {
            const result = await handle.read(buffer, count, buffer.length - count, null);
            if (!result.bytesRead) break;
            count += result.bytesRead;
          }
          if (count > limit) throw Error('IMPORT_SIZE_LIMIT');
          text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
        } finally {
          await handle.close();
        }
        const dataset = await this.call('dataset.import', { id, text, label: value.name });
        await this.call('workspace.update', { id, preferences: { datasetId: dataset.id } });
        return this.project(id);
      },
      directory,
      () => this.project(id),
    );
  }
  async history(id, kind, offset = 0) {
    const result = await this.call('history.list', { id, kind, offset, limit: 15 });
    const options = [{ label: this.text('back'), value: 'back' }];
    if (offset) options.push({ label: this.text('previous'), value: 'previous' });
    if (result.nextOffset !== null) options.push({ label: this.text('next'), value: 'next' });
    if (kind === 'research') {
      options.push(
        ...result.items.map((row) => ({
          label: stripAnsi(String(row.title)),
          value: 'source:' + row.evidenceId,
        })),
      );
      return this.menu(
        this.text(kind),
        options,
        (value) =>
          value.startsWith('source:')
            ? this.evidence(id, value.slice(7))
            : value === 'back'
              ? this.project(id)
              : this.history(
                  id,
                  kind,
                  value === 'next' ? result.nextOffset : Math.max(0, offset - 15),
                ),
        this.text('researchHint') + (result.items.length ? '' : '\n' + this.text('empty')),
        () => this.project(id),
      );
    }
    this.menu(
      this.text(kind),
      options,
      (value) =>
        value === 'back'
          ? this.project(id)
          : this.history(id, kind, value === 'next' ? result.nextOffset : Math.max(0, offset - 15)),
      JSON.stringify(result.items, null, 2),
      () => this.project(id),
    );
  }
  async evidence(id, evidenceId, offset = 0) {
    const page = await this.call('research.read', { id, evidenceId, offset, maxChars: 4000 });
    const options = [{ label: this.text('back'), value: 'back' }];
    if (offset) options.push({ label: this.text('previous'), value: 'previous' });
    if (page.nextOffset !== null) options.push({ label: this.text('next'), value: 'next' });
    const detail = [
      this.text('researchHint'),
      `${this.text('retrieved')}: ${page.retrievedAt}`,
      `${this.text('published')}: ${page.publishedAtReported || this.text('unknown')}`,
      page.url || '',
      page.kind === 'article' && !page.archiveCompleteDocument ? this.text('partial') : '',
      ...(page.results || []).map(
        (row) =>
          `${row.title}\n${row.url}\n${row.publishedAtReported || this.text('unknown')}\n${row.snippet}`,
      ),
      page.content || '',
    ].join('\n\n');
    return this.menu(
      stripAnsi(String(page.title || page.query)),
      options,
      (value) =>
        value === 'back'
          ? this.history(id, 'research')
          : this.evidence(
              id,
              evidenceId,
              value === 'next' ? page.nextOffset : Math.max(0, offset - 4000),
            ),
      stripAnsi(detail),
      () => this.history(id, 'research'),
    );
  }
}
module.exports = { QuantBrowser, labels };
