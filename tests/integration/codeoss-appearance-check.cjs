const assert = require('node:assert/strict');
module.exports = async function appearance(renderer, service, waitFor) {
  const evaluate = (script) => renderer.executeJavaScript(script);
  const geometry = await evaluate(`(() => {
    const messages = document.getElementById('code-chat-messages');
    const user = messages.querySelector('.message.user');
    const box = messages.getBoundingClientRect(), bubble = user.getBoundingClientRect();
    const usage = document.querySelector('.code-agent-usage').getBoundingClientRect();
    const indicator = document.querySelector('.code-agent-usage .context-indicator').getBoundingClientRect();
    return {gap: box.right - bubble.right, padding: parseFloat(getComputedStyle(messages).paddingRight), usageRight: usage.right, indicatorRight: indicator.right, indicatorWidth: indicator.width, usageWidth: usage.width};
  })()`);
  assert(
    Math.abs(geometry.gap - geometry.padding) < 20,
    'User messages must align with the right edge, allowing only the scrollbar',
  );
  assert(
    geometry.usageRight - geometry.indicatorRight <= 13,
    'Usage indicators belong on the right',
  );
  assert(
    geometry.indicatorWidth < geometry.usageWidth - 20,
    'Hover trigger must fit the indicators',
  );
  assert(
    await evaluate(`['user','assistant'].every(role => {
    const avatar=document.querySelector('#code-chat-messages .message.'+role+' .message-avatar');
    return avatar?.querySelector('img') && avatar.querySelector('.avatar-frame-overlay svg') && avatar.getBoundingClientRect().width >= 30;
  })`),
    'Code messages preserve configured avatars and frames',
  );
  await evaluate(
    `window.api.setSettings({ aiPersona: { avatar: '' }, userProfile: { avatar: '' } })`,
  );
  await waitFor(() =>
    evaluate(
      `!!document.querySelector('#code-chat-messages .message.user .message-avatar .fa-user') && !!document.querySelector('#code-chat-messages .message.assistant .message-avatar .fa-robot') && !document.querySelector('#code-chat-messages .message-avatar img')`,
    ),
  );
  const logos = () =>
    service.view.webContents.executeJavaScript(
      `({immersive:document.body.dataset.cibypImmersive, icons:[...document.querySelectorAll('.window-appicon,.letterpress')].map(e=>({display:getComputedStyle(e).display,background:getComputedStyle(e).backgroundImage}))})`,
    );
  assert(
    (await logos()).icons.every((item) => item.display === 'none'),
    'Brand logos are hidden outside immersive mode',
  );
  await evaluate(`document.getElementById('btn-code-immersive').click()`);
  await waitFor(() => service.immersive && service.bounds.x === 0 && service.bounds.y <= 32);
  const immersive = await evaluate(
    `({outer:['titlebar','sidebar','session-tabs-host'].map(id=>document.getElementById(id).getClientRects().length), chat:document.getElementById('code-agent-panel').getBoundingClientRect().width, exit:document.getElementById('btn-code-immersive').getClientRects().length})`,
  );
  assert(immersive.outer.every((count) => count === 0));
  assert(immersive.chat >= 300 && immersive.exit === 1);
  assert((await logos()).icons.every((item) => item.background.startsWith('url("data:image/png')));
  const icon = await service.view.webContents.executeJavaScript(`(() => {
    const element = document.querySelector('.window-appicon');
    return element ? getComputedStyle(element).backgroundSize : null;
  })()`);
  if (icon) assert.equal(icon, '18px 18px');
  await evaluate(`document.getElementById('btn-code-immersive').click()`);
  await waitFor(() => !service.immersive && service.bounds.x > 0);
  await evaluate(`window.navigatePage('about')`);
  assert.match(
    await evaluate(`document.getElementById('about-codeoss-version').textContent`),
    /Code-OSS 1\.135\.0/,
  );
  await evaluate(`window.navigatePage('code')`);
  await waitFor(() => service.visible);
  for (const enabled of [false, true]) {
    await evaluate(`window.api.setSettings({theme:{focusOutlines:${enabled}}})`);
    await waitFor(() =>
      service.view.webContents.executeJavaScript(
        `globalThis.__cibypAppearance?.colors.focusBorder === '${enabled ? '#725ce7' : '#00000000'}'`,
      ),
    );
    await waitFor(() =>
      evaluate(`document.documentElement.dataset.focusOutlines === '${enabled ? 'on' : 'off'}'`),
    );
  }
  console.log(
    '[codeoss-desktop] Right-aligned chat/usage, compact hover, immersive branding and About version passed.',
  );
};
