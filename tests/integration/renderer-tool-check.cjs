/* Real renderer schemas, tool discovery, settings and permission setup UI. */
module.exports = async function checkTools(webContents) {
  return webContents.executeJavaScript(`(async () => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const probe = new Agent();
    const settings = await window.api.getSettings();
    probe.settings = { ...settings, llm: { ...settings.llm, maxContextLength: 32768 }, toolExposure: { mode: 'adaptive', budgetTokens: 4000 } };
    probe.mode = 'code';
    const initial = probe.getRuntimeToolSchemas();
    check(initial.some(tool => tool.function.name === 'searchTools'), 'Code must support tool discovery');
    check(Math.ceil(JSON.stringify(initial).length / 4) <= 4000, 'Code schema budget exceeded');
    const search = await probe.executeTool('searchTools', { names: ['downloadFile'] });
    check(search.tools[0]?.loaded, 'deferred Code tool failed to load');
    check(probe.getRuntimeToolSchemas().some(tool => tool.function.name === 'downloadFile'), 'loaded schema missing from next request');
    const description = await probe.executeTool('describeTool', { name: 'downloadFile' });
    check(description.properties?.url, 'original tool parameters unavailable');
    await window.api.backendRequest('saveSettings', { tools: { ...settings.tools, downloadFile: false } });
    check(!(await probe.executeTool('searchTools', { names: ['downloadFile'] })).tools.length, 'disabled tool remained discoverable');
    await window.api.backendRequest('saveSettings', { tools: { ...settings.tools, downloadFile: true } });
    await window.api.backendRequest('close', probe.backendKey);
    probe.unsubscribeStreams();
    const permissions = await window.api.computerPermissions();
    check(permissions.ok && permissions.location === 'host', 'permission preflight IPC failed');
    await window.navigatePage('tools');
    const deadline = Date.now() + 3000;
    while (!document.querySelector('[data-computer-recheck]') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    check(!!document.querySelector('[data-computer-recheck]'), 'permission setup card did not render');
    check(!!document.querySelector('#tool-schema-budget'), 'schema budget preference missing');
    check(!!document.querySelector('#toggle-auto-optimize-tools') && !!document.querySelector('#toggle-tool-discovery'), 'Jev optimization and discovery must have independent preferences');
    const optimizer = document.querySelector('#toggle-auto-optimize-tools');
    const discovery = document.querySelector('#toggle-tool-discovery');
    const waitSetting = async (label, predicate) => {
      const deadline = Date.now() + 3000;
      let last;
      while (Date.now() < deadline) {
        const current = await window.api.getSettings(); last = { autoOptimize: current.autoOptimizeToolSelection, mode: current.toolExposure?.mode }; if (predicate(current)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Tool preference did not persist: ' + label + ' ' + JSON.stringify(last));
    };
    optimizer.checked = true; optimizer.dispatchEvent(new Event('change', { bubbles: true }));
    await waitSetting('enable Jev', current => current.autoOptimizeToolSelection === true && current.toolExposure.mode === 'adaptive');
    discovery.checked = false; discovery.dispatchEvent(new Event('change', { bubbles: true }));
    await waitSetting('disable discovery', current => current.toolExposure.mode === 'all' && current.autoOptimizeToolSelection === true);
    discovery.checked = true; discovery.dispatchEvent(new Event('change', { bubbles: true }));
    await waitSetting('enable discovery', current => current.toolExposure.mode === 'adaptive' && current.autoOptimizeToolSelection === true);
    const budget = document.querySelector('#tool-schema-budget');
    budget.value = '1200'; budget.dispatchEvent(new Event('change', { bubbles: true }));
    await waitSetting('change budget', current => current.toolExposure.budgetTokens === 1200 && current.autoOptimizeToolSelection === true && current.toolExposure.mode === 'adaptive');
    document.querySelector('[data-tool-category="文件"]').click();
    const fileToggle = document.querySelector('[data-tool-name="readFile"]');
    check(!!fileToggle, 'file tool toggle missing');
    fileToggle.checked = false; fileToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await waitSetting('disable a tool', current => current.tools.readFile === false && current.autoOptimizeToolSelection === true && current.toolExposure.mode === 'adaptive' && current.toolExposure.budgetTokens === 1200);
    const restoredToggle = document.querySelector('[data-tool-name="readFile"]');
    restoredToggle.checked = true; restoredToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await waitSetting('restore a tool', current => current.tools.readFile === true && current.autoOptimizeToolSelection === true && current.toolExposure.mode === 'adaptive');
    document.querySelector('#tools-modal-close').click();
    optimizer.checked = false; optimizer.dispatchEvent(new Event('change', { bubbles: true }));
    await waitSetting('disable Jev', current => current.autoOptimizeToolSelection === false && current.toolExposure.mode === 'adaptive');
    check(document.querySelector('#tools-stats').textContent.includes('本轮已加载'), 'tools stats did not show actual loaded schemas');
    document.querySelector('[data-computer-recheck]').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    check(document.querySelector('#computer-permissions-card').textContent.includes('电脑控制'), 'permission recheck damaged card');
    await window.navigatePage('chat');
    return { initialCodeTokens: Math.ceil(JSON.stringify(initial).length / 4), computerLocation: permissions.location, setupCard: true };
  })()`);
};
