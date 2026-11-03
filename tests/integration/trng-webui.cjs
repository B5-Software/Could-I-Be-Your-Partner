/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real firmware WebUI + real host-built Rust protocol core. HTTP/Wi-Fi transport
// is a local fixture, not evidence of ESP32 radio/USB hardware acceptance.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { spawn } = require('node:child_process'),
  assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
app.disableHardwareAcceleration();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-trng-ui-'));
app.setPath('userData', profile);
const root = path.resolve(__dirname, '../..'),
  web = path.join(root, 'IoT-Firmware/CIBYP-TRNG/web');
const executable = path.join(
  root,
  'IoT-Firmware/CIBYP-TRNG/rust/target/debug/examples/preview' +
    (process.platform === 'win32' ? '.exe' : ''),
);
let child,
  server,
  wss,
  window,
  queue = [],
  buffer = '',
  setup = false,
  draws = 0,
  dropDraw = false,
  rejectSockets = false;
const errors = [];
const wireCommands = [];
const restBodies = [];
function launch() {
  child = spawn(executable, setup ? ['--setup'] : [], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  child.stdout.on('data', (bytes) => {
    buffer += bytes;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const waiter = queue.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        try {
          waiter.resolve(JSON.parse(line));
        } catch (error) {
          waiter.reject(error);
        }
      }
    }
  });
  child.on('error', (error) => {
    for (const waiter of queue) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    queue = [];
  });
}
function command(input) {
  wireCommands.push(input);
  return new Promise((resolve, reject) => {
    const item = {
      resolve,
      reject,
      timer: setTimeout(() => reject(Error('Rust fixture timeout')), 4000),
    };
    queue.push(item);
    child.stdin.write(input + '\n');
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function js(code) {
  return window.webContents.executeJavaScript(code, true);
}
async function until(code) {
  for (let i = 0; i < 150; i++) {
    if (await js(code)) return;
    await sleep(100);
  }
  throw Error('Timed out: ' + code);
}
async function screenshot(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await sleep(650);
  const folder = path.join(root, '.cache/previews');
  fs.mkdirSync(folder, { recursive: true });
  // Capture the full actual document, including card captions below the fold.
  // Native Windows bounds can constrain a hidden window to the work area.
  const attached = window.webContents.debugger.isAttached();
  if (!attached) window.webContents.debugger.attach('1.3');
  try {
    const layout = await window.webContents.debugger.sendCommand('Page.getLayoutMetrics');
    const bounds = layout.cssContentSize;
    const shot = await window.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(bounds.width),
        height: Math.ceil(bounds.height),
        scale: 1,
      },
    });
    fs.writeFileSync(path.join(folder, name), Buffer.from(shot.data, 'base64'));
  } finally {
    if (!attached) window.webContents.debugger.detach();
  }
}
const timeout = setTimeout(() => finish(Error('TRNG UI integration timeout')), 90000);
async function finish(error) {
  clearTimeout(timeout);
  fs.writeFileSync(
    path.join(root, '.cache/trng-webui-result.json'),
    JSON.stringify({ ok: !error, error: error?.stack, errors }, null, 2),
  );
  if (error) console.error(error.stack);
  for (const client of wss?.clients || []) client.terminate();
  wss?.close();
  server?.close();
  child?.kill();
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  try {
    launch();
    server = http.createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (
          ['/', '/app.js', '/app.css', '/catalog.json', '/deck.json', '/question-seed.js'].includes(
            pathname,
          )
        ) {
          const file = pathname === '/' ? 'index.html' : pathname.slice(1);
          res.setHeader(
            'Content-Type',
            file.endsWith('.js')
              ? 'text/javascript'
              : file.endsWith('.css')
                ? 'text/css'
                : file.endsWith('.json')
                  ? 'application/json'
                  : 'text/html',
          );
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          );
          res.end(fs.readFileSync(path.join(web, file)));
          return;
        }
        if (/^\/cards\/\d{2}\.webp$/.test(pathname)) {
          res.setHeader('Content-Type', 'image/webp');
          res.end(fs.readFileSync(path.join(web, pathname)));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          if (pathname === '/api/spread') {
            restBodies.push(body);
            assert.match(body, /^SPREAD2 [a-z_-]+ [a-f0-9]{64}$/);
            res.end(JSON.stringify(await command(body)));
            return;
          }
          if (!setup && req.headers.authorization !== 'Bearer my password') {
            res.statusCode = 401;
            res.end('{"error":"ADMIN_REQUIRED"}');
            return;
          }
          assert.ok(!setup || req.headers['x-cibyp-setup'] === '1');
          res.end(JSON.stringify(await command('ADMIN ' + body)));
          return;
        }
        const cmd =
          pathname === '/api/info'
            ? 'INFO'
            : pathname === '/api/draw'
              ? 'DRAW'
              : 'SPREAD:' + new URL(req.url, 'http://localhost').searchParams.get('type');
        res.end(JSON.stringify(await command(cmd)));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      if (rejectSockets) {
        ws.close();
        return;
      }
      ws.on('message', async (raw) => {
        const input = raw.toString();
        if (input.startsWith('SPREAD:') || input.startsWith('SPREAD2 ')) {
          draws++;
          if (dropDraw) {
            dropDraw = false;
            ws.close();
            return;
          }
        }
        try {
          const result = await command(input);
          if (ws.readyState === 1) ws.send(JSON.stringify(result));
        } catch {
          ws.close();
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    window = new BrowserWindow({
      width: 1480,
      height: 1120,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push(message);
    });
    await window.loadURL('http://127.0.0.1:' + server.address().port);
    await until("!document.getElementById('draw').disabled");
    const alignment = await js(
      `(()=>{const center=el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};};const mark=document.querySelector('.brand .brand-mark'),svg=mark.querySelector('svg'),text=document.querySelector('.brand>span:last-child');return{symbolX:Math.abs(center(mark).x-center(svg).x),symbolY:Math.abs(center(mark).y-center(svg).y),textY:Math.abs(center(mark).y-center(text).y),nav:Math.abs(center(document.querySelector('.nav svg')).y-center(document.querySelector('.nav>span:nth-child(2)')).y)};})()`,
    );
    for (const [key, offset] of Object.entries(alignment))
      assert.ok(offset <= 1, key + ' must be centered: ' + offset);
    await js(
      "document.getElementById('question').value='';document.getElementById('draw').click()",
    );
    await until("document.querySelectorAll('.card-orientation').length===3");
    await until(
      "Array.from(document.querySelectorAll('.card-illustration')).length===3&&Array.from(document.querySelectorAll('.card-illustration')).every(img=>img.complete&&img.naturalWidth>0)",
    );
    assert.equal(draws, 1);
    assert.equal(await js("document.getElementById('history-count').textContent"), '1');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await screenshot('trng-webui-light.png');
    await js("document.getElementById('theme').click()");
    await screenshot('trng-webui-dark.png');
    window.setSize(430, 960);
    await sleep(200);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await screenshot('trng-webui-mobile.png');
    await js("document.querySelector('[data-view=history]').click()");
    assert.equal(await js("document.querySelectorAll('.history-item').length"), 1);
    await js("document.querySelector('.history-item').click()");
    await window.reload();
    await until("!document.getElementById('draw').disabled");
    assert.equal(await js("document.getElementById('history-count').textContent"), '1');
    dropDraw = true;
    await js("document.getElementById('draw').click()");
    await until("!document.getElementById('notice').hidden");
    await sleep(2500);
    assert.equal(draws, 2, 'A lost draw must never be automatically replayed');
    await until("!document.getElementById('draw').disabled");
    await js(
      "document.getElementById('question').value='一个只在本地保存的问题';document.getElementById('draw').click()",
    );
    await until("document.querySelector('[data-i=footer]').textContent.includes('HKDF')");
    assert.ok(wireCommands.some((command) => /^SPREAD2 three [a-f0-9]{64}$/.test(command)));
    assert.ok(wireCommands.every((command) => !command.includes('一个只在本地保存的问题')));
    assert.equal(
      await js("document.getElementById('reading-label').textContent"),
      '一个只在本地保存的问题',
    );
    const reading = await js(
      "JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('tarot-history-'))))[0]",
    );
    assert.deepEqual(Object.keys(reading).sort(), [
      'cards',
      'question',
      'questionMixed',
      'spread',
      'time',
    ]);
    assert.equal(reading.questionMixed, true);
    assert.equal(reading.question, '一个只在本地保存的问题');
    assert.deepEqual(Object.keys(reading.cards[0]).sort(), ['cardIndex', 'isReversed']);
    window.setSize(1480, 1120);
    await js("document.documentElement.dataset.theme='light'");
    await until(
      "Array.from(document.querySelectorAll('.card-illustration')).every(img=>img.complete&&img.naturalWidth>0)",
    );
    await screenshot('trng-webui-question.png');
    rejectSockets = true;
    for (const client of wss.clients) client.terminate();
    await until(
      "document.getElementById('channel').textContent==='REST'&&!document.getElementById('draw').disabled",
    );
    await js(
      "document.getElementById('question').value='REST 本地问题';document.getElementById('draw').click()",
    );
    await until("document.getElementById('reading-label').textContent==='REST 本地问题'");
    assert.equal(restBodies.length, 1);
    assert.match(restBodies[0], /^SPREAD2 three [a-f0-9]{64}$/);
    assert.ok(wireCommands.every((command) => !command.includes('REST 本地问题')));
    assert.equal(
      await js("document.querySelector('[data-i=footer]').textContent.includes('HKDF')"),
      true,
    );
    rejectSockets = false;
    await js(
      "document.querySelector('[data-view=network]').click();document.getElementById('admin').value='incorrect';document.getElementById('ssid').value='My Tarot';document.getElementById('wifi-password').value='new password';document.getElementById('network-form').requestSubmit()",
    );
    await until("document.getElementById('network-status').textContent.includes('不正确')");
    assert.equal(await js("document.getElementById('admin').value"), '');
    // Switch the real Rust fixture to its first-boot configuration-only state.
    child.kill();
    await sleep(100);
    setup = true;
    buffer = '';
    launch();
    for (const client of wss.clients) client.terminate();
    window.setSize(1340, 900);
    await window.reload();
    await until("document.body.classList.contains('setup-mode')");
    assert.equal(await js("document.getElementById('draw').disabled"), true);
    assert.equal((await command('DRAW')).error, 'SETUP_REQUIRED');
    await js("document.documentElement.dataset.theme='light'");
    await screenshot('trng-webui-first-use.png');
    await js(
      "document.getElementById('setup-password').value='my password';document.getElementById('setup-confirm').value='different password';document.getElementById('setup-form').requestSubmit()",
    );
    await until("document.getElementById('setup-status').textContent.includes('不一致')");
    await js(
      "document.getElementById('setup-confirm').value='my password';document.getElementById('setup-form').requestSubmit()",
    );
    await until("document.getElementById('setup-status').textContent.includes('即将重启')");
    assert.equal(await js("document.getElementById('setup-password').value"), '');
    assert.equal(
      (await command('DRAW')).error,
      'SETUP_REQUIRED',
      'Open AP must stay locked after saving until WPA2 boot',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: real Rust core/WebUI, draw/history/reload, light/dark/mobile, no replay, config auth and mandatory first-use setup. HTTP/radio are fixtures.',
    );
    finish();
  } catch (error) {
    await screenshot('trng-webui-failure.png').catch(() => {});
    finish(error);
  }
});
