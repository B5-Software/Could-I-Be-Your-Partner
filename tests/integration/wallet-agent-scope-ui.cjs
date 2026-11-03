/* SPDX-License-Identifier: GPL-3.0-or-later */
const { app, BrowserWindow } = require('electron'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { limits, nativeLimits } = require('../../src/main/services/wallet/policy');
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const bundle = await require('esbuild').build({
      stdin: {
        contents:
          "export {WalletPanel} from './src/renderer/core/wallet-panel'; export {WalletAgentScopePanel} from './src/renderer/core/wallet-agent-scopes';",
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'ScopePreview',
    });
    const win = new BrowserWindow({
      width: 1200,
      height: 960,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const settle = () => new Promise((r) => setTimeout(r, 40));
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<main style="padding:36px"><h2>Agent 签名范围 · 界面验收 / Public fixture data</h2><div id="settings-wallet"></div></main>',
          ),
      );
      await win.webContents.insertCSS(
        'html{background:var(--bg-primary,#151b23);color:var(--text-primary,#eef2f7);font:14px system-ui}body{margin:0}button,input,textarea,select{font:inherit}',
      );
      for (const file of ['src/renderer/css/quant.css', 'src/renderer/css/wallet.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await js(bundle.outputFiles[0].text);
      const rules = nativeLimits(
        limits({ maxTransactions: 6, maxTotalValueEth: '0.05', maxTotalFeeEth: '0.01' }),
      );
      await js(`window.calls=[];window.current={scope:{id:'child',subject:'native-sub-public-fixture',label:'执行子任务 · 测试范围',parentId:'root',chainId:8453,walletIds:['wallet-fixture'],limits:${JSON.stringify(rules)},maxFeeWei:'1000000000000000',expiresAt:0},state:'active',revision:1,ready:true,reason:null,path:['child','root'],usage:{valueWei:'1000000000000000',feeWei:'90000000000000',transactions:3,tokens:{}}};
    window.request=async(action,input={})=>{calls.push({action,input});if(action==='list')return {wallets:[],intents:[]};if(action==='history')return {items:[],total:0,next:null};if(action==='scope.list')return {items:[{...current.scope,state:current.state}],total:1,next:null};if(action==='scope.get')return structuredClone(current);if(action==='scope.pause'){current.state='paused';current.ready=false;current.reason='WALLET_AGENT_SCOPE_PAUSED';current.revision++;return structuredClone(current);}if(action==='scope.challenge')return {id:'frozen-challenge',snapshot:structuredClone(current)};if(action==='scope.confirm'){current.state='active';current.ready=true;current.reason=null;return structuredClone(current);}throw Error('Unexpected fixture action '+action);};
    window.walletPanel=new ScopePreview.WalletPanel({request,subscribe:()=>{},language:()=> 'zh-CN'});true;`);
      await js('walletPanel.refresh()');
      assert.equal(
        await js(`!!document.querySelector('[data-wallet-action="agent-scopes"]')`),
        true,
      );
      await js(`document.querySelector('[data-wallet-action="agent-scopes"]').click()`);
      await settle();
      await js(`document.querySelector('[data-scope]').click()`);
      await settle();
      assert.equal(await js(`document.querySelectorAll('.wallet-budget-row').length`), 3);
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('[data-editor] input,[data-editor] select,[data-editor] textarea')).every(n=>n.disabled)`,
        ),
        true,
      );
      const shot = async (name) => {
        await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
        fs.mkdirSync('.cache/previews', { recursive: true });
        fs.writeFileSync(
          '.cache/previews/wallet-agent-scope-' + name + '.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      };
      for (const dark of [true, false]) {
        const colors = dark
          ? {
              'bg-primary': '#151b23',
              'bg-secondary': '#1d2530',
              'text-primary': '#eef2f7',
              'text-secondary': '#b5bfcc',
              'text-tertiary': '#96a3b5',
              border: '#364354',
              warning: '#f0b85e',
              danger: '#ff8797',
            }
          : {
              'bg-primary': '#f8f9fb',
              'bg-secondary': '#ffffff',
              'text-primary': '#222633',
              'text-secondary': '#565e6e',
              'text-tertiary': '#727c8c',
              border: '#d8dee8',
              warning: '#866000',
              danger: '#ad243c',
            };
        await js(
          `Object.entries(${JSON.stringify(colors)}).forEach(([k,v])=>document.documentElement.style.setProperty('--'+k,v));document.documentElement.style.setProperty('--accent-color',${JSON.stringify(dark ? '#8da7ff' : '#435ac8')});true;`,
        );
        await shot(dark ? 'dark' : 'light');
      }
      await js(`document.querySelector('[data-pause]').click()`);
      await settle();
      assert.equal(await js('current.state'), 'paused');
      await js(`document.querySelector('[data-confirm=active]').click()`);
      await settle();
      assert.equal(await js(`document.querySelector('form [type=submit]').disabled`), true);
      assert.equal(await js(`calls.filter(c=>c.action==='scope.confirm').length`), 0);
      await js(
        `const input=document.querySelector('[name=ack]');input.value='ALLOW AGENT SCOPE';input.dispatchEvent(new Event('input'));document.querySelector('form').requestSubmit()`,
      );
      await settle();
      assert.equal(
        await js(`calls.find(c=>c.action==='scope.confirm').input.ack`),
        'ALLOW AGENT SCOPE',
      );
      assert.equal(await js('current.ready'), true);
      console.log(
        'PASS: actual Wallet settings entry, immutable inherited scope, usage and themed progress, pause, frozen human-only resume, dark/light screenshots. No keys or RPC.',
      );
    } finally {
      win.destroy();
    }
  })
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
