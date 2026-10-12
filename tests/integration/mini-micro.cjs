/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process'),
  { createInterface } = require('node:readline');
const WebSocket = require('ws');
const { createNodeRuntime } = require('../../src/agent/node-host');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-micro-'));
  const host = await createNodeRuntime({ dataDir: dir });
  let child, socket;
  try {
    const token = crypto.randomBytes(32).toString('hex'),
      address = await host.start({ port: 0, token });
    const auth = { id: 'integration', scopes: ['*'] };
    const call = async (method, params) => {
      const result = await host.dispatch.remote.handle(
        { jsonrpc: '2.0', id: crypto.randomUUID(), method, params },
        auth,
      );
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.result;
    };
    const { deviceToken } = await call('device.provision', {
      deviceId: 'simulator',
      policy: {
        tools: {
          gpio_read: { resources: ['gpio:17'] },
          gpio_write: { resources: ['gpio:17'], write: true },
        },
      },
      operationId: crypto.randomUUID(),
    });
    const binary =
      process.env.CIBYP_MICRO_SIMULATOR ||
      path.resolve(
        __dirname,
        '../../../CIBYP-Micro/build/micro-simulator' + (process.platform === 'win32' ? '.exe' : ''),
      );
    child = spawn(binary, ['simulator', 'gpio:17', path.join(dir, 'device.journal')]);
    let hello,
      diagnostic = '';
    child.stderr.on('data', (data) => {
      diagnostic += String(data);
    });
    const first = new Promise((resolve, reject) => {
      child.once('error', reject);
      createInterface({ input: child.stdout }).on('line', (value) => {
        if (!hello) {
          hello = value;
          resolve(value);
        } else socket?.send(value);
      });
    });
    hello = await first;
    socket = new WebSocket(address.url.replace('http', 'ws') + '/remote/v2/devices', {
      headers: { Authorization: 'Bearer ' + deviceToken },
    });
    socket.on('message', (data) => child.stdin.write(data + '\n'));
    await new Promise((resolve, reject) => {
      socket.once('open', () => {
        socket.send(hello);
        resolve();
      });
      socket.once('error', reject);
    });
    for (let i = 0; i < 100 && host.tools.list().total < 2; ++i)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(host.tools.list().total, 2);
    const lease = await call('tool.lease', {
      resource: 'gpio:17',
      durationMs: 30000,
      operationId: crypto.randomUUID(),
    });
    const params = {
      name: 'micro__simulator__gpio_write',
      input: { resource: 'gpio:17', value: 1 },
      ...lease,
      operationId: crypto.randomUUID(),
    };
    assert.equal((await call('tool.invoke', params)).value, 1);
    assert.equal((await call('tool.invoke', params)).value, 1);
    const read = await call('tool.invoke', {
      name: 'micro__simulator__gpio_read',
      input: { resource: 'gpio:17' },
      operationId: crypto.randomUUID(),
    });
    assert.equal(read.value, 1);
    for (let i = 0; i < 100 && !diagnostic.includes('SIMULATED GPIO='); ++i)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((diagnostic.match(/SIMULATED GPIO=/g) || []).length, 1, diagnostic);
    await call('tool.release', {
      resource: 'gpio:17',
      leaseId: lease.leaseId,
      operationId: crypto.randomUUID(),
    });
    const session = host.runtime.createSession({ mode: 'code' });
    await host.runtime.initialize({ key: session.key });
    const agent = host.runtime.sessions.get(session.key).agent;
    assert.ok(!agent.getRuntimeToolSchemas().some((t) => t.function.name === params.name));
    assert.equal((await agent.executeTool('listHardwareTools', {})).total, 2);
    await agent.executeTool('describeHardwareTool', { name: params.name });
    assert.ok(agent.getRuntimeToolSchemas().some((t) => t.function.name === params.name));
    const action = agent.executeTool(
      params.name,
      { ...params.input, value: 0 },
      { callId: 'agent-write' },
    );
    let interaction;
    for (
      let i = 0;
      i < 100 && !(interaction = host.runtime.getSessionDetails(session.key).pendingInteraction);
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(interaction, 'Agent hardware writes require the shared approval flow');
    await call('interaction.answer', {
      sessionId: session.key,
      interactionId: interaction.id,
      revision: interaction.revision,
      response: true,
      operationId: crypto.randomUUID(),
    });
    assert.equal((await action).value, 0);
    assert.equal(
      (
        await agent.executeTool(
          params.name,
          { ...params.input, value: 0 },
          { callId: 'agent-write' },
        )
      ).value,
      0,
    );
    for (let i = 0; i < 100 && (diagnostic.match(/SIMULATED GPIO=/g) || []).length < 2; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((diagnostic.match(/SIMULATED GPIO=/g) || []).length, 2, diagnostic);
    agent._toolScope = new Set(['readFile']);
    assert.ok(!agent.getRuntimeToolSchemas().some((t) => t.function.name === params.name));
    await assert.rejects(
      agent.executeTool(params.name, params.input),
      (e) => e.data?.reason === 'FORBIDDEN',
    );
    console.log(
      'PASS: pure Node Mini -> authenticated WebSocket -> C Micro simulator; GPIO read/write + persistent deduplication',
    );
  } finally {
    socket?.terminate();
    child?.stdin.end();
    child?.kill();
    await host.close();
    await new Promise((r) => setTimeout(r, 30));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
