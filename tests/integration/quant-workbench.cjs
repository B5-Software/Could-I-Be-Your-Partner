/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real shared GUI/backend + isolated profile; all prices/models/RPCs are fixtures.
// No user credentials, real funds, external broadcasts or model charges.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { createConnection } = require('node:net');
const { once } = require('node:events');
const { duplexPair } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { crc32 } = require('node:zlib');
const { Agent, WebSocket: RuntimeWebSocket } = require('undici');
const { WebSocketServer } = require('ws');
const orderFeedServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
const listening = once(orderFeedServer, 'listening');
let orderFeedSocket;
orderFeedServer.on('connection', (socket) => {
  socket.once('message', (data) => {
    const subscription = JSON.parse(data.toString());
    assert.equal(subscription.type, 'subscribe');
    assert.equal(subscription.key, 'fixture-key');
    assert.equal(subscription.passphrase, 'fixture-passphrase');
    assert.deepEqual(
      subscription.channels,
      ['user', 'heartbeat'].map((name) => ({ name, product_ids: ['ETH-USD'] })),
    );
    orderFeedSocket = socket;
    socket.send(JSON.stringify({ type: 'subscriptions', channels: subscription.channels }));
  });
});
const network = require('../../src/main/net-proxy');
const fixNetwork = require('../../src/main/services/quant/coinbase-fix-network');
const { FixFramer, encode: fixEncode } = require('../../src/main/services/quant/coinbase-fix-wire');
const fixRequests = [];
let nativeFixOrder, stopFixOrder, tpslFixOrder, repriceTpsl;
fixNetwork.connectFix = async (env) => {
  assert.equal(env, 'sandbox');
  const [client, venue] = duplexPair();
  const framer = new FixFramer();
  let sequence = 1;
  const send = (type, fields = []) =>
    venue.write(
      fixEncode(
        {
          type,
          from: 'Coinbase',
          to: 'fixture-key',
          sequence: sequence++,
        },
        fields,
      ),
    );
  venue.on('data', (data) =>
    framer.push(data, (fields) => {
      const type = fields.get(35);
      fixRequests.push(type);
      if (type === 'A') {
        assert.equal(fields.get(553), 'fixture-key');
        assert.equal(fields.get(8013), undefined);
        send('A', [
          [108, '10'],
          [141, 'Y'],
        ]);
      } else if (type === 'H') {
        assert.equal(fields.get(11), sandboxOrder.client_oid);
        assert.equal(fields.get(55), sandboxOrder.product_id);
        send('8', [
          [11, sandboxOrder.client_oid],
          [37, sandboxOrder.id],
          [150, 'I'],
          [39, '1'],
          [55, sandboxOrder.product_id],
          [54, '1'],
          [14, '0.025'],
          [151, '0.075'],
        ]);
      } else if (type === 'D' && fields.get(40) === '4') {
        assert.equal(fields.get(99), '1925');
        assert.equal(fields.get(1109), 'D');
        assert.equal(fields.get(44), '1900');
        stopFixOrder = {
          ...nativeFixOrder,
          client_oid: fields.get(11),
          id: '55555555-2222-3333-4444-555555555555',
          type: 'stop',
          stop: 'loss',
          stop_price: fields.get(99),
          price: fields.get(44),
          size: fields.get(38),
          status: 'active',
          filled_size: '0',
          executed_value: '0',
          fill_fees: '0',
        };
        send('8', [
          [11, stopFixOrder.client_oid],
          [37, stopFixOrder.id],
          [17, randomUUID()],
          [150, '0'],
          [39, 'A'],
          [55, 'ETH-USD'],
          [40, '4'],
          [99, '1925'],
          [1109, 'D'],
          [44, '1900'],
          [14, '0'],
          [151, '0.1'],
        ]);
      } else if (type === 'D' && fields.get(40) === 'O') {
        assert.deepEqual(
          [44, 99, 3040, 1109, 18].map((tag) => fields.get(tag)),
          ['1880', '1920', '1940', undefined, undefined],
        );
        tpslFixOrder = {
          ...nativeFixOrder,
          id: '66666666-2222-3333-4444-555555555555',
          client_oid: fields.get(11),
          price: fields.get(44),
          size: fields.get(38),
          stop: 'entry',
          stop_price: fields.get(99),
          stop_limit_price: fields.get(3040),
          post_only: false,
          filled_size: '0',
          executed_value: '0',
          fill_fees: '0',
        };
        const identity = [
          [11, tpslFixOrder.client_oid],
          [37, tpslFixOrder.id],
          [40, 'O'],
          [55, 'ETH-USD'],
          [39, '0'],
        ];
        send('8', [
          ...identity,
          [17, randomUUID()],
          [150, '0'],
          [44, tpslFixOrder.price],
          [99, '1920'],
          [3040, '1940'],
          [14, '0'],
          [151, '0.1'],
        ]);
        repriceTpsl = () => {
          tpslFixOrder.price = tpslFixOrder.stop_limit_price;
          send('8', [
            ...identity,
            [17, randomUUID()],
            [150, 'D'],
            [378, '3'],
            [44, tpslFixOrder.price],
          ]);
        };
      } else if (type === 'D' || type === 'G') {
        const amended = type === 'G';
        if (amended) {
          assert.equal(fields.get(37), nativeFixOrder.id);
          assert.equal(fields.get(41), nativeFixOrder.client_oid);
        }
        nativeFixOrder = {
          id: '33333333-2222-3333-4444-555555555555',
          profile_id: '11111111-2222-3333-4444-555555555555',
          client_oid: fields.get(11),
          product_id: fields.get(55),
          side: 'buy',
          type: 'limit',
          time_in_force: 'GTC',
          post_only: true,
          status: 'open',
          size: fields.get(38),
          price: fields.get(44),
          filled_size: '0.025',
          executed_value: '50',
          fill_fees: '0.2',
        };
        send('8', [
          [11, nativeFixOrder.client_oid],
          [37, nativeFixOrder.id],
          [17, randomUUID()],
          [150, amended ? '5' : 'F'],
          [39, amended ? '5' : '1'],
          [54, '1'],
          [55, 'ETH-USD'],
          [18, 'A'],
          [14, '0.025'],
          [151, amended ? '0.05' : '0.075'],
          [44, nativeFixOrder.price],
          [38, nativeFixOrder.size],
          ...(amended ? [[41, fields.get(41)]] : []),
        ]);
      } else assert.equal(type, '0');
    }),
  );
  return client;
};
const publicDispatcher = network.createWebSocketDispatcher;
const privateFeedUrl = 'wss://ws-feed-public.sandbox.exchange.coinbase.com';
network.createWebSocketDispatcher = async (url, options) => {
  if (url !== privateFeedUrl) return publicDispatcher(url, options);
  await listening;
  return new Agent({
    connect: (_options, callback) => {
      const socket = createConnection(orderFeedServer.address().port, '127.0.0.1');
      const report = (error) => callback(error);
      socket.once('error', report);
      socket.once('connect', () => {
        socket.off('error', report);
        callback(null, socket);
      });
    },
  });
};
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
let productionOrder,
  productionCancel,
  productionCancelAttempts = 0;
let sandboxOrder;
const word = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { deployments, routerAbi } = require('../../src/main/services/quant/base-swap');
const { Interface } = require('ethers');
const feeOracle = new Interface(['function getL1Fee(bytes)', 'function getOperatorFee(uint256)']);
const swapEvent = new Interface([
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);
const profileHead = 4080;
const profileTime = Math.floor(Date.now() / 1000);
const profilePool = '0x' + 'b'.repeat(40);
let sqrt = (2n ** 192n * 10n ** 12n) / 3100n,
  x = (sqrt + 1n) / 2n;
while (x < sqrt) {
  sqrt = x;
  x = ((2n ** 192n * 10n ** 12n) / 3100n / x + x) / 2n;
}
global.fetch = async (url, options = {}) => {
  if (String(url).startsWith('https://api.exchange.coinbase.com/products/ETH-USD/')) {
    assert.equal(options.headers?.['CB-ACCESS-KEY'], undefined);
    const target = new URL(url);
    const reply = (value) => new Response(JSON.stringify(value));
    if (target.pathname.endsWith('/ticker'))
      return reply({ time: new Date().toISOString(), price: '2000' });
    if (target.pathname.endsWith('/book'))
      return reply({ bids: [['1999', '1', 1]], asks: [['2001', '1', 1]], sequence: 9 });
    if (target.pathname.endsWith('/candles')) {
      const interval = Number(target.searchParams.get('granularity'));
      const end = Math.floor(Date.now() / 1000 / interval) * interval;
      return reply(
        Array.from({ length: 30 }, (_, index) => [
          end - (index + 1) * interval,
          1990,
          2010,
          1998,
          2000,
          33,
        ]),
      );
    }
    throw Error('Unexpected Coinbase public market fixture request');
  }
  const liveExchange = String(url).startsWith('https://api.exchange.coinbase.com/');
  if (liveExchange || String(url).startsWith('https://api-public.sandbox.exchange.coinbase.com/')) {
    const target = new URL(url);
    const route = target.pathname;
    const profile = liveExchange
      ? '22222222-2222-3333-4444-555555555555'
      : '11111111-2222-3333-4444-555555555555';
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (liveExchange && !route.startsWith('/products/'))
      assert.equal(options.headers['CB-ACCESS-KEY'], 'fixture-live-key');
    if (route === '/accounts')
      return json(
        ['ETH', 'USD'].map((currency) => ({
          currency,
          profile_id: profile,
          available: '10000',
          trading_enabled: true,
        })),
      );
    if (route === '/fees') return json({ maker_fee_rate: '0.004', taker_fee_rate: '0.006' });
    if (route === '/products/ETH-USD')
      return json({
        id: 'ETH-USD',
        base_currency: 'ETH',
        quote_currency: 'USD',
        status: 'online',
        cancel_only: false,
        auction_mode: false,
        quote_increment: '0.01',
        base_increment: '0.00000001',
        min_market_funds: '10',
      });
    if (route === '/orders' && options.method === 'POST') {
      if (!liveExchange && sandboxOrder) assert.equal(sandboxOrder.done_reason, 'canceled');
      const result = {
        ...JSON.parse(options.body),
        id:
          !liveExchange && sandboxOrder
            ? '77777777-2222-3333-4444-555555555555'
            : '99999999-2222-3333-4444-555555555555',
        profile_id: profile,
        status: 'open',
        filled_size: '0',
        executed_value: '0',
        fill_fees: '0',
        settled: false,
      };
      if (liveExchange) productionOrder = result;
      else sandboxOrder = result;
      return json(result);
    }
    if (liveExchange && productionOrder && route === '/orders/' + productionOrder.id) {
      if (options.method === 'GET') return json(productionOrder);
      assert.equal(options.method, 'DELETE');
      assert.equal(target.searchParams.get('product_id'), 'ETH-USD');
      productionCancelAttempts++;
      if (productionCancelAttempts === 1)
        return new Promise((resolve) => {
          productionCancel = () => resolve(json({}, 503));
        });
      return json(productionOrder.id);
    }
    if (
      !liveExchange &&
      nativeFixOrder &&
      route === '/orders/' + nativeFixOrder.id &&
      options.method === 'GET'
    )
      return json(nativeFixOrder);
    if (
      !liveExchange &&
      stopFixOrder &&
      route === '/orders/' + stopFixOrder.id &&
      options.method === 'GET'
    )
      return json(stopFixOrder);
    if (
      !liveExchange &&
      tpslFixOrder &&
      route === '/orders/' + tpslFixOrder.id &&
      options.method === 'GET'
    )
      return json(tpslFixOrder);
    if (!liveExchange && sandboxOrder && route === '/orders/' + sandboxOrder.id) {
      if (options.method === 'GET') return json(sandboxOrder);
      assert.equal(options.method, 'DELETE');
      assert.equal(target.searchParams.get('product_id'), 'ETH-USD');
      Object.assign(sandboxOrder, { status: 'done', done_reason: 'canceled', settled: true });
      return json(sandboxOrder.id);
    }
    throw Error('Unexpected Coinbase fixture request');
  }
  if (String(url) === 'https://api.coinbase.com/api/v3/brokerage/time')
    return new Response(JSON.stringify({ epochMillis: String(Date.now()) }));
  if (String(url) === 'https://api.kraken.com/0/public/AssetPairs?pair=ETHUSD')
    return Response.json({
      error: [],
      result: {
        XETHZUSD: {
          wsname: 'ETH/USD',
          altname: 'ETHUSD',
          aclass_base: 'currency',
          aclass_quote: 'currency',
          status: 'online',
          lot_decimals: 8,
          lot_multiplier: 1,
          tick_size: '0.01',
          ordermin: '0.002',
          costmin: '0.5',
        },
      },
    });
  if (/^https:\/\/api\.kraken\.com\/0\/public\/(?:Trades|Depth|OHLC)\?/.test(String(url))) {
    const target = new URL(url);
    assert.equal(target.searchParams.get('pair'), 'ETHUSD');
    const route = target.pathname.split('/').at(-1);
    const interval = Number(target.searchParams.get('interval')) * 60;
    const now = Date.now() / 1000;
    const start = Math.floor(now / interval) * interval;
    const result =
      route === 'Trades'
        ? [['2340.25', '0.002', now, 's', 'l', '', 1]]
        : route === 'Depth'
          ? { bids: [['2339.95', '1']], asks: [['2340.26', '2']] }
          : Array.from({ length: 130 }, (_, i) => {
              const open = 2300 + Math.round(i * 0.3 + Math.sin(i / 4) * 7);
              return [
                start - (129 - i) * interval,
                String(open),
                String(open + 4),
                String(open - 3),
                String(open + (i % 3) - 1),
                String(open),
                String(0.5 + (i % 7)),
                i,
              ];
            });
    return Response.json({ error: [], result: { XETHZUSD: result } });
  }
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
    if (
      body.tools?.some((tool) => tool.function?.name === 'quant_ask_user') &&
      body.messages.some(
        (item) => item.role === 'user' && item.content === 'Ask my research horizon.',
      )
    ) {
      const answer = body.messages.find(
        (item) => item.name === 'quant_ask_user' && item.role === 'tool',
      );
      if (answer) {
        assert.deepEqual(JSON.parse(answer.content), {
          ok: true,
          answers: ['一周', ['WETH', 'USDC']],
          authority: 'none',
        });
        message.content = '已按一周的研究周期继续。';
      } else {
        message.content = '';
        message.tool_calls = [
          {
            id: 'quant-fixture-question',
            type: 'function',
            function: {
              name: 'quant_ask_user',
              arguments: JSON.stringify({
                questions: [
                  { question: '研究周期选多久？', options: ['一天', '一周'], custom: false },
                  {
                    question: '关注哪些资产？',
                    options: ['WETH', 'USDC'],
                    multiSelect: true,
                    custom: false,
                  },
                ],
              }),
            },
          },
        ];
        finish = 'tool_calls';
      }
    } else if (body.tools?.some((tool) => tool.function?.name === 'quant_backtest')) {
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
    else if (method === 'eth_getBlockByNumber') {
      const number =
        params[0] === 'latest' ? 4096 : params[0] === 'finalized' ? profileHead : Number(params[0]);
      const timestamp =
        number === 4096 ? Math.floor(Date.now() / 1000) : profileTime - (profileHead - number) * 2;
      result = {
        number: '0x' + number.toString(16),
        hash: number === 4096 ? '0x' + 'a'.repeat(64) : word(number),
        timestamp: '0x' + timestamp.toString(16),
        baseFeePerGas: '0x10000',
        gasLimit: '0x200000',
      };
    } else if (method === 'eth_getLogs') {
      const { fromBlock, toBlock } = params[0];
      result = [
        [profileHead - 350, 10n ** 18n],
        [profileHead - 200, 2n * 10n ** 18n],
        [profileHead - 40, 10n ** 18n],
        [profileHead - 10, 3n * 10n ** 18n],
      ]
        .filter(([block]) => Number(fromBlock) <= block && block <= Number(toBlock))
        .map(([block, amount]) => ({
          ...swapEvent.encodeEventLog('Swap', [
            profilePool,
            profilePool,
            -1000000n,
            amount,
            sqrt,
            1n,
            0n,
          ]),
          address: profilePool,
          blockNumber: '0x' + block.toString(16),
          blockHash: word(block),
          transactionHash: word(block + 10000),
          logIndex: '0x0',
          removed: false,
        }));
    } else if (method === 'eth_simulateV1') {
      const anchor = Number(params[1]);
      const blocks = params[0].blockStateCalls;
      assert.equal(blocks.length, 2);
      let weth = BigInt(blocks[0].calls[2].value),
        usdc = 0n;
      const response = (returnData, gasUsed = '0x5208') => ({ status: '0x1', returnData, gasUsed });
      const balance = (amount) => response(word(amount));
      const spot = (mark) => response(word(mark) + '0'.repeat(6 * 64));
      const initial = [
        balance(0),
        balance(0),
        response('0x'),
        balance(1),
        balance(1),
        balance(weth),
        balance(0),
      ];
      result = blocks.map(({ calls, blockOverrides }, i) => {
        const swap = calls.at(-4);
        assert.equal(swap.to, deployments.base.router);
        const [leg] = routerAbi.decodeFunctionData('exactInputSingle', swap.input);
        assert.equal(leg.amountIn, 100000000000000000n);
        const output = 2000000n - BigInt(i) * 100000n;
        weth -= leg.amountIn;
        usdc += output;
        const timestamp =
          '0x' + (profileTime - (profileHead - anchor) * 2 + (i + 1) * 2).toString(16);
        assert.equal(blockOverrides.timestamp, timestamp);
        return {
          number: '0x' + (anchor + i + 1).toString(16),
          hash: word(100000 + anchor + i + 1),
          parentHash: word(i ? 100000 + anchor + i : anchor),
          timestamp,
          calls: [
            ...(i ? [] : initial),
            spot(sqrt - BigInt(i)),
            response(word(output), '0x20000'),
            spot(sqrt - BigInt(i + 1)),
            balance(weth),
            balance(usdc),
          ],
        };
      });
    } else if (method === 'eth_getBalance') result = '0x0';
    else if (method === 'eth_call') {
      const { to, data } = params[0];
      if (to === CHAINS.base.factory) result = word('0x' + 'b'.repeat(40));
      else if (to === '0x420000000000000000000000000000000000000f') {
        assert.ok(params[1].requireCanonical && params[1].blockHash);
        result = word(feeOracle.parseTransaction({ data }).name === 'getL1Fee' ? 50000n : 1000n);
      } else if (data === '0x0dfe1681') result = word(CHAINS.base.usdc);
      else if (data === '0xd21220a7') result = word(CHAINS.base.weth);
      else if (data === '0x3850c7bd') result = word(sqrt) + '0'.repeat(6 * 64);
      else if (to === deployments.base.quoter) {
        assert.ok(params[1].requireCanonical && params[1].blockHash);
        result = word(10n ** 18n) + [sqrt, 2n, 123456n].map((part) => word(part).slice(2)).join('');
      } else if (data === '0x1a686502') result = word(1000000000000n);
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
class FixtureKrakenSocket extends EventTarget {
  constructor() {
    super();
    setImmediate(() => {
      this.dispatchEvent(new Event('open'));
      this.frame({ channel: 'status', data: [{ system: 'online' }] });
    });
  }
  frame(value) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
  send(text) {
    const { method, req_id, params } = JSON.parse(text);
    if (method === 'ping') {
      const timestamp = new Date().toISOString();
      this.frame({ method: 'pong', req_id, time_in: timestamp, time_out: timestamp });
      return;
    }
    assert.deepEqual(params.symbol, ['ETH/USD']);
    this.frame({ method, req_id, success: true, result: { ...params, symbol: 'ETH/USD' } });
    if (params.channel !== 'book') return;
    const checksum = crc32('2339223311');
    this.frame({
      channel: 'book',
      type: 'snapshot',
      data: [
        {
          symbol: 'ETH/USD',
          checksum,
          bids: [{ price: 2331, qty: 1 }],
          asks: [{ price: 2339, qty: 2 }],
        },
      ],
    });
    this.timer = setInterval(
      () =>
        this.frame({
          channel: 'book',
          type: 'update',
          data: [
            {
              symbol: 'ETH/USD',
              checksum,
              bids: [],
              asks: [],
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      200,
    );
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.dispatchEvent(new Event('close'));
  }
}
require('undici').WebSocket = class FixtureSocket {
  constructor(url, ...options) {
    if (url === privateFeedUrl) return new RuntimeWebSocket(url, ...options);
    if (url === 'wss://ws.kraken.com/v2') return new FixtureKrakenSocket();
    return new FixtureMarketSocket(url, ...options);
  }
};
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
    const panelValue = (selector, property) =>
      js(
        `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()[${JSON.stringify(property)}]`,
      );
    const savedPanel = (key) =>
      js(
        `window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId}).then(w=>w.preferences[${JSON.stringify(key)}])`,
      );
    const dragPanel = async (split, dx, dy) => {
      const point = await js(`(() => {
        const bar=document.querySelector('[data-quant-split=${split}]');
        bar.scrollIntoView({block:'nearest'});
        const r=bar.getBoundingClientRect();
        return {x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2)};
      })()`);
      const send = (type, x, y, button, buttons) =>
        wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button,
          buttons,
          clickCount: 1,
        });
      wc.debugger.attach('1.3');
      try {
        await send('mousePressed', point.x, point.y, 'left', 1);
        await send('mouseMoved', point.x + dx, point.y + dy, 'left', 1);
        await send('mouseReleased', point.x + dx, point.y + dy, 'left', 0);
      } finally {
        wc.debugger.detach();
      }
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
      const refreshBook = () =>
        marketSocket.frame('l2_data', [
          {
            type: 'update',
            product_id: 'ETH-USD',
            updates: [{ side: 'bid', price_level: '2333', new_quantity: '0.25' }],
          },
        ]);
      refreshBook();
      await pause(650);
      refreshBook();
      await pause(450);
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
      await until(
        "!!document.querySelector('.quant-event-dialog [data-qe=validate]:not(:disabled)')",
      );
      await js(`(() => {
        const dialog = document.querySelector('.quant-event-dialog');
        dialog.querySelector('[data-qe-train]').value = '500';
        dialog.querySelector('[data-qe-test]').value = '500';
        dialog.querySelector('[data-qe-folds]').value = '1';
        dialog.querySelector('[data-qe=validate]').click();
      })()`);
      await until(
        "document.querySelector('.quant-event-dialog .qe-validation-result')?.textContent.includes('样本外结果')",
      );
      await until(
        "document.querySelector('.quant-event-dialog [data-qe-history-context]').textContent.includes('样本外结果')",
      );
      await js(
        "document.querySelector('.quant-event-dialog [data-qe-ranking] summary').click();document.querySelector('.quant-event-dialog [data-qe-training]').click()",
      );
      await until(
        "document.querySelector('.quant-event-dialog [data-qe-history-context]').textContent.includes('训练排名')",
      );
      await js(
        "document.querySelector('.quant-event-dialog .qe-validation-result').scrollIntoView({block:'start'})",
      );
      await shot('quant-native-validation-' + theme + '.png');
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
      marketSocket.frame('l2_data', [
        {
          type: 'update',
          product_id: 'ETH-USD',
          updates: [{ side: 'offer', price_level: '2334', new_quantity: '0.3' }],
        },
      ]);
      await until(
        `(async()=>{const b=await window.api.backendRequest('quant:request','native.source.book',{product:'ETH-USD',limit:1});return b?.eligible;})()`,
      );
      await js(`(() => {
        const form = document.querySelector('.quant-native-paper [data-np-order]');
        form.elements.timeInForce.value = 'fok';
        form.elements.price.value = '2334';
        form.elements.quantity.value = '0.1';
        form.requestSubmit();
      })()`);
      await until(
        `(async()=>{const p=await window.api.backendRequest('quant:request','native.paper.orders',{id:window.__quantTestId});return p.items.some(o=>o.request.time_in_force==='fok'&&o.status==='filled'&&o.filled==='0.1');})()`,
      );
      await until(
        `document.querySelector('.quant-native-paper [data-np-history]').textContent.includes('FOK')`,
      );
      await shot('quant-native-paper-orders-' + theme + '.png');
      await js("document.querySelector('.quant-native-paper [data-np=executions]').click()");
      await until("document.querySelectorAll('.quant-native-paper tbody tr').length>=3");
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
      const imported = await js(
        `window.api.backendRequest('quant:request','dataset.import',{id:window.__quantTestId,label:'UI TEST FIXTURE · OHLC',text:${JSON.stringify(JSON.stringify(candles))}})`,
      );
      await js("window.navigatePage('quant')");
      await until("document.querySelector('[data-product]').textContent==='WETH-USDC'");
      await until("!!document.querySelector('[data-chart-canvas] canvas').width");
      await js("document.querySelector('[data-action=base-history]').click()");
      await until("!!document.querySelector('.quant-amm-dialog[open]')");
      await js("document.querySelector('.quant-amm-dialog button[value=recent]').click()");
      await until("!document.querySelector('.quant-amm-dialog[open]')");
      await until("document.querySelector('[data-source]').textContent.includes('Uniswap v3')");
      await js("document.querySelector('[data-action=base-history]').click()");
      await until("!!document.querySelector('.quant-amm-dialog [data-trades] tbody tr')");
      await js("document.querySelector('.quant-amm-dialog button[value=continue]').click()");
      await until("document.querySelector('.quant-amm-dialog [role=alert]:not([hidden])')");
      await js("document.querySelector('.quant-amm-dialog [data-record=Selected]').click()");
      await until("!!document.querySelector('.quant-amm-dialog [data-record=Stop]:not([hidden])')");
      await js("document.querySelector('.quant-amm-dialog [data-record=Stop]').click()");
      await until(
        "!!document.querySelector('.quant-amm-dialog [data-record=Resume]:not([hidden])')",
      );
      assert.equal(
        await js(
          "!!document.querySelector('.quant-amm-dialog [data-record=Latest]:not([hidden])')",
        ),
        true,
      );
      await js("document.querySelector('.quant-amm-dialog [data-series-form] button').click()");
      await until("!document.querySelector('.quant-amm-dialog[open]')");
      await until(
        "(async()=>{const w=await window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId});return !!w.datasets.find(d=>d.id===w.preferences.datasetId)?.series;})()",
      );
      await until("!!document.querySelector('[data-action=amm-replay]:not([hidden])')");
      await js("document.querySelector('[data-action=amm-replay]').click()");
      await until("!!document.querySelector('.quant-amm-replay-dialog[open]')");
      await js(
        "(()=>{const select=document.querySelector('.quant-amm-replay-dialog [name=feeMode]');select.value='historical';select.dispatchEvent(new Event('change'));})()",
      );
      await until(
        "!document.querySelector('.quant-amm-replay-dialog [name=networkFeeCapUsdc]').disabled",
      );
      await js("document.querySelector('.quant-amm-replay-dialog button[type=submit]').click()");
      await until("!document.querySelector('.quant-amm-replay-dialog[open]')");
      await until("!!document.querySelector('[data-run-report] details table tr')");
      await until(
        "document.querySelector('[data-run-report] details table tr small')?.textContent.includes('运营商费')",
      );
      await js("document.querySelector('[data-action=amm-scenario]').click()");
      await until("!!document.querySelector('.quant-amm-scenario-dialog[open]')");
      await js(`(() => {
        const dialog = document.querySelector('.quant-amm-scenario-dialog');
        dialog.querySelector('[data-add]').click();
        dialog.querySelectorAll('[name=amountIn]')[1].value = '0.1';
        dialog.querySelector('button[type=submit]').click();
      })()`);
      await until("!document.querySelector('.quant-amm-scenario-dialog[open]')");
      await until("document.querySelectorAll('[data-run-report] table tbody tr').length === 2");
      assert.match(
        await js(
          "document.querySelector('[data-run-report] table tbody tr:last-child').textContent",
        ),
        /1\.9 USDC/,
      );
      const scenario = await js(
        "(async()=>{const id=window.__quantTestId;const w=await window.api.backendRequest('quant:request','workspace.get',{id});const summary=w.runs.find(run=>run.codeVersion==='base-amm-scenario-1');return window.api.backendRequest('quant:request','run.get',{id,runId:summary.id});})()",
      );
      assert.equal(
        scenario.ammScenario.legs[1].sqrtBeforeX96,
        scenario.ammScenario.legs[0].sqrtAfterX96,
      );
      await js(
        `window.api.backendRequest('quant:request','workspace.update',{id:window.__quantTestId,preferences:{datasetId:${JSON.stringify(imported.id)}}})`,
      );
      await until(
        `document.querySelector('[data-dataset]').value === ${JSON.stringify(imported.id)}`,
      );
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
        ).runs.filter((run) => !run.codeVersion?.startsWith('base-amm-')).length,
        1,
      );
      await shot('quant-professional-dark.png');
      const professionalChartHeight = await panelValue('[data-chart-home]', 'height');
      for (const [split, dx, dy, selector, property, setting] of [
        ['projects', 45, 0, '.quant-projects', 'width', 'projectWidth'],
        ['assistant', -55, 0, '.quant-conversation', 'width', 'chatWidth'],
        ['chart', 0, 42, '[data-chart-home]', 'height', 'chartShare'],
      ]) {
        const beforeSize = await panelValue(selector, property);
        const beforeSetting = await savedPanel(setting);
        await dragPanel(split, dx, dy);
        await until(
          `window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId}).then(w=>Number.isInteger(w.preferences.${setting}) && w.preferences.${setting}!==${JSON.stringify(beforeSetting) ?? 'undefined'})`,
        );
        assert.ok(
          (await panelValue(selector, property)) > beforeSize + 10,
          `${split} expands by drag`,
        );
      }
      await js(
        "document.querySelector('[data-quant-split=projects]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}))",
      );
      await until(
        "window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId}).then(w=>w.preferences.projectWidth<261)",
      );
      await js(
        "document.querySelector('[data-quant-split=projects]').dispatchEvent(new MouseEvent('dblclick'))",
      );
      await until(
        "window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId}).then(w=>w.preferences.projectWidth===216)",
      );
      await js("document.querySelector('[data-action=walk-forward]').click()");
      await until("!!document.querySelector('.quant-walk-forward-dialog[open]')");
      await js("document.querySelector('.quant-walk-forward-dialog [type=submit]').click()");
      await until("!document.querySelector('.quant-walk-forward-dialog[open]')");
      await until(
        "document.querySelectorAll('[data-walk-forward-report] > div table tbody tr').length === 3",
      );
      await js("document.querySelector('[data-walk-forward-report] details summary').click()");
      assert.equal(
        await js(
          "document.querySelectorAll('[data-walk-forward-report] details[open] tbody tr').length",
        ),
        9,
      );
      await js(`(() => {
        document.querySelector('[data-walk-forward-report] details[open]').dataset.testMarker = 'open';
        return window.api.backendRequest('quant:request','workspace.update',{id:window.__quantTestId,preferences:{datasetId:${JSON.stringify(imported.id)}}});
      })()`);
      await until("!document.querySelector('[data-test-marker=open]')");
      assert.equal(
        await js(
          'document.querySelector(\'[data-walk-forward-report] details[data-fold="1"]\').open',
        ),
        true,
      );
      const walkRun = await js(
        "(async()=>{const id=window.__quantTestId;const w=await window.api.backendRequest('quant:request','workspace.get',{id});const row=w.runs.find(run=>run.codeVersion==='candle-walk-forward-1');return window.api.backendRequest('quant:request','run.get',{id,runId:row.id});})()",
      );
      assert.equal(walkRun.datasetId, imported.id);
      assert.equal(walkRun.metrics.bars, 90);
      assert.equal(walkRun.walkForward.windows[0].training.bars, 120);
      await shot('quant-walk-forward.png');
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
        await js(`(() => {
          const field = document.querySelector('[data-source-venue]');
          field.value = 'kraken';
          field.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await until("!document.querySelector('[data-source=start]').disabled");
        await js("document.querySelector('[data-source=start]').click()");
        await until(
          "document.querySelector('[data-source-status]').textContent.includes('连续行情就绪')",
        );
        await js("document.querySelector('[data-source=book]').click()");
        await until("document.querySelector('[data-source-book]').textContent.includes('2339')");
        const krakenBook = await js(
          "document.querySelector('.quant-source-book-dialog').textContent",
        );
        assert.match(krakenBook, /Kraken Spot/);
        assert.match(krakenBook, /0\.002/);
        await shot('quant-kraken-spot-book.png');
        await js("document.querySelector('.quant-source-book-dialog [data-close]').click()");
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
      await until(
        "!!document.fullscreenElement || document.querySelector('[data-chart-card]').classList.contains('quant-focus-fullscreen')",
      );
      await shot('quant-fullscreen.png');
      await js("document.querySelector('[data-action=fullscreen]').click()");
      await js("document.querySelector('[data-action=immersive]').click()");
      await until("document.querySelector('[data-layout]').dataset.layout==='immersive'");
      assert.ok((await panelValue('[data-chart-home]', 'height')) > professionalChartHeight + 100);
      assert.ok((await panelValue('.quant-chart-surface', 'height')) > 350);
      const marketBefore = await panelValue('.quant-center', 'width');
      await dragPanel('assistant', 96, 0);
      await until(
        "window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId}).then(w=>w.preferences.focusMarketShare>49)",
      );
      assert.ok((await panelValue('.quant-center', 'width')) > marketBefore + 30);
      await js(
        "window.api.setSettings({theme:{frontend:'v2',mode:'light',accentColor:'#527d76',backgroundColor:'#f7f8fa'}})",
      );
      await until("document.documentElement.dataset.theme==='light'");
      await shot('quant-immersive-light.png');
      await js("document.querySelector('[data-action=focus-details]').click()");
      await until(
        "document.querySelector('[data-layout]').dataset.focusDetails==='true' && document.querySelector('.quant-bottom').getBoundingClientRect().height>100",
      );
      await js("document.querySelector('[data-action=focus-details]').click()");
      await until("document.querySelector('[data-layout]').dataset.focusDetails==='false'");
      win.setMinimumSize(440, 600);
      win.setSize(560, 940);
      await until(
        "document.querySelector('[data-quant-split=assistant]').getAttribute('aria-orientation')==='horizontal'",
      );
      await js("document.querySelector('[data-action=tools-menu]').click()");
      await until("document.querySelector('[data-action=wallet]').getClientRects().length>0");
      await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
      await until("document.querySelector('[data-action=wallet]').getClientRects().length===0");
      const stackedHeight = await panelValue('[data-chart-home]', 'height');
      await dragPanel('assistant', 0, 55);
      await until(
        "window.api.backendRequest('quant:request','workspace.get',{id:window.__quantTestId}).then(w=>w.preferences.focusStackMarketHeight>420)",
      );
      assert.ok((await panelValue('[data-chart-home]', 'height')) > stackedHeight + 30);
      assert.ok((await panelValue('.quant-conversation', 'height')) >= 365);
      await js("document.querySelector('[data-action=jump-chat]').click()");
      await until(
        "document.activeElement.matches('[data-chat-input]') && document.querySelector('[data-chat-form]').getBoundingClientRect().bottom <= document.querySelector('[data-layout]').getBoundingClientRect().bottom + 1",
      );
      await shot('quant-immersive-narrow-chat.png');
      await js("document.querySelector('[data-action=jump-market]').click()");
      await shot('quant-immersive-narrow.png');
      win.setSize(1640, 1080);
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
      await js("document.querySelector('[data-wallet-action=enable]').click()");
      await until("!!document.querySelector('.wallet-dialog [data-continue]')");
      await js("document.querySelector('.wallet-dialog [data-continue]').click()");
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
        "document.querySelector('.le-dialog [data-le=new]').click();const schedule=document.querySelector('.le-dialog [name=schedule]');schedule.value='vwap';schedule.dispatchEvent(new Event('change'));document.querySelector('.le-dialog [name=minimumTotalOutput]').value='0.006200000000000001';document.querySelector('.le-dialog [name=maxArrivalCostBps]').value='125';const input=document.querySelector('.le-dialog [name=totalInput]');input.value='12.50';input.focus()",
      );
      await pause(3300);
      assert.equal(
        await js(
          "document.activeElement===document.querySelector('.le-dialog [name=totalInput]')&&document.activeElement.value==='12.50'",
        ),
        true,
        'polling must not replace an active financial input',
      );
      await js("document.querySelector('.le-dialog [data-le=capture]').click()");
      await until("document.querySelector('[data-vwap-preview]').textContent.includes('75%')");
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
      assert.equal(plans.items[0].plan.min_total_output_atoms, '6200000000000001');
      assert.equal(plans.items[0].plan.template, 'base-vwap-fixed-v1');
      assert.equal(plans.items[0].plan.max_arrival_cost_bps, 125);
      assert.deepEqual(plans.items[0].plan.vwap.weth_volume_atoms, [
        '1000000000000000000',
        '3000000000000000000',
      ]);
      assert.equal(plans.items[0].fixed, undefined);
      assert.equal(plans.items[0].commands_created, 0);
      await js(`(() => {
        document.querySelector('.le-dialog [data-le=new]').click();
        const form = document.querySelector('.le-dialog form');
        form.elements.schedule.value = 'settlement';
        form.elements.schedule.dispatchEvent(new Event('change'));
        form.elements.entryRelation.value = 'at-or-above';
        form.elements.entryRelation.dispatchEvent(new Event('change'));
        form.elements.entryPrice.value = '2000.123456';
        form.requestSubmit();
      })()`);
      await until(
        "document.querySelector('.le-dialog [data-le-detail]').textContent.includes('≥ 2000.123456 USDC/WETH')",
      );
      const conditionalEntry = await js(
        "window.api.backendRequest('quant:request','execution.list',{id:window.__quantTestId}).then(p=>p.items.find(i=>i.plan.entry_trigger))",
      );
      assert.deepEqual(conditionalEntry.plan.entry_trigger, {
        relation: 'at-or-above',
        price_atoms: '2000123456',
      });
      assert.equal(conditionalEntry.phase, 'paused');
      assert.equal(conditionalEntry.commands_created, 0);
      assert.equal(await js("document.querySelector('.le-dialog [data-le=start]').disabled"), true);
      await shot('quant-conditional-entry.png');
      await js(`(() => {
        document.querySelector('.le-dialog [data-le=new]').click();
        const form = document.querySelector('.le-dialog form');
        form.elements.side.value = 'sell';
        form.elements.slices.value = '1';
        form.elements.totalInput.value = '0.0001';
        form.elements.minimumTotalOutput.value = '0.19';
        form.elements.maxArrivalCostBps.value = '';
        form.elements.entryRelation.value = 'protective-exit';
        form.elements.entryRelation.dispatchEvent(new Event('change'));
        form.elements.stopLossPrice.value = '1970';
        form.elements.takeProfitPrice.value = '1990';
        form.requestSubmit();
      })()`);
      await until(
        "document.querySelector('.le-dialog [data-le-detail]').textContent.includes('≤ 1970 USDC/WETH')",
      );
      const protective = await js(
        "window.api.backendRequest('quant:request','execution.list',{id:window.__quantTestId}).then(p=>p.items.find(i=>i.plan.protective_exit))",
      );
      assert.deepEqual(protective.plan.protective_exit, {
        stop_loss_price_atoms: '1970000000',
        take_profit_price_atoms: '1990000000',
      });
      assert.equal(protective.plan.side, 'sell');
      assert.equal(protective.phase, 'paused');
      assert.equal(protective.commands_created, 0);
      await shot('quant-protective-exit.png');
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
      await js("window.navigatePage('quant')");
      assert.equal(
        (
          await js(
            "window.api.backendRequest('quant:request','chat.send',{id:window.__quantTestId,message:'Ask my research horizon.'})",
          )
        ).ok,
        true,
      );
      await until("!!document.querySelector('[data-quant-question]:not([hidden]) button')");
      await js("document.querySelector('[data-quant-question] button').click()");
      await until("!!document.querySelector('.quant-question-dialog[open] input[value=一周]')");
      await js("document.querySelector('.quant-question-dialog form').requestSubmit()");
      await until("!!document.querySelector('.quant-question-dialog [role=alert]:not([hidden])')");
      assert.equal(
        await js(`Array.from(document.querySelectorAll('.quant-question-option')).every(label => {
        const input = label.querySelector('input').getBoundingClientRect();
        const text = label.querySelector('span').getBoundingClientRect();
        return input.right < text.left && Math.abs(input.top + input.height / 2 - text.top - text.height / 2) < 2 && input.width <= 45;
      })`),
        true,
        'choice controls must sit alongside their labels',
      );
      await js(
        "document.querySelector('.quant-question-dialog input[value=一周]').click();document.querySelector('.quant-question-dialog input[value=WETH]').click();document.querySelector('.quant-question-dialog input[value=USDC]').click()",
      );
      await until("document.querySelector('.quant-question-dialog [role=alert]').hidden");
      await shot('quant-research-question.png');
      await js("document.querySelector('.quant-question-dialog form').requestSubmit()");
      await until(
        "!document.querySelector('.quant-question-dialog[open]') && document.querySelector('#page-quant').textContent.includes('已按一周的研究周期继续。')",
      );
      if (process.platform === 'win32') {
        await js("document.querySelector('.quant-project-controls [data-action=new]').click()");
        await until("!!document.querySelector('.quant-dialog[open] select[name=venue]')");
        await js(`(() => {
          const form = document.querySelector('.quant-dialog[open] select[name=venue]').form;
          form.elements.venue.value = 'coinbase';
          form.elements.product.value = 'ETH-USD';
          form.elements.name.value = 'Coinbase · UI TEST FIXTURE';
          form.requestSubmit();
        })()`);
        await until(
          "!document.querySelector('.quant-dialog[open] select[name=venue]') && document.querySelector('[data-project-select]').selectedOptions[0].textContent.includes('Coinbase')",
        );
        await js("document.querySelector('[data-action=live-execution]').click()");
        await until("!!document.querySelector('[data-ex-env]')");
        assert.equal(await js("document.querySelector('[data-ex-env]').value"), 'sandbox');
        await js(`(() => {
          const form = document.querySelector('[data-ex-credentials]');
          form.closest('details').open = true;
          form.elements.key.value = 'fixture-key';
          form.elements.secret.value = ${JSON.stringify(Buffer.alloc(64, 22).toString('base64'))};
          form.elements.passphrase.value = 'fixture-passphrase';
          form.requestSubmit();
        })()`);
        await until("!!document.querySelector('[data-ex-order]:not([hidden])')");
        assert.equal(
          await js(`(() => {
          const toggle = document.querySelector('[data-ex-order] [name=postOnly]');
          const control = toggle.getBoundingClientRect();
          const text = toggle.nextElementSibling.getBoundingClientRect();
          return control.height === 24 && control.width === 44 && control.right < text.left &&
            Math.abs(control.top + control.height / 2 - text.top - text.height / 2) < 2;
        })()`),
          true,
        );
        await js(`(() => {
          const form = document.querySelector('[data-ex-order]');
          form.elements.size.value = '0.1';
          form.elements.price.value = '2000';
          form.requestSubmit();
        })()`);
        await until("!!document.querySelector('[data-ex-submit]')");
        await shot('quant-coinbase-exchange-review.png');
        await js(
          "document.querySelector('[data-ex-submit] [name=ack]').value='PLACE ORDER';document.querySelector('[data-ex-submit]').requestSubmit()",
        );
        await until(
          "document.querySelector('[data-ex-history]').textContent.includes('99999999-2222-3333-4444-555555555555')",
        );
        await js(`(() => {
          const row = document.querySelector('[data-ex-item]');
          row.open = true;
          row.querySelector('[name=ack]').value = 'CAN';
          document.querySelector('[data-ex=watch]').click();
        })()`);
        await until(
          "document.querySelector('[data-ex-watch-status]')?.textContent.includes('认证订单流已连接')",
        );
        await until(
          "document.querySelector('[data-ex-watch-notice]')?.textContent.includes('最近核对')",
        );
        assert.ok(orderFeedSocket);
        Object.assign(sandboxOrder, {
          filled_size: '0.025',
          executed_value: '50',
          fill_fees: '0.2',
        });
        orderFeedSocket.send(
          JSON.stringify({
            type: 'match',
            profile_id: sandboxOrder.profile_id,
            product_id: 'ETH-USD',
            maker_order_id: sandboxOrder.id,
          }),
        );
        await until("document.querySelector('[data-ex-history]').textContent.includes('部分成交')");
        await until(
          "document.querySelector('[data-ex-history]').textContent.includes('成交手续费 · 0.2 USD')",
        );
        assert.equal(
          await js("document.querySelector('[data-ex-item][open] [name=ack]').value"),
          'CAN',
        );
        await shot('quant-coinbase-order-watch.png');
        await js("document.querySelector('[data-ex=watch]').click()");
        await until("document.querySelector('[data-ex-watch-status]').hidden");
        await js("document.querySelector('[data-ex=fixQuery]').click()");
        await until("!!document.querySelector('[data-ex-fix-report]:not([hidden])')");
        assert.match(
          await js("document.querySelector('[data-ex-fix-report]').textContent"),
          /剩余数量 · 0\.075/,
        );
        assert.deepEqual(fixRequests.slice(0, 2), ['A', 'H']);
        await shot('quant-coinbase-fix-verification.png');
        await js("document.querySelector('[data-ex=fixToggle]').click()");
        await until("document.querySelector('[data-ex-fix-status]').textContent === 'FIX 未连接'");
        await js(`(() => {
          document.querySelector('[data-ex=replace]').click();
        })()`);
        await until("!!document.querySelector('[data-ex-replacement-preview]')");
        await js(`(() => {
          const form = document.querySelector('[data-ex-replacement-preview]');
          form.elements.size.value = '0.07';
          form.elements.price.value = '2010';
          form.requestSubmit();
        })()`);
        await until("!!document.querySelector('[data-ex-replacement-confirm]')");
        assert.match(
          await js("document.querySelector('[data-ex-replacement]').textContent"),
          /已成交 · 0\.025/,
        );
        await shot('quant-coinbase-replacement.png');
        await js(`(() => {
          const form = document.querySelector('[data-ex-replacement-confirm]');
          form.elements.ack.value = 'REPLACE ORDER';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-history]').textContent.includes('77777777-2222-3333-4444-555555555555')",
        );
        assert.match(await js("document.querySelector('[data-ex-history]').textContent"), /已撤单/);
        await js("document.querySelector('[data-ex=fixToggle]').click()");
        await until(
          "!document.querySelector('[data-ex-order] [name=transport] option[value=fix]').disabled",
        );
        await js(`(() => {
          const form = document.querySelector('[data-ex-order]');
          form.elements.size.value = '0.1';
          form.elements.price.value = '2000';
          form.elements.postOnly.checked = true;
          form.elements.transport.value = 'fix';
          form.requestSubmit();
        })()`);
        await until("document.querySelector('[data-ex-submit]')?.textContent.includes('FIX 5.0')");
        await js(`(() => {
          const form = document.querySelector('[data-ex-submit]');
          form.elements.ack.value = 'PLACE ORDER';
          form.requestSubmit();
        })()`);
        await until("!!document.querySelector('[data-ex=amend]')");
        await js(`(() => {
          const button = document.querySelector('[data-ex=amend]');
          button.closest('details').open = true;
          button.click();
        })()`);
        await until("!!document.querySelector('[data-ex-amend]')");
        await js(`(() => {
          const form = document.querySelector('[data-ex-amend]');
          form.elements.size.value = '0.075';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-replacement]')?.textContent.includes('保留排队位置')",
        );
        assert.match(
          await js("document.querySelector('[data-ex-replacement]').textContent"),
          /剩余名义金额 · 100 USD/,
        );
        assert.equal(await js("document.querySelector('[data-ex-fix-report]').hidden"), true);
        await shot('quant-coinbase-fix-amendment.png');
        await js(`(() => {
          const form = document.querySelector('[data-ex-replacement-confirm]');
          form.elements.ack.value = 'AMEND ORDER';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-history]')?.textContent.includes('改单已生效')",
        );
        assert.deepEqual(
          fixRequests.filter((type) => type === 'D' || type === 'G'),
          ['D', 'G'],
        );
        await js(`(() => {
          const form = document.querySelector('[data-ex-order]');
          const fields = form.elements;
          fields.transport.value = 'fix';
          fields.transport.dispatchEvent(new Event('change'));
          fields.orderKind.value = 'stop-limit';
          fields.orderKind.dispatchEvent(new Event('change'));
          fields.price.value = '1900';
          fields.size.value = '0.1';
          fields.stopPrice.value = '1925';
          fields.triggerDirection.value = 'down';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-submit]')?.textContent.includes('触发价 1925 USD')",
        );
        await shot('quant-coinbase-stop-limit-review.png');
        await js(`(() => {
          const form = document.querySelector('[data-ex-submit]');
          form.elements.ack.value = 'PLACE ORDER';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-history]')?.textContent.includes('等待触发')",
        );
        assert.equal(fixRequests.filter((type) => type === 'D').length, 2);
        await js(`(() => {
          const form = document.querySelector('[data-ex-order]');
          const fields = form.elements;
          fields.orderKind.value = 'tpsl';
          fields.orderKind.dispatchEvent(new Event('change'));
          fields.price.value = '1880';
          fields.stopPrice.value = '1920';
          fields.stopLimitPrice.value = '1940';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-submit]')?.textContent.includes('最大订单名义金额 · 194 USD')",
        );
        await shot('quant-coinbase-tpsl-review.png');
        await js(`(() => {
          const form = document.querySelector('[data-ex-submit]');
          form.elements.ack.value = 'PLACE ORDER';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-history]')?.textContent.includes('止盈已挂单，等待止损触发')",
        );
        assert.equal(fixRequests.filter((type) => type === 'D').length, 3);
        repriceTpsl();
        await until(
          "document.querySelector('[data-ex-history]')?.textContent.includes('当前执行限价 1940 USD')",
        );
        assert.match(
          await js("document.querySelector('[data-ex-history]').textContent"),
          /止损已触发/,
        );
        await js(`(() => {
          const form = document.querySelector('[data-ex-authority-form]');
          form.closest('details').open = true;
          form.elements.perOrder.value = '250';
          form.elements.total.value = '500';
          form.elements.maxOrders.value = '2';
          form.requestSubmit();
        })()`);
        await until("!!document.querySelector('[data-ex-authority-confirm]')");
        await shot('quant-coinbase-agent-review.png');
        await js(`(() => {
          const confirm = document.querySelector('[data-ex-authority-confirm]');
          confirm.elements.ack.value = 'ALLOW EXCHANGE AGENT';
          confirm.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-grants]').textContent.includes('500 USD') && !!document.querySelector('[data-ex=revokeAuthority]')",
        );
        await js("document.querySelector('[data-ex=revokeAuthority]').click()");
        await until(
          "!!document.querySelector('[data-ex-grants] article') && !document.querySelector('[data-ex=revokeAuthority]')",
        );
        await js(`(() => {
          const form = document.querySelector('[data-ex-authority-form]');
          form.elements.transport.value = 'fix';
          form.elements.transport.dispatchEvent(new Event('change'));
          form.elements.allowAmend.click();
          form.elements.allowStopLimit.click();
          form.elements.allowTpsl.click();
          form.elements.perOrder.value = '260';
          form.elements.total.value = '500';
          form.elements.maxOrders.value = '5';
          form.elements.maxCancels.value = '3';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-authority-confirm]')?.textContent.includes('允许提交 FIX 触发限价单')",
        );
        assert.match(
          await js("document.querySelector('[data-ex-authority-confirm]').textContent"),
          /撤单次数上限（0 禁用）3/,
        );
        assert.match(
          await js("document.querySelector('[data-ex-authority-confirm]').textContent"),
          /允许提交 FIX 双腿止盈止损/,
        );
        await shot('quant-coinbase-fix-agent-authority.png');
        await js(`(() => {
          const form = document.querySelector('[data-ex-authority-confirm]');
          form.elements.ack.value = 'ALLOW EXCHANGE AGENT';
          form.requestSubmit();
        })()`);
        await until(
          "document.querySelector('[data-ex-grants]')?.textContent.includes('剩余操作次数 5') && document.querySelector('[data-ex-grants]')?.textContent.includes('剩余撤单次数 · 3')",
        );
        await js("document.querySelector('[data-ex=close]').click()");
        await js(`(async()=>{
          const id = document.querySelector('[data-project-select]').value;
          const request = (action, extra) => window.api.backendRequest('quant:request','exchange.'+action,{id,env:'live',...extra});
          await request('connect',{key:'fixture-live-key',secret:${JSON.stringify(Buffer.alloc(64, 22).toString('base64'))},passphrase:'fixture-passphrase'});
          const draft = await request('preview',{price:'2000',size:'0.1',side:'buy',postOnly:true,operationId:'gui-emergency-order'});
          await request('confirm',{reviewId:draft.reviewId,specHash:draft.specHash,ack:'PLACE ORDER'});
          window.navigatePage('settings');window.activateSettingsTab('wallet');
        })()`);
        await until("!!document.querySelector('[data-wallet-action=emergency-stop]')");
        await js("document.querySelector('[data-wallet-action=emergency-stop]').click()");
        await until(
          "document.querySelector('[data-exchange-cancel]')?.textContent.includes('正在撤销 Coinbase')",
        );
        await until(
          "document.querySelector('[data-wallet-action=emergency-reset]')?.disabled === true",
        );
        for (let i = 0; i < 60 && !productionCancel; i++) await pause(25);
        assert.ok(productionCancel);
        productionCancel();
        await until("!!document.querySelector('[data-wallet-action=emergency-cancel-exchange]')");
        await until(
          "document.querySelector('[data-exchange-cancel]')?.textContent.includes('待核实 1 笔')",
        );
        await shot('wallet-coinbase-emergency.png');
        await js(
          "document.querySelector('[data-wallet-action=emergency-cancel-exchange]').click()",
        );
        await until(
          "document.querySelector('[data-exchange-cancel]')?.textContent.includes('已撤 1 / 共 1 笔')",
        );
        assert.equal(productionCancelAttempts, 2);
      }
      await js("window.navigatePage('quant')");
      await until("!!document.querySelector('#page-quant [data-action=new]')");
      await js(`(() => {
        document.querySelector('#page-quant [data-action=new]').click();
        const form = document.querySelector('dialog[open].quant-dialog form');
        form.elements.name.value = 'Kraken research fixture';
        form.elements.venue.value = 'kraken';
        form.elements.venue.dispatchEvent(new Event('change', { bubbles: true }));
        form.elements.product.value = 'ETH-USD';
        form.requestSubmit();
      })()`);
      await until(
        "document.querySelector('#page-quant [data-venue]').textContent.includes('KRAKEN SPOT') && document.querySelector('#page-quant [data-chart-empty]').hidden",
      );
      await js(`(() => {
        const select = document.querySelector('#page-quant [data-interval]');
        select.value = '14400';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await until(`(async () => {
        const project = (await window.api.backendRequest('quant:request', 'workspace.list')).find(w => w.venue === 'kraken');
        if (!project) return false;
        window.__krakenUiId = project.id;
        const w = await window.api.backendRequest('quant:request', 'workspace.get', { id: project.id });
        return w.market.interval === 14400 && w.candles.length === 129;
      })()`);
      await until(
        "document.querySelector('#page-quant [data-interval]').value === '14400' && !document.querySelector('#page-quant [data-action=capture-candles]').disabled",
      );
      await js("document.querySelector('#page-quant [data-action=capture-candles]').click()");
      await until(
        "document.querySelector('#page-quant [data-dataset]').value !== '' && document.querySelector('#page-quant [data-interval]').disabled",
      );
      assert.equal(
        await js("document.querySelector('#page-quant [data-action=live-execution]').hidden"),
        true,
      );
      assert.match(
        await js("document.querySelector('#page-quant .quant-chart-source').textContent"),
        /Kraken Spot/,
      );
      const result = await js(
        "window.api.backendRequest('quant:request','run.backtest',{id:window.__krakenUiId,config:{strategy:'buy-hold'}})",
      );
      assert.equal(result.metrics.bars, 129);
      assert.equal(result.dataSource, 'kraken-spot-committed-ohlc');
      assert.equal(result.provenance.interval, 14400);
      await until("!!document.querySelector('#page-quant [data-action=prompt-market]')");
      await js('document.querySelector(\'#page-quant [data-action="tab:experiments"]\').click()');
      await until(`!!document.querySelector('#page-quant [data-action="run:${result.id}"]')`);
      await shot('quant-kraken-research.png');
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
  for (const socket of orderFeedServer.clients) socket.terminate();
  orderFeedServer.close();
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}
require('../../src/main/main');
