/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared GUI/WebUI Mission Control component; synthetic nonprivate tasks, no model calls.
const { app, BrowserWindow } = require('electron'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const bundle = await require('esbuild').build({
      entryPoints: [path.resolve('src/renderer/core/super-agent.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      globalName: 'SuperPreview',
    });
    const win = new BrowserWindow({
        width: 1440,
        height: 1020,
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true },
      }),
      js = (s) => win.webContents.executeJavaScript(s),
      settle = () => new Promise((r) => setTimeout(r, 80));
    const capture = async () => {
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
      return (await win.webContents.capturePage()).toPNG();
    };
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<main id="page-superagent" class="page active"></main>'),
      );
      for (const file of [
        'src/renderer/css/theme.css',
        'src/renderer/css/controls.css',
        'src/renderer/css/focus.css',
        'src/renderer/css/super-agent.css',
      ])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await win.webContents.insertCSS(
        'html,body{height:100%;margin:0;background:var(--bg-primary);color:var(--text-primary);font:14px system-ui}.page.active{display:flex;flex-direction:column;height:100%}button,input,select,textarea{font:inherit}',
      );
      await js(bundle.outputFiles[0].text);
      await js(`window.calls=[];window.listener=null;window.lang='zh-CN';window.runtimeLoc='vm';window.superState={config:{enabled:true,maxWorkers:2,maxAttempts:12,maxTokens:100000,routerModel:'fast',workerModel:'strong',watchdog:true,proactive:false,rules:'',sources:['automation']},paused:false,pending:1,counts:{queued:1,running:1,waiting:0,needs_attention:1,completed:1,stopped:0}};
  window.tasks=[{id:'research',title:'整理竞品发布与技术动态',status:'running',generation:2,summary:'正在核对一手来源，汇总可追溯的研究结论。',evidence:[],reason:'',tokens:12340,attempts:2,updatedAt:Date.now(),workerKey:'worker-research',mode:'chat'},{id:'code',title:'完善项目的导出功能',status:'completed',generation:3,summary:'已完成实现与回归验证，结果保存在独立工作区。',evidence:['export-report.md · 已生成','相关功能检查通过'],tokens:28640,attempts:3,updatedAt:Date.now()-300000,workerKey:'worker-code',mode:'code',workspacePath:'/tmp/ws-code'},{id:'review',title:'检查并修复自动化任务',status:'needs_attention',generation:2,summary:'需要你确认一次命令执行，后台保留当前任务进度。',evidence:[],tokens:6840,attempts:1,updatedAt:Date.now()-60000,workerKey:'worker-review',mode:'code',workspacePath:'/tmp/ws-review'}];
  window.deliveries=[{id:'del-1',taskId:'code',generation:3,summary:'导出功能交付完成',status:'completed',at:Date.now()-120000,read:false}];
  window.pending={id:'approval',revision:3,kind:'tool-auth',payload:{toolName:'runShellCommand',args:{command:'npm test -- --runInBand'}}};
  window.panel=new SuperPreview.SuperAgentPanel({language:()=>lang,settings:async()=>({runtime:{location:runtimeLoc},llm:{pool:[{id:'fast',label:'轻量协调模型',model:'router-model'},{id:'strong',label:'任务执行模型',model:'worker-model'}]}}),pickWorkspace:async()=>'/workspace/vm-repo',pickHostWorkspace:async()=>'D:\\\\repos\\\\host-repo',subscribe:fn=>{listener=fn},request:async(action,input={})=>{calls.push({action,input});if(action==='status')return superState;if(action==='list')return {items:tasks,total:tasks.length,next:null};if(action==='deliveries')return {items:deliveries,total:deliveries.length,next:null};if(action==='events')return {items:[{id:'event',text:'整理最新的项目反馈',status:'needs_attention',reason:'SUPER_ROUTING_FAILED'}]};if(action==='get')return {task:tasks.find(t=>t.id===input.id),events:[{id:'input',text:'检查任务并验证修改；遇到需要确认的操作先等待我。',source:'local',at:Date.now()}],view:input.id==='review'?{pendingInteraction:pending,displayMessages:[{role:'user',content:JSON.stringify({superAgentInput:true,taskId:'review',events:[{id:'e1',text:'检查自动化脚本并运行回归测试'}]})},{role:'assistant',reasoning:'先检查工作区测试配置，再执行测试命令。',content:'我将运行测试套件以确认回归状态。'},{role:'tool',name:'readFile',content:'{"scripts":{"test":"node --test"}}'}],subAgents:[{id:'sa-1',task:'扫描配置差异',status:'completed',iterations:2,toolUseCount:3}]}:null};if(action==='respond'){pending=null;return {ok:true}}if(action==='ack'){deliveries[0].read=true;return {ok:true}}if(action==='pause'){superState.paused=true;return {ok:true}}if(action==='configure'){Object.assign(superState.config,input);return superState}return {ok:true};}});true;`);
      await settle();

      assert.equal(await js(`document.querySelectorAll('.super-task').length`), 3);
      assert.equal(
        await js(`document.querySelector('[name=routerModel] option:checked').textContent`),
        '轻量协调模型',
      );
      assert.equal(
        await js(
          `document.querySelectorAll('[data-preferences] input[type=checkbox]:not([role=switch])').length`,
        ),
        0,
      );
      // Verify switch thumbs stay strictly inside track bounds (no translateX overflow)
      const switchMetrics = await js(
        `[...document.querySelectorAll('[data-preferences] input[type=checkbox]')].map(el => { const after = getComputedStyle(el, '::after'); return { checked: el.checked, trackW: el.getBoundingClientRect().width, left: parseFloat(after.left), width: parseFloat(after.width), transform: after.transform }; })`,
      );
      for (const m of switchMetrics) {
        assert.equal(m.transform, 'none', 'Switch thumb must not apply extra transform');
        assert.ok(m.left >= 0 && m.left + m.width <= m.trackW - 1, 'Switch thumb overflowed track');
      }
      assert.ok(
        await js(
          `document.querySelector('.super-composer textarea').getBoundingClientRect().width > 560`,
        ),
      );

      // Quick Code template reveals VM-compatible workspace selector and submits workspacePath
      assert.equal(await js(`document.querySelector('[data-workspace-bar]').hidden`), true);
      await js(`document.querySelector('.super-template-card').click();true;`);
      assert.ok(await js(`document.querySelector('.super-composer textarea').value.length > 10`));
      assert.equal(await js(`document.querySelector('[data-workspace-bar]').hidden`), false);
      assert.equal(await js(`document.querySelector('[data-pick-host-workspace]').hidden`), false);
      await js(`document.querySelector('[data-pick-workspace]').click();true;`);
      await settle();
      assert.equal(
        await js(`document.querySelector('[data-workspace-input]').value`),
        '/workspace/vm-repo',
      );
      await js(`document.querySelector('[data-pick-host-workspace]').click();true;`);
      await settle();
      assert.equal(
        await js(`document.querySelector('[data-workspace-input]').value`),
        'D:\\repos\\host-repo',
      );
      await js(`document.querySelector('.super-composer').requestSubmit();true;`);
      await settle();
      const submitCall = await js(`calls.find(c=>c.action==='submit')`);
      assert.equal(submitCall.input.mode, 'code');
      assert.equal(submitCall.input.workspacePath, 'D:\\repos\\host-repo');
      await js(`document.querySelector('[data-clear-workspace]').click();true;`);
      assert.equal(await js(`document.querySelector('[data-workspace-input]').value`), '');
      // Keep Code workspace bar visible for light/dark preview inspection
      await js(
        `document.querySelector('[data-workspace-input]').value='/workspace/vm-repo';document.querySelector('[data-workspace-input]').dispatchEvent(new Event('input'));true;`,
      );

      // Filtering & search
      await js(`document.querySelector('.super-filter-pill[data-filter=running]').click();true;`);
      assert.equal(await js(`document.querySelectorAll('.super-task').length`), 1);
      await js(`document.querySelector('.super-filter-pill[data-filter=all]').click();true;`);
      await js(
        `(()=>{const s=document.querySelector('[data-task-search]');s.value='导出';s.dispatchEvent(new Event('input'));return true;})()`,
      );
      assert.equal(await js(`document.querySelectorAll('.super-task').length`), 1);
      await js(
        `(()=>{const s=document.querySelector('[data-task-search]');s.value='';s.dispatchEvent(new Event('input'));return true;})()`,
      );
      assert.equal(await js(`document.querySelectorAll('.super-task').length`), 3);

      fs.mkdirSync('.cache/previews', { recursive: true });
      fs.writeFileSync('.cache/previews/superagent-light.png', await capture());
      await js(`document.documentElement.setAttribute('data-theme','dark')`);
      await settle();
      fs.writeFileSync('.cache/previews/superagent-dark.png', await capture());

      // Selecting a task renders inline mission view (no modal dialog) + live stream + inline approval
      await js(
        `document.documentElement.removeAttribute('data-theme');document.querySelector('[data-task=review]').click();true;`,
      );
      await settle();
      assert.equal(await js(`document.querySelectorAll('dialog[open]').length`), 0);
      assert.equal(await js(`document.querySelector('[data-detail-stage]').hidden`), false);
      assert.ok(
        (await js(`document.querySelector('.super-approval-args').textContent`)).includes(
          'npm test',
        ),
      );
      assert.ok(
        (await js(`document.querySelector('.super-messages').textContent`)).includes(
          '检查自动化脚本并运行回归测试',
        ),
      );
      assert.equal(
        await js(
          `document.querySelector('.super-messages').textContent.includes('superAgentInput')`,
        ),
        false,
      );
      assert.equal(await js(`document.querySelectorAll('.super-subagent-card').length`), 1);
      fs.writeFileSync('.cache/previews/superagent-task-light.png', await capture());

      // Live refresh preserves follow-up draft & focus
      await js(
        `document.querySelector('.super-followup textarea').focus();document.querySelector('.super-followup textarea').value='保留草稿';document.querySelector('.super-followup textarea').dispatchEvent(new Event('input'));listener({channel:'agent:session-event',payload:{type:'superagent'}});true;`,
      );
      await settle();
      assert.equal(
        await js(`document.querySelector('.super-followup textarea').value`),
        '保留草稿',
      );

      // Inline once-only approval
      await js(
        `Array.from(document.querySelectorAll('.super-interaction button')).find(b=>b.textContent==='允许本次').click();true;`,
      );
      await settle();
      const confirmation = await js(`calls.find(c=>c.action==='respond')`);
      assert.deepEqual(confirmation.input, {
        id: 'review',
        interactionId: 'approval',
        revision: 3,
        response: 'allow-once',
      });

      // Deliveries tab ack & source chip configure
      await js(`document.querySelector('[data-insp-tab=deliveries]').click();true;`);
      await settle();
      await js(`document.querySelector('[data-ack="del-1"]').click();true;`);
      await settle();
      assert.ok(await js(`calls.some(c=>c.action==='ack' && c.input.id==='del-1')`));

      await js(`document.querySelector('[data-insp-tab=config]').click();true;`);
      await js(
        `document.querySelector('[data-source=github]').click();document.querySelector('[data-preferences]').requestSubmit();true;`,
      );
      await settle();
      const cfgCall = await js(`calls.find(c=>c.action==='configure')`);
      assert.ok(
        cfgCall.input.sources.includes('github') && cfgCall.input.sources.includes('automation'),
      );

      await js(
        `document.querySelector('[data-close-detail]').click();document.querySelector('[data-pause]').click();true;`,
      );
      await settle();
      assert.ok(await js(`calls.some(c=>c.action==='pause')`));
      console.log(
        'PASS: 3-column Mission Control, filtering/search, templates, live stream unwrapping, subagents, inline once-only approval, draft preservation, deliveries ack, source chips, and pause controls. Screenshots in .cache/previews/superagent-*.png.',
      );
    } finally {
      win.destroy();
    }
  })
  .then(() => app.exit(0))
  .catch((e) => {
    console.error(e.stack);
    app.exit(1);
  });
