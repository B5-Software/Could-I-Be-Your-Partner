/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared GUI/WebUI components with public fixture data; no keys or RPC.
const { app, BrowserWindow } = require('electron'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const bundle = await require('esbuild').build({
      stdin: {
        contents:
          "export { WalletAppsPanel } from './src/renderer/core/wallet-apps';export { approvalCard } from './src/renderer/core/wallet-panel';",
        resolveDir: path.resolve('.'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'AppsPreview',
    });
    const win = new BrowserWindow({
      width: 1100,
      height: 960,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<main><h2>应用连接 · 隔离界面验收 / Public fixture data</h2></main><div id="settings-wallet"></div>',
          ),
      );
      await win.webContents.insertCSS(
        'html{font:14px system-ui;background:var(--bg-primary);color:var(--text-primary)}body{margin:0}main{padding:32px}button,input,select{font:inherit}',
      );
      for (const file of ['src/renderer/css/quant.css', 'src/renderer/css/wallet.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await js(bundle.outputFiles[0].text);
      await js(`window.calls=[];window.pending=[{id:'site-request',origin:'https://dex.example',expiresAt:Date.now()+120000}];window.connections=[];
      const request=async(action,input={})=>{
        calls.push({action,input:structuredClone(input)});
        if(action==='app.list')return{connections,pending};
        if(action==='list')return{wallets:[{id:'one',name:'研究钱包',address:'0x'+'1'.repeat(40)},{id:'two',name:'执行钱包',address:'0x'+'2'.repeat(40)}]};
        if(action==='network.list')return{items:[{key:'base',name:'Base',id:8453},{key:'evm-1337',name:'本地 EVM · 测试',id:1337}]};
        if(action==='app.allow'){
          connections=[{id:'connection',origin:pending[0].origin,walletId:input.walletId,chain:input.chain,revision:1,expiresAt:Date.now()+86400000}];
          pending=[];
          return connections[0];
        }
        if(action==='app.revoke'){connections=[];return{ok:true};}
        if(action==='app.probeNetwork')return {id:'frozen-probe',profile:{...pending[0].network,rpcOrigin:new URL(input.rpc).origin,genesisHash:'0x'+'a'.repeat(64),additionalFeeNative:input.additionalFeeNative,capabilities:{signType2:true}}};
        if(action==='app.addNetwork'){pending=[];return{ok:true};}
        throw Error('Unexpected '+action);
      };
      const dialog=(title,html)=>{
        const d=document.createElement('dialog');d.className='quant-dialog wallet-dialog';d.innerHTML='<header><h2>'+title+'</h2><button data-close>×</button></header>'+html;
        document.body.append(d);
        d.querySelector('[data-close]').onclick=()=>d.close();
        d.addEventListener('close',()=>d.remove(),{once:true});
        d.showModal();
        return d;
      };
      window.panel=new AppsPreview.WalletAppsPanel({language:()=> 'zh-CN',dialog,request});panel.open();`);
      await js(
        `document.querySelector('[name=wallet]').value='one';document.querySelector('[name=chain]').value='evm-1337';document.querySelector('form').requestSubmit();new Promise(r=>setTimeout(r,20));`,
      );
      assert.equal(await js(`calls.some(c=>c.action==='app.allow')`), false);
      assert.equal(
        await js(`Array.from(document.querySelectorAll('form select')).every(n=>n.disabled)`),
        true,
      );
      for (const dark of [false, true]) {
        const colors = dark
          ? {
              'bg-primary': '#151b23',
              'bg-secondary': '#1d2530',
              'text-primary': '#eef2f7',
              'text-secondary': '#b5bfcc',
              border: '#364354',
              accent: '#80b8ff',
            }
          : {
              'bg-primary': '#f8f9fb',
              'bg-secondary': '#fff',
              'text-primary': '#222633',
              'text-secondary': '#565e6e',
              border: '#dce1ea',
              accent: '#315ea8',
            };
        await js(
          `Object.entries(${JSON.stringify(colors)}).forEach(([k,v])=>document.documentElement.style.setProperty('--'+k,v));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))));`,
        );
        fs.mkdirSync('.cache/previews', { recursive: true });
        fs.writeFileSync(
          '.cache/previews/wallet-apps-review-' + (dark ? 'dark' : 'light') + '.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      await js(
        `document.querySelector('[name=wallet]').value='two';document.querySelector('[name=chain]').value='base';document.querySelector('form').requestSubmit();new Promise(r=>setTimeout(r,30));`,
      );
      const allowed = await js(`calls.find(c=>c.action==='app.allow').input`);
      assert.deepEqual(allowed, {
        id: 'site-request',
        walletId: 'one',
        chain: 'evm-1337',
        confirmed: true,
      });
      await js(`document.querySelector('[data-revoke]').click();new Promise(r=>setTimeout(r,30));`);
      assert.equal(await js(`calls.filter(c=>c.action==='app.revoke').length`), 1);
      const origin = await js(
        `(()=>{const html=AppsPreview.approvalCard({id:'site-intent',digest:'reviewed',status:'approval-required',chainId:1337,network:'Local EVM',sourceApp:{origin:'https://dex.example',connectionId:'connection'},valueEth:'0.001',executionFeeMaxWei:'21000',l1FeeEstimateWei:'0',description:{kind:'native-transfer'},transaction:{to:'0x'+'2'.repeat(40),data:'0x',value:'1000000000000000'}},'zh-CN');const n=document.createElement('div');n.innerHTML=html;return n.querySelector('.wallet-app-origin').textContent;})()`,
      );
      assert.ok(origin.includes('https://dex.example'));
      assert.equal(await js(`calls.some(c=>c.action==='intent.approve')`), false);
      await js(
        `document.querySelector('dialog[open]').close();pending=[{id:'proposed-chain',origin:'https://dex.example',expiresAt:Date.now()+120000,network:{id:7343,name:'Fixture Network',nativeSymbol:'TEST',rpcOrigins:['https://suggested.invalid']}}];panel.open();`,
      );
      assert.equal(await js(`document.querySelector('[name=rpc]').value`), '');
      await js(
        `document.querySelector('[name=rpc]').value='https://owner.invalid/rpc';document.querySelector('[data-network]').requestSubmit();new Promise(r=>setTimeout(r,30));`,
      );
      assert.equal(await js(`calls.some(c=>c.action==='app.addNetwork')`), false);
      assert.equal(await js(`document.querySelector('[name=rpc]').readOnly`), true);
      assert.match(
        await js(`document.querySelector('[data-network-review]').textContent`),
        /https:\/\/owner\.invalid/,
      );
      await js(
        `document.querySelector('[data-network]').requestSubmit();new Promise(r=>setTimeout(r,30));`,
      );
      assert.deepEqual(await js(`calls.find(c=>c.action==='app.addNetwork').input`), {
        id: 'proposed-chain',
        reviewId: 'frozen-probe',
        confirmed: true,
      });
      console.log(
        'PASS: shared site manager, frozen account and network review, independent trusted RPC, disconnect and trusted origin on financial approval. Public fixtures only.',
      );
    } finally {
      win.destroy();
    }
  })
  .then(
    () => app.quit(),
    (error) => {
      console.error(error.stack);
      app.exit(1);
    },
  );
