/* SPDX-License-Identifier: GPL-3.0-or-later */
  let remoteDeviceEditing = null;
  const remoteDeviceText = (key, fallback) => t('ui.remoteDevices.' + key, fallback);
  function remoteDeviceElement(tag, text, className) {
    const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element;
  }
  async function remoteDeviceCall(method, params = {}) {
    const reply = await window.api.remoteCall(method, params);
    if (!reply?.ok) throw new Error(reply?.error || 'Remote unavailable'); return reply.result;
  }
  function addRemoteDeviceGrant(name = '', grant = {}) {
    const row = remoteDeviceElement('div', '', 'remote-device-grant');
    const tool = remoteDeviceElement('input'); tool.placeholder = remoteDeviceText('tool', '工具名，例如 gpio_write'); tool.value = name; tool.required = true; tool.maxLength = 80; tool.setAttribute('aria-label', tool.placeholder);
    const resources = remoteDeviceElement('input'); resources.placeholder = remoteDeviceText('resources', '资源，例如 gpio:17，多个以逗号分隔'); resources.value = (grant.resources || []).join(', '); resources.required = true; resources.maxLength = 2048; resources.setAttribute('aria-label', resources.placeholder);
    const write = remoteDeviceElement('input'); write.type = 'checkbox'; write.checked = grant.write === true; write.setAttribute('role', 'switch');
    const label = remoteDeviceElement('label', '', 'remote-device-write'); label.append(write, remoteDeviceElement('span', remoteDeviceText('write', '允许写入（需要审批和租约）')));
    const remove = remoteDeviceElement('button', remoteDeviceText('remove', '移除'), 'btn-secondary'); remove.type = 'button'; remove.onclick = () => row.remove();
    row.append(tool, resources, label, remove); row.grantFields = {tool, resources, write}; document.getElementById('remote-device-grants').append(row);
  }
  async function refreshRemoteDevices() {
    const root = document.getElementById('remote-devices-list'); if (!root) return;
    try {
      const devices = []; let offset = 0;
      do { const page = await remoteDeviceCall('device.page', {offset, limit: 32}); devices.push(...page.items); offset = page.nextOffset; } while (offset !== null && devices.length < 128);
      root.replaceChildren();
      if (!devices.length) root.append(remoteDeviceElement('p', remoteDeviceText('empty', '尚未配对设备'), 'setting-hint'));
      for (const device of devices) {
        const card = remoteDeviceElement('article', '', 'remote-device-card');
        card.append(remoteDeviceElement('strong', device.label || device.id), remoteDeviceElement('span', device.online ? remoteDeviceText('online', '在线') : remoteDeviceText('offline', '离线'), 'remote-device-state'));
        const permissions = remoteDeviceElement('ul');
        permissions.append(remoteDeviceElement('li', device.toolCount + ' · ' + remoteDeviceText('authorizedTools', '授权工具')));
        card.append(permissions);
        const actions = remoteDeviceElement('div', '', 'remote-device-actions');
        const edit = remoteDeviceElement('button', remoteDeviceText('edit', '修改权限'), 'btn-secondary'); edit.onclick = async () => {
          edit.disabled = true;
          try { const detail = await remoteDeviceCall('device.get', {deviceId: device.id});
          remoteDeviceEditing = device.id; document.getElementById('remote-device-id').value = device.id; document.getElementById('remote-device-grants').replaceChildren();
          for (const [name, grant] of Object.entries(detail.policy.tools || {})) addRemoteDeviceGrant(name, grant);
          document.getElementById('remote-device-credentials').hidden = true; document.getElementById('remote-device-id').focus();
          } catch (error) { root.append(remoteDeviceElement('p', error.message)); } finally { edit.disabled = false; }
        };
        const revoke = remoteDeviceElement('button', remoteDeviceText('revoke', '撤销设备'), 'btn-secondary'); let confirming = false;
        revoke.onclick = async () => {
          if (!confirming) {confirming = true; revoke.textContent = remoteDeviceText('confirmRevoke', '再次点击确认撤销'); return;}
          try {await remoteDeviceCall('device.revoke', {deviceId: device.id, operationId: crypto.randomUUID()}); await refreshRemoteDevices();} catch (error) {root.append(remoteDeviceElement('p', error.message));}
        };
        actions.append(edit, revoke); card.append(actions); root.append(card);
      }
    } catch (error) {root.replaceChildren(remoteDeviceElement('p', error.message, 'setting-hint'));}
  }
  document.getElementById('remote-devices-refresh')?.addEventListener('click', refreshRemoteDevices);
  document.getElementById('remote-device-add')?.addEventListener('click', () => addRemoteDeviceGrant());
  document.getElementById('remote-device-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const result = document.getElementById('remote-device-result'); const button = event.submitter; button.disabled = true;
    try {
      const deviceId = document.getElementById('remote-device-id').value.trim(), tools = {};
      for (const row of document.querySelectorAll('.remote-device-grant')) {const {tool, resources, write} = row.grantFields; if (Object.hasOwn(tools, tool.value.trim())) throw new Error(remoteDeviceText('duplicate', '工具名不能重复')); tools[tool.value.trim()] = {resources: resources.value.split(',').map(v => v.trim()).filter(Boolean), write: write.checked};}
      const editing = deviceId === remoteDeviceEditing;
      const value = await remoteDeviceCall(editing ? 'device.setPolicy' : 'device.provision', {deviceId, policy: {tools}, operationId: crypto.randomUUID()});
      const credentials = document.getElementById('remote-device-credentials'); credentials.hidden = editing;
      if (!editing) credentials.value = JSON.stringify(value, null, 2);
      result.textContent = remoteDeviceText('saved', '已保存。请将网关 WSS 地址和新凭据配置到设备。'); remoteDeviceEditing = deviceId; await refreshRemoteDevices();
    } catch (error) {result.textContent = error.message;} finally {button.disabled = false;}
  });
  addRemoteDeviceGrant('gpio_read', {resources: ['gpio:17']});
