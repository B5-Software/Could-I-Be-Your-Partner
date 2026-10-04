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
const { Terminal } = require('@xterm/xterm');

const root = path.resolve(__dirname, '../..');
const pty = require(path.join(root, 'node_modules', 'node-pty'));
const { stripAnsi } = require(path.join(root, 'src/tui/ansi.js'));

const REPLY = '这是真终端测试回复';
const TITLE = '真终端会话';
const USER_TEXT = '你好';
const CTRL_C = String.fromCharCode(3);
const CR = String.fromCharCode(13);

function startStubLlm({ retryOnce = false } = {}) {
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
        if (retryOnce && !isTitle && !hits.retried) {
          hits.retried = true;
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          res.end(JSON.stringify({ error: { message: 'Disposable provider rate limit' } }));
          return;
        }
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
function runInPty({ args, env, onOutput, onScreen, watchdogMs = 25000, describe, command }) {
  return new Promise((resolve, reject) => {
    const exitMarker = 'CIBYP_TEST_EXIT_' + require('node:crypto').randomUUID() + ':';
    const resources = process.env.CIBYP_TEST_PACKAGED_RESOURCES;
    const binary = resources
      ? path.join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
      : process.execPath;
    const actualArgs = resources
      ? [
          path.join(resources, 'cli/launch.cjs'),
          command || process.env.CIBYP_TEST_COMMAND || 'tui',
          ...args.slice(1),
        ]
      : args;
    const child = pty.spawn(binary, actualArgs, {
      name: 'xterm-color',
      cols: 110,
      rows: 32,
      cwd: root,
      env: Object.assign({}, process.env, env, {
        CIBYP_DOCUMENTS: path.join(env.CIBYP_USER_DATA, 'documents'),
        CIBYP_TEST_EXIT_MARKER: exitMarker,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS || '',
          '--require=' +
            JSON.stringify(
              path.join(root, 'tests/fixtures/tui-exit-marker.cjs').replace(/\\/g, '/'),
            ),
        ]
          .join(' ')
          .trim(),
      }),
    });
    const terminal = onScreen
      ? new Terminal({ cols: 110, rows: 32, allowProposedApi: true })
      : null;
    let out = '';
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminal?.dispose();
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
      terminal?.write(data, () => onScreen(terminal));
      if (onOutput) onOutput(data, out, child);
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(watchdog);
      if (settled) return;
      settled = true;
      const finish = () => {
        terminal?.dispose();
        // ConPTY can close its output before node-pty receives the native exit
        // code. Use the actual Node exit event, never assume a missing code is 0.
        const marker = out.match(new RegExp(exitMarker + '(\\d+)'));
        const reported = marker ? Number(marker[1]) : exitCode;
        if (marker && Number.isInteger(exitCode) && reported !== exitCode) {
          reject(new Error(`Node exit ${reported} disagrees with PTY exit ${exitCode}`));
          return;
        }
        resolve({ exitCode: reported, output: out });
      };
      if (terminal) terminal.write('', finish);
      else finish();
    });
  });
}

test('TUI Code startup workspace failure still accepts real keyboard input and workspace recovery', async () => {
  const stub = await startStubLlm();
  const profile = makeProfile(stub.port);
  let stage = 'startup';
  let child;
  try {
    const result = await runInPty({
      args: [
        path.join(root, 'bin/cibyp-tui.js'),
        '--mode=code',
        '--workspace=' + path.join(profile, 'missing-project'),
        '--workspace-local',
      ],
      command: 'tui',
      env: { CIBYP_USER_DATA: profile, CIBYP_AUTO_APPROVE: '1' },
      watchdogMs: 35000,
      describe: () => stage,
      onOutput: (_data, _all, ptyChild) => {
        child = ptyChild;
      },
      onScreen: (terminal) => {
        const rows = Array.from(
          { length: 32 },
          (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) || '',
        );
        const screen = rows.join('\n');
        if (!child) return;
        if (
          stage === 'startup' &&
          screen.includes('工作区初始化失败') &&
          screen.includes('终端模式')
        ) {
          stage = 'typing after startup failure';
          child.write('draft-kept');
        } else if (
          stage === 'typing after startup failure' &&
          rows.slice(-6).join('\n').includes('draft-kept')
        ) {
          stage = 'blocked send keeps draft';
          child.write(CR);
        } else if (
          stage === 'blocked send keeps draft' &&
          screen.split('工作区初始化失败').length >= 3
        ) {
          assert.ok(rows.slice(-6).join('\n').includes('draft-kept'));
          assert.equal(stub.hits.count, 0, 'no LLM/tool execution in an unprepared workspace');
          stage = 'recovering workspace';
          child.write('\x1b');
          setTimeout(() => child.write('/workspace ' + path.join(profile, 'documents') + CR), 80);
        } else if (stage === 'recovering workspace' && screen.includes('工作区已设置为')) {
          stage = 'sending after recovery';
          child.write(USER_TEXT + CR);
        } else if (stage === 'sending after recovery' && screen.includes(REPLY)) {
          stage = 'quitting';
          child.write(CTRL_C);
          setTimeout(() => child.write(CTRL_C), 120);
        }
      },
    });
    assert.equal(stage, 'quitting');
    assert.equal(result.exitCode, 0);
    assert.ok(stub.hits.count > 0);
  } finally {
    closeStub(stub);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test(
  'TUI 真终端：交互界面持续运行、可输入、可退出（回归：输入框闪退）',
  async () => {
    const stub = await startStubLlm();
    const profile = makeProfile(stub.port);
    const stage = { welcomed: false, typed: false, echoed: false, replied: false, quitting: 0 };
    const resources = process.env.CIBYP_TEST_PACKAGED_RESOURCES;
    const version = require(
      path.join(resources ? path.join(resources, 'app.asar.unpacked') : root, 'package.json'),
    ).version.split('+')[0];
    let completeVersionSeen = false;
    let lastStatus = '';

    try {
      const result = await runInPty({
        args: [path.join(root, 'bin/cibyp-tui.js')],
        env: { CIBYP_USER_DATA: profile, CIBYP_AUTO_APPROVE: '1' },
        watchdogMs: 30000,
        describe: () => JSON.stringify({ stage, stubHits: stub.hits.count }),
        onScreen: (terminal) => {
          const row = terminal.buffer.active.getLine(31).translateToString(true);
          if (row.includes('Could I Be Your Partner')) {
            lastStatus = row;
            completeVersionSeen ||= row.endsWith('Could I Be Your Partner ' + version);
          }
        },
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
      assert.ok(
        completeVersionSeen,
        `The actual terminal must display the complete version ${version}: ${lastStatus}`,
      );
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
  'TUI real terminal inherits GUI colors, toggles native colors, and displays an actual 429 retry at top-right',
  async () => {
    const stub = await startStubLlm({ retryOnce: true });
    const profile = makeProfile(stub.port);
    const settingsFile = path.join(profile, 'data/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.theme = { mode: 'light', backgroundColor: '#f5f7fa', accentColor: '#3355aa' };
    settings.tui = { followGuiTheme: true, thinkingExpanded: true };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    const stage = { ready: false, off: false, on: false, retry: false, reply: false };
    let retryRow = '';
    let retryDetail = '';
    let persistenceError;
    const afterSaved = async (value, child, next) => {
      try {
        const deadline = Date.now() + 4000;
        while (JSON.parse(fs.readFileSync(settingsFile)).tui.followGuiTheme !== value) {
          if (Date.now() > deadline) throw new Error('Theme preference was not persisted');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        child.write(next + CR);
      } catch (error) {
        persistenceError = error;
        child.kill();
      }
    };
    try {
      const result = await runInPty({
        args: [path.join(root, 'bin/cibyp-tui.js')],
        env: { CIBYP_USER_DATA: profile, CIBYP_AUTO_APPROVE: '1' },
        watchdogMs: 30000,
        describe: () => JSON.stringify(stage),
        onScreen: (terminal) => {
          const row = terminal.buffer.active.getLine(2)?.translateToString(true) || '';
          if (row.includes('LLM 重试 #1')) {
            stage.retry = true;
            retryRow = row;
            retryDetail = [3, 4, 5]
              .map(
                (index) =>
                  terminal.buffer.active.getLine(index)?.translateToString(true).slice(48) || '',
              )
              .join(' ')
              .replace(/[│╭╮╰╯─]/g, ' ')
              .replace(/\s+/g, ' ');
          }
        },
        onOutput: (_data, all, child) => {
          const plain = stripAnsi(all);
          if (!stage.ready && plain.includes('终端模式')) {
            stage.ready = true;
            setTimeout(() => child.write('/theme off' + CR), 200);
          } else if (!stage.off && plain.includes('TUI 主题：终端默认')) {
            stage.off = true;
            afterSaved(false, child, '/theme on');
          } else if (stage.off && !stage.on && plain.includes('TUI 主题：沿用 GUI 色系')) {
            stage.on = true;
            afterSaved(true, child, USER_TEXT);
          } else if (stage.on && !stage.reply && plain.includes(REPLY)) {
            stage.reply = true;
            child.write(CTRL_C);
            setTimeout(() => child.write(CTRL_C), 300);
          }
        },
      });
      if (persistenceError) throw persistenceError;
      assert.equal(result.exitCode, 0);
      assert.ok(stage.off && stage.on && stage.retry && stage.reply, JSON.stringify(stage));
      assert.ok(retryRow.indexOf('LLM 重试') >= 48, retryRow);
      assert.ok(
        result.output.includes('48;2;245;247;250'),
        'GUI background must paint actual terminal cells',
      );
      assert.ok(
        retryDetail.includes('Disposable provider rate limit'),
        'Retry error reaches the terminal: ' + retryDetail,
      );
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
