/* Real renderer -> IPC -> local model-list server, without paid inference. */
const http = require('node:http');
const assert = require('node:assert/strict');
module.exports = async function checkSystemOne(contents) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url]);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'local-decider' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await contents.executeJavaScript(`(async () => {
      const original = (await window.api.getSettings()).decision;
      const field = id => document.getElementById(id);
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const until = async predicate => {
        const deadline = Date.now() + 4000;
        while (!(await predicate()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        check(await predicate(), 'System One setting did not persist');
      };
      const change = (id, value) => {
        if (field(id).type === 'checkbox') field(id).checked = value;
        else field(id).value = value;
        field(id).dispatchEvent(new Event('change', { bubbles: true }));
      };
      try {
        await window.api.setSettings({ decision: { ...original, provider: 'typesafe', apiKey: 'fixture-key', enabled: false } });
        await window.navigatePage('chat');
        await window.navigatePage('settings');
        window.activateSettingsTab('decision');
        await until(() => field('setting-decision-provider').value === 'typesafe');
        check(field('setting-decision-provider').options.length === 7, 'provider presets missing');
        check(document.querySelector('.settings-tab[data-tab="decision"]').textContent.includes('System One'), 'generic feature name missing');
        change('setting-decision-provider', 'compatible');
        await until(async () => (await window.api.getSettings()).decision.provider === 'compatible' && field('setting-decision-key').value === '');
        check((await window.api.getSettings()).decision.apiKey === '', 'old provider key leaked');
        change('setting-decision-url', 'http://127.0.0.1:${server.address().port}/v1/systemone');
        await until(async () => (await window.api.getSettings()).decision.apiUrl.includes(':${server.address().port}/'));
        field('btn-decision-models').click();
        await until(() => !field('btn-decision-models').disabled);
        check(field('system-one-models').firstElementChild?.value === 'local-decider', 'real model discovery failed: ' + field('decision-models-status').textContent);
        change('setting-decision-cap-score', false);
        await until(async () => (await window.api.getSettings()).decision.capabilities.score === false);
        await window.navigatePage('chat');
        await window.navigatePage('settings');
        await until(() => field('setting-decision-cap-score').checked === false);
      } finally {
        await window.api.setSettings({ decision: original });
        await window.navigatePage('chat');
        await window.navigatePage('settings');
      }
    })()`);
    assert.deepEqual(requests, [['GET', '/v1/models']]);
    console.log(
      '[desktop-smoke] System One: provider isolation, GET model discovery and capability persistence passed.',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};
