/* SPDX-License-Identifier: GPL-3.0-or-later */
const { app } = require('electron');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const timer = setTimeout(() => {
  console.error('SDK Electron smoke timed out');
  app.exit(1);
}, 20000);
app
  .whenReady()
  .then(async () => {
    const server = require('node:http').createServer((request, response) => {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(
        'data: {"choices":[{"index":0,"delta":{"content":"Electron SDK ready"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { fetchOpenCode } = require('../../src/main/services/opencode-ai-transport');
      const result = await fetchOpenCode(
        {
          url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
          headers: {},
          opencodeSdk: { protocol: 'openai', body: {} },
          body: { model: 'fixture', messages: [{ role: 'user', content: 'hello' }] },
        },
        { timeoutMs: 5000 },
      );
      try {
        assert.equal(
          (await result.response.json()).choices[0].message.content,
          'Electron SDK ready',
        );
      } finally {
        result.releaseController?.();
      }
      console.log('PASS: real OpenCode AI SDK runs inside Electron');
      clearTimeout(timer);
      app.exit(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  })
  .catch((error) => {
    console.error(error);
    clearTimeout(timer);
    app.exit(1);
  });
