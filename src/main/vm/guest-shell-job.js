/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
// The detached guest supervisor keeps each stream bounded on disk as well as in
// the returned tool result. Its process group includes every spawned descendant.
const fs = require('node:fs').promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const [root, cwd] = process.argv.slice(2);
const LIMIT = 64 * 1024;
const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
let dirty = false;
let chain = Promise.resolve();

function flush() {
  if (!dirty) return chain;
  dirty = false;
  const snapshot = { ...output };
  chain = chain.then(async () => {
    for (const key of ['stdout', 'stderr']) {
      const file = path.join(root, key);
      await fs.writeFile(file + '.tmp', snapshot[key]);
      await fs.rename(file + '.tmp', file);
    }
  });
  return chain;
}

async function run() {
  const child = spawn('bash', [path.join(root, 'script.sh')], {
    cwd,
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const key of ['stdout', 'stderr'])
    child[key].on('data', (chunk) => {
      output[key] = Buffer.concat([output[key], chunk]).subarray(-LIMIT);
      dirty = true;
    });
  const timer = setInterval(() => {
    flush().catch((error) => {
      console.error(error.message);
      child.kill();
    });
  }, 100);
  // close, rather than exit, also waits for pipes held by an explicitly
  // backgrounded process. The Agent has already been released by the launcher.
  const code = await new Promise((resolve, reject) => {
    child.once('close', (value) => resolve(value));
    child.once('error', reject);
  }).finally(() => clearInterval(timer));
  await flush();
  await fs.writeFile(path.join(root, 'exit'), String(code ?? 1));
}
run().catch(async (error) => {
  try {
    await fs.writeFile(path.join(root, 'stderr'), error.message);
    await fs.writeFile(path.join(root, 'exit'), '1');
  } catch {
    /* guest filesystem unavailable */
  }
  process.exitCode = 1;
});
