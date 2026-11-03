/* SPDX-License-Identifier: GPL-3.0-or-later */
// Actual shared GUI/WebUI components; public fixture addresses, no keys or RPC.
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
      platform: 'browser',
      format: 'iife',
      globalName: 'PortfolioPreview',
    });
    const win = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<main><h2>组合预算 · 隔离界面验收 / Public fixture data</h2><div id="settings-wallet"></div></main>',
          ),
      );
      await win.webContents.insertCSS(
        'html{background:#151b23;color:#eef2f7;font:14px system-ui}body{margin:0}main{padding:40px}button,input,textarea,select{font:inherit}',
      );
      for (const file of ['src/renderer/css/quant.css', 'src/renderer/css/wallet.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
      const native = nativeLimits(
        limits({
          maxTotalValueEth: '0.05',
          maxTotalFeeEth: '0.01',
          maxTransactions: 6,
          tokens: [
            {
              chainId: 8453,
              address: '0x' + '3'.repeat(40),
              symbol: 'USDC',
              decimals: 6,
              maxSignedAmount: '100',
            },
          ],
        }),
      );
      await win.webContents
        .executeJavaScript(`window.calls=[];window.wallets=[{id:'one',name:'研究钱包 · 测试',address:'0x'+'1'.repeat(40)},{id:'two',name:'执行钱包 · 测试',address:'0x'+'2'.repeat(40)}];window.group={portfolio:{id:'fixture-group',name:'双钱包执行预算 · 测试',chainId:8453,members:wallets.map(w=>({walletId:w.id,address:w.address})),limits:${JSON.stringify(native)},maxFeeWei:'10000000000000000',expiresAt:0},state:'active',revision:1,usage:{valueWei:'1000000000000000',feeWei:'300000000000000',transactions:3,tokens:{['eip155:8453/erc20:0x'+'3'.repeat(40)]:{transferAtoms:'12500000',approvalAtoms:'15000000',signatures:2}}}};
    window.panel=new PortfolioPreview.WalletPortfolioPanel({language:()=> 'zh-CN',wallets:()=>wallets,request:async(action,input)=>{calls.push({action,input});if(action==='portfolio.list')return{items:[{...group.portfolio,state:group.state,revision:group.revision}],total:1,next:null};if(action==='portfolio.get')return structuredClone(group);if(action==='portfolio.challenge')return{id:'fixture-challenge'};if(action==='portfolio.pause'){group.state='paused';group.revision++;return group;}if(action==='portfolio.confirm')return group;throw Error('Unexpected fixture action');}});true;`);
      async function theme(name) {
        const colors =
          name === 'dark'
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
                'text-tertiary': '#737d90',
                border: '#dce1ea',
                warning: '#ad7009',
                danger: '#bb3850',
              };
        await win.webContents.executeJavaScript(
          `Object.entries(${JSON.stringify(colors)}).forEach(([key,value])=>document.documentElement.style.setProperty('--'+key,value));new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`,
        );
      }
      async function shot(name) {
        await win.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        fs.mkdirSync('.cache/previews', { recursive: true });
        fs.writeFileSync(
          '.cache/previews/wallet-portfolio-' + name + '.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      await theme('dark');
      await win.webContents.executeJavaScript('panel.open()');
      await shot('list-dark');
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-create]').click();document.querySelector('[name=portfolio-name]').value='新的双钱包预算';document.querySelectorAll('[data-member]').forEach(n=>n.checked=true);document.querySelector('[name=limit-maxTransactions]').value='6';`,
      );
      await shot('create-dark');
      await win.webContents.executeJavaScript(
        `document.querySelector('dialog form').requestSubmit()`,
      );
      await new Promise((r) => setTimeout(r, 30));
      const challenge = await win.webContents.executeJavaScript(
        `calls.find(c=>c.action==='portfolio.challenge')`,
      );
      assert.deepEqual(challenge.input.walletIds, ['one', 'two']);
      assert.equal(challenge.input.limits.maxTransactions, '6');
      assert.equal(
        await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('form input,form select,form textarea')).filter(n=>n.name!=='portfolio-ack').every(n=>n.disabled)`,
        ),
        true,
      );
      assert.equal(
        await win.webContents.executeJavaScript(`calls.some(c=>c.action==='portfolio.confirm')`),
        false,
      );
      await win.webContents.executeJavaScript(
        `const ack=document.querySelector('[name=portfolio-ack]');ack.value='ALLOW PORTFOLIO';ack.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('dialog form').requestSubmit()`,
      );
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(
        await win.webContents.executeJavaScript(
          `calls.find(c=>c.action==='portfolio.confirm').input.ack`,
        ),
        'ALLOW PORTFOLIO',
      );
      await win.webContents.executeJavaScript(`document.querySelector('[data-detail]').click()`);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('.wallet-budget-row').length`,
        ),
        6,
      );
      assert.ok(
        await win.webContents.executeJavaScript(
          `document.querySelector('dialog').textContent.includes('27.5 / 100')`,
        ),
      );
      for (const name of ['dark', 'light']) {
        await theme(name);
        await shot('budget-' + name);
      }
      await win.webContents.executeJavaScript(`document.querySelector('[data-pause]').click()`);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(await win.webContents.executeJavaScript('group.state'), 'paused');
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-resume]').click();document.querySelector('dialog form').requestSubmit()`,
      );
      await new Promise((r) => setTimeout(r, 30));
      const state = await win.webContents.executeJavaScript(
        `calls.filter(c=>c.action==='portfolio.challenge').at(-1)`,
      );
      assert.equal(state.input.operation, 'active');
      assert.equal(state.input.revision, 2);
      assert.equal(
        await win.webContents.executeJavaScript(
          `calls.filter(c=>c.action==='portfolio.confirm').length`,
        ),
        1,
      );
      assert.ok(
        (await win.webContents.executeJavaScript(`calls.map(c=>c.action)`)).every((action) =>
          action.startsWith('portfolio.'),
        ),
      );
      console.log(
        'PASS: actual shared portfolio creation, named multi-wallet selection, frozen second confirmation, budget rendering, scoped pause and explicit resume review; light/dark screenshots, public fixture data.',
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
