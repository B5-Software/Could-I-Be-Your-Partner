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
    window.panel=new PortfolioPreview.WalletPortfolioPanel({language:()=> 'zh-CN',wallets:()=>wallets,request:async(action,input)=>{calls.push({action,input});if(action==='network.list')return {items:[{id:8453,name:'Base',archived:false,capabilities:{autonomous:true,signType2:true}},{id:84532,name:'Base Sepolia',archived:false,capabilities:{autonomous:true,signType2:true}},{id:1337,name:'Local EVM fixture',archived:false,capabilities:{autonomous:true,signType2:true}}]};if(action==='portfolio.list')return{items:[{...group.portfolio,state:group.state,revision:group.revision}],total:1,next:null};if(action==='portfolio.get')return structuredClone(group);if(action==='portfolio.challenge')return{id:'fixture-challenge'};if(action==='portfolio.pause'){group.state='paused';group.revision++;return group;}if(action==='portfolio.confirm')return group;throw Error('Unexpected fixture action');}});true;`);
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
        `document.querySelector('[data-create]').click();new Promise(r=>setTimeout(r,20))`,
      );
      await win.webContents.executeJavaScript(
        `document.querySelector('[name=portfolio-name]').value='新的双钱包预算';document.querySelectorAll('[data-member]').forEach(n=>n.checked=true);document.querySelector('[name=limit-maxTransactions]').value='6';document.querySelector('[name=portfolio-equity]').value='500.25';`,
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
      assert.equal(challenge.input.equityFloorUsd, '500.25');
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
      const equity = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelector('dialog[open]').close();
        group.portfolio.equityFloorUsdAtomic='50025000000';
        const original=panel.options.request;
        panel.options.request=async(action,input)=>{
          if(action!=='portfolio.equity')return original(action,input);
          calls.push({action,input});
          return {status:'below',availableUsd:'490',block:'123',blockHash:'0x'+'b'.repeat(64)};
        };
        await panel.detail('fixture-group');
        document.querySelector('[data-equity-check]').click();
        await new Promise(resolve=>setTimeout(resolve,20));
        return document.querySelector('[data-equity-status]').textContent;
      })()`);
      assert.match(equity, /低于下限.*490 USD.*#123/);
      await shot('equity-floor-light');
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
        (await win.webContents.executeJavaScript(`calls.map(c=>c.action)`)).every(
          (action) => action.startsWith('portfolio.') || action === 'network.list',
        ),
      );
      const holdings = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelectorAll('dialog[open]').forEach(d=>d.close());
        const original=panel.options.request;
        panel.options.request=async(action,input)=>{
          if(action!=='portfolio.holdings')return original(action,input);
          calls.push({action,input});
          const snapshot={name:group.portfolio.name,network:'Base',block:'123',blockHash:'0x'+'a'.repeat(64),complete:false,
            assets:[{symbol:'ETH',amount:'0.3',amountAtomic:'300000000000000000',complete:true},{symbol:'USDC',address:'0x'+'3'.repeat(40),amount:null,amountAtomic:null,knownAmountAtomic:'1250000',knownAmount:'1.25',complete:false}],
            members:wallets.map((w,i)=>({...w,walletId:w.id,assets:[{symbol:'ETH',amount:i?'0.2':'0.1',amountAtomic:i?'200000000000000000':'100000000000000000'}]}))};
          snapshot.capital={pendingCount:3,approvalCount:1,unknownCount:0};
          snapshot.assets[0].capital={complete:true,reservedAtomic:'10000000000000000',reserved:'0.01',availableAtomic:'290000000000000000',available:'0.29',shortfallAtomic:'0'};
          snapshot.assets[1].capital={complete:false,reservedAtomic:'200000',reserved:'0.2',availableAtomic:null,available:null,shortfallAtomic:null};
          if(input.valuation){
            const value=(complete,knownValue)=>({complete,knownValue,value:complete?knownValue:null});
            snapshot.assets[0].valuation=value(true,'600');
            snapshot.assets[1].valuation={...value(false,'1.225'),error:'WALLET_ASSET_UNAVAILABLE'};
            snapshot.members.forEach((member,i)=>{member.assets[0].valuation=value(true,i?'400':'200');});
            snapshot.valuation={...value(false,'601.225'),source:'Chainlink',sequencer:{status:'up'},prices:{
              eth:{pair:'ETH/USD',address:'0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',status:'available',price:'2000',updatedAt:1793836800,ageSeconds:30},
              usdc:{pair:'USDC/USD',address:'0x7e860098F58bBFC8648a4311b374B1D669a2bc6B',status:'available',price:'0.98',updatedAt:1793836800,ageSeconds:30,stablecoinCapped:true}
            }};
          }
          return snapshot;
        };
        await panel.detail('fixture-group');
        document.querySelector('[data-holdings]').click();
        await new Promise(resolve=>setTimeout(resolve,20));
        const d=document.querySelector('dialog[open]');
        return {text:d.querySelector('[data-assets]').textContent,members:d.querySelectorAll('[data-members] details').length,block:d.querySelector('output').textContent,request:calls.at(-1)};
      })()`);
      assert.match(holdings.text, /0\.3/);
      assert.match(holdings.text, /部分成员余额不可用/);
      assert.match(holdings.text, /已知数量 · 1\.25 USDC/);
      assert.match(holdings.text, /已知本地预留0\.01/);
      assert.match(holdings.text, /扣除预留后0\.29/);
      assert.match(holdings.text, /扣除预留后无法确定/);
      assert.match(holdings.block, /#123/);
      assert.equal(holdings.members, 2);
      assert.deepEqual(holdings.request, {
        action: 'portfolio.holdings',
        input: { id: 'fixture-group' },
      });
      for (const name of ['dark', 'light']) {
        await theme(name);
        await shot('holdings-' + name);
        await shot('capital-' + name);
      }
      assert.equal(
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-valuation]').textContent`,
        ),
        '',
      );
      const priced = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelector('[data-valuation-read]').click();
        await new Promise(resolve=>setTimeout(resolve,20));
        return {text:document.querySelector('[data-valuation]').textContent,assets:document.querySelector('[data-assets]').textContent,request:calls.at(-1)};
      })()`);
      assert.deepEqual(priced.request, {
        action: 'portfolio.holdings',
        input: { id: 'fixture-group', valuation: true },
      });
      assert.match(priced.text, /已知部分估值 · 601\.225 USD/);
      assert.match(priced.text, /ETH\/USD/);
      assert.match(priced.text, /USDC\/USD/);
      assert.match(priced.text, /价格年龄 30 s/);
      assert.match(priced.text, /稳定币价格上限馈送/);
      assert.match(priced.assets, /600 USD/);
      assert.match(priced.assets, /已知部分估值 · 1\.225 USD/);
      for (const name of ['dark', 'light']) {
        await theme(name);
        await shot('valuation-' + name);
      }
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-valuation] details').open=true`,
      );
      await shot('valuation-sources-light');
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-refresh]').click();new Promise(resolve=>setTimeout(resolve,20))`,
      );
      assert.equal(await win.webContents.executeJavaScript('calls.at(-1).input.valuation'), true);
      const exposure = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelectorAll('dialog[open]').forEach(d=>d.close());
        const original=panel.options.request, token='0x'+'3'.repeat(40), spender='0x'+'4'.repeat(40);
        const amount=(value)=>({amount:value,atomic:null});
        const pair={walletId:'one',walletName:wallets[0].name,token,spender,protocol:'permit2',status:'active',symbol:'USDC',spendable:amount('15')};
        const snapshot={reportId:'fixture-snapshot',block:'123',blockHash:'0x'+'a'.repeat(64),observedAt:1793836800000,
          coverage:{mode:'recent',tokens:[token],nextEndBlock:'100',scannedRanges:[{fromBlock:'101',toBlock:'123'}],scanIncomplete:true},
          totals:[{token,symbol:'USDC',decimals:6,measured:amount('55'),includingPermit2:amount('65'),balance:amount('80')}],items:[pair],total:1,next:null};
        let scanned=false, reviewed;
        window.exposureFixture={snapshot,pair,amount};
        panel.options.reviewAllowance=(id,selection)=>{reviewed={id,...selection}};
        panel.options.request=async(action,input)=>{
          if(!action.startsWith('portfolio.allowances.'))return original(action,input);
          calls.push({action,input});
          if(action.endsWith('.list'))return {items:scanned?[snapshot]:[],next:null};
          if(action.endsWith('.scan'))scanned=true;
          return snapshot;
        };
        await panel.detail('fixture-group');
        document.querySelector('[data-exposure]').click();
        await new Promise(resolve=>setTimeout(resolve,25));
        const d=document.querySelector('dialog[open]');
        d.querySelector('[data-exposure-token]').value=token;
        d.querySelector('[data-mode=recent]').click();
        await new Promise(resolve=>setTimeout(resolve,25));
        d.querySelector('[data-exposure-review]').click();
        return {text:d.querySelector('[data-exposure-summary]').textContent,reviewed,selected:d.querySelector('[data-exposure-history]').value,scan:calls.find(c=>c.action==='portfolio.allowances.scan').input};
      })()`);
      assert.match(exposure.text, /已核对的可支出量 · 55/);
      assert.match(exposure.text, /计入 Permit2 外层的条件容量 · 65/);
      assert.match(exposure.text, /读取失败或扫描超限/);
      assert.equal(exposure.selected, 'fixture-snapshot');
      assert.equal(exposure.scan.mode, 'recent');
      assert.deepEqual(exposure.reviewed, {
        id: 'one',
        chain: 'base',
        protocol: 'permit2',
        token: '0x' + '3'.repeat(40),
        spender: '0x' + '4'.repeat(40),
      });
      for (const name of ['light', 'dark']) {
        await theme(name);
        await shot('allowance-exposure-' + name);
      }
      const monitor = await win.webContents.executeJavaScript(`(async()=>{
        const {snapshot,pair,amount}=exposureFixture, original=panel.options.request;
        let status={revision:0,enabled:false,status:'off',next:null,notices:[]};
        panel.options.request=async(action,input)=>{
          if(!action.startsWith('portfolio.allowanceMonitor.'))return original(action,input);
          calls.push({action,input});
          if(action.endsWith('.start'))status={revision:1,enabled:true,status:'watching',lastBlock:'126',checkedAt:1793836800000,nextAt:1793837100000,next:null,
            notices:[{block:'126',blockHash:snapshot.blockHash,observedAt:1793836800000,pairCount:1,increaseCount:1,pairs:[pair],increases:[{symbol:'USDC',metric:'measured',before:amount('55'),after:amount('70')}]}]};
          if(input.includeReport)return {report:{...snapshot,block:'126',coverage:{...snapshot.coverage,monitoredRange:{fromBlock:'124',toBlock:'126'}}}};
          return status;
        };
        const wait=()=>new Promise(resolve=>setTimeout(resolve,25));
        document.querySelector('[data-exposure-monitor]').click();
        await wait();
        const start=document.querySelector('[data-monitor-start]');
        const rejectedPartial=start.disabled;
        start.closest('dialog').close();
        snapshot.coverage.scanIncomplete=false;
        document.querySelector('[data-mode=recent]').click();
        await wait();
        document.querySelector('[data-exposure-monitor]').click();
        await wait();
        document.querySelector('[data-monitor-interval]').value='60';
        document.querySelector('[data-monitor-start]').click();
        await wait();
        const d=document.querySelector('[data-monitor-state]').closest('dialog');
        d.querySelector('[data-monitor-evidence]').click();
        await wait();
        const evidence=Array.from(document.querySelectorAll('[data-exposure-summary]')).at(-1);
        const hiddenScan=getComputedStyle(evidence.closest('dialog').querySelector('.wallet-allowance-actions')).display;
        const output={rejectedPartial,state:d.querySelector('[data-monitor-state]').textContent,history:d.querySelector('[data-monitor-history]').textContent,evidence:evidence.textContent,hiddenScan,request:calls.find(c=>c.action==='portfolio.allowanceMonitor.start').input};
        evidence.closest('dialog').close();
        return output;
      })()`);
      assert.equal(monitor.rejectedPartial, true);
      assert.match(monitor.state, /监控中[\s\S]*#126/);
      assert.match(monitor.history, /55 → 70/);
      assert.match(monitor.evidence, /#124–#126/);
      assert.equal(monitor.hiddenScan, 'none');
      assert.deepEqual(monitor.request, {
        id: 'fixture-group',
        expectedRevision: 0,
        intervalSeconds: 60,
        reportId: 'fixture-snapshot',
      });
      for (const name of ['light', 'dark']) {
        await theme(name);
        await shot('allowance-monitor-' + name);
      }
      const ceiling = await win.webContents.executeJavaScript(`(async()=>{
        document.querySelector('[data-monitor-state]').closest('dialog').close();
        document.querySelector('[data-exposure-ceiling]').click();
        const wait=()=>new Promise(resolve=>setTimeout(resolve,25));
        await wait();
        const form=document.querySelector('input[name=amount]').form;
        form.elements.amount.value='10.5';
        form.requestSubmit();
        await wait();
        const confirmation=document.querySelector('input[name=ack]').form;
        confirmation.requestSubmit();
        await wait();
        return {text:confirmation.textContent, ack:confirmation.querySelector('[data-ack]').hidden,
          pending:calls.filter(c=>c.action==='portfolio.confirm').length,
          input:calls.filter(c=>c.action==='portfolio.challenge').at(-1).input};
      })()`);
      assert.equal(ceiling.ack, false);
      assert.equal(ceiling.pending, 1);
      assert.match(ceiling.text, /10\.5.*#123/);
      assert.deepEqual(ceiling.input.ceiling, {
        reportId: 'fixture-snapshot',
        amount: '10.5',
        token: '0x' + '3'.repeat(40),
      });
      console.log(
        'PASS: shared portfolio creation, frozen confirmation, pause/resume, holdings, USD valuation, allowance exposure and opt-in monitoring; light/dark screenshots use synthetic public data.',
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
