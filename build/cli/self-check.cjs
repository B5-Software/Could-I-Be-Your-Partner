/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Build-time smoke test: a private profile and host runtime, no user App or VM.
const path = require('node:path');
const resources = path.resolve(__dirname, '..');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');
const normalize = (file) => {
  const actual = fs.realpathSync(file);
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
};
const boundary = normalize(resources) + path.sep;
// A build in a repository must never borrow a missing module from the parent
// checkout. Exercise the same physical files available on a clean installation.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (
      result.url.startsWith('file:') &&
      !normalize(fileURLToPath(result.url)).startsWith(boundary)
    ) {
      throw new Error('PACKAGED_RUNTIME_ESCAPE: ' + specifier);
    }
    return result;
  },
});
process.env.CIBYP_PACKAGED_RESOURCES = resources;
process.resourcesPath = resources;
const { bootNodeRuntime, waitForRuntime } = require(
  path.join(resources, 'app.asar.unpacked/src/tui/node-entry.js'),
);
const main = bootNodeRuntime(['--headless']);
waitForRuntime(main, 30000)
  .then(async (runtime) => {
    if (!Array.isArray(runtime.listSessions())) throw new Error('Agent runtime unavailable');
    const { TuiApp } = require(path.join(resources, 'app.asar.unpacked/src/tui/app.js'));
    if (typeof TuiApp !== 'function') throw new Error('Packaged TUI unavailable');
    const { NativeEngine } = require(
      path.join(resources, 'app.asar.unpacked/src/main/services/quant/native-engine.js'),
    );
    const engine = new NativeEngine({
      directory: path.join(process.env.CIBYP_USER_DATA, 'quant-self-check'),
    });
    try {
      const status = await engine.start();
      if (status.development || status.protocol !== 1)
        throw Error('Packaged native runtime is not a managed verified resource');
      if ((await engine.call('status')).mode !== 'paper')
        throw Error('Unexpected native execution mode');
      const child = engine.child,
        exited = new Promise((resolve) => child.once('exit', resolve));
      await engine.stop();
      await exited;
    } finally {
      engine.dispose();
    }
    console.log('PACKAGED_QUANT_READY');
    const {WalletService}=require(path.join(resources,'app.asar.unpacked/src/main/services/wallet'));
    const wallet=new WalletService({directory:path.join(process.env.CIBYP_USER_DATA,'wallet-self-check')});
    try {
      const created=await wallet.request('create',{name:'Installation self-check',password:'temporary-self-check-'+require('node:crypto').randomUUID()});
      if(!created.address||created.unlocked)throw Error('Packaged native wallet self-check failed');
      const backup=await wallet.request('keystore.export',{id:created.id});
      if(JSON.parse(backup.text).header.format!=='CIBYP-WALLET')throw Error('Packaged wallet encryption unavailable');
    } finally {wallet.dispose();}
    console.log('PACKAGED_WALLET_READY');
    console.log('PACKAGED_RUNTIME_READY');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
