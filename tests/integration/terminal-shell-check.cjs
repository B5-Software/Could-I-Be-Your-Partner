/* Real settings UI and host PTY, with isolated App settings. */
module.exports = async function checkTerminalShell(contents) {
  const binary = process.platform === 'win32' ? process.env.ComSpec : '/bin/sh';
  const args = process.platform === 'win32' ? ['/D', '/Q'] : [];
  return contents.executeJavaScript(`(async () => {
    const original = (await window.api.getSettings()).terminal;
    const check = (value, message) => { if (!value) throw new Error(message); };
    const until = async predicate => {
      const deadline = Date.now() + 4000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error('Shell setting did not settle');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    let id;
    try {
      await window.navigatePage('settings');
      window.activateSettingsTab('terminal');
      const target = document.getElementById('setting-terminal-target');
      const change = (id, value) => {
        const field = document.getElementById(id); field.value = value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      };
      change('setting-terminal-target', 'host');
      await until(() => target.value === 'host');
      change('setting-terminal-shell', 'custom');
      change('setting-terminal-custom-path', ${JSON.stringify(binary)});
      change('setting-terminal-args', ${JSON.stringify(JSON.stringify(args))});
      await until(async () => { const terminal = (await window.api.getSettings()).terminal; return terminal.shell === 'custom' && terminal.customShellPath === ${JSON.stringify(binary)} && JSON.stringify(terminal.args) === ${JSON.stringify(JSON.stringify(args))}; });
      const resolved = await window.api.terminalShellInfo('host');
      check(resolved.ok && resolved.file && resolved.args.length === ${args.length}, 'custom binary not resolved');
      const made = await window.api.makeTerminal('');
      check(made.ok && made.shell === resolved.file, 'terminal did not use the configured executable');
      id = made.terminalId;
      const ran = await window.api.awaitTerminalCommand(id, 'echo CIBYP_CUSTOM_SHELL_OK', 5000);
      check(ran.ok && !ran.running && ran.output.includes('CIBYP_CUSTOM_SHELL_OK'), 'custom PTY cannot execute commands: ' + JSON.stringify(ran));
      await window.api.killTerminal(id); id = null;
      await window.api.setSettings({ terminal: { customShellPath: ${JSON.stringify(binary + '.missing')} } });
      const invalid = await window.api.makeTerminal('');
      check(!invalid.ok && invalid.error.includes('unavailable'), 'invalid binary silently fell back');
      await window.api.setSettings({ terminal: { vm: { shell: 'custom', customShellPath: '/usr/bin/fish', args: ['-i'] } } });
      check((await window.api.getSettings()).terminal.customShellPath === ${JSON.stringify(binary + '.missing')}, 'VM configuration overwrote host settings');
      return { customPTY: resolved.file, args: resolved.args, execution: 'passed', invalid: 'explicit error', settings: 'separate host and VM' };
    } finally {
      if (id) await window.api.killTerminal(id);
      await window.api.setSettings({ terminal: original });
      await window.navigatePage('settings');
    }
  })()`);
};
