/* SPDX-License-Identifier: GPL-3.0-or-later */
// Actual shared GUI/WebUI component. Public fixture addresses; no keys or RPC.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const bundle = await require('esbuild').build({
      entryPoints: [path.resolve('src/renderer/core/wallet-panel.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'WalletPreview',
    });
    const win = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    try {
      await win.loadURL(
        'data:text/html,<html lang="zh-CN"><meta charset="utf-8"><main><h2>确认替换交易</h2><section id="preview"></section></main><section id="settings-wallet" hidden></section></html>',
      );
      await win.webContents.insertCSS(
        'body{margin:0;background:var(--bg-primary);color:var(--text-primary);font:14px "Segoe UI",sans-serif}main{max-width:680px;margin:55px auto}h2{font-size:22px;margin:0 0 22px}',
      );
      await win.webContents.insertCSS(fs.readFileSync('src/renderer/css/quant.css', 'utf8'));
      await win.webContents.insertCSS(fs.readFileSync('src/renderer/css/wallet.css', 'utf8'));
      await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
      await win.webContents
        .executeJavaScript(`window.calls=[];window.fixture={id:'preview-only',digest:'fixture-digest',status:'approval-required',network:'Base · 本地测试预览',chainId:8453,replacementOf:'0x'+'a'.repeat(64),transaction:{type:2,chainId:8453,nonce:7,to:'0x'+'2'.repeat(40),value:'1000000000000000',data:'0x',gasLimit:'25200',maxFeePerGas:'10000000',maxPriorityFeePerGas:'1000000'},valueEth:'0.001',description:{kind:'native-transfer'},expiresAt:Date.now()+60000,executionFeeMaxWei:'252000000000',l1FeeEstimateWei:'1000000000'};
      window.panel=new WalletPreview.WalletPanel({language:()=> 'zh-CN',subscribe:()=>{},request:async(action,input)=>{calls.push({action,input});if(action==='list')return{wallets:[],intents:[]};if(action==='history')return{items:[],total:0,next:null};if(action==='policy.challenge')return{id:'scope-fixture-challenge'};if(action==='policy.usage')return{revoked:false,expiresAt:0,limits:{maxTotalValueWei:'100000000000000000',maxTotalFeeWei:'20000000000000000',maxTransactions:20,tokens:[{chainId:8453,address:'0x'+'3'.repeat(40),symbol:'USDC',decimals:6,maxSignedAtoms:'100000000'}]},usage:{valueWei:'1000000000000000',feeWei:'300000000000000',transactions:3,tokens:{['eip155:8453/erc20:0x'+'3'.repeat(40)]:{transferAtoms:'12500000',approvalAtoms:'15000000',signatures:2}}}};return{};}});
      document.querySelector('#preview').innerHTML=WalletPreview.approvalCard(fixture,'zh-CN');`);
      for (const [name, variables] of Object.entries({
        light: {
          'bg-primary': '#f8f9fb',
          'bg-secondary': '#ffffff',
          'text-primary': '#222633',
          'text-secondary': '#565e6e',
          'text-tertiary': '#737d90',
          border: '#dce1ea',
          warning: '#ad7009',
          danger: '#bb3850',
        },
        dark: {
          'bg-primary': '#151b23',
          'bg-secondary': '#1d2530',
          'text-primary': '#eef2f7',
          'text-secondary': '#b5bfcc',
          'text-tertiary': '#96a3b5',
          border: '#364354',
          warning: '#f0b85e',
          danger: '#ff8797',
        },
      })) {
        await win.webContents.executeJavaScript(
          `Object.entries(${JSON.stringify(variables)}).forEach(([name,value])=>document.documentElement.style.setProperty('--'+name,value))`,
        );
        await win.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        const image = await win.webContents.capturePage();
        fs.mkdirSync('.cache/previews', { recursive: true });
        fs.writeFileSync('.cache/previews/wallet-native-approval-' + name + '.png', image.toPNG());
      }
      const dimensions = await win.webContents.executeJavaScript(
        `(()=>{const a=document.querySelector('article').getBoundingClientRect(),b=document.querySelector('[data-wallet-decision=approve]').getBoundingClientRect();return{card:a.toJSON(),button:b.toJSON(),scroll:document.documentElement.scrollWidth,width:innerWidth,visible:document.body.textContent.includes('nonce')};})()`,
      );
      assert.ok(dimensions.visible);
      assert.ok(dimensions.button.right <= dimensions.card.right);
      assert.ok(dimensions.scroll <= dimensions.width);
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-wallet-decision=approve]').click()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sent = await win.webContents.executeJavaScript(
        'calls.find(call=>call.action==="intent.approve")',
      );
      assert.deepEqual(sent.input, {
        id: 'preview-only',
        digest: 'fixture-digest',
        replacementOf: '0x' + 'a'.repeat(64),
      });
      await win.webContents
        .executeJavaScript(`panel.authorization({id:'scope-fixture',address:'0x'+'2'.repeat(40),policy:{mode:'manual',chains:[]}});document.querySelector('.wallet-policy-limits').open=true;
        for(const [name,value] of Object.entries({maxValueEth:'0.01',maxTotalValueEth:'0.1',maxTotalFeeEth:'0.02',maxTransactions:'20',targets:'0x'+'2'.repeat(40)}))document.querySelector('[name="limit-'+name+'"]').value=value;
        document.querySelector('[name="limit-allowReplacement"]').checked=true;`);
      await win.webContents.executeJavaScript(
        `const preset=document.querySelector('.wallet-token-add select');preset.value='0';preset.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-token-field=maxSignedAmount]').value='100';document.querySelector('[data-token-field=maxApprovalAmount]').value='20';`,
      );
      for (const [name, selector] of [
        ['scope', '[name="limit-maxValueEth"]'],
        ['scope-details', '[name="limit-allowReplacement"]'],
        ['tokens', '[data-token-field=maxSignedAmount]'],
      ]) {
        await win.webContents.executeJavaScript(
          `document.querySelector('${selector}').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`,
        );
        fs.writeFileSync(
          '.cache/previews/wallet-native-' + name + '-dark.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      await win.webContents.executeJavaScript(
        `document.querySelector('.wallet-policy-dialog form').requestSubmit()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const scope = await win.webContents.executeJavaScript(
        'calls.find(call=>call.action==="policy.challenge")',
      );
      const switchSize = await win.webContents.executeJavaScript(
        `(()=>{const rect=document.querySelector('[name="limit-allowReplacement"]').getBoundingClientRect();return {width:rect.width,height:rect.height};})()`,
      );
      assert.ok(
        switchSize.width >= switchSize.height * 1.5,
        'The toggle must remain a horizontal switch',
      );
      assert.equal(scope.input.limits.maxTotalValueEth, '0.1');
      assert.equal(scope.input.limits.allowReplacement, true);
      assert.equal(scope.input.limits.tokens[0].symbol, 'USDC');
      assert.equal(scope.input.limits.tokens[0].maxSignedAmount, '100');
      assert.equal(scope.input.limits.tokens[0].decimals, 6);
      assert.equal(
        await win.webContents.executeJavaScript(
          `document.querySelector('[name="limit-allowReplacement"]').disabled`,
        ),
        true,
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.wallet-token-editor input,.wallet-token-editor button,.wallet-token-editor select,.wallet-token-editor textarea')).every(node=>node.disabled)`,
        ),
        true,
      );
      assert.equal(
        await win.webContents.executeJavaScript(`calls.some(call=>call.action==='policy.grant')`),
        false,
      );
      await win.webContents.executeJavaScript(
        `const ack=document.querySelector('.wallet-policy-dialog [name=ack]');ack.value='ALLOW LIVE';ack.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.wallet-policy-dialog form').requestSubmit()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        await win.webContents.executeJavaScript(
          `calls.some(call=>call.action==='policy.grant'&&call.input.challengeId==='scope-fixture-challenge')`,
        ),
        true,
      );
      console.log(
        'PASS: actual shared approval card, light/dark layout and explicit replacement hash binding. Public fixtures only.',
      );
      await win.webContents.executeJavaScript(
        `panel.action({dataset:{walletAction:'usage',walletId:'scope-fixture'}})`,
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('.wallet-budget-row').length`,
        ),
        6,
      );
      assert.ok(
        await win.webContents.executeJavaScript(`document.body.textContent.includes('27.5 / 100')`),
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          `document.querySelector('progress').getAttribute('value')`,
        ),
        '1',
      );
      await win.webContents.executeJavaScript(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
      );
      fs.writeFileSync(
        '.cache/previews/wallet-native-budget-dark.png',
        (await win.webContents.capturePage()).toPNG(),
      );
      console.log(
        'PASS: shared token editor, frozen second confirmation and native budget visualization.',
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
