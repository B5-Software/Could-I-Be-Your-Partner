/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * TUI 真终端测试（node-pty 起真实 PTY 驱动纯 Node CLI）：
 *
 *   1. 本地 stub LLM HTTP 服务（避免真实网络）
 *   2. 独立用户数据目录（不碰真实配置）
 *   3. PTY 里运行 node bin/cibyp-tui.js，验证：
 *        - 交互界面真的起来了（不是"渲染一帧就退出"）
 *        - 键入文本 + 回车 → 用户消息回显 → stub 回复渲染出来
 *        - Ctrl+C 两次能干净退出
 *
 * 这条用例就是"输入框直接退出 / 还是 Shell"问题的回归测试。
 * 失败时会带上阶段标记（stage）与界面尾部，便于定位卡在哪一步。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const pty = require(path.join(root, 'node_modules', 'node-pty'));
const { stripAnsi } = require(path.join(root, 'src/tui/ansi.js'));

const REPLY = '这是真终端测试回复';
const TITLE = '真终端会话';
const USER_TEXT = '你好';
const CTRL_C = String.fromCharCode(3);
const CR = String.fromCharCode(13);

function startStubLlm() {
  return new Promise((resolve) => {
    const hits = { count: 0 };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          payload = {};
        }
        hits.count += 1;
        const isTitle = payload.temperature === 0 && payload.max_tokens === 512;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'stub-1',
            model: payload.model || 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: isTitle ? TITLE : REPLY },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          }),
        );
      });
    });
    // 不阻止进程退出（否则 node --test 跑完会一直挂着）
    server.unref();
    server.on('connection', (socket) => socket.unref());
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, hits });
    });
  });
}

function closeStub(stub) {
  if (!stub || !stub.server) return;
  try {
    if (typeof stub.server.closeAllConnections === 'function') stub.server.closeAllConnections();
    stub.server.close();
  } catch {
    /* ignore */
  }
}

function makeProfile(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-tui-tty-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'documents'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'data/settings.json'),
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
        apiUrl: 'http://127.0.0.1:' + port + '/v1',
        apiKey: 'stub-key',
        model: 'stub-model',
        streamResponses: false,
        maxContextLength: 32768,
        maxResponseTokens: 512,
      },
    }),
  );
  return dir;
}

/** 起 PTY 子进程；watchdogMs 到点未完成则杀掉并 reject（带阶段信息） */
function runInPty({ args, env, onOutput, watchdogMs = 25000, describe }) {
  return new Promise((resolve, reject) => {
    const resources = process.env.CIBYP_TEST_PACKAGED_RESOURCES;
    const binary = resources
      ? path.join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
      : process.execPath;
    const actualArgs = resources
      ? [path.join(resources, 'cli/launch.cjs'), process.env.CIBYP_TEST_COMMAND || 'tui']
      : args;
    const child = pty.spawn(binary, actualArgs, {
      name: 'xterm-color',
      cols: 110,
      rows: 32,
      cwd: root,
      env: Object.assign({}, process.env, env, {
        CIBYP_DOCUMENTS: path.join(env.CIBYP_USER_DATA, 'documents'),
      }),
    });
    let out = '';
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      const plain = stripAnsi(out);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          'watchdog 超时，阶段=' +
            (describe ? describe() : '?') +
            '\n--- 界面尾部 ---\n' +
            plain.slice(-700),
        ),
      );
    }, watchdogMs);
    child.onData((data) => {
      out += data;
      if (onOutput) onOutput(data, out, child);
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(watchdog);
      if (settled) return;
      settled = true;
      resolve({ exitCode, output: out });
    });
  });
}

test(
  'TUI 真终端：交互界面持续运行、可输入、可退出（回归：输入框闪退）',
  async () => {
    const stub = await startStubLlm();
    const profile = makeProfile(stub.port);
    const stage = { welcomed: false, typed: false, echoed: false, replied: false, quitting: 0 };

    try {
      const result = await runInPty({
        args: [path.join(root, 'bin/cibyp-tui.js')],
        env: { CIBYP_USER_DATA: profile, CIBYP_AUTO_APPROVE: '1' },
        watchdogMs: 30000,
        describe: () => JSON.stringify({ stage, stubHits: stub.hits.count }),
        onOutput: (data, all, child) => {
          const plain = stripAnsi(all);
          if (!stage.welcomed && plain.includes('终端模式')) {
            stage.welcomed = true;
            setTimeout(() => {
              stage.typed = true;
              child.write(USER_TEXT + CR);
            }, 500);
            return;
          }
          if (stage.typed && !stage.echoed && plain.includes(USER_TEXT)) {
            stage.echoed = true;
          }
          if (stage.echoed && !stage.replied && plain.includes(REPLY)) {
            stage.replied = true;
            child.write('/rename 重命名终端' + CR);
            setTimeout(() => {
              stage.quitting = 1;
              child.write(CTRL_C);
              setTimeout(() => {
                stage.quitting = 2;
                child.write(CTRL_C);
              }, 400);
            }, 400);
          }
        },
      });

      assert.equal(result.exitCode, 0, 'Ctrl+C 两次后应干净退出；阶段=' + JSON.stringify(stage));
      for (const title of ['New', TITLE, '重命名终端']) {
        assert.ok(
          result.output.includes('CIBYP | ' + title),
          'Terminal title should include ' + title,
        );
      }
    } finally {
      closeStub(stub);
    }
  },
  { timeout: 60000 },
);

test(
  'TUI 真终端：界面持续驻留渲染（不是一帧即走）',
  async () => {
    const stub = await startStubLlm();
    const profile = makeProfile(stub.port);
    let frames = 0;
    let lastFrameAt = 0;
    let quitSent = false;
    let typingStarted = false;
    const startedAt = Date.now();

    try {
      const result = await runInPty({
        args: [path.join(root, 'bin/cibyp-tui.js')],
        env: { CIBYP_USER_DATA: profile },
        watchdogMs: 25000,
        describe: () => 'frames=' + frames,
        onOutput: (data, all, child) => {
          if (typingStarted && data) {
            frames++;
            lastFrameAt = Date.now() - startedAt;
          }
          if (!typingStarted && stripAnsi(all).includes('终端模式')) {
            typingStarted = true;
            // Idle frames are deliberately deduplicated. Exercise redraws with
            // real input and a terminal resize instead of demanding idle flicker.
            child.resize(90, 25);
            for (let i = 0; i < 8; i++) setTimeout(() => child.write('a'), 200 + i * 200);
          }
          if (stripAnsi(all).includes('aaaaaaaa') && !quitSent) {
            quitSent = true;
            child.write(CTRL_C);
            setTimeout(() => child.write(CTRL_C), 300);
          }
        },
      });

      assert.ok(frames >= 5, '界面应持续渲染多帧（而不是渲染一帧就退出）：frames=' + frames);
      assert.ok(lastFrameAt > 1000, '渲染应持续到 1 秒之后，实际 ' + lastFrameAt + 'ms');
      assert.equal(result.exitCode, 0);
    } finally {
      closeStub(stub);
    }
  },
  { timeout: 60000 },
);
