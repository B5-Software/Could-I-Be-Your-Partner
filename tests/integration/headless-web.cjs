/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 无头模式集成测试：不起任何 GUI 窗口，WebUI 直接驱动主进程里的 Agent 运行时。
 *
 * 覆盖：
 *   - --headless 启动不创建 BrowserWindow
 *   - WebUI 登录 → HTTP 发消息 → Agent 跑完整轮（伪造 LLM 响应）→ 消息流回 WebUI
 *   - WS 协议（auth / sendMessage / message 推送）
 *   - 历史接口与会话状态
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const WEB_PORT = 38000 + Math.floor(Math.random() * 1500);
const WEB_PASSWORD = 'headless-test-pass';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-headless-web-'));
fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    notifications: { enabled: false },
    runtime: { location: 'host' },
    closeToTray: 'never',
    trayEnabled: false,
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    llm: {
      provider: 'openai',
      apiUrl: 'http://stub.local/v1',
      apiKey: 'stub-key',
      model: 'stub-model',
      streamResponses: false,
      maxContextLength: 32768,
      maxResponseTokens: 1024,
    },
  }),
);

// 无头启动：main.js 按 process.argv 识别
process.argv.push('--headless', '--web');
process.env.CIBYP_WEB_PASSWORD = WEB_PASSWORD;
process.env.CIBYP_WEB_PORT = String(WEB_PORT);
process.env.CIBYP_AUTO_APPROVE = '1';

// 伪造 LLM 端点：无网络依赖的完整对话轮次。
// 注意：net-proxy.install() 会用 undici.fetch 包装覆盖 globalThis.fetch，
// 因此 stub 打在 undici 模块上（包装器绑定的是它）。
const llmCalls = [];
const FAKE_REPLY = '无头运行时回复成功';
const realFetch = globalThis.fetch;
const fakeFetch = async (url, opts) => {
  const target = String(url && typeof url === 'object' && url.url ? url.url : url);
  // LLM 端点（测试配置指向 stub.local；不同 provider 的 URL 形态不同）
  if (
    target.includes('stub.local') ||
    target.includes('/chat/completions') ||
    target.includes('/completions')
  ) {
    llmCalls.push({ url: target, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        id: 'stub-1',
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: FAKE_REPLY },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }),
      text: async () => '',
    };
  }
  // 测试自身与本机 WebUI 通信走真实网络（仅回环），其余一律禁网
  if (target.startsWith('http://127.0.0.1:') || target.startsWith('http://localhost:')) {
    return realFetch(url, opts);
  }
  throw new Error(`Network disabled in headless check: ${target}`);
};
global.fetch = fakeFetch;
try {
  require('undici').fetch = fakeFetch;
} catch {
  /* undici 不可用时退回 global.fetch */
}

let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  if (error) {
    console.error('[headless-web] FAILED:', error);
    app.exit(1);
    return;
  }
  console.log('[headless-web] OK');
  app.exit(0);
}

const timeout = setTimeout(() => finish(new Error('headless web check timed out')), 90000);

function apiBase() {
  return `http://127.0.0.1:${WEB_PORT}`;
}

async function waitForWebUi() {
  for (let i = 0; i < 120; i++) {
    try {
      // 服务是否在线以"有 HTTP 响应"为准（未登录时 auth-check 会 401，也算在线）
      const res = await fetch(`${apiBase()}/`);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`WebUI did not start on port ${WEB_PORT}`);
}

async function run() {
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'Headless owner creates no windows');
  await waitForWebUi();
  const { BackendClient } = require('../../src/shared/backend-client');
  const client = new BackendClient({
    url: apiBase(),
    socketFactory: (url, token) =>
      new (require('ws'))(url, { headers: { Authorization: 'Bearer ' + token } }),
  });
  const events = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.login(WEB_PASSWORD);
    const snapshot = await client.connect();
    assert.equal(snapshot.pid, process.pid);
    for (let n = 0; n < 100 && !events.some((e) => e.type === 'connection'); n++)
      await new Promise((r) => setTimeout(r, 20));
    const session = await client.request('createSession', { mode: 'chat' });
    const result = await client.request('sendMessage', session.key, 'Headless test');
    assert.equal(result.ok, true);
    const view = await client.request('getView', session.key);
    assert.ok(view.messages.some((m) => m.role === 'assistant' && m.content === FAKE_REPLY));
    assert.ok(events.some((e) => e.payload?.key === session.key && e.payload?.type === 'message'));
    const history = await client.request('listHistory', 'chat');
    assert.ok(Array.isArray(history));
    assert.ok(llmCalls.length > 0);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log('[headless-web] Shared RPC + authenticated events + history passed without a GUI.');
  } finally {
    client.close();
  }
  clearTimeout(timeout);
  finish();
}

require('../../src/main/main.js');

app
  .whenReady()
  .then(() => run())
  .catch((error) => finish(error));

process.on('uncaughtException', (error) => finish(error));
process.on('unhandledRejection', (error) =>
  finish(error instanceof Error ? error : new Error(String(error))),
);
