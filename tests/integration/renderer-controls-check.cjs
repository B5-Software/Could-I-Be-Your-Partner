/* Actual pointer/keyboard interaction with the shared switch surface. */
const assert = require('node:assert/strict');
module.exports = async function checkControls(contents) {
  const point = await contents.executeJavaScript(`(async () => {
    await window.navigatePage('settings');
    window.activateSettingsTab('webcontrol');
    const input = document.getElementById('setting-tor-auto');
    input.scrollIntoView({block:'center', behavior:'instant'});
    await new Promise(resolve=>setTimeout(resolve,40));
    const raw = [...document.querySelectorAll('input[type="checkbox"]')].filter(item=>!item.indeterminate && (item.getAttribute('role') !== 'switch' || getComputedStyle(item).appearance !== 'none' || parseFloat(getComputedStyle(item).width) < 40));
    if(raw.length) throw new Error('Unstyled controls: '+raw.map(item=>item.id||item.className).join(', '));
    const rect = input.getBoundingClientRect();
    if(getComputedStyle(input).opacity !== '1') throw new Error('Switch input is invisible');
    const progress = document.getElementById('tor-progress');
    if(getComputedStyle(progress).appearance !== 'none' || progress.clientHeight !== 6) throw new Error('Tor progress uses native styling');
    const rows = [...document.querySelectorAll('.tor-remote-settings .settings-actions')];
    if(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom < 14) throw new Error('Tor actions touch vertically');
    for(const row of rows) {
      const buttons=[...row.children];
      if(buttons.length!==2 || buttons[1].getBoundingClientRect().left - buttons[0].getBoundingClientRect().right < 8) throw new Error('Tor actions touch horizontally');
    }
    return { x:Math.round(rect.left+rect.width/2), y:Math.round(rect.top+rect.height/2), initial:input.checked };
  })()`);
  contents.sendInputEvent({
    type: 'mouseDown',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  contents.sendInputEvent({
    type: 'mouseUp',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  const waitFor = async (expected) => {
    const deadline = Date.now() + 3000;
    let value;
    do {
      value = await contents.executeJavaScript(
        `(async()=>({checked:document.getElementById('setting-tor-auto').checked,saved:(await window.api.getSettings()).remote.tor.autoStart}))()`,
      );
      if (value.checked === expected && value.saved === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.fail('Switch state did not persist: ' + JSON.stringify(value));
  };
  await waitFor(!point.initial);
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor(point.initial);
  console.log(
    '[desktop-smoke] Shared switches: pointer, Space, persistence and Tor layout passed.',
  );
};
