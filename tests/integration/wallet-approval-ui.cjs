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
      window.panel=new WalletPreview.WalletPanel({language:()=> 'zh-CN',subscribe:()=>{},request:async(action,input)=>{calls.push({action,input});if(action==='network.list')return {items:[{id:8453,name:'Base',archived:false,capabilities:{autonomous:true,signType2:true}},{id:84532,name:'Base Sepolia',archived:false,capabilities:{autonomous:true,signType2:true}},{id:1337,name:'Local EVM fixture',archived:false,capabilities:{autonomous:true,signType2:true}}]};if(action==='list')return{wallets:[],intents:[]};if(action==='history')return{items:[],total:0,next:null};if(action==='policy.challenge')return{id:'scope-fixture-challenge'};if(action==='policy.usage')return{revoked:false,expiresAt:0,limits:{maxTotalValueWei:'100000000000000000',maxTotalFeeWei:'20000000000000000',maxTransactions:20,tokens:[{chainId:8453,address:'0x'+'3'.repeat(40),symbol:'USDC',decimals:6,maxSignedAtoms:'100000000'}]},usage:{valueWei:'1000000000000000',feeWei:'300000000000000',transactions:3,tokens:{['eip155:8453/erc20:0x'+'3'.repeat(40)]:{transferAtoms:'12500000',approvalAtoms:'15000000',signatures:2}}}};return{};}});
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
      await win.webContents.executeJavaScript(
        `panel.authorization({id:'scope-fixture',address:'0x'+'2'.repeat(40),policy:{mode:'manual',chains:[]}})`,
      );
      await win.webContents
        .executeJavaScript(`document.querySelector('.wallet-policy-limits').open=true;
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
      await win.webContents.executeJavaScript(
        `document.querySelectorAll('dialog[open]').forEach(d=>d.close());panel.authorization({id:'scope-fixture',address:'0x'+'2'.repeat(40),policy:{mode:'manual',chains:[],limits:{maxTransactions:2,maxTotalValueEth:'0.001',tokens:[{chainId:1337,address:'0x'+'3'.repeat(40),symbol:'TEST',decimals:6,maxSignedAmount:'0.2',maxAmount:'0.1',allowApprovals:false}]}}})`,
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-token-field=chainId]').value`,
        ),
        '1337',
      );
      await win.webContents.executeJavaScript(
        `document.querySelector('[name=chains]').value='1337';document.querySelector('.wallet-policy-dialog form').requestSubmit();new Promise(r=>setTimeout(r,20))`,
      );
      const customReview = await win.webContents.executeJavaScript(
        `calls.filter(c=>c.action==='policy.challenge').at(-1).input`,
      );
      assert.deepEqual(customReview.chains, [1337]);
      assert.equal(customReview.limits.tokens[0].chainId, 1337);
      for (const dark of [false, true]) {
        await win.webContents.executeJavaScript(
          `Object.entries(${JSON.stringify({ light: { 'bg-primary': '#f8f9fb', 'bg-secondary': '#fff', 'text-primary': '#222633', 'text-secondary': '#565e6e', border: '#dce1ea', warning: '#ad7009' }, dark: { 'bg-primary': '#151b23', 'bg-secondary': '#1d2530', 'text-primary': '#eef2f7', 'text-secondary': '#b5bfcc', border: '#364354', warning: '#f0b85e' } })}[${JSON.stringify(dark ? 'dark' : 'light')}]).forEach(([k,v])=>document.documentElement.style.setProperty('--'+k,v));document.querySelector('.wallet-policy-dialog').scrollTop=0;new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`,
        );
        fs.writeFileSync(
          '.cache/previews/wallet-evm-agent-authority-' + (dark ? 'dark' : 'light') + '.png',
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      assert.equal(
        await win.webContents.executeJavaScript(
          `calls.filter(c=>c.action==='policy.grant').length`,
        ),
        1,
        'A review or screenshot cannot grant authority',
      );
      await win.webContents.executeJavaScript(
        `document.querySelectorAll('dialog[open]').forEach(d=>d.close());true;`,
      );
      console.log(
        'PASS: custom-network authority and token selectors retain chain 1337, freeze review without granting and render both themes.',
      );
      for (const protocol of ['erc20', 'permit2']) {
        const allowance = await win.webContents.executeJavaScript(`(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const token='0x'+'3'.repeat(40), spender='0x'+'4'.repeat(40);
        const protocol=${JSON.stringify(protocol)};
        const original=panel.options.request;
        calls.length=0;
        panel.options.request=async (action,input)=>{
          if(action==='list')return {wallets:[{id:'allowance-wallet',name:'Local test',address:'0x'+'2'.repeat(40),unlocked:true,policy:{mode:'manual',chains:[]}}],intents:[]};
          if(action.startsWith('allowance.') || action.startsWith('permit2.')) calls.push({action,input});
          if(action==='allowance.discover')return {fromBlock:'100',toBlock:'123',anchorHash:'0x'+'a'.repeat(64),nextOffset:null,nextEndBlock:'99',total:1,items:[{token,spender,block:'112',transactionHash:'0x'+'b'.repeat(64),eventAmountAtomic:'9000000'}]};
          if(action==='allowance.inspect')return {token,spender,amount:'2.5',amountAtomic:'2500000',symbol:'USDC',block:'123',network:'Base Sepolia',commandId:'observed-pair',observedAt:0,blockHash:'0x'+'a'.repeat(64),...(input.protocol==='permit2'?{permit2:{tokenAllowance:'1.5',tokenAllowanceAtomic:'1500000',effectiveAmount:'1.5',effectiveAmountAtomic:'1500000',expiration:1779000000,nonce:'7',nextNonce:'8'}}:{})};
          if(action==='permit2.signature.inspect')return {nonce:'511',unavailable:false,block:'123',commandId:'observed-signature'};
          if(action.endsWith('.prepare'))return {status:'approval-required'};
          return original(action,input);
        };
        await panel.refresh();
        document.querySelector('[data-wallet-action=allowances]').click();
        const form=document.querySelector('dialog[open] form');
        const read=form.querySelector('[value=read]'),revoke=form.querySelector('[value=revoke]');
        form.elements.chain.value='base-sepolia';
        form.elements.protocol.value=protocol;
        form.querySelector('[data-approval-history]').click();
        await Promise.resolve();await Promise.resolve();
        const historyDialog=document.querySelector('dialog[open] .wallet-approval-history');
        const historical=historyDialog.textContent;
        historyDialog.querySelector('button').click();
        await Promise.resolve();await Promise.resolve();
        const observed=form.querySelector('output').textContent;
        const ready=!revoke.disabled;
        form.elements.protocol.dispatchEvent(new Event('input',{bubbles:true}));
        const cleared=revoke.disabled&&form.querySelector('output').textContent==='';
        form.requestSubmit(read);
        await Promise.resolve();await Promise.resolve();
        form.requestSubmit(revoke);
        await Promise.resolve();await Promise.resolve();
        const prepared=form.querySelector('output').textContent;
        if(protocol==='permit2'){
          form.requestSubmit(read);
          await Promise.resolve();await Promise.resolve();
          form.requestSubmit(form.querySelector('[value=ordered]'));
          await Promise.resolve();await Promise.resolve();
          form.querySelector('[data-signature]').click();
          const input=document.querySelector('dialog[open] [name=nonce]');
          input.value='0x1ff';
          input.form.requestSubmit(input.form.querySelector('[value=read]'));
          await Promise.resolve();await Promise.resolve();
          input.form.requestSubmit(input.form.querySelector('[value=prepare]'));
          await Promise.resolve();await Promise.resolve();
        }
        return {historical,observed,ready,cleared,prepared,
          ordered:calls.find(call=>call.action==='permit2.ordered.prepare')?.input,
          signature:calls.find(call=>call.action==='permit2.signature.prepare')?.input,
          scan:calls.find(call=>call.action==='allowance.discover').input,
          request:calls.find(call=>call.action==='allowance.revoke.prepare'),approved:calls.some(call=>call.action==='intent.approve')};
      })()`);
        assert.match(allowance.historical, /#112/);
        assert.match(allowance.observed, /2\.5 USDC.*#123/);
        if (protocol === 'permit2') assert.match(allowance.observed, /1\.5 USDC.*Nonce 7/);
        assert.equal(allowance.scan.protocol, protocol === 'permit2' ? protocol : undefined);
        assert.equal(allowance.ready, true);
        assert.equal(allowance.cleared, true);
        assert.match(allowance.prepared, /待审批/);
        assert.deepEqual(allowance.request.input, {
          id: 'allowance-wallet',
          chain: 'base-sepolia',
          token: '0x' + '3'.repeat(40),
          spender: '0x' + '4'.repeat(40),
          commandId: 'observed-pair',
          ...(protocol === 'permit2' ? { protocol } : {}),
        });
        assert.equal(allowance.approved, false);
        if (protocol === 'permit2') {
          assert.deepEqual(allowance.ordered, {
            id: 'allowance-wallet',
            chain: 'base-sepolia',
            token: '0x' + '3'.repeat(40),
            spender: '0x' + '4'.repeat(40),
            nonce: '7',
            commandId: 'observed-pair:nonce',
          });
          assert.deepEqual(allowance.signature, {
            id: 'allowance-wallet',
            chain: 'base-sepolia',
            nonce: '511',
            commandId: 'observed-signature',
          });
        }
      }
      console.log(
        'PASS: shared ERC-20 and Permit2 allowance query and revocation review preserve the observed pair.',
      );
      const lockdown = await win.webContents.executeJavaScript(`(() => {
        const token='0x'+'3'.repeat(40), spender='0x'+'4'.repeat(40);
        const preview=document.querySelector('#preview');
        preview.innerHTML=WalletPreview.approvalCard({...fixture,replacementOf:null,description:{kind:'permit2-lockdown',tokenContract:token,recipient:spender,rawTokenAmount:'0'}},'zh-CN');
        return {summary:preview.querySelector('.wallet-action-summary').textContent,
          scope:preview.querySelector('.wallet-warning').textContent,
          addresses:Array.from(preview.querySelectorAll('dd')).slice(1,3).map(node=>node.textContent)};
      })()`);
      assert.match(lockdown.summary, /Permit2/);
      assert.match(lockdown.scope, /nonce/);
      assert.deepEqual(lockdown.addresses, ['0x' + '3'.repeat(40), '0x' + '4'.repeat(40)]);
      const watch = await win.webContents.executeJavaScript(`(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
        const original=panel.options.request;
        const address='0x'+'5'.repeat(40), token='0x'+'6'.repeat(40);
        let added=false, tracked=false, upgraded=false;
        calls.length=0;
        panel.options.request=async(action,input)=>{
          if(action==='list')return {wallets:added?[{id:'watch-fixture',name:'Public account',address,kind:upgraded?'local':'watch',unlocked:false,policy:{mode:'manual',chains:[]}}]:[],intents:[]};
          if(['watch.add','watch.remove','watch.import','asset.track','asset.untrack','assets'].includes(action))calls.push({action,input});
          if(action==='watch.add'){added=true;return {id:'watch-fixture'};}
          if(action==='watch.remove'){added=false;return {removed:true};}
          if(action==='watch.import'){upgraded=true;return {id:'watch-fixture'};}
          if(action==='asset.track'){tracked=true;return {};}
          if(action==='network.list')return {items:[{key:'base',id:8453,name:'Base',nativeSymbol:'ETH'},{key:'base-sepolia',id:84532,name:'Base Sepolia',nativeSymbol:'ETH'}]};
          if(action==='assets')return {network:input.chain==='base'?'Base':'Base Sepolia',block:'123',blockHash:'0x'+'a'.repeat(64),observedAt:0,trackedTokens:tracked?[token]:[],assets:[{kind:'native',symbol:'ETH',amount:'1',amountAtomic:'1000000000000000000'},{kind:'erc20',symbol:'USDC',address:'0x'+'3'.repeat(40),amount:'1.25',amountAtomic:'1250000'},...(tracked?[{kind:'erc20',symbol:null,address:token,amount:null,amountAtomic:'123',metadataError:'missing decimals'}]:[])]};
          return original(action,input);
        };
        const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
        await panel.refresh();
        document.querySelector('[data-wallet-action=watch-add]').click();
        const creation=document.querySelector('dialog[open] form');
        creation.elements.name.value='Public account';creation.elements.address.value=address;
        creation.requestSubmit();await tick();
        const account=document.querySelector('.wallet-account');
        const actions=Array.from(account.querySelectorAll('[data-wallet-action]')).map(node=>node.dataset.walletAction);
        account.querySelector('[data-wallet-action=balance]').click();await tick();
        const assets=document.querySelector('dialog[open] form');
        assets.elements.chain.value='base-sepolia';assets.elements.chain.dispatchEvent(new Event('change'));await tick();
        assets.elements.token.value=token;assets.requestSubmit();await tick();
        const text=assets.querySelector('.wallet-assets').textContent;
        return {actions,text,request:calls.find(call=>call.action==='asset.track')?.input,secretFields:Array.from(creation.querySelectorAll('input')).map(input=>input.name)};
      })()`);
      assert.deepEqual(watch.actions, ['balance', 'allowances', 'import', 'watch-remove']);
      assert.deepEqual(watch.secretFields, ['name', 'address']);
      assert.match(watch.text, /USDC1\.25/);
      assert.match(watch.text, /123 最小单位/);
      assert.deepEqual(watch.request, {
        id: 'watch-fixture',
        chain: 'base-sepolia',
        token: '0x' + '6'.repeat(40),
      });
      await win.webContents.executeJavaScript(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
      );
      fs.writeFileSync(
        '.cache/previews/wallet-assets-dark.png',
        (await win.webContents.capturePage()).toPNG(),
      );
      const upgraded = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
        document.querySelector('[data-wallet-action=import][data-wallet-id=watch-fixture]').click();
        const form=document.querySelector('dialog[open] form');
        const bound=!!form.querySelector('code')?.textContent.includes('0x'+'5'.repeat(40));
        const nameHidden=!form.elements.name;
        form.elements.password.value='test-watch-upgrade-password';
        form.elements.secret.value='public-fixture-placeholder';
        form.requestSubmit();
        const cleared=form.elements.password.value===''&&form.elements.secret.value==='';
        await new Promise(resolve=>setTimeout(resolve,20));
        return {bound,nameHidden,cleared,id:calls.find(call=>call.action==='watch.import')?.input.id,unlocked:calls.some(call=>call.action==='unlock'),hasUnlock:!!document.querySelector('[data-wallet-action=unlock][data-wallet-id=watch-fixture]')};
      })()`);
      assert.deepEqual(upgraded, {
        bound: true,
        nameHidden: true,
        cleared: true,
        id: 'watch-fixture',
        unlocked: false,
        hasUnlock: true,
      });
      const lateError = await win.webContents.executeJavaScript(`(async()=>{
        const original=panel.options.request;
        let rejectImport, unhandled=0;
        const listener=event=>{unhandled++;event.preventDefault();};
        window.addEventListener('unhandledrejection',listener);
        panel.options.request=(action,input)=>action==='import'?new Promise((_resolve,reject)=>{rejectImport=reject;}):original(action,input);
        document.querySelector('.wallet-heading [data-wallet-action=import]').click();
        const dialog=document.querySelector('dialog[open]'), form=dialog.querySelector('form');
        form.elements.password.value='test-cancelled-import-password';
        form.elements.secret.value='public-fixture-placeholder';
        form.requestSubmit();dialog.close();
        await new Promise(resolve=>setTimeout(resolve,20));
        rejectImport(Error('fixture late import failure'));
        await new Promise(resolve=>setTimeout(resolve,20));
        panel.options.request=original;
        window.removeEventListener('unhandledrejection',listener);
        return {unhandled,removed:!dialog.isConnected};
      })()`);
      assert.deepEqual(lateError, { unhandled: 0, removed: true });
      console.log(
        'PASS: shared watch-account creation and asset snapshots hide signing controls and preserve token tracking.',
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
