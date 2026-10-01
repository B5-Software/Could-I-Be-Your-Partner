/* Loads the real bridge inside Electron. Never requests permission or posts input. */
const { app } = require('electron');
const assert = require('node:assert/strict');
const { loadMacBridge } = require('../../src/main/services/macos-computer');

app.whenReady().then(async () => {
  try {
    assert.equal(process.platform, 'darwin');
    const bridge = loadMacBridge();
    const state = JSON.parse(bridge.invoke('permissions', '{}'));
    assert.equal(state.ok, true);
    for (const permission of ['accessibility', 'screen', 'postEvents'])
      assert.equal(typeof state[permission], 'boolean');
    if (!state.accessibility) {
      const tree = JSON.parse(await bridge.getUITree());
      assert.equal(tree.ok, false);
      assert.equal(tree.code, 'accessibility_required');
    }
    console.log(
      '[computer-smoke] Electron loaded the native bridge; silent preflight verified',
      state,
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
