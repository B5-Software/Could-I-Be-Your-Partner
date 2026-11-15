/* SPDX-License-Identifier: GPL-3.0-or-later */
// Actual shared GUI/WebUI components; synthetic profiles, no keys or network.
const { app, BrowserWindow } = require('electron'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const result = await require('esbuild').build({
      stdin: {
        contents:
          "export {WalletNetworkPanel} from './src/renderer/core/wallet-networks';export {approvalCard} from './src/renderer/core/wallet-panel';",
        resolveDir: path.resolve('.'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'NetworkPreview',
    });
    const win = new BrowserWindow({
      width: 1180,
      height: 950,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<main><h2>钱包网络 · 隔离界面验收 / Public fixture data</h2><div id="settings-wallet"></div></main>',
          ),
      );
      await win.webContents.insertCSS(
        'html{font:14px system-ui;background:var(--bg-primary);color:var(--text-primary)}body{margin:0}main{padding:32px}button,input,select{font:inherit}',
      );
      for (const file of ['src/renderer/css/quant.css', 'src/renderer/css/wallet.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await win.webContents.executeJavaScript(result.outputFiles[0].text);
      await win.webContents
        .executeJavaScript(`window.calls=[];window.errors=[];window.lang='zh-CN';window.refreshes=0;
      window.profile={key:'evm-1337',id:1337,name:'本地 EVM · 测试',nativeSymbol:'TEST',rpcOrigin:'https://rpc.example',rpc:'https://rpc.example/fixture-provider-path',additionalFeeNative:'0.00002',revision:1,builtin:false,archived:false,genesisHash:'0x'+'a'.repeat(64),capabilities:{signType2:true}};
      const publicProfile=()=>{const {rpc,...safe}=profile;return safe;};
      const base={key:'base',id:8453,name:'Base',nativeSymbol:'ETH',rpcOrigin:'https://mainnet.base.org',additionalFeeNative:'0',revision:1,builtin:true,archived:false,genesisHash:null,capabilities:{signType2:true}};
      window.panel=new NetworkPreview.WalletNetworkPanel({language:()=>lang,reportError:error=>errors.push(String(error)),refresh:async()=>{refreshes++;},dialog:(title,html)=>{const d=document.createElement('dialog');d.className='quant-dialog wallet-dialog';d.innerHTML='<header><h2>'+title+'</h2><button data-close>×</button></header>'+html;document.body.append(d);d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();return d;},request:async(action,input={})=>{
        calls.push({action,input:structuredClone(input)});
        if(action==='network.list')return {items:[base,publicProfile()]};
        if(action==='network.config')return structuredClone(profile);
        if(action==='network.challenge'){await new Promise(resolve=>window.resolveProbe=resolve);return {id:'fixture-review',profile:{...publicProfile(),name:input.name}};}
        if(action==='network.confirm'){profile.revision++;return publicProfile();}
        if(action==='transaction.prepare')return {id:'fixture-intent',status:'approval-required'};
        throw Error('Unexpected action '+action);
      }});true;`);
      async function theme(dark) {
        const colors = dark
          ? {
              'bg-primary': '#151b23',
              'bg-secondary': '#1d2530',
              'text-primary': '#eef2f7',
              'text-secondary': '#b5bfcc',
              border: '#364354',
              warning: '#f0b85e',
            }
          : {
              'bg-primary': '#f8f9fb',
              'bg-secondary': '#fff',
              'text-primary': '#222633',
              'text-secondary': '#565e6e',
              border: '#dce1ea',
              warning: '#ad7009',
            };
        await win.webContents.executeJavaScript(
          `Object.entries(${JSON.stringify(colors)}).forEach(([k,v])=>document.documentElement.style.setProperty('--'+k,v));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`,
        );
      }
      async function shot(name) {
        await win.webContents.executeJavaScript(
          'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))',
        );
        fs.mkdirSync('.cache/previews', { recursive: true });
        fs.writeFileSync(
          '.cache/previews/wallet-networks-' + name + '.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      await win.webContents.executeJavaScript('panel.open()');
      for (const dark of [false, true]) {
        await theme(dark);
        await shot(dark ? 'list-dark' : 'list-light');
      }
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-edit="evm-1337"]').click();new Promise(r=>setTimeout(r,20))`,
      );
      assert.equal(
        await win.webContents.executeJavaScript('document.querySelector("[name=id]").readOnly'),
        true,
      );
      await win.webContents.executeJavaScript(
        `document.querySelector('dialog form').requestSubmit();new Promise(r=>setTimeout(r,20))`,
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('dialog input')).every(n=>n.disabled)`,
        ),
        true,
      );
      assert.equal(
        await win.webContents.executeJavaScript(`calls.some(c=>c.action==='network.confirm')`),
        false,
      );
      await win.webContents.executeJavaScript('resolveProbe();new Promise(r=>setTimeout(r,20))');
      assert.match(
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-review]').textContent`,
        ),
        /1337 · TEST/,
      );
      for (const dark of [false, true]) {
        await theme(dark);
        await shot(dark ? 'review-dark' : 'review-light');
      }
      await win.webContents.executeJavaScript(
        `document.querySelector('dialog form').requestSubmit();new Promise(r=>setTimeout(r,20))`,
      );
      assert.deepEqual(
        await win.webContents.executeJavaScript(
          `calls.find(c=>c.action==='network.confirm').input`,
        ),
        { challengeId: 'fixture-review', ack: 'SAVE NETWORK', confirmed: true },
      );
      await win.webContents.executeJavaScript(
        `document.querySelectorAll('dialog[open]').forEach(d=>d.close());panel.send({id:'wallet-fixture',name:'测试钱包',unlocked:true})`,
      );
      await win.webContents.executeJavaScript(
        `const form=document.querySelector('dialog form');form.elements.chain.value='evm-1337';form.elements.to.value='0x'+'2'.repeat(40);form.elements.value.value='0.1';form.requestSubmit();new Promise(r=>setTimeout(r,20))`,
      );
      assert.deepEqual(
        await win.webContents.executeJavaScript(
          `calls.find(c=>c.action==='transaction.prepare').input`,
        ),
        { id: 'wallet-fixture', chain: 'evm-1337', to: '0x' + '2'.repeat(40), value: '0.1' },
      );
      assert.equal(
        await win.webContents.executeJavaScript(`calls.some(c=>c.action==='intent.approve')`),
        false,
      );
      const card = await win.webContents.executeJavaScript(
        `(()=>{const intent={id:'fixture',walletId:'wallet-fixture',address:'0x'+'1'.repeat(40),digest:'fixture-digest',status:'approval-required',chainId:1337,network:'本地 EVM',nativeSymbol:'TEST',valueEth:'0.1',executionFeeMaxWei:'1000000000000',l1FeeEstimateWei:'0',additionalFeeReserveWei:'20000000000000',transaction:{to:'0x'+'2'.repeat(40),value:'100000000000000000',data:'0x'},description:{kind:'native-transfer'},authorization:{mode:'manual'},createdAt:0};const d=document.createElement('div');d.innerHTML=NetworkPreview.approvalCard(intent,'zh-CN');return {text:d.textContent,blocked:NetworkPreview.approvalCard({...intent,networkBlocked:true},'zh-CN')};})()`,
      );
      assert.match(card.text, /1337/);
      assert.match(card.text, /TEST 数额/);
      assert.match(card.text, /额外预留（TEST）/);
      assert.match(card.text, /0\.000021/);
      assert.doesNotMatch(card.blocked, /data-wallet-decision="approve"/);
      assert.deepEqual(await win.webContents.executeJavaScript('errors'), []);
      console.log(
        'PASS: shared EVM network list and frozen review, explicit save, manual transaction preparation without approval, native currency/fee labels, stale-network approval blocking; light/dark screenshots with synthetic profiles.',
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
