/* SPDX-License-Identifier: GPL-3.0-or-later */
// Synthetic pairing metadata; no wallet keys, approvals or tokens leave the fixture.
'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const bundle = await require('esbuild').build({
      stdin: {
        contents: "export { WalletBrowserPanel } from './src/renderer/core/wallet-browser';",
        resolveDir: path.resolve('.'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'BrowserFixture',
    });
    const win = new BrowserWindow({
      width: 840,
      height: 880,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' + encodeURIComponent('<div id="settings-wallet"></div>'),
      );
      await win.webContents.insertCSS(
        'html{font:14px system-ui;background:var(--bg-primary);color:var(--text-primary)}body{margin:0}button,textarea{font:inherit}',
      );
      for (const file of ['src/renderer/css/quant.css', 'src/renderer/css/wallet.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await js(bundle.outputFiles[0].text);
      await js(`window.calls=[];window.fixture={state:'listening',enabled:true,error:null,fingerprint:'b91b'.repeat(16),clients:[],pending:[]};
      window.panel=new BrowserFixture.WalletBrowserPanel({language:()=> 'zh-CN',dialog:(title,html)=>{const d=document.createElement('dialog');d.className='quant-dialog wallet-dialog wallet-browser-dialog';d.innerHTML='<header><h2>'+title+'</h2><button data-close>×</button></header>'+html;document.body.append(d);d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();return d;},request:async(action,input={})=>{
        calls.push({action,input:structuredClone(input)});
        if(action==='browser.status')return structuredClone(fixture);
        if(action==='browser.pair')return {uri:'cibyp-wallet://pair#public-fixture',expiresAt:Date.now()+120000};
        if(action==='browser.confirm'){fixture.clients=[{...fixture.pending[0],revision:1}];fixture.pending=[];return fixture;}
        if(action==='browser.revoke'){fixture.clients[0].revoked=true;return fixture;}
        if(action==='browser.stop'){fixture.state='stopped';fixture.enabled=false;return fixture;}
        throw Error(action);
      }});
      window.act=async (action)=>{document.querySelector('[data-browser-action='+action+']').click();await new Promise(r=>setTimeout(r,20));};
      panel.open();`);
      await js("act('pair')");
      assert.match(await js("document.querySelector('[data-pair-uri]').value"), /^cibyp-wallet:/);
      await js(
        `fixture.pending=[{id:'public-pair',name:'研究浏览器 <example>',origin:'chrome-extension://'+'a'.repeat(32),fingerprint:'4a12'.repeat(16),digest:'frozen-review',expiresAt:Date.now()+120000}];act('refresh');`,
      );
      assert.equal(await js("document.querySelector('[data-pair-uri]')"), null);
      await js("act('review')");
      assert.equal(await js("calls.some(c=>c.action==='browser.confirm')"), false);
      assert.equal(await js('document.activeElement.dataset.browserAction'), 'deny');
      const css = (colors) =>
        js(
          `Object.entries(${JSON.stringify(colors)}).forEach(([k,v])=>document.documentElement.style.setProperty('--'+k,v));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))));`,
        );
      fs.mkdirSync('.cache/previews', { recursive: true });
      await css({
        'bg-primary': '#f8f9fb',
        'bg-secondary': '#fff',
        'text-primary': '#222633',
        'text-secondary': '#565e6e',
        'text-inverse': '#fff',
        border: '#dce1ea',
        accent: '#315ea8',
      });
      fs.writeFileSync(
        '.cache/previews/wallet-browser-review.png',
        (await win.webContents.capturePage()).toPNG(),
      );
      win.setContentSize(390, 770);
      await css({
        'bg-primary': '#151b23',
        'bg-secondary': '#1d2530',
        'text-primary': '#eef2f7',
        'text-secondary': '#b5bfcc',
        'text-inverse': '#151b23',
        border: '#364354',
        accent: '#80b8ff',
      });
      assert.equal(
        await js(
          "(()=>{const d=document.querySelector('dialog');return d.scrollWidth<=d.clientWidth;})()",
        ),
        true,
      );
      await js("act('confirm')");
      assert.deepEqual(await js("calls.find(c=>c.action==='browser.confirm').input"), {
        id: 'public-pair',
        digest: 'frozen-review',
        confirmed: true,
      });
      await js("act('revoke')");
      assert.deepEqual(await js("calls.find(c=>c.action==='browser.revoke').input"), {
        id: 'public-pair',
        revision: 1,
      });
      await js("act('stop')");
      assert.ok(await js("document.querySelector('[data-browser-action=start]') !== null"));
      await js("document.querySelector('[data-close]').click(); true");
      console.log(
        'PASS: shared wallet browser manager, ephemeral address, manual frozen identity review, revoke, stop, and narrow dark layout.',
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
