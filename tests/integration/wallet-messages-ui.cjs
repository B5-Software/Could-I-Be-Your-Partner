/* SPDX-License-Identifier: GPL-3.0-or-later */
// Actual shared GUI/WebUI component with public fixtures, no signing keys.
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
        contents: "export {WalletMessagesPanel} from './src/renderer/core/wallet-messages';",
        resolveDir: path.resolve('.'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'MessagePreview',
    });
    const win = new BrowserWindow({
      width: 1120,
      height: 1020,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<main><h2>消息签名 · 隔离界面验收 / Public fixture data</h2></main>'),
      );
      await win.webContents.insertCSS(
        'html{font:14px system-ui;background:var(--bg-primary);color:var(--text-primary)}body{margin:0}main{padding:32px}button,input,select{font:inherit}',
      );
      for (const file of ['src/renderer/css/quant.css', 'src/renderer/css/wallet.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await js(bundle.outputFiles[0].text);
      await js(
        `window.calls=[];window.record={id:'public-message',reviewDigest:'frozen-review',status:'approval-required',address:'0x'+'1'.repeat(40),expiresAt:Date.now()+300000,digest:'0x'+'a'.repeat(64),message:{kind:'typed',origin:'https://dex.example',chainId:1337,payload:'{}'},preview:{types:{Order:[{name:'recipient',type:'address'},{name:'amount',type:'uint256'},{name:'memo',type:'string'}]},primaryType:'Order',domain:{name:'Public fixture exchange',chainId:1337,verifyingContract:'0x'+'2'.repeat(40)},message:{recipient:'0x'+'3'.repeat(40),amount:'123456789012345678901234567890',memo:'<script data-injected>unsafe</script>'}}};window.panel=new MessagePreview.WalletMessagesPanel({language:()=> 'zh-CN',request:async(action,input={})=>{calls.push({action,input:structuredClone(input)});if(action==='message.get')return structuredClone(record);if(action==='message.list')return{items:[],total:0,next:null};if(action==='message.approve'){record.status='approved';return record;}if(action==='message.reconcile')return record;throw Error('Unexpected '+action);},dialog:(title,html)=>{const d=document.createElement('dialog');d.className='quant-dialog wallet-dialog';d.innerHTML='<header><h2>'+title+'</h2><button data-close>×</button></header>'+html;document.body.append(d);d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();return d;}});panel.review(record.id);`,
      );
      assert.equal(await js(`document.querySelectorAll('script[data-injected]').length`), 0);
      assert.equal(
        await js(
          `document.querySelector('[data-message-content]').textContent.includes('<script data-injected>')`,
        ),
        true,
      );
      assert.equal(
        await js(
          `document.querySelector('.wallet-app-origin').textContent.includes('https://dex.example')`,
        ),
        true,
      );
      assert.equal(
        await js(`document.body.textContent.includes('123456789012345678901234567890')`),
        true,
      );
      await js(`document.querySelector('[data-sign]').click();new Promise(r=>setTimeout(r,20));`);
      assert.equal(await js(`calls.some(c=>c.action==='message.approve')`), false);
      fs.mkdirSync('.cache/previews', { recursive: true });
      for (const dark of [false, true]) {
        const colors = dark
          ? {
              'bg-primary': '#151b23',
              'bg-secondary': '#1d2530',
              'text-primary': '#eef2f7',
              'text-secondary': '#b5bfcc',
              'text-tertiary': '#b5bfcc',
              border: '#364354',
              accent: '#80b8ff',
              danger: '#ff9f9f',
              warning: '#e4bc72',
            }
          : {
              'bg-primary': '#f8f9fb',
              'bg-secondary': '#fff',
              'text-primary': '#222633',
              'text-secondary': '#565e6e',
              'text-tertiary': '#565e6e',
              border: '#dce1ea',
              accent: '#315ea8',
              danger: '#a33131',
              warning: '#956112',
            };
        await js(
          `Object.entries(${JSON.stringify(colors)}).forEach(([k,v])=>document.documentElement.style.setProperty('--'+k,v));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))));`,
        );
        fs.writeFileSync(
          '.cache/previews/wallet-messages-' + (dark ? 'dark' : 'light') + '.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      await js(
        `record.reviewDigest='tampered-after-review';document.querySelector('[data-sign]').click();new Promise(r=>setTimeout(r,20));`,
      );
      assert.deepEqual(await js(`calls.find(c=>c.action==='message.approve').input`), {
        id: 'public-message',
        digest: 'frozen-review',
        confirmed: true,
      });
      await js(`record.status='signed-withheld';panel.review(record.id);`);
      assert.equal(await js(`!!document.querySelector('[data-sign]')`), false);
      await js(
        `document.querySelector('[data-reconcile]').click();new Promise(r=>setTimeout(r,20));`,
      );
      assert.equal(await js(`calls.filter(c=>c.action==='message.approve').length`), 1);
      win.setSize(390, 844);
      await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))));`);
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true);
      assert.equal(
        await js(
          `(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`,
        ),
        true,
      );
      console.log(
        'PASS: shared message review, trusted origin, full-width amounts, escaped external content, frozen two-step confirmation, metadata-only recovery, narrow/light/dark layouts.',
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
