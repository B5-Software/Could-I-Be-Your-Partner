/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real shared renderer and backend. LLM responses are local fixtures; no user data.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const nativeCodeOSS = process.argv.includes('--native-codeoss');
if (!nativeCodeOSS) {
  // CI shell coverage does not download an IDE. The explicit native run uses the real runtime.
  require('../../src/main/services/codeoss-service').CodeOSSService.prototype.open =
    async function (directory) {
      return { ok: true, path: directory, location: 'host' };
    };
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-frontends-'));
const workspace = path.join(profile, 'workspace');
for (const name of ['data', 'documents', 'workspace']) fs.mkdirSync(path.join(profile, name));
fs.writeFileSync(path.join(workspace, 'notes.md'), '# Shared workspace\n');
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    runtime: { location: 'host' },
    trayEnabled: false,
    closeToTray: 'never',
    notifications: { enabled: false },
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    automaticMemory: { enabled: false },
    decision: { enabled: false },
    tarotVisible: false,
    animations: false,
    modalAnimations: false,
    theme: { frontend: 'v1', mode: 'light', accentColor: '#3d4148', backgroundColor: '#f7f8fa' },
    codeMode: { lastWorkspace: workspace },
    llm: {
      provider: 'openai-compat',
      apiUrl: 'http://fixture.local/v1',
      apiKey: 'fixture',
      model: 'Fixture model',
      streamResponses: false,
    },
  }),
);
let hold = false;
let release;
let calls = 0;
require('../../src/main/net-proxy').install = () => {};
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url).includes('fixture.local')) {
    calls++;
    if (hold)
      await new Promise((resolve) => {
        release = resolve;
      });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                'The same task continued across both interfaces.\n\n| Interface | Backend |\n| --- | --- |\n| V1 | Shared |\n| V2 | Shared |',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return realFetch(url, options);
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
};
require('undici').fetch = global.fetch;
const errors = [];
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (event) => {
    if (
      event.level === 'error' &&
      /Uncaught|Initialization failed|Failed to load /.test(event.message)
    )
      errors.push(event.message);
  });
});
let finished = false;
const timeout = setTimeout(
  () => finish(new Error('Frontend shell verification timed out')),
  180000,
);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  hold = false;
  release?.();
  if (error) console.error('[frontend-shell] FAIL', error);
  else
    console.log(
      '[frontend-shell] PASS: shared components, active task, drafts, settings, modes, keyboard, responsive layout and screenshots',
    );
  app.exit(error ? 1 : 0);
}
const checkHelpers = `
  const check = (v, message) => { if(!v) throw new Error(message); };
  const until = async (fn, message = 'Condition timed out') => { const end = Date.now()+30000; while(!(await fn())) { if(Date.now()>end) throw new Error(message); await new Promise(r=>setTimeout(r,40)); } };
  const paint = () => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
`;
async function until(check, message, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}
ipcMain.once('app:renderer-ready', (event) =>
  setTimeout(async () => {
    const contents = event.sender;
    const win = BrowserWindow.fromWebContents(contents);
    // Windows runners can request reduced motion globally. Control it explicitly
    // so both enabled transitions and reduced-motion behavior are exercised.
    const motionPreference = (value) =>
      contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value }],
      });
    const screenshot = async (name) => {
      const destination = path.resolve(
        __dirname,
        '../../.cache/screenshots/frontend-' + name + '.png',
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, (await win.capturePage()).toPNG());
      console.log('[frontend-shell] screenshot', name);
    };
    try {
      contents.debugger.attach('1.3');
      await motionPreference('no-preference');
      win.setContentSize(1440, 940);
      await contents.executeJavaScript(`(async () => { ${checkHelpers}
      await until(()=>window.CibypFrontendShell && window.__sessionManager);
      check(document.documentElement.dataset.frontend==='v1','V1 default changed');
      window.__sharedManager=window.__sessionManager;
      window.__sharedAgent=window.__sessionManager.getActive('chat').agent;
      window.__sharedInput=document.getElementById('chat-input');
      window.__sharedComponents=[...document.querySelectorAll('#main-content > .page, .nav-item, .mode-btn, #btn-send, #btn-camera, #btn-attach-file, #btn-mic, #btn-todo-toggle')];
      await window.__sharedAgent.setMinimalMode(true);
      document.getElementById('chat-input').value='Keep the project requirements.';
      document.getElementById('btn-send').click();
    })()`);
      await contents.executeJavaScript(
        `(async()=>{${checkHelpers} await until(()=>!window.__sharedAgent.running && document.getElementById('chat-messages').textContent.includes('The same task continued'));})()`,
      );
      hold = true;
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
      document.getElementById('chat-input').value='Continue working while the interface switches.';
      document.getElementById('btn-send').click();
      await until(()=>window.__sharedAgent.running);
      document.getElementById('chat-input').value='Draft survives the switch';
      document.getElementById('chat-input').dispatchEvent(new Event('input',{bubbles:true}));
      window.navigatePage('settings'); window.activateSettingsTab('theme');
      await until(()=>document.getElementById('setting-frontend').value==='v1');
      const selector=document.getElementById('setting-frontend'); selector.value='v2'; selector.dispatchEvent(new Event('change',{bubbles:true}));
      await until(()=>document.documentElement.dataset.frontend==='v2');
      check(window.__sharedAgent.running, 'Switch stopped the running Agent');
      check(window.__sharedManager===window.__sessionManager, 'Switch replaced session manager');
      check(window.__sharedInput===document.getElementById('chat-input'), 'Switch replaced composer');
      check(document.getElementById('chat-input').value==='Draft survives the switch','Draft was lost');
      check(window.__sharedComponents.every(node=>node.isConnected),'Feature component was replaced');
      check(document.getElementById('session-tabs-host').closest('#sidebar'),'Sessions not in V2 sidebar');
      check(document.querySelector('.mode-switcher').closest('#sidebar'),'Modes not in V2 sidebar');
      window.navigatePage('chat'); await paint();
    })()`);
      assert.ok(release, 'The real model request was not held');
      hold = false;
      release();
      await contents.executeJavaScript(
        `(async()=>{${checkHelpers} await until(()=>!window.__sharedAgent.running); await paint();})()`,
      );
      await screenshot('v2-chat-light');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        window.navigatePage('settings'); window.activateSettingsTab('network-privacy');
        await until(()=>document.querySelector('.settings-panel[data-tab="network-privacy"]').classList.contains('active'));
        const settings=await window.api.getSettings();
        check(settings.networkPrivacy.tor.enabled===false,'Network privacy must be opt-in');
        const initial=await window.api.privacyTorStatus(); check(initial.phase==='stopped','Tor must not start by visiting settings');
        const catalog=await window.api.backendRequest('settings:catalog');
        check(catalog.fields.some(field=>field.path==='networkPrivacy.tor.enabled' && field.category==='network-privacy'),'Shared settings catalog is missing privacy');
        check(document.getElementById('setting-privacy-tor-enabled').closest('.toggle-switch'),'Privacy checkbox was not styled as a switch');
        const bridgeInput=document.getElementById('setting-privacy-tor-bridges');
        bridgeInput.value='invalid transport bridge';
        bridgeInput.dispatchEvent(new Event('change',{bubbles:true}));
        await until(()=>document.getElementById('privacy-tor-status').textContent.includes(' · '));
        check((await window.api.getSettings()).networkPrivacy.tor.bridges===settings.networkPrivacy.tor.bridges,'Invalid bridge was saved');
        bridgeInput.value=settings.networkPrivacy.tor.bridges||'';
        bridgeInput.dispatchEvent(new Event('change',{bubbles:true}));
        await until(()=>!document.getElementById('privacy-tor-status').textContent.includes(' · '));
        await paint();
      })()`);
      await screenshot('network-privacy');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        window.activateSettingsTab('llm');
        check(document.querySelector('#setting-opencode-transport option[value="sdk"]'),'SDK request engine is missing');
        const select=document.getElementById('setting-opencode-transport'); select.value='sdk'; select.dispatchEvent(new Event('change',{bubbles:true}));
        await until(async()=>(await window.api.getSettings()).llm.opencodeTransport==='sdk');
        select.value='cibyp';select.dispatchEvent(new Event('change',{bubbles:true}));
        await until(async()=>(await window.api.getSettings()).llm.opencodeTransport==='cibyp');
        window.navigatePage('chat');await paint();
      })()`);
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        check(getComputedStyle(document.querySelector('.titlebar-center')).webkitAppRegion==='drag','Titlebar blank center is not draggable');
        check(getComputedStyle(document.getElementById('btn-close')).webkitAppRegion==='no-drag','Window button lost click target');
        const idle=document.querySelector('.session-status-dot.idle'); if(idle) check(getComputedStyle(idle).display==='none','Idle session dot still visible');
        const before=await window.api.getSettings();
        await window.api.setSettings({llm:{pool:[{id:'fixture-primary',label:'Fixture model',model:'Fixture model',provider:'openai-compat',apiUrl:'http://fixture.local/v1',apiKey:'fixture',effort:'off',enabled:true},{id:'fixture-reasoning',label:'Reasoning model',model:'gpt-5',provider:'openai-compat',apiUrl:'http://fixture.local/v1',apiKey:'fixture',effort:'high',enabled:true}]}});
        document.querySelector('.chat-input-area .v2-composer-model').click();
        await until(()=>document.querySelector('.reasoning-picker-model')?.textContent.includes('Fixture'));
        document.querySelector('.reasoning-picker-model').click();
        await until(()=>document.querySelector('.model-picker-option[data-entry-id="fixture-reasoning"]'));
        document.querySelector('.model-picker-option[data-entry-id="fixture-reasoning"]').click();
        await until(()=>!document.querySelector('.model-picker'));
        check(window.__sharedAgent.getActiveModelId()==='gpt-5','Model selection did not reach backend');
        check(document.querySelector('.chat-input-area .v2-composer-model span').textContent==='Reasoning model','Composer did not use the custom model name');
        check((await window.api.getSettings()).llm.model===before.llm.model,'Session selection changed global default');
        document.querySelector('.chat-input-area .v2-composer-model').click();
        await until(()=>document.querySelector('.reasoning-picker input')?.max==='4');
        const slider=document.querySelector('.reasoning-picker input'); slider.value='2';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));
        await until(()=>!document.querySelector('.reasoning-picker')?.hasAttribute('aria-busy') && window.__sharedAgent.getActiveReasoningEffort()==='low');
        document.querySelector('.reasoning-picker-reset').click();
        await until(()=>!document.querySelector('.reasoning-picker')?.hasAttribute('aria-busy') && window.__sharedAgent.getActiveReasoningEffort()==='high');
        window.__effortPanel=document.querySelector('.reasoning-picker');
        await window.api.setSettings({animations:true}); await until(()=>document.documentElement.dataset.animations!=='off'); await paint();
        check(document.querySelector('.reasoning-picker')===window.__effortPanel,'Repeated appearance notification closed slider');
        check(parseFloat(getComputedStyle(document.querySelector('.reasoning-picker-thumb')).transitionDuration)>0,'Slider has no step transition');
        const request=window.CibypBackendViews.request;
        window.CibypBackendViews.request=async (...args)=>{ if(args[0]==='setSessionReasoning') await new Promise(r=>setTimeout(r,120)); return request(...args); };
        slider.value='1';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));
        check(slider.value==='1' && !slider.disabled,'Saving reset or disabled slider');
        slider.value='3';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));
        check(slider.value==='3' && getComputedStyle(document.querySelector('.reasoning-picker-thumb')).opacity==='1','Pending slider flickers');
        await until(()=>!window.__effortPanel.hasAttribute('aria-busy') && window.__sharedAgent.getActiveReasoningEffort()==='medium');
        check(document.querySelector('.reasoning-picker')===window.__effortPanel && slider.value==='3','Rapid changes did not retain final selection');
        window.CibypBackendViews.request=request;
        await window.api.setSettings({animations:false}); await paint();
        check(getComputedStyle(document.querySelector('.reasoning-picker-thumb')).transitionDuration==='0s','Global motion switch ignored');
        const fill=document.querySelector('.reasoning-picker-fill'), thumb=document.querySelector('.reasoning-picker-thumb');
        check(getComputedStyle(fill).borderTopRightRadius==='0px','Filled slider edge is still rounded');
        check(Math.abs(fill.getBoundingClientRect().right-(thumb.getBoundingClientRect().left+thumb.getBoundingClientRect().width/2))<1,'Slider fill does not reach the thumb center');
        await paint();
      })()`);
      await contents.executeJavaScript(
        `(async()=>{${checkHelpers} await window.api.setSettings({animations:true}); await until(()=>document.documentElement.dataset.animations!=='off');})()`,
      );
      await motionPreference('reduce');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        await paint();
        check(matchMedia('(prefers-reduced-motion: reduce)').matches,'Reduced-motion emulation failed');
        check(getComputedStyle(document.querySelector('.reasoning-picker-thumb')).transitionDuration==='0s','System reduced-motion preference ignored');
      })()`);
      await motionPreference('no-preference');
      await contents.executeJavaScript(
        `(async()=>{${checkHelpers} await window.api.setSettings({animations:false}); await until(()=>document.documentElement.dataset.animations==='off'); await paint();})()`,
      );
      await screenshot('v2-reasoning');
      const drag = await contents.executeJavaScript(
        `(()=>{const input=document.querySelector('.reasoning-picker input'),r=input.getBoundingClientRect();return{x:r.left+16+(r.width-32)*Number(input.value)/Number(input.max),target:r.left+16+(r.width-32)*.44,y:r.top+r.height/2};})()`,
      );
      contents.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(drag.x),
        y: Math.round(drag.y),
        button: 'left',
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(drag.target),
        y: Math.round(drag.y),
      });
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        await until(()=>document.querySelector('.reasoning-picker-track')?.dataset.dragging==='true');
        const slider=document.querySelector('.reasoning-picker input');
        check(!Number.isInteger(Number(slider.value)),'Pointer drag still jumps between discrete values');
        await window.api.setSettings({animations:true});await paint();
        check(document.querySelector('.reasoning-picker')===window.__effortPanel,'Appearance refresh closed active pointer drag');
        check(getComputedStyle(document.querySelector('.reasoning-picker-thumb')).opacity==='1','Thumb dimmed during pointer drag');
      })()`);
      contents.sendInputEvent({
        type: 'mouseUp',
        x: Math.round(drag.target),
        y: Math.round(drag.y),
        button: 'left',
        clickCount: 1,
      });
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        await until(()=>!window.__effortPanel.hasAttribute('aria-busy') && document.querySelector('.reasoning-picker input').value==='2');
        check(parseFloat(getComputedStyle(document.querySelector('.reasoning-picker-thumb')).transitionDuration)>0,'Release has no snap animation');
        await window.api.setSettings({animations:false}); await paint();
      })()`);
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        document.querySelector('[data-message-manager="chat"]').click();
        await until(()=>document.querySelector('.message-manager-row'));
        check(document.querySelector('.message-manager-scope').value==='both','Message deletion must default to chat and context');
        document.querySelector('.message-manager-row').click();
        await until(()=>!document.querySelector('.message-manager .btn-danger').disabled); await paint();
      })()`);
      await screenshot('v2-message-manager');
      await contents.executeJavaScript(
        `document.querySelector('.message-manager header button').click();`,
      );
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        document.getElementById('btn-todo-toggle').click(); await until(()=>!document.getElementById('todo-panel').classList.contains('hidden'));
        check(!document.querySelector('.message-manager'),'Todo button opened message manager');
        check(!document.querySelector('.message-manager-trigger .fa-list-check'),'Manager reused Todo icon');
        document.getElementById('btn-close-todo').click(); await until(()=>document.getElementById('todo-panel').classList.contains('hidden'));
        document.getElementById('btn-chat-search').click(); await paint();
        const bar=document.querySelector('.chat-search-bar').getBoundingClientRect(), title=document.getElementById('titlebar').getBoundingClientRect(), main=document.getElementById('main-content').getBoundingClientRect();
        check(bar.top>=title.bottom && bar.left>=main.left && bar.right<=main.right,'Search bar is behind titlebar or outside content');
        const hit=document.elementFromPoint(bar.left+20,bar.top+20);check(document.getElementById('chat-search-overlay').contains(hit),'Search is covered by another surface');
        document.getElementById('chat-search-input').value='same task';document.getElementById('chat-search-input').dispatchEvent(new Event('input')); await paint();
      })()`);
      await screenshot('v2-search');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        document.getElementById('chat-search-close').click();await until(()=>document.getElementById('chat-search-overlay').classList.contains('hidden'));
        const rows=[...document.querySelectorAll('#chat-messages .message.user,#chat-messages .message.assistant:not(.thinking-indicator)')];
        const view=await window.CibypBackendViews.request('getView',window.__sharedAgent.backendKey);
        for(const row of rows){check(!!row.dataset.messageId,'Live message has no authoritative ID');check(view.messages.some(m=>m.metadata?.messageId===row.dataset.messageId),'Live ID does not match stored message');}
        const target=rows.filter(row=>row.classList.contains('assistant')).at(-1);
        window.__deletedMessageId=target.dataset.messageId;target.querySelector('.message-delete-action').click();
        await until(()=>document.querySelector('.message-delete-dialog .btn-danger')?.disabled===false);await paint();
      })()`);
      await screenshot('v2-delete-message');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        document.querySelector('.message-delete-dialog .btn-danger').click();
        await until(()=>!document.querySelector('.message-delete-dialog'));
        await until(()=>!document.querySelector('[data-message-id="'+window.__deletedMessageId+'"]'));
        const view=await window.CibypBackendViews.request('getView',window.__sharedAgent.backendKey);
        check(!view.messages.some(m=>m.metadata?.messageId===window.__deletedMessageId),'Direct deletion left transcript');
        check(!view.workingMessages.some(m=>m.metadata?.messageId===window.__deletedMessageId),'Direct deletion left raw context');
        check(view.messages.filter(m=>m.role==='user' && m.metadata?.kind!=='context-update').length===2,'Assistant deletion removed unrelated user messages');
        const first=document.querySelector('#chat-messages .message.user');
        first.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:300}));
        const action=document.querySelector('.message-context-menu [data-message-action="delete-after"]');
        check(action && !action.disabled,'Delete-following action is unavailable'); action.click();
        await until(()=>document.querySelector('.message-delete-dialog .btn-danger')?.disabled===false);
        check(document.querySelector('.message-delete-dialog .message-manager-preview').textContent.includes('3'),'Following-message deletion preview omitted messages');
        document.querySelector('.message-delete-dialog .btn-secondary').click();
      })()`);
      console.log('[frontend-shell] Active task and draft preservation passed');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
      const search=document.getElementById('v2-session-search'); search.value='NO_MATCH_123'; search.dispatchEvent(new Event('input'));
      check(document.querySelector('#chat-session-tabs .session-tab.v2-filtered'),'Session filtering failed');
      const settings=await window.api.getSettings(); await window.api.setSettings({theme:{...settings.theme,frontend:'v1'}});
      await until(()=>document.documentElement.dataset.frontend==='v1');
      check(document.getElementById('session-tabs-host').parentElement.id==='main-content','V1 session tabs not restored');
      check(document.querySelector('.mode-switcher').closest('#titlebar'),'V1 modes not restored');
      check(document.querySelector('#sidebar > .sidebar-nav'),'V1 navigation not restored');
      check(!document.querySelector('.session-tab.v2-filtered'),'V2 filter leaked into V1');
      check(!document.getElementById('sidebar').inert,'V1 sidebar remained inert');
      check(getComputedStyle(document.getElementById('v2-rail')).display==='none','V2 rail leaked into V1');
      check(window.__sharedInput.value==='Draft survives the switch','Round trip lost draft');
      await window.api.setSettings({theme:{...settings.theme,frontend:'v2'}});
      await until(()=>document.documentElement.dataset.frontend==='v2');
      search.value=''; search.dispatchEvent(new Event('input'));
      const pages=[...document.querySelectorAll('#main-content > .page')].map(page=>page.id.slice(5));
      for(const page of pages.filter(p=>!['code','babe','code-history','babe-history'].includes(p))) {
        window.navigatePage(page); await paint();
        check(document.getElementById('page-'+page).classList.contains('active'),page+' cannot open');
        check(!document.getElementById('page-'+page).inert,page+' remains inert');
        check(document.querySelectorAll('#main-content > .page.active').length===1,'Multiple pages active');
      }
      window.navigatePage('settings'); window.activateSettingsTab('theme');
      await paint();
      check(document.querySelectorAll('.settings-tab').length>=30,'Missing settings categories');
      for(const button of document.querySelectorAll('.settings-tab')) {
        if(button.hidden || button.classList.contains('hidden')) continue;
        button.click();
        const panel=document.querySelector('.settings-panel[data-tab="'+button.dataset.tab+'"]');
        check(panel && panel.classList.contains('active'),'Missing settings panel '+button.dataset.tab);
      }
      window.activateSettingsTab('theme');
    })()`);
      await screenshot('v2-settings');
      console.log('[frontend-shell] All shared page and settings destinations passed');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
      document.getElementById('mode-btn-babe').click();
      await until(()=>window.getCurrentMode()==='babe' && window.__sessionManager.getActive('babe'));
      document.getElementById('babe-chat-input').value='A Babe draft';
      document.getElementById('babe-chat-input').dispatchEvent(new Event('input',{bubbles:true}));
      const before=window.__sessionManager.list('babe').length;
      document.getElementById('v2-new-session').click();
      await until(()=>window.__sessionManager.list('babe').length===before+1);
      check(window.__sessionManager.list('babe').some(s=>s.draft==='A Babe draft'),'Babe session draft missing');
      document.getElementById('v2-new-session').click();
      await until(()=>window.__sessionManager.list('babe').length===before+2);
      const tabs=[...document.querySelectorAll('#babe-session-tabs .session-tab')];
      const dragged=tabs[0].dataset.sessionKey, target=tabs[1], bounds=target.getBoundingClientRect();
      const transfer=new DataTransfer(); transfer.setData('text/plain',dragged);
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:bounds.bottom-1,clientX:bounds.left+1}));
      check(window.__sessionManager.ordered('babe')[1].key===dragged,'Vertical session drop inserted at the wrong index');
      const first=document.querySelector('#babe-session-tabs .session-tab'); first.focus(); first.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      check(document.activeElement!==first && document.activeElement.classList.contains('session-tab'),'Keyboard session navigation failed');
      document.getElementById('btn-babe-relationship').click();
      check(!document.getElementById('babe-relationship-panel').hidden,'Relationship panel unavailable');
      document.getElementById('btn-babe-relationship-close').click();
      const babeInput=document.getElementById('babe-chat-input'), babeSend=document.getElementById('btn-babe-send');
      babeInput.value='Keep this Babe draft';
      babeInput.dispatchEvent(new Event('input',{bubbles:true}));
      check(babeInput.closest('.v2-babe-composer'),'Babe composer not unified');
      babeInput.focus(); await paint();
      const border=getComputedStyle(babeInput.closest('.v2-babe-composer')).borderColor;
      const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const swatch=document.createElement('span'); swatch.style.color=accent; document.body.append(swatch);
      check(border===getComputedStyle(swatch).color, 'Babe focus does not follow accent '+accent+' / '+border); swatch.remove();
      const settings=await window.api.getSettings();
      await window.api.setSettings({theme:{...settings.theme,frontend:'v1'}});
      await until(()=>document.documentElement.dataset.frontend==='v1');
      check(babeInput.parentElement.classList.contains('babe-chat-input') && babeSend.parentElement===babeInput.parentElement,'V1 Babe controls not restored');
      await window.api.setSettings({theme:{...settings.theme,frontend:'v2'}});
      await until(()=>document.documentElement.dataset.frontend==='v2');
      check(babeInput===document.getElementById('babe-chat-input') && babeInput.value==='Keep this Babe draft','Babe composer switch lost draft or identity');
      await paint();
    })()`);
      await screenshot('v2-babe');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
      document.getElementById('mode-btn-code').click();
      await until(()=>window.getCurrentMode()==='code' && window.__sessionManager.getActive('code'), 'Code workspace/session unavailable');
      check(document.getElementById('code-workspace-path').textContent.includes('workspace'),'Workspace missing');
      document.getElementById('code-chat-input').value='Code draft';
      document.getElementById('code-chat-input').dispatchEvent(new Event('input',{bubbles:true}));
      const modeAgent=window.__sessionManager.getActive('code').agent;
      const s=await window.api.getSettings(); await window.api.setSettings({theme:{...s.theme,frontend:'v1'}});
      await until(()=>document.documentElement.dataset.frontend==='v1');
      await window.api.setSettings({theme:{...s.theme,frontend:'v2'}});
      await until(()=>document.documentElement.dataset.frontend==='v2');
      check(window.__sessionManager.getActive('code').agent===modeAgent,'Code agent replaced');
      check(document.getElementById('code-chat-input').value==='Code draft','Code draft lost');
      document.getElementById('btn-code-immersive').click(); await paint();
      check(getComputedStyle(document.getElementById('v2-rail')).display==='none','Rail visible in immersive mode');
      check(getComputedStyle(document.getElementById('btn-code-immersive')).display!=='none','Cannot exit immersive mode');
      document.getElementById('btn-code-immersive').click(); await paint();
    })()`);
      if (nativeCodeOSS) {
        const service = globalThis.__cibypWorkbenchHost;
        await until(() => service.activePeer(), 'Native Code-OSS did not connect', 60000);
        await until(() => service.visible, 'Native Code-OSS not visible');
        const view = await contents.executeJavaScript(
          'document.getElementById("codeoss-viewport").getBoundingClientRect().toJSON()',
        );
        assert.equal(service.bounds.x, Math.round(view.x));
        assert.equal(service.bounds.width, Math.round(view.width));
        await service.request('ide.command', {
          command: 'workbench.action.terminal.toggleTerminal',
        });
        await until(
          async () =>
            (await service.view.webContents.executeJavaScript('document.body.innerText')).includes(
              'notes.md',
            ),
          'Real IDE explorer unavailable',
        );
        const editorShot = await service.view.webContents.capturePage({ stayAwake: true });
        assert.ok(!editorShot.isEmpty(), 'Native IDE did not paint');
        fs.writeFileSync(
          path.resolve(__dirname, '../../.cache/screenshots/frontend-v2-code-editor.png'),
          editorShot.toPNG(),
        );
        win.setMinimumSize(0, 0);
        win.setContentSize(850, 940);
        await contents.executeJavaScript(`(async()=>{${checkHelpers}
          await paint(); document.getElementById('v2-sidebar-toggle').click(); await paint();
        })()`);
        await until(() => !service.visible, 'Native IDE covered the narrow sidebar drawer');
        await contents.executeJavaScript("document.querySelector('.v2-sidebar-backdrop').click()");
        await until(() => service.visible, 'Native IDE did not return after closing drawer');
        win.setContentSize(1440, 940);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await screenshot('v2-code');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
      document.getElementById('mode-btn-chat').click(); await until(()=>window.getCurrentMode()==='chat');
      const s=await window.api.getSettings(); await window.api.setSettings({theme:{...s.theme,frontend:'v2',mode:'dark',backgroundColor:'#18191c',accentColor:'#8ca6ef'}});
      await until(()=>document.documentElement.dataset.theme==='dark');
      window.navigatePage('chat'); await paint();
      check(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()==='#8ca6ef','Accent not shared');
      i18nSetLanguage('en');
      check(document.querySelector('#v2-new-session span').textContent==='New conversation','English shell missing');
      i18nSetLanguage('de');
      check(document.querySelector('#v2-new-session span').textContent==='Neue Unterhaltung','German shell missing');
      i18nSetLanguage('zh-CN'); await paint();
    })()`);
      await screenshot('v2-chat-dark');
      if (!nativeCodeOSS) {
        // Browser UI uses the same entry point and backend settings/events.
        const webStatus = await contents.executeJavaScript('window.api.webControlStart()');
        assert.ok(webStatus.running, webStatus.error);
        const web = new BrowserWindow({
          show: false,
          width: 1440,
          height: 940,
          webPreferences: {
            offscreen: true,
            contextIsolation: true,
            nodeIntegration: false,
            partition: 'frontend-shell-web',
          },
        });
        await web.loadURL(webStatus.url + '/login');
        const loginSettings = await contents.executeJavaScript('window.api.getSettings()');
        for (const language of ['zh-CN', 'en', 'de']) {
          await contents.executeJavaScript(
            `window.api.setSettings(${JSON.stringify({ language, theme: { mode: 'light', backgroundColor: '#f7f8fa' } })})`,
          );
          for (const width of [1440, 390]) {
            web.setContentSize(width, 900);
            await web.loadURL(webStatus.url + '/login');
            await web.webContents.executeJavaScript(`(async()=>{${checkHelpers}
              const reveal=document.getElementById('reveal'), password=document.getElementById('password');
              check(reveal.querySelector('svg') && !reveal.textContent.trim(),'Translated label replaced the eye icon');
              check(!!reveal.getAttribute('aria-label'),'Missing accessible password control');
              password.value='private draft';reveal.click();check(password.type==='text' && password.value==='private draft','Reveal lost password');
              check(parseFloat(getComputedStyle(password).paddingRight)>=46,'Revealed password overlaps eye');
              reveal.click();check(password.type==='password' && reveal.getAttribute('aria-pressed')==='false','Hide failed');
              const eye=reveal.getBoundingClientRect(), field=password.getBoundingClientRect();check(eye.width>=32 && eye.left>=field.left && eye.right<=field.right && eye.bottom<=field.bottom,'Eye outside input');
              check(document.documentElement.scrollWidth<=innerWidth,'Login overflows narrow screen'); await paint();
            })()`);
            if (language === 'zh-CN')
              fs.writeFileSync(
                path.resolve(__dirname, '../../.cache/screenshots/webui-login-' + width + '.png'),
                (await web.webContents.capturePage({ stayAwake: true })).toPNG(),
              );
          }
        }
        await contents.executeJavaScript(
          `window.api.setSettings(${JSON.stringify({ language: loginSettings.language, theme: loginSettings.theme })})`,
        );
        web.setContentSize(1440, 940);
        await web.loadURL(webStatus.url + '/login');
        await web.webContents.executeJavaScript(
          "document.getElementById('password').value='frontend-shell-test';document.querySelector('form').requestSubmit();",
        );
        await until(() => web.webContents.getURL().includes('/index.html'), 'WebUI login failed');
        await until(
          () =>
            web.webContents.executeJavaScript(
              '!!window.CibypFrontendShell && !!window.__sessionManager',
            ),
          'WebUI bootstrap failed',
        );
        await web.webContents.executeJavaScript(`(async()=>{${checkHelpers}
        check(document.documentElement.dataset.frontend==='v2','WebUI did not read shared frontend preference');
        check(document.querySelector('#sidebar #session-tabs-host'),'WebUI shell missing');
        window.__webInput=document.getElementById('chat-input'); window.__webInput.value='Browser draft';
        document.getElementById('btn-attach-file').click();
        await until(()=>document.querySelector('.attachment-source-menu[open]')); await paint();
        const modal=document.querySelector('.attachment-source-menu'), rect=modal.getBoundingClientRect();
        check(Math.abs(rect.left+rect.width/2-innerWidth/2)<2 && Math.abs(rect.top+rect.height/2-innerHeight/2)<2,'Attachment picker is not centered');
        modal.querySelector('button:last-child').click();
        window.__webInput.dispatchEvent(new Event('input',{bubbles:true}));
        await window.api.setSettings({theme:{frontend:'v1'}});
        await until(()=>document.documentElement.dataset.frontend==='v1');
        check(document.querySelector('#main-content > #session-tabs-host'),'Browser V1 restore failed');
        await window.api.setSettings({theme:{frontend:'v2'}});
        await until(()=>document.documentElement.dataset.frontend==='v2');
        check(window.__webInput===document.getElementById('chat-input') && window.__webInput.value==='Browser draft','Browser draft lost');
        window.navigatePage('settings'); window.activateSettingsTab('theme'); await paint();
        check(document.getElementById('setting-frontend').value==='v2','Browser settings selector out of sync');
        const theme=(await window.api.getSettings()).theme;
        check(theme.mode==='dark' && theme.accentColor==='#8ca6ef' && theme.backgroundColor==='#18191c','Frontend preference erased sibling appearance settings');
        await until(()=>document.getElementById('setting-accent-color').value===theme.accentColor,'Browser appearance controls not hydrated');
        await paint();
      })()`);
        await until(
          () => contents.executeJavaScript('document.documentElement.dataset.frontend==="v2"'),
          'GUI did not receive shared frontend preference',
        );
        fs.writeFileSync(
          path.resolve(__dirname, '../../.cache/screenshots/frontend-v2-webui.png'),
          (await web.webContents.capturePage({ stayAwake: true })).toPNG(),
        );
        web.destroy();
        console.log(
          '[frontend-shell] Authenticated WebUI, shared preference and browser draft passed',
        );
      }
      win.setMinimumSize(0, 0);
      win.setContentSize(550, 850);
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
      await paint(); check(document.documentElement.dataset.v2Sidebar==='closed','Mobile sidebar not collapsed');
      document.getElementById('v2-sidebar-toggle').click(); await paint();
      check(!document.getElementById('sidebar').inert,'Mobile sidebar cannot open');
      document.querySelector('.v2-sidebar-backdrop').click(); await paint();
      check(document.getElementById('sidebar').inert,'Mobile sidebar cannot close');
      const send=document.getElementById('btn-send').getBoundingClientRect();
      check(send.right<=innerWidth && send.bottom<=innerHeight && send.width>0,'Send button clipped on mobile');
      check(document.documentElement.scrollWidth<=innerWidth,'Horizontal document overflow');
      const messages=document.getElementById('chat-messages');
      check(messages.scrollWidth<=messages.clientWidth+1,'Chat area has horizontal overflow');
      const title=document.querySelector('.titlebar-center').getBoundingClientRect(), controls=document.querySelector('.titlebar-controls').getBoundingClientRect();
      check(title.right<=controls.left+1,'Title overlaps window controls');
    })()`);
      await screenshot('v2-narrow');
      win.setContentSize(1440, 940);
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        const s=await window.api.getSettings(); await window.api.setSettings({theme:{...s.theme,frontend:'v2',mode:'light',backgroundColor:'#f7f8fa',accentColor:'#3d4148'}});
        const count=window.__sessionManager.list('chat').length;
        document.getElementById('v2-new-session').click();
        await until(()=>window.__sessionManager.list('chat').length===count+1);
        await until(()=>document.querySelector('#chat-messages .welcome-message'));
        const quick=document.querySelector('.chat-input-area .quick-actions');
        check(quick && quick.querySelectorAll('button').length>=3,'Welcome actions not below composer');
        const input=document.getElementById('chat-input'); input.value='Welcome draft'; input.dispatchEvent(new Event('input',{bubbles:true}));
        await window.api.setSettings({theme:{frontend:'v1'}});
        await until(()=>document.documentElement.dataset.frontend==='v1');
        check(quick===document.querySelector('#chat-messages .welcome-message .quick-actions'),'V1 welcome actions not restored');
        await window.api.setSettings({theme:{frontend:'v2'}});
        await until(()=>document.documentElement.dataset.frontend==='v2');
        check(quick===document.querySelector('.chat-input-area .quick-actions') && input.value==='Welcome draft','Welcome switch lost quick actions or draft');
        input.value=''; input.dispatchEvent(new Event('input',{bubbles:true}));
        window.CibypFrontendShell.invalidateHistory();
        await new Promise(r=>setTimeout(r,800));
        const openIds=new Set([...document.querySelectorAll('#chat-session-tabs .session-tab')].map(t=>t.dataset.historyId));
        check([...document.querySelectorAll('.v2-recent-item')].every(t=>!openIds.has(t.dataset.historyId)),'Sidebar repeats open conversations');
        await paint();
      })()`);
      await screenshot('v2-welcome');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        const transfer=new DataTransfer(); transfer.items.add(new File(['# Monthly project notes'], 'project-notes.md', {type:'text/markdown'}));
        document.querySelector('.chat-input-area').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
        await until(()=>document.querySelector('#attachments-preview .attachment-item'));
        check(document.querySelector('.input-wrapper #attachments-preview'),'Attachments are outside composer');
        const preview=document.getElementById('attachments-preview'), rect=preview.getBoundingClientRect(), input=document.querySelector('.input-wrapper').getBoundingClientRect();
        check(rect.left>=input.left && rect.right<=input.right,'Attachment card overflows composer');
        check(getComputedStyle(preview).borderTopWidth==='0px','Old full-width attachment strip remains');await paint();
      })()`);
      await screenshot('v2-attachments');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        const s=await window.api.getSettings(); await window.api.setSettings({theme:{...s.theme,mode:'dark',backgroundColor:'#18191c',accentColor:'#8ca6ef'}});
        await until(()=>document.documentElement.dataset.theme==='dark'); await paint();
      })()`);
      await screenshot('v2-welcome-dark');
      await contents.executeJavaScript(`(async()=>{${checkHelpers}
        const owner=window.__sessionManager.getActive('chat').agent, key=owner.backendKey;
        await owner.sendMessage('Delete this fixture conversation');
        const view=await window.CibypBackendViews.request('getView',key);
        await window.CibypBackendViews.request('deleteHistory','chat',view.session.conversationId);
        await until(()=>window.__sessionManager.getActive('chat')?.agent.backendKey!==key && window.__sessionManager.getActive('chat'));
        await owner.resetOptimizedTools(); await owner.saveToHistory();
        check((await window.CibypBackendViews.request('getView',key))===null,'Deleted session was resurrected');
        const next=window.__sessionManager.getActive('chat').agent;
        await next.sendMessage('Continue after deletion');
        check(!next._backendClosed && next.conversationId,'Replacement conversation is not usable');
      })()`);
      assert.ok(calls >= 2);
      assert.deepEqual(errors, []);
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'data/settings.json')));
      assert.equal(saved.theme.frontend, 'v2');
      finish();
    } catch (error) {
      finish(error);
    }
  }, 800),
);
(async () => {
  const reservation = require('node:net').createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const file = path.join(profile, 'data/settings.json');
  const settings = JSON.parse(fs.readFileSync(file));
  settings.webControl = {
    enabled: false,
    host: '127.0.0.1',
    port,
    password: 'frontend-shell-test',
  };
  fs.writeFileSync(file, JSON.stringify(settings));
  require('../../src/main/main.js');
})().catch(finish);
