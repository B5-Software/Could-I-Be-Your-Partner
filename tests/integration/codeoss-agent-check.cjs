/* Exercise the host AI UI against the real IDE and a local model endpoint. */
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function checkAgent(renderer, service, requests, workspace, waitFor) {
  const evaluate = (script) => renderer.executeJavaScript(script);
  await waitFor(() =>
    evaluate(
      `window.getCurrentMode() === 'code' && document.querySelector('#code-chat-messages .assistant') && !document.getElementById('btn-code-send').classList.contains('hidden')`,
    ),
  );
  const editor = await service.request('ide.context', {});
  assert(editor.path.endsWith('sample.js'));
  assert.equal(editor.selection.selected, true);
  await evaluate(`(() => {
    const input = document.getElementById('code-chat-input');
    input.value = 'sidebar UI fixture';
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', isComposing:true, bubbles:true}));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    await evaluate(`document.getElementById('code-chat-input').value`),
    'sidebar UI fixture',
  );
  const before = requests.length;
  await evaluate(`document.getElementById('btn-code-send').click()`);
  await waitFor(() => requests.length > before);
  await waitFor(() =>
    evaluate(
      `!document.getElementById('btn-code-send').classList.contains('hidden') && document.getElementById('code-agent-status').textContent === '待命中'`,
    ),
  );
  assert(
    requests
      .slice(before)
      .some((request) => JSON.stringify(request.messages).includes(editor.content)),
  );
  assert(
    requests
      .slice(before)
      .some((request) => JSON.stringify(request.messages).includes('sidebar UI fixture')),
  );
  assert.match(
    await evaluate(`document.getElementById('code-chat-messages').innerText`),
    /CIBYP fixture completed/,
  );
  assert(
    await evaluate(`document.querySelectorAll('#code-chat-messages .tool-call-card').length > 0`),
  );
  assert.equal(
    await evaluate(`document.getElementById('btn-code-stop').classList.contains('hidden')`),
    true,
  );

  assert(
    requests
      .slice(before)
      .some((request) =>
        request.messages.some(
          (message) =>
            typeof message.content === 'string' && message.content.includes('【当前编辑器】'),
        ),
      ),
    'Editor context must use the append-only runtime context source',
  );
  const firstKey = await evaluate(
    `document.querySelector('#code-session-tabs .session-tab.active').dataset.sessionKey`,
  );
  await evaluate(`document.getElementById('btn-code-new-session').click()`);
  await waitFor(() =>
    evaluate(
      `document.querySelectorAll('#code-session-tabs .session-tab').length === 2 && !!document.querySelector('#code-chat-messages .welcome-message')`,
    ),
  );
  await evaluate(
    `document.querySelector('#code-session-tabs [data-session-key=${JSON.stringify(firstKey)}]').click()`,
  );
  await waitFor(() =>
    evaluate(
      `document.getElementById('code-chat-messages').innerText.includes('sidebar UI fixture')`,
    ),
  );
  assert.doesNotMatch(
    await evaluate(`document.getElementById('code-chat-messages').innerText`),
    /"selection":|【运行时上下文更新】/,
    'AI history must show tasks without exposing internal context snapshots',
  );
  const checkpoints = await service.request('ide.changes', {});
  const key = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const checkpoint = checkpoints.changes.find(
    (item) => key(item.path) === key(path.join(workspace, 'agent-result.js')),
  );
  assert(checkpoint, 'Agent file tool must create an IDE checkpoint');
  await waitFor(() =>
    evaluate(
      `Number(document.getElementById('code-changes-count').textContent) === ${checkpoints.changes.length}`,
    ),
  );
  await evaluate(`document.getElementById('code-agent-changes').open = true`);
  const generated = checkpoint.path;
  await evaluate(
    `[...document.querySelectorAll('#code-changes-list .code-change-file')].find(button => button.title === ${JSON.stringify(generated)}).click()`,
  );
  await waitFor(() =>
    service.view.webContents.executeJavaScript(`document.body.innerText.includes('CIBYP 修改')`),
  );
  await evaluate(
    `[...document.querySelectorAll('#code-changes-list .code-change-file')].find(button => button.title === ${JSON.stringify(generated)}).parentElement.querySelector('button[aria-label="接受修改"]').click()`,
  );
  await waitFor(
    async () =>
      !(await service.request('ide.changes', {})).changes.some((item) => item.path === generated),
  );
  const openGeometry = await evaluate(`(() => {
    const viewport = document.getElementById('codeoss-viewport').getBoundingClientRect();
    return {left:viewport.left, right:viewport.right};
  })()`);
  await evaluate(`document.getElementById('btn-code-agent').click()`);
  await waitFor(() =>
    evaluate(`document.getElementById('code-agent-panel').getBoundingClientRect().width === 0`),
  );
  const closedGeometry = await evaluate(`(() => {
    const viewport = document.getElementById('codeoss-viewport').getBoundingClientRect();
    return {left:viewport.left, right:viewport.right};
  })()`);
  assert.equal(
    closedGeometry.left,
    openGeometry.left,
    'AI collapse must keep the IDE left edge fixed',
  );
  assert(closedGeometry.right > openGeometry.right + 290);
  assert.equal(await evaluate(`document.getElementById('code-agent-panel').inert`), true);
  await service.request('ide.command', { command: 'cibyp.agent.focus' });
  await waitFor(() =>
    evaluate(`document.getElementById('code-agent-panel').getBoundingClientRect().width >= 300`),
  );
  const geometry = await evaluate(`(() => {
    const viewport = document.getElementById('codeoss-viewport').getBoundingClientRect();
    const ai = document.getElementById('code-agent-panel').getBoundingClientRect();
    return {right:viewport.right, left:ai.left};
  })()`);
  assert.equal(geometry.right, geometry.left);
  await waitFor(
    () => Math.abs(service.view.getBounds().width - (geometry.right - openGeometry.left)) < 2,
  );
  console.log(
    '[codeoss-desktop] Host AI: editor selection, real tools, streaming, sessions, changes and independent layout passed.',
  );
};
