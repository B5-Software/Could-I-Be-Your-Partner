/* SPDX-License-Identifier: GPL-3.0-or-later */
const api = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let stream;
let activeSession;
function add(role, text, html) {
  const element = document.createElement('article');
  element.className = role;
  if (html) element.innerHTML = html;
  else element.textContent = text || '';
  $('messages').append(element);
  $('messages').scrollTop = $('messages').scrollHeight;
  return element;
}
function running(value) {
  $('send').disabled = value;
  $('stop').hidden = !value;
  $('status').textContent = value ? '处理中…' : '就绪';
}
function send() {
  const text = $('prompt').value.trim();
  if (!text || $('send').disabled) return;
  $('prompt').value = '';
  running(true);
  api.postMessage({ type: 'send', text, context: $('context').checked });
}
$('send').onclick = send;
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
};
$('stop').onclick = () => api.postMessage({ type: 'stop' });
$('new').onclick = () => api.postMessage({ type: 'new' });
$('settings').onclick = () => api.postMessage({ type: 'settings' });
$('attach').onclick = () => api.postMessage({ type: 'attach' });
$('sessions').onchange = () => api.postMessage({ type: 'session', key: $('sessions').value });
for (const id of ['approve', 'reject'])
  $(id).onclick = () => {
    api.postMessage({ type: 'approve', approved: id === 'approve' });
    $('approval').hidden = true;
  };
$('messages').onclick = (event) => {
  const link = event.target.closest('a');
  if (link) {
    event.preventDefault();
    api.postMessage({ type: 'openLink', url: link.href });
  }
};
window.addEventListener('message', (event) => {
  const { type, data } = event.data;
  if (type === 'personalization')
    $('model').textContent =
      `${data.model || '请配置模型'} · 上下文 ${Math.round(data.maxContext / 1024)}K`;
  if (type === 'draft') {
    $('prompt').value = data;
    $('prompt').focus();
  }
  if (type === 'user') add('user', data.text);
  if (type === 'error') add('error', data);
  if (type === 'running') running(data);
  if (type === 'attachments') {
    $('attachments').replaceChildren();
    for (const [index, file] of data.entries()) {
      const button = document.createElement('button');
      button.textContent = `${file.name} ×`;
      button.title = `${file.path} · 点击移除`;
      button.onclick = () => api.postMessage({ type: 'removeAttachment', index });
      $('attachments').append(button);
    }
  }
  if (type === 'sessions') {
    if (activeSession !== data.activeKey || !data.running) {
      activeSession = data.activeKey;
      $('messages').replaceChildren();
      stream = null;
      for (const message of data.messages || []) add(message.role, message.content, message.html);
    }
    $('sessions').replaceChildren();
    for (const session of data.sessions || []) {
      const option = document.createElement('option');
      option.value = session.key;
      option.textContent = session.title || '未命名会话';
      option.selected = session.key === activeSession;
      $('sessions').append(option);
    }
    running(data.running === true);
    $('approval').hidden = !data.approval;
    if (data.approval) {
      $('approval-text').textContent =
        `${data.approval.toolName}\n${JSON.stringify(data.approval.args, null, 2)}`;
      $('approval').hidden = false;
    }
  }
  if (type === 'agent') {
    if (data.sessionKey && activeSession && data.sessionKey !== activeSession) return;
    const value = data.data;
    if (data.type === 'stream-start') stream = add('assistant', '');
    if (data.type === 'stream-chunk' && data.html) {
      if (!stream) stream = add('assistant', '');
      stream.innerHTML = data.html;
    }
    if (data.type === 'stream-end' && data.html && stream) {
      stream.innerHTML = data.html;
      stream = null;
    }
    if (data.type === 'assistant' && !stream)
      add('assistant', value?.content || String(value || ''), data.html);
    if (data.type === 'error' || data.type === 'system')
      add(data.type, typeof value === 'string' ? value : value?.content || '');
    if (data.type === 'tool_call') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `工具 · ${value?.name || value?.toolName || '执行中'}`;
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(value, null, 2)?.slice(0, 12000) || '';
      details.append(summary, pre);
      $('messages').append(details);
    }
    if (data.type === 'approval') {
      $('approval-text').textContent = `${value.toolName}\n${JSON.stringify(value.args, null, 2)}`;
      $('approval').hidden = false;
    }
    $('messages').scrollTop = $('messages').scrollHeight;
  }
});
api.postMessage({ type: 'ready' });
