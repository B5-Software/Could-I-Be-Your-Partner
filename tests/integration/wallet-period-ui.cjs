/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared GUI/WebUI components with public, nonfinancial fixtures.
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
      entryPoints: [path.resolve('src/renderer/core/wallet-portfolios.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      globalName: 'PeriodPreview',
    });
    const win = new BrowserWindow({
        width: 1240,
        height: 1100,
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true },
      }),
      js = (s) => win.webContents.executeJavaScript(s),
      settle = () => new Promise((r) => setTimeout(r, 40));
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<main style="padding:40px"><h2>周期预算与调整 · Public fixture data</h2></main>',
          ),
      );
      await win.webContents.insertCSS(
        'html{background:var(--bg-primary,#151b23);color:var(--text-primary,#eef2f7);font:14px system-ui}button,input,select,textarea{font:inherit}',
      );
      for (const file of ['src/renderer/css/quant.css', 'src/renderer/css/wallet.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await js(bundle.outputFiles[0].text);
      const native = nativeLimits(
        limits({
          maxTransactions: 10,
          maxTotalValueEth: '0.05',
          maxTotalFeeEth: '0.02',
          period: {
            seconds: 3600,
            maxTransactions: 3,
            maxTotalValueEth: '0.02',
            maxTotalFeeEth: '0.005',
          },
        }),
      );
      await js(`window.calls=[];window.group={portfolio:{id:'fixture-period-group',name:'连续执行 · 周期与累计预算',chainId:8453,members:[{walletId:'fixture-wallet',address:'0x'+'1'.repeat(40)}],limits:${JSON.stringify(native)},maxFeeWei:'1000000000000000',expiresAt:0},state:'active',revision:1,usage:{valueWei:'18000000000000000',feeWei:'60000000000000',transactions:7,tokens:{}},period:{identity:{kind:'portfolio',id:'fixture-period-group'},seconds:3600,originMs:Date.now()-4500000,startMs:Date.now()-900000,endMs:Date.now()+2700000,clockRollback:false,limits:${JSON.stringify(native.period)},usage:{valueWei:'10000000000000000',feeWei:'20000000000000',transactions:2,tokens:{}}}};
    window.original=structuredClone(group);window.frozen=null;
    window.panel=new PeriodPreview.WalletPortfolioPanel({language:()=> 'zh-CN',wallets:()=>[{id:'fixture-wallet',name:'执行钱包 · 测试',address:'0x'+'1'.repeat(40)}],request:async(action,input={})=>{calls.push({action,input:structuredClone(input)});if(action==='portfolio.get')return structuredClone(group);if(action==='portfolio.list')return{items:[{...group.portfolio,state:group.state,revision:group.revision}],total:1,next:null};if(action==='portfolio.challenge'){frozen=structuredClone(input);return{id:'frozen-period-review'};}if(action==='portfolio.confirm'){group.revision++;return structuredClone(group);}if(action==='period.history')return{items:[{startMs:group.period.startMs,endMs:group.period.endMs,limits:group.period.limits,usage:group.period.usage},{startMs:group.period.startMs-3600000,endMs:group.period.startMs,limits:group.period.limits,usage:{valueWei:'8000000000000000',feeWei:'40000000000000',transactions:3,tokens:{}}}],total:2,next:null};if(action==='portfolio.revisions')return{items:[{revision:2,name:group.portfolio.name,kind:'edit',state:'active',changedAt:Date.now()},{revision:1,name:original.portfolio.name,kind:'create',state:'active',changedAt:Date.now()-5000000}],total:2,next:null};if(action==='portfolio.revision')return{portfolio:original.portfolio,changedAt:Date.now()-5000000,kind:'create'};throw Error('Unexpected '+action);}});true;`);
      await js(`panel.detail('fixture-period-group')`);
      assert.equal(await js(`document.querySelectorAll('.wallet-budget-row').length`), 6);
      assert.equal(await js(`document.querySelector('[data-period-history]')!==null`), true);
      const theme = async (dark) => {
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
      };
      const shot = async (name) => {
        await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
        fs.mkdirSync('.cache/previews', { recursive: true });
        fs.writeFileSync(
          '.cache/previews/wallet-period-' + name + '.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      };
      for (const dark of [true, false]) {
        await theme(dark);
        await shot(dark ? 'budget-dark' : 'budget-light');
      }
      await js(`document.querySelector('[data-edit]').click()`);
      assert.equal(
        await js(
          `document.querySelector('[name=period-enabled]').disabled&&document.querySelector('[name=period-preset]').disabled`,
        ),
        true,
      );
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('[data-member]')).every(n=>n.checked&&n.disabled)`,
        ),
        true,
      );
      await js(
        `document.querySelector('[name=period-maxTransactions]').value='4';document.querySelector('[name=limit-maxTransactions]').value='12';document.querySelector('form').requestSubmit()`,
      );
      await settle();
      assert.equal(await js('frozen.operation'), 'edit');
      assert.equal(await js('frozen.limits.period.maxTransactions'), '4');
      assert.equal(await js('frozen.limits.period.seconds'), 3600);
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('form input,form select,form textarea')).filter(n=>n.name!=='portfolio-ack').every(n=>n.disabled)`,
        ),
        true,
      );
      assert.equal(await js(`calls.some(c=>c.action==='portfolio.confirm')`), false);
      await shot('review-light');
      await js(
        `const ack=document.querySelector('[name=portfolio-ack]');ack.value='ALLOW PORTFOLIO';ack.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()`,
      );
      await settle();
      assert.equal(
        await js(`calls.find(c=>c.action==='portfolio.confirm').input.ack`),
        'ALLOW PORTFOLIO',
      );
      await js(
        `document.querySelectorAll('dialog').forEach(d=>d.close());panel.detail('fixture-period-group')`,
      );
      await settle();
      await js(`document.querySelector('[data-period-history]').click()`);
      await settle();
      assert.equal(await js(`document.querySelectorAll('.wallet-budget-row').length`), 6);
      await shot('history-light');
      await js(
        `document.querySelectorAll('dialog').forEach(d=>d.close());panel.revisions('fixture-period-group')`,
      );
      await settle();
      assert.equal(await js(`document.querySelectorAll('[data-revision]').length`), 2);
      await js(`document.querySelector('[data-revision="1"]').click()`);
      await settle();
      assert.equal(
        await js(
          `Array.from(document.querySelector('dialog:last-of-type [data-scope]').querySelectorAll('input,textarea,select')).every(n=>n.disabled)`,
        ),
        true,
      );
      console.log(
        'PASS: shared periodic/lifetime cards, stable schedule and member identity, frozen edit confirmation, bounded period history and immutable revision detail; light/dark screenshots. Public fixtures, no keys/RPC.',
      );
    } finally {
      win.destroy();
    }
  })
  .then(() => app.quit())
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
