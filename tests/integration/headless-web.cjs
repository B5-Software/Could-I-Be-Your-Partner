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
process.argv.push('--headless');
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

function cookieFrom(response) {
  const raw =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

async function waitForMessages(baseUrl, cookie, predicate, label) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: cookie } });
    const body = await res.json();
    if (predicate(body.messages || [])) return body.messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function run() {
  // ---- 启动即无窗口 ----
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'headless 不应创建任何窗口');

  await waitForWebUi();
  const base = apiBase();

  // ---- 页面可访问 ----
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200, 'WebUI 首页应可访问');
  const html = await page.text();
  assert.ok(html.length > 500, 'WebUI 首页应返回完整 HTML');

  // ---- 登录 ----
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: WEB_PASSWORD }),
  });
  const loginBody = await login.json();
  assert.equal(loginBody.ok, true, `登录应成功：${JSON.stringify(loginBody)}`);
  const cookie = cookieFrom(login);
  assert.ok(cookie.includes('connect.sid'), '登录应下发会话 cookie');

  // ---- HTTP 发消息 → Agent 完整一轮 → 消息回流 ----
  const send = await fetch(`${base}/api/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ message: '你好，这是无头测试' }),
  });
  const sendBody = await send.json();
  assert.equal(sendBody.ok, true, `发消息应成功：${JSON.stringify(sendBody)}`);

  const messages = await waitForMessages(
    base,
    cookie,
    (list) => list.some((m) => m.content === FAKE_REPLY),
    'assistant reply',
  );
  assert.ok(
    messages.some((m) => m.role === 'user'),
    '消息流应包含用户消息',
  );
  assert.ok(llmCalls.length > 0, '应发起过 LLM 调用');
  assert.equal(BrowserWindow.getAllWindows().length, 0, '对话过程中仍不应出现窗口');

  // ---- 会话状态 / 历史 ----
  const status = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
  assert.equal(status.ok, true, '状态接口应可用');
  assert.equal(status.agentStatus, 'idle', '轮次结束后状态应回到 idle');

  const history = await (
    await fetch(`${base}/api/history`, { headers: { Cookie: cookie } })
  ).json();
  assert.equal(history.ok, true, '历史接口应可用');

  // ---- WS 协议：auth → sendMessage → message 推送 ----
  await new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`);
    const pushes = [];
    const wsTimeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WS check timed out; got ${JSON.stringify(pushes.map((p) => p.type))}`));
    }, 30000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', password: WEB_PASSWORD })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      pushes.push(msg);
      if (msg.type === 'auth_fail') {
        clearTimeout(wsTimeout);
        ws.terminate();
        reject(new Error(`WS auth failed: ${msg.error}`));
        return;
      }
      if (msg.type === 'init') {
        // 认证成功（服务端推 init 快照）后发起第二轮
        ws.send(JSON.stringify({ type: 'sendMessage', message: 'WS 第二轮' }));
        return;
      }
      if (msg.type === 'message' && msg.message && msg.message.content === FAKE_REPLY) {
        clearTimeout(wsTimeout);
        ws.close();
        resolve();
      }
    });
    ws.on('error', (error) => {
      clearTimeout(wsTimeout);
      reject(error);
    });
  });

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
