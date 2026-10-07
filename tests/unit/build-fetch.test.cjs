/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('build fetch survives a closed socket while download consumption is paused', async () => {
  const preload = path.resolve(__dirname, '../../scripts/lib/build-fetch.cjs');
  const program = `
    const assert = require('node:assert/strict');
    const {createServer} = require('node:net');
    const {Readable} = require('node:stream');
    const {setTimeout:delay} = require('node:timers/promises');
    const body = Buffer.alloc(64 * 1024, 0x61);
    const sockets = new Set();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\\r\\nContent-Length: '+body.length+'\\r\\nConnection: close\\r\\n\\r\\n');
        socket.write(body);
        socket.end();
      });
    });
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        assert.equal(globalThis.fetch, require('build-undici').fetch);
        const response = await fetch('http://127.0.0.1:'+server.address().port);
        assert.equal(response.status, 200);
        // The old HTTP parser crashes before a reader gets attached.
        await delay(500);
        const chunks = [];
        for await (const chunk of Readable.fromWeb(response.body)) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), body);
        console.log('Paused download completed with all bytes intact');
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, '-e', program], {
      cwd: path.resolve(__dirname, '../..'),
      windowsHide: true,
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk.toString();
      });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Paused download completed with all bytes intact/);
});
