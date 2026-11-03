/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real shared GUI/backend + isolated profile; all prices/models/RPCs are fixtures.
// No user credentials, real funds, external broadcasts or model charges.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-quant-ui-'));
for (const name of ['data', 'documents']) fs.mkdirSync(path.join(profile, name));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    features: { quant: true },
    language: 'zh-CN',
    runtime: { location: 'host' },
    trayEnabled: false,
    closeToTray: 'never',
    notifications: { enabled: false },
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    automaticMemory: { enabled: false },
    decision: { enabled: false },
    tarotVisible: false,
    animations: false,
    theme: { frontend: 'v2', mode: 'dark', accentColor: '#69ad9b', backgroundColor: '#141b20' },
    toolExposure: { mode: 'all' },
    llm: {
      provider: 'openai-compat',
      apiUrl: 'http://quant.fixture/v1',
      apiKey: 'fixture',
      model: 'Fixture research model',
      streamResponses: false,
      pool: [],
    },
    webResearch: {
      engine: 'exa',
      providers: {
        exa: {
          provider: 'exa',
          endpoint: 'https://news.fixture/search',
          apiKey: 'fixture-news-key',
        },
      },
    },
  }),
);
require('../../src/main/net-proxy').install = () => {};
const realFetch = global.fetch,
  errors = [];
let agentSteps = 0;
const word = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0');
const { CHAINS } = require('../../src/main/services/quant/market-data');
let sqrt = (2n ** 192n * 10n ** 12n) / 3100n,
  x = (sqrt + 1n) / 2n;
while (x < sqrt) {
  sqrt = x;
  x = ((2n ** 192n * 10n ** 12n) / 3100n / x + x) / 2n;
}
global.fetch = async (url, options = {}) => {
  if (String(url) === 'https://api.coinbase.com/api/v3/brokerage/time')
    return new Response(JSON.stringify({ epochMillis: String(Date.now()) }));
  if (String(url) === 'https://api.coinbase.com/api/v3/brokerage/market/products/ETH-USD')
    return new Response(
      JSON.stringify({
        product_id: 'ETH-USD',
        product_type: 'SPOT',
        base_currency_id: 'ETH',
        quote_currency_id: 'USD',
        price_increment: '0.01',
        base_increment: '0.00000001',
        base_min_size: '0.00000001',
        quote_min_size: '1',
      }),
    );
  if (String(url) === 'https://news.fixture/search') {
    assert.equal(options.headers['x-api-key'], 'fixture-news-key');
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Base 治理提案 · UI TEST FIXTURE',
            url: 'https://news.fixture/proposal',
            text: '这是一项尚未实施的治理提案；应核验投票结果及实施日期。',
            publishedDate: '2026-10-25T12:00:00Z',
          },
        ],
      }),
    );
  }
  if (String(url) === 'https://news.fixture/proposal')
    return new Response(
      '<title>Base 治理提案 · UI TEST FIXTURE</title><meta property="article:published_time" content="2026-10-25T12:00:00Z"><article><p>这是一项尚未实施的治理提案。</p><p>核验要点：治理投票结果、实施时间，以及相关流动性与价格反应。</p><p>本页为 UI TEST FIXTURE，不是实际市场消息。</p></article>',
      { headers: { 'content-type': 'text/html' } },
    );
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
  if (String(url).startsWith('http://quant.fixture/')) {
    const body = JSON.parse(options.body);
    let message = { role: 'assistant', content: 'Base research' },
      finish = 'stop';
    if (body.tools?.some((tool) => tool.function?.name === 'quant_backtest')) {
      agentSteps++;
      assert.ok(
        body.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes(require('../../src/main/services/quant/research-prompt')),
        ),
        'the actual research session must receive the shared decision workflow',
      );
      const tools = {
        2: ['quant_inspect', {}],
        3: [
          'quant_news_search',
          { query: 'Base governance proposal October 2026 · UI TEST FIXTURE' },
        ],
        4: ['quant_news_fetch', { url: 'https://news.fixture/proposal' }],
        5: ['quant_backtest', { strategy: 'sma-cross', fast: 9, slow: 21 }],
        6: [
          'goalComplete',
          {
            summary:
              'Inspected the Base workspace, executed the saved dataset experiment and verified the persistent report.',
          },
        ],
      };
      const next = tools[agentSteps];
      assert.equal(JSON.stringify(body).includes('fixture-news-key'), false);
      if (agentSteps === 5) {
        assert.ok(JSON.stringify(body.messages).includes('尚未实施'));
        assert.ok(JSON.stringify(body.messages).includes('evidenceId'));
      }
      message = {
        role: 'assistant',
        content:
          agentSteps === 1
            ? '我会检查数据并保存实验。'
            : '已完成数据检查和双均线实验，报告已保存。',
      };
      if (next) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'quant-fixture-' + agentSteps,
              type: 'function',
              function: { name: next[0], arguments: JSON.stringify(next[1]) },
            },
          ],
        };
        finish = 'tool_calls';
      }
    }
    return new Response(
      JSON.stringify({
        choices: [{ message, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  if (String(url).startsWith('https://mainnet.base.org')) {
    const { method, params } = JSON.parse(options.body);
    let result;
    if (method === 'eth_chainId') result = '0x2105';
    else if (method === 'eth_getBlockByNumber')
      result = {
        number: '0x1000',
        hash: '0x' + 'a'.repeat(64),
        timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
      };
    else if (method === 'eth_getBalance') result = '0x0';
    else if (method === 'eth_call') {
      const { to, data } = params[0];
      if (to === CHAINS.base.factory) result = word('0x' + 'b'.repeat(40));
      else if (data === '0x0dfe1681') result = word(CHAINS.base.usdc);
      else if (data === '0xd21220a7') result = word(CHAINS.base.weth);
      else if (data === '0x3850c7bd') result = word(sqrt);
      else if (data === '0x1a686502') result = word(1000000000000n);
      else if (data === '0x313ce567') result = word(to === CHAINS.base.usdc ? 6 : 18);
    }
    if (result === undefined) throw new Error('Unexpected fixture RPC ' + method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }
  if (String(url).endsWith('/models')) return new Response('{"data":[{"id":"fixture"}]}');
  if (String(url).includes('models.dev')) return new Response('{}');
  throw new Error('External network disabled in quant UI fixture');
};
require('undici').fetch = global.fetch;
let marketSocket,
  nativeTrade = 100;
class FixtureMarketSocket extends EventTarget {
  constructor() {
    super();
    marketSocket = this;
    this.sequence = 0;
    this.channels = new Set();
    setImmediate(() => this.dispatchEvent(new Event('open')));
  }
  frame(channel, events) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          channel,
          events,
          sequence_num: this.sequence++,
          timestamp: new Date().toISOString(),
        }),
      }),
    );
  }
  send(text) {
    this.channels.add(JSON.parse(text).channel);
    if (this.channels.size !== 3 || this.timer) return;
    this.frame('l2_data', [
      {
        type: 'snapshot',
        product_id: 'ETH-USD',
        updates: Array.from({ length: 16 }, (_, i) => [
          { side: 'bid', price_level: String(2333 - i), new_quantity: String((i + 1) * 0.25) },
          {
            side: 'offer',
            price_level: String(2334 + i),
            new_quantity: String(((i + 1) * 3) / 10),
          },
        ]).flat(),
      },
    ]);
    this.frame('market_trades', [{ type: 'snapshot', trades: [] }]);
    this.beat = () => this.frame('heartbeats', [{ heartbeat_counter: this.sequence }]);
    this.beat();
    this.timer = setInterval(this.beat, 250);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.dispatchEvent(new Event('close'));
  }
}
require('undici').WebSocket = FixtureMarketSocket;
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.webContents.on('preload-error', (_e, _file, error) => errors.push(error.message));
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && /Uncaught|Initialization failed/.test(event.message))
      errors.push(event.message);
  });
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => finish(new Error('Quant integration timed out')), 120000);
ipcMain.once('app:renderer-ready', (event) =>
  setTimeout(async () => {
    const wc = event.sender,
      win = BrowserWindow.fromWebContents(wc);
    win.setSize(1640, 1080);
    const js = (code) => wc.executeJavaScript(code, true);
    const until = async (code) => {
      const deadline = Date.now() + 20000;
      while (!(await js(code))) {
        if (Date.now() > deadline) {
          console.error(
            'Quant UI timeout state:',
            await js(
              "JSON.stringify({panel:document.querySelector('.quant-native-paper')?.textContent,busy:document.querySelector('.quant-native-paper')?.getAttribute('aria-busy')})",
            ),
          );
          throw new Error('Timed out: ' + code);
        }
        await pause(50);
      }
    };
    const preview = path.resolve(__dirname, '../../.cache/previews');
    fs.mkdirSync(preview, { recursive: true });
    const shot = async (name) => {
      await pause(250);
      fs.writeFileSync(path.join(preview, name), (await wc.capturePage()).toPNG());
    };
    const strategyUi = async (theme) => {
      await js("window.api.backendRequest('quant:request','native.start')");
      await js(
        "window.api.backendRequest('quant:request','native.source.start',{product:'ETH-USD'})",
      );
      await until(
        "(async()=>{const s=await window.api.backendRequest('quant:request','native.source.status');return s.sources.some(v=>v.phase==='ready');})()",
      );
      await js(
        "window.api.backendRequest('quant:request','native.paper.enable',{id:window.__quantTestId})",
      );
      await js("document.querySelector('[data-action=strategies]').click()");
      await until(
        "!!document.querySelector('.quant-strategy-dialog [data-ns=new]:not(:disabled)')",
      );
      await js(
        "document.querySelector('.quant-strategy-dialog [data-ns=new]').click();document.querySelector('.quant-strategy-dialog [name=name]').value='Maker · UI TEST FIXTURE " +
          theme +
          "';document.querySelector('.quant-strategy-dialog [name=quantity]').value='0.01';document.querySelector('.quant-strategy-dialog form').requestSubmit()",
      );
      await until(
        "document.querySelector('.quant-strategy-dialog [data-ns-editor]').hidden&&document.querySelector('.quant-strategy-dialog [data-ns-detail]').textContent.includes('" +
          theme +
          "')",
      );
      await js(
        "document.querySelector('.quant-strategy-dialog [data-ns-mode]').value='shadow';document.querySelector('.quant-strategy-dialog [data-ns=start]').click()",
      );
      await until(
        "document.querySelector('.quant-strategy-dialog [data-ns-run]').textContent.includes('运行中')&&document.querySelector('.quant-strategy-dialog [data-ns-decisions]').textContent.includes('影子')",
      );
      await shot('quant-strategy-shadow-' + theme + '.png');
      await js("document.querySelector('.quant-strategy-dialog [data-ns=stop]').click()");
      await until(
        "document.querySelector('.quant-strategy-dialog [data-ns-run]').textContent.includes('已停止')",
      );
      await js(
        "document.querySelector('.quant-strategy-dialog [data-ns-mode]').value='paper';document.querySelector('.quant-strategy-dialog [data-ns=start]').click()",
      );
      await until(
        "document.querySelector('.quant-strategy-dialog [data-ns-run]').textContent.includes('运行中')&&document.querySelector('.quant-strategy-dialog [data-ns-decisions]').textContent.includes('已接收')",
      );
      await js(
        "document.querySelector('.quant-strategy-dialog [data-ns=edit]').click();document.querySelector('.quant-strategy-dialog [name=quantity]').value='0.02';document.querySelector('.quant-strategy-dialog form').requestSubmit()",
      );
      await until(
        "document.querySelector('.quant-strategy-dialog [data-ns-editor]').hidden&&document.querySelector('.quant-strategy-dialog [data-ns-detail]').textContent.includes('v2')",
      );
      assert.ok(
        await js(
          "document.querySelector('.quant-strategy-dialog [data-ns-run]').textContent.includes('固定版本 v1')",
        ),
      );
      await shot('quant-strategy-paper-' + theme + '.png');
      await js("document.querySelector('.quant-strategy-dialog [data-ns=stop]').click()");
      await until(
        "document.querySelector('.quant-strategy-dialog [data-ns-run]').textContent.includes('已停止')",
      );
      await js("document.querySelector('.quant-strategy-dialog [data-ns=close]').click()");
      await eventDataUi(theme);
      await js("window.api.backendRequest('quant:request','native.stop')");
      await until(
        "(async()=>{const s=await window.api.backendRequest('quant:request','native.status');return s.state==='stopped';})()",
      );
    };
    const eventDataUi = async (theme) => {
      await js("document.querySelector('[data-action=event-data]').click()");
      await until("!!document.querySelector('.quant-event-dialog [data-qe-strategy] option')");
      await js(
        "document.querySelector('.quant-event-dialog [name=name]').value='Market · UI TEST FIXTURE " +
          theme +
          "';document.querySelector('.quant-event-dialog form').requestSubmit()",
      );
      await until("!!document.querySelector('.quant-event-dialog [data-qe-stop]')");
      await js('new Promise(resolve=>setTimeout(resolve,700))');
      await js("document.querySelector('.quant-event-dialog [data-qe-stop]').click()");
      await until("!!document.querySelector('.quant-event-dialog [data-qe=run]:not(:disabled)')");
      await js("document.querySelector('.quant-event-dialog [data-qe=run]').click()");
      await until(
        "document.querySelector('.quant-event-dialog [data-qe-result]').textContent.includes('原生账本 SHA-256')",
      );
      assert.ok(
        await js(
          "document.querySelector('.quant-event-dialog [data-qe-result]').textContent.includes('已完成')",
        ),
      );
      await js(
        "document.querySelector('.quant-event-dialog [data-qe-kind]').value='orders';document.querySelector('.quant-event-dialog [data-qe-kind]').dispatchEvent(new Event('change'))",
      );
      await until(
        "document.querySelectorAll('.quant-event-dialog [data-qe-history] tbody tr').length>=2",
      );
      await shot('quant-event-replay-' + theme + '.png');
      await js(
        "document.querySelector('.quant-event-dialog [data-qe-result]').scrollIntoView({block:'start'})",
      );
      await shot('quant-event-replay-report-' + theme + '.png');
      await js("document.querySelector('.quant-event-dialog [data-qe=close]').click()");
    };
    const nativePaperUi = async (theme) => {
      await js("document.querySelector('[data-action=native-paper]').click()");
      await until("!!document.querySelector('.quant-native-paper [data-np=start]:not(:disabled)')");
      await js("document.querySelector('.quant-native-paper [data-np=start]').click()");
      await until(
        "!!document.querySelector('.quant-native-paper [data-np=source]:not(:disabled)')",
      );
      await js("document.querySelector('.quant-native-paper [data-np=source]').click()");
      await until(
        "document.querySelector('.quant-native-paper [data-np-source]').textContent.includes('连续行情就绪')&&!document.querySelector('.quant-native-paper [data-np=create]').disabled",
      );
      await js(
        "document.querySelector('.quant-native-paper [data-np=create]').click();document.querySelector('.quant-native-paper [name=name]').value='Paper · UI TEST FIXTURE';document.querySelector('.quant-native-paper [data-np-create]').requestSubmit()",
      );
      await until(
        "document.querySelector('.quant-native-paper [data-np-create]').hidden&&document.querySelector('.quant-native-paper [data-np-account]').textContent.includes('Paper · UI TEST FIXTURE')&&!document.querySelector('.quant-native-paper [data-np=enable]').disabled",
      );
      await js("document.querySelector('.quant-native-paper [data-np=enable]').click()");
      await until(
        "!document.querySelector('.quant-native-paper [data-np-order] [type=submit]').disabled",
      );
      await js(
        "document.querySelector('.quant-native-paper [data-np-order] [name=price]').value='2333';document.querySelector('.quant-native-paper [data-np-order] [name=quantity]').value='0.25';document.querySelector('.quant-native-paper [data-np-order]').requestSubmit()",
      );
      await until(
        "document.querySelector('.quant-native-paper [data-np-history]').textContent.includes('队列中')",
      );
      await pause(750);
      const trade = (size) =>
        marketSocket.frame('market_trades', [
          {
            type: 'update',
            trades: [
              {
                product_id: 'ETH-USD',
                trade_id: String(++nativeTrade),
                side: 'BUY',
                price: '2333',
                size,
                time: new Date().toISOString(),
              },
            ],
          },
        ]);
      trade('0.35');
      await until(
        "(async()=>{const p=await window.api.backendRequest('quant:request','native.paper.orders',{id:window.__quantTestId});return p.items[0]?.filled==='0.1';})()",
      );
      trade('0.05');
      await until(
        "document.querySelector('.quant-native-paper [data-np-history]').textContent.includes('0.15')",
      );
      await shot('quant-native-paper-orders-' + theme + '.png');
      await js("document.querySelector('.quant-native-paper [data-np=executions]').click()");
      await until("document.querySelectorAll('.quant-native-paper tbody tr').length>=2");
      await shot('quant-native-paper-fills-' + theme + '.png');
      await js(
        "document.querySelector('.quant-native-paper [data-np=pause]').click();document.querySelector('.quant-native-paper [data-np=orders]').click()",
      );
      await until(
        "document.querySelector('.quant-native-paper [data-np-history]').textContent.includes('挂起')",
      );
      await js("document.querySelector('.quant-native-paper [data-np=halt]').click()");
      await until(
        "(async()=>{const s=await window.api.backendRequest('quant:request','native.paper.status',{id:window.__quantTestId});return !!s.account?.halt&&s.account.openOrders===0;})()",
      );
      await until(
        "document.querySelector('.quant-native-paper [data-np=enable]')?.disabled===true",
      );
      await shot('quant-native-emergency-' + theme + '.png');
      await js(
        "document.querySelector('.quant-native-paper [data-np=reset-halt]').click();document.querySelector('.quant-native-paper [data-np-confirm]').scrollIntoView({block:'center'})",
      );
      await until("!document.querySelector('.quant-native-paper [data-np-confirm]').hidden");
      assert.equal(await js('document.activeElement?.dataset.np'), 'reset-cancel');
      await shot('quant-native-emergency-confirm-' + theme + '.png');
      await js("document.querySelector('.quant-native-paper [data-np=reset-cancel]').click()");
      assert.equal(
        await js(
          "(async()=>{const s=await window.api.backendRequest('quant:request','native.paper.status',{id:window.__quantTestId});return !!s.account?.halt;})()",
        ),
        true,
      );
      await js(
        "document.querySelector('.quant-native-paper [data-np=reset-halt]').click();document.querySelector('.quant-native-paper [data-np=reset-confirm]').click()",
      );
      await until(
        "(async()=>{const s=await window.api.backendRequest('quant:request','native.paper.status',{id:window.__quantTestId});return s.account?.halt===null&&s.account.active===false;})()",
      );
      await js(
        "document.querySelector('.quant-native-paper [data-np=close]').click();window.api.backendRequest('quant:request','native.stop')",
      );
      await until(
        "(async()=>{const s=await window.api.backendRequest('quant:request','native.status');return s.state==='stopped';})()",
      );
    };
    try {
      await until('!!window.CibypQuant');
      const id = await js(
        "(async()=>{const w=await window.api.backendRequest('quant:request','workspace.create',{name:'Base · UI TEST FIXTURE',venue:'base'});window.__quantTestId=w.id;return w.id;})()",
      );
      const end = Math.floor(Date.now() / 1000 / 300) * 300 - 300;
      const candles = Array.from({ length: 260 }, (_, i) => {
        const open = 3000 + i * 0.5 + Math.sin(i / 13) * 65 + Math.cos(i / 5) * 14,
          close = open + Math.sin(i * 1.7) * 13;
        return {
          time: end - (259 - i) * 300,
          open,
          close,
          high: Math.max(open, close) + 8 + Math.sin(i) * 3,
          low: Math.min(open, close) - 9,
          volume: 5 + Math.abs(Math.sin(i)) * 35,
        };
      });
      await js(
        `window.api.backendRequest('quant:request','dataset.import',{id:window.__quantTestId,label:'UI TEST FIXTURE · OHLC',text:${JSON.stringify(JSON.stringify(candles))}})`,
      );
      await js("window.navigatePage('quant')");
      await until("document.querySelector('[data-product]').textContent==='WETH-USDC'");
      await until("!!document.querySelector('[data-chart-canvas] canvas').width");
      await js(
        "window.api.backendRequest('quant:request','chat.send',{id:window.__quantTestId,message:'Inspect the data, run and verify an SMA experiment.',autonomous:true})",
      );
      await until(
        "window.api.backendRequest('getSession','quant:'+window.__quantTestId).then(s=>s.goal?.status==='complete'&&!s.busy)",
      );
      assert.equal(
        agentSteps,
        7,
        'normal final text must continue into tools and explicit goal completion',
      );
      await until("document.querySelector('[data-run-list]').textContent.includes('sma-cross')");
      await js("document.querySelector('[data-run-list] button').click()");
      await until("!!document.querySelector('.quant-equity-line')");
      assert.equal(
        (
          await js(
            "window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId})",
          )
        ).runs.length,
        1,
      );
      await shot('quant-professional-dark.png');
      if (
        fs.existsSync(
          require('../../src/main/services/quant/native-binary').developmentBinary(
            path.resolve(__dirname, '../..'),
          ),
        )
      ) {
        await js("document.querySelector('#page-quant [data-action=settings]').click()");
        await until(
          "!!document.querySelector('[data-native=start]') && !document.querySelector('[data-native=start]').disabled",
        );
        await js("document.querySelector('[data-native=start]').click()");
        await until(
          "document.querySelector('[data-native-status]').textContent.includes('已连接')",
        );
        assert.equal(
          (await js("window.api.backendRequest('quant:request','native.status')")).liveExecution,
          false,
        );
        await shot('quant-native-process.png');
        await js("document.querySelector('[data-source=start]').click()");
        await until(
          "document.querySelector('[data-source-status]').textContent.includes('连续行情就绪')",
        );
        await js(
          "document.querySelector('.quant-source-controls').scrollIntoView({block:'center'})",
        );
        await shot('quant-continuous-source-dark.png');
        await js("document.querySelector('[data-source=book]').click()");
        await until(
          "document.querySelector('[data-source-book]').textContent.includes('盘口可用于')",
        );
        await shot('quant-continuous-book-dark.png');
        await js(
          "document.querySelector('.quant-source-book-dialog [data-close]').click();document.querySelector('[data-source=stop]').click()",
        );
        await until(
          "document.querySelector('[data-source-status]').textContent.includes('已停止')",
        );
        await js("document.querySelector('[data-native=stop]').click()");
        await until(
          "document.querySelector('[data-native-status]').textContent.includes('已停止')",
        );
        await js(
          "document.querySelector('[data-native-engine]').closest('dialog').querySelector('[data-close]').click()",
        );
        await nativePaperUi('dark');
        await strategyUi('dark');
      }
      const evidence = await js(
        "window.api.backendRequest('quant:request','history.list',{id:window.__quantTestId,kind:'research'})",
      );
      assert.equal(
        evidence.total,
        2,
        'Agent tool calls must save news search and article evidence',
      );
      assert.equal(JSON.stringify(evidence).includes('fixture-news-key'), false);
      await js('document.querySelector(\'[data-action="tab:research"]\').click()');
      await until("document.querySelectorAll('.quant-evidence-row').length===2");
      await js('document.querySelector(\'[data-action^="evidence:"]\').click()');
      await until(
        "document.querySelector('.quant-evidence-dialog').textContent.includes('尚未实施')",
      );
      assert.ok(
        await js(
          "document.querySelector('.quant-evidence-dialog').textContent.includes('2026-10-25T12:00:00Z')",
        ),
      );
      await shot('quant-research-evidence.png');
      await js(
        "document.querySelector('.quant-evidence-dialog [data-close]').click();document.querySelector('[data-action=\"tab:experiments\"]').click()",
      );
      await js("document.querySelector('[data-action=fullscreen]').click()");
      await pause(250);
      assert.ok(
        await js(
          "!!document.fullscreenElement || document.querySelector('[data-chart-card]').classList.contains('quant-focus-fullscreen')",
        ),
      );
      await shot('quant-fullscreen.png');
      await js("document.querySelector('[data-action=fullscreen]').click()");
      await js("document.querySelector('[data-action=immersive]').click()");
      await until("document.querySelector('[data-layout]').dataset.layout==='immersive'");
      await js(
        "window.api.setSettings({theme:{frontend:'v2',mode:'light',accentColor:'#527d76',backgroundColor:'#f7f8fa'}})",
      );
      await until("document.documentElement.dataset.theme==='light'");
      await shot('quant-immersive-light.png');
      await js("document.querySelector('[data-action=professional]').click()");
      await until("document.querySelector('[data-layout]').dataset.layout==='professional'");
      await js('document.querySelector(\'[data-action="tab:research"]\').click()');
      await until("document.querySelectorAll('.quant-evidence-row').length===2");
      await shot('quant-research-history-light.png');
      await js('document.querySelector(\'[data-action^="evidence:"]\').click()');
      await until(
        "document.querySelector('.quant-evidence-dialog').textContent.includes('尚未实施')",
      );
      await shot('quant-research-evidence-light.png');
      await js("document.querySelector('.quant-evidence-dialog [data-close]').click()");
      if (
        fs.existsSync(
          require('../../src/main/services/quant/native-binary').developmentBinary(
            path.resolve(__dirname, '../..'),
          ),
        )
      ) {
        await js("document.querySelector('#page-quant [data-action=settings]').click()");
        await until(
          "document.querySelector('[data-native-status]')?.textContent.includes('已停止')",
        );
        await shot('quant-native-process-light.png');
        await js("document.querySelector('[data-native=start]').click()");
        await until(
          "document.querySelector('[data-native-status]').textContent.includes('已连接')",
        );
        await js("document.querySelector('[data-source=start]').click()");
        await until(
          "document.querySelector('[data-source-status]').textContent.includes('连续行情就绪')",
        );
        await js(
          "document.querySelector('.quant-source-controls').scrollIntoView({block:'center'})",
        );
        await shot('quant-continuous-source-light.png');
        await js("document.querySelector('[data-source=book]').click()");
        await until(
          "document.querySelector('[data-source-book]').textContent.includes('盘口可用于')",
        );
        await shot('quant-continuous-book-light.png');
        await js(
          "document.querySelector('.quant-source-book-dialog [data-close]').click();document.querySelector('[data-native=stop]').click()",
        );
        await until(
          "document.querySelector('[data-native-status]').textContent.includes('已停止')",
        );
        await js(
          "document.querySelector('[data-native-engine]').closest('dialog').querySelector('[data-close]').click()",
        );
        await nativePaperUi('light');
        await strategyUi('light');
      }
      const savedGoal = JSON.parse(
        fs.readFileSync(path.join(profile, 'quant/conversations', id + '.json'), 'utf8'),
      );
      assert.equal(savedGoal.goal.status, 'complete');
      const wallet = await js(
        "window.api.backendRequest('wallet:request','create',{password:'fixture-wallet-password-only',name:'UI TEST · empty wallet'})",
      );
      assert.ok(wallet.address);
      await js("window.navigatePage('settings');window.activateSettingsTab('wallet')");
      await until("document.querySelector('#settings-wallet').textContent.includes('UI TEST')");
      await js("document.querySelector('[data-wallet-action=password-change]').click()");
      await until("!!document.querySelector('.wallet-dialog [name=newPassword]')");
      await shot('wallet-encryption-upgrade.png');
      await js(
        "document.querySelector('.wallet-dialog [name=password]').value='fixture-wallet-password-only';document.querySelector('.wallet-dialog [name=newPassword]').value='ui-new-test-password';document.querySelector('.wallet-dialog [name=repeatPassword]').value='different-password';document.querySelector('.wallet-dialog form').requestSubmit()",
      );
      await until(
        "document.querySelector('.wallet-dialog [data-error]').textContent.includes('不一致')",
      );
      await js(
        "document.querySelector('.wallet-dialog [name=repeatPassword]').value='ui-new-test-password';document.querySelector('.wallet-dialog form').requestSubmit()",
      );
      await until("!document.querySelector('.wallet-dialog')");
      const rotated = await js("window.api.backendRequest('wallet:request','list')");
      assert.equal(rotated.wallets[0].unlocked, false);
      assert.equal(rotated.wallets[0].policy.mode, 'manual');
      await js(
        "document.querySelector('[data-wallet-action=enable]').click();document.querySelector('.wallet-dialog [data-continue]').click()",
      );
      await until("!document.querySelector('.wallet-dialog [data-second]').hidden");
      const before = await js("window.api.backendRequest('wallet:request','list')");
      assert.equal(before.wallets[0].policy.mode, 'manual');
      await shot('wallet-permissions.png');
      await js(
        "document.querySelector('.wallet-dialog [name=ack]').value='ALLOW LIVE';document.querySelector('.wallet-dialog [name=ack]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.wallet-dialog [data-continue]').click()",
      );
      await until(
        "window.api.backendRequest('wallet:request','list').then(s=>s.wallets[0].policy.mode==='autonomous')",
      );
      await js("document.querySelector('[data-wallet-action=revoke]').click()");
      await until(
        "window.api.backendRequest('wallet:request','list').then(s=>s.wallets[0].policy.mode==='manual')",
      );
      await js("window.navigatePage('quant')");
      await until("!!document.querySelector('[data-action=live-execution]')");
      await js("window.api.backendRequest('quant:request','native.start')");
      await js("document.querySelector('[data-action=live-execution]').click()");
      await until("!!document.querySelector('.le-dialog [data-le=new]:not(:disabled)')");
      await js(
        "document.querySelector('.le-dialog [data-le=new]').click();const input=document.querySelector('.le-dialog [name=totalInput]');input.value='12.50';input.focus()",
      );
      await pause(3300);
      assert.equal(
        await js(
          "document.activeElement===document.querySelector('.le-dialog [name=totalInput]')&&document.activeElement.value==='12.50'",
        ),
        true,
        'polling must not replace an active financial input',
      );
      await js("document.querySelector('.le-dialog form').requestSubmit()");
      await until("!!document.querySelector('.le-dialog [data-le=start]')");
      assert.equal(
        await js("document.querySelector('.le-dialog [data-le=start]').disabled"),
        true,
        'creating a plan cannot grant live authority',
      );
      assert.ok(
        (await js("document.querySelector('.le-dialog [data-le-detail]').textContent")).includes(
          '12.5',
        ),
      );
      await shot('quant-live-plan-light.png');
      await js(
        "window.api.setSettings({theme:{frontend:'v2',mode:'dark',accentColor:'#69ad9b',backgroundColor:'#141b20'}})",
      );
      await pause(500);
      await shot('quant-live-plan-dark.png');
      win.setMinimumSize(440, 600);
      win.setSize(560, 940);
      await shot('quant-live-plan-narrow.png');
      assert.equal(
        await js(
          "(()=>{const dialog=document.querySelector('.le-dialog');return dialog.scrollWidth<=dialog.clientWidth+1;})()",
        ),
        true,
        'financial controls must remain usable in narrow windows',
      );
      win.setSize(1640, 1080);
      const plans = await js(
        "window.api.backendRequest('quant:request','execution.list',{id:window.__quantTestId})",
      );
      assert.equal(plans.items.length, 1);
      assert.equal(plans.items[0].phase, 'paused');
      assert.equal(plans.items[0].commands_created, 0);
      await js("document.querySelector('.le-dialog').close()");
      const stillPaused = await js(
        "window.api.backendRequest('quant:request','execution.list',{id:window.__quantTestId})",
      );
      assert.equal(
        stillPaused.items[0].phase,
        'paused',
        'closing a frontend cannot start or stop a plan',
      );
      await js(
        "window.api.backendRequest('wallet:request','unlock',{id:" +
          JSON.stringify(wallet.id) +
          ",password:'ui-new-test-password',minutes:0})",
      );
      const stopGrant = await js(
        "window.api.backendRequest('wallet:request','policy.challenge',{id:" +
          JSON.stringify(wallet.id) +
          ',chains:[8453]})',
      );
      await js(
        "window.api.backendRequest('wallet:request','policy.grant',{challengeId:" +
          JSON.stringify(stopGrant.id) +
          ",ack:'ALLOW LIVE',confirmed:true})",
      );
      await js("window.navigatePage('settings');window.activateSettingsTab('wallet')");
      await until("!!document.querySelector('[data-wallet-action=emergency-stop]')");
      await js("document.querySelector('[data-wallet-action=emergency-stop]').click()");
      await until(
        "window.api.backendRequest('wallet:request','emergency.status').then(s=>s.halted&&!s.nativePausePending)",
      );
      await until(
        "!!document.querySelector('[data-wallet-action=emergency-reset]:not(:disabled)')",
      );
      const globallyStopped = await js("window.api.backendRequest('wallet:request','list')");
      assert.equal(globallyStopped.wallets[0].unlocked, false);
      assert.equal(globallyStopped.wallets[0].policy.mode, 'manual');
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('#settings-wallet [data-wallet-action=unlock],#settings-wallet [data-wallet-action=enable]')).every(button=>button.disabled)",
        ),
        true,
      );
      await shot('wallet-live-stop-dark.png');
      await js(
        "window.api.setSettings({theme:{frontend:'v2',mode:'light',accentColor:'#527d76',backgroundColor:'#f7f8fa'}})",
      );
      await pause(350);
      await shot('wallet-live-stop-light.png');
      await js(
        "document.querySelector('[data-wallet-action=emergency-reset]').click();document.querySelector('[data-emergency-reset] [data-continue]').click()",
      );
      await until("!document.querySelector('[data-emergency-reset] [data-second]').hidden");
      assert.equal(
        (await js("window.api.backendRequest('wallet:request','emergency.status')")).halted,
        true,
      );
      assert.equal(
        await js("document.querySelector('[data-emergency-reset] [data-continue]').disabled"),
        true,
      );
      await shot('wallet-live-stop-confirm.png');
      await js(
        "(()=>{const input=document.querySelector('[data-emergency-reset] [name=ack]');input.value='RESET LIVE';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-emergency-reset] [data-continue]').click();})()",
      );
      await until(
        "window.api.backendRequest('wallet:request','emergency.status').then(s=>!s.halted)",
      );
      const safelyReset = await js("window.api.backendRequest('wallet:request','list')");
      assert.equal(safelyReset.wallets[0].unlocked, false);
      assert.equal(safelyReset.wallets[0].policy.mode, 'manual');
      const stoppedPlans = await js(
        "window.api.backendRequest('quant:request','execution.list',{id:window.__quantTestId})",
      );
      assert.equal(stoppedPlans.items[0].phase, 'paused');
      assert.equal(stoppedPlans.items[0].commands_created, 0);
      assert.deepEqual(errors, []);
      console.log(
        '[quant] PASS: shared backend, Base RPC, persistent datasets/experiments/goal/chat, professional/immersive/fullscreen charts, wallet confirmation gate and screenshots.',
      );
      finish();
    } catch (error) {
      await shot('quant-failure.png').catch(() => {});
      finish(error);
    }
  }, 300),
);
function finish(error) {
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}
require('../../src/main/main');
