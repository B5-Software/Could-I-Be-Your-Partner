// Run the production bridge against an isolated Linux desktop test session.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { VmAppearanceSync } = require('../../src/main/vm/vm-theme');

async function main() {
  const [configHome, themeJson, systemDark = 'false'] = process.argv.slice(2);
  if (!/^\/tmp\/cibyp-campus-[^/]+\/config$/.test(configHome || ''))
    throw new Error('Use an isolated campus smoke configuration');
  const instance = {
    state: 'ready',
    exec: async (command) => {
      const result = await promisify(execFile)(
        'wsl.exe',
        [
          '-d',
          'Debian',
          '-u',
          'cibyp',
          '--exec',
          'env',
          `XDG_CONFIG_HOME=${configHome}`,
          'sh',
          '-c',
          command,
        ],
        { timeout: 20000 },
      );
      return { ok: true, ...result };
    },
  };
  const sync = new VmAppearanceSync({
    getInstance: () => instance,
    getTheme: () => JSON.parse(themeJson),
    getSystemDark: () => systemDark === 'true',
  });
  await sync.sync();
  process.stdout.write('App appearance bridge applied\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
