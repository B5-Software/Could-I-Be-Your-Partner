/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared GUI/WebUI component; synthetic nonprivate tasks, no model calls.
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
      settle = () => new Promise((r) => setTimeout(r, 70));
    const capture = async () => {
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
      return (await win.webContents.capturePage()).toPNG();
    };
    try {
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<main id="page-superagent" class="page active"></main>'),
      );
      for (const file of ['src/renderer/css/theme.css', 'src/renderer/css/super-agent.css'])
        await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
      await win.webContents.insertCSS(
        'html{background:var(--bg-primary);color:var(--text-primary);font:14px system-ui}body{margin:0}.page.active{display:flex;flex-direction:column}button,input,select,textarea{font:inherit}',
      );
      await js(bundle.outputFiles[0].text);
      await js(`window.calls=[];window.listener=null;window.lang='zh-CN';window.superState={config:{enabled:true,maxWorkers:2,maxAttempts:12,maxTokens:100000,routerModel:'fast',workerModel:'strong',watchdog:true,proactive:false,rules:'',sources:[]},paused:false,pending:1,counts:{queued:1,running:1,waiting:0,needs_attention:1,completed:1,stopped:0}};
  window.tasks=[{id:'research',title:'整理竞品发布与技术动态',status:'running',generation:2,summary:'正在核对一手来源，汇总可追溯的研究结论。',evidence:[],reason:'',tokens:12340,attempts:2,updatedAt:Date.now(),workerKey:'worker-research',mode:'chat'},{id:'code',title:'完善项目的导出功能',status:'completed',generation:3,summary:'已完成实现与回归验证，结果保存在独立工作区。',evidence:['export-report.md · 已生成','相关功能检查通过'],tokens:28640,attempts:3,updatedAt:Date.now()-300000,workerKey:'worker-code',mode:'code'},{id:'review',title:'检查并修复自动化任务',status:'needs_attention',generation:2,summary:'需要你确认一次命令执行，后台保留当前任务进度。',evidence:[],tokens:6840,attempts:1,updatedAt:Date.now()-60000,workerKey:'worker-review',mode:'code'}];
  window.pending={id:'approval',revision:3,kind:'tool-auth',payload:{toolName:'runShellCommand',args:{command:'npm test -- --runInBand'}}};
  window.panel=new SuperPreview.SuperAgentPanel({language:()=>lang,settings:async()=>({llm:{pool:[{id:'fast',label:'轻量协调模型',model:'router-model'},{id:'strong',label:'任务执行模型',model:'worker-model'}]}}),subscribe:fn=>{listener=fn},request:async(action,input={})=>{calls.push({action,input});if(action==='status')return superState;if(action==='list')return {items:tasks,total:tasks.length,next:null};if(action==='events')return {items:[{id:'event',text:'整理最新的项目反馈',status:'needs_attention',reason:'SUPER_ROUTING_FAILED'}]};if(action==='get')return {task:tasks.find(t=>t.id===input.id),events:[{id:'input',text:'检查任务并验证修改；遇到需要确认的操作先等待我。',source:'local',at:Date.now()}],view:input.id==='review'?{pendingInteraction:pending}:null};if(action==='respond'){pending=null;return {ok:true}};if(action==='pause'){superState.paused=true;return {ok:true}};return {ok:true};}});true;`);
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
      assert.ok(
        await js(
          `document.querySelector('.super-composer textarea').getBoundingClientRect().width > 900`,
        ),
      );
      fs.mkdirSync('.cache/previews', { recursive: true });
      fs.writeFileSync('.cache/previews/superagent-light.png', await capture());
      await js(`document.documentElement.setAttribute('data-theme','dark')`);
      await settle();
      fs.writeFileSync('.cache/previews/superagent-dark.png', await capture());
      await js(
        `document.documentElement.removeAttribute('data-theme');document.querySelector('[data-task=review]').click();true;`,
      );
      await settle();
      assert.equal(await js(`document.querySelectorAll('dialog[open]').length`), 1);
      assert.ok(
        (await js(`document.querySelector('.super-approval-args').textContent`)).includes(
          'npm test',
        ),
      );
      const bounds = await js(
        `(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return {left:r.left,right:r.right,width:document.documentElement.clientWidth}})()`,
      );
      assert.ok(Math.abs(bounds.left - (bounds.width - bounds.right)) < 3);
      fs.writeFileSync('.cache/previews/superagent-task-light.png', await capture());
      await js(
        `document.querySelector('.super-followup textarea').focus();document.querySelector('.super-followup textarea').value='保留草稿';listener({channel:'agent:session-event',payload:{type:'superagent'}});true;`,
      );
      await settle();
      assert.equal(
        await js(`document.querySelector('.super-followup textarea').value`),
        '保留草稿',
      );
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
      await js(
        `document.querySelector('[data-close]').click();document.querySelector('[data-pause]').click();true;`,
      );
      await settle();
      assert.ok(await js(`calls.some(c=>c.action==='pause')`));
      console.log(
        'PASS: shared task center, model-pool labels, switches, light/dark layout, centered task details, exact once-only approval, incoming updates preserve drafts, and pause controls. Screenshots in .cache/previews/superagent-*.png.',
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
