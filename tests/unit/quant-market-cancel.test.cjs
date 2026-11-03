/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { MarketData } = require('../../src/main/services/quant/market-data');
for (const method of ['eth_getBalance', 'eth_sendRawTransaction'])
  test(
    'wallet RPC cancellation closes an active host HTTP request: ' + method,
    { timeout: 5000 },
    async (t) => {
      let entered, closed;
      const accepted = new Promise((r) => {
          entered = r;
        }),
        disconnected = new Promise((r) => {
          closed = r;
        });
      const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.method, method);
        res.once('close', closed);
        entered();
        // The local fixture deliberately withholds the response after accepting it.
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      t.after(
        () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      );
      const controller = new AbortController(),
        market = new MarketData();
      const operation = market.rpc(
        'base',
        'http://127.0.0.1:' + server.address().port,
        method,
        [],
        { signal: controller.signal },
      );
      await accepted;
      controller.abort(Error('fixture caller stopped request'));
      await assert.rejects(operation, /fixture caller stopped request/);
      await disconnected;
    },
  );
