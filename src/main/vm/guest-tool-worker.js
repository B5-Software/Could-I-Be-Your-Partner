/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

// This entry point runs under Linux Node inside the guest, never in Electron.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const word = require('../word-tools');
const { createPresentation } = require('../ppt-maker');
const sheets = require('../spreadsheet-io');
const { importKnowledgeFile } = require('../document-import');
const { readTextWithEncoding } = require('../file-encoding');
process.env.CIBYP_VM_TOOL_WORKER = '1';

async function run(request) {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const decodeXmlEntities = (s) =>
    String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, n) => {
      if (n[0] === '#')
        return String.fromCodePoint(
          n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : Number(n.slice(1)),
        );
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n] || m;
    });
  const encodeXmlEntities = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
    );
  require('../ipc/documents')({
    ipcMain,
    fs,
    ...word,
    createPresentation,
    ...sheets,
    decodeXmlEntities,
    encodeXmlEntities,
    getSettings: () => request.settings || {},
    nativeTheme: { shouldUseDarkColors: !!request.nativeDark },
  });
  require('../ffmpeg-tools').registerFfmpegIpc({ ipcMain });
  require('../ipc/network')({ ipcMain, path, fs });
  const os = require('node:os');
  const systemInfo = () => ({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    homeDir: os.homedir(),
    tempDir: os.tmpdir(),
    nodeVersion: process.versions.node,
    osRelease: os.release(),
    shell: process.env.SHELL || '/bin/bash',
  });
  ipcMain.handle('system:info', systemInfo);
  ipcMain.handle('system:fullInfo', systemInfo);
  ipcMain.handle('system:network', () => ({ ok: true, interfaces: os.networkInterfaces() }));
  const lint = require('../eslint-service');
  ipcMain.handle('eslint:isLintable', (_, directory) => ({
    ok: true,
    lintable: lint.isProjectLintable(directory),
  }));
  ipcMain.handle('eslint:lint', (_, directory, options) => lint.lintWorkspace(directory, options));
  ipcMain.handle('eslint:lintFile', (_, input) => lint.lintSingleFile(input));
  ipcMain.handle('eslint:clearCache', () => ({ ok: true }));
  ipcMain.handle('ds:toolCall', async (_, plugin, name, args, context) => {
    const { PluginHost } = require('../ds-compat/plugin-host');
    const host = new PluginHost();
    try {
      await host.init();
      const loaded = await host.loadPlugin(plugin.id, plugin.entry, {
        name: plugin.name,
        config: plugin.config,
      });
      if (name === null) return { ok: true, ...loaded };
      if (loaded.issues?.length && !loaded.tools?.length) throw new Error(loaded.issues.join('; '));
      return await host.callTool(plugin.id, name, args, context);
    } finally {
      await host.dispose();
    }
  });
  ipcMain.handle('knowledge:importFile', (_, input, destination) =>
    importKnowledgeFile(input, { targetDir: destination, readText: readTextWithEncoding }),
  );
  ipcMain.handle('ocr:recognize', (_, input) => ({
    ok: true,
    text: execFileSync('tesseract', [input, 'stdout', '-l', 'chi_sim+eng'], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
    }),
  }));
  ipcMain.handle('qr:generate', async (_, text, directory, filename) => {
    const output = path.join(directory, path.basename(filename || `qrcode_${Date.now()}.png`));
    fs.mkdirSync(directory, { recursive: true });
    await require('qrcode').toFile(output, text, { width: 400, margin: 2 });
    return { ok: true, path: output, filename: path.basename(output) };
  });
  ipcMain.handle('qr:scan', async (_, input) => {
    const png = require('pngjs').PNG.sync.read(
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          input,
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-vcodec',
          'png',
          'pipe:1',
        ],
        { timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
      ),
    );
    const code = require('jsqr')(new Uint8ClampedArray(png.data), png.width, png.height);
    return code ? { ok: true, data: code.data } : { ok: false, error: '未识别到二维码' };
  });
  const handler = handlers.get(request.channel);
  if (!handler) throw new Error(`Unsupported guest tool: ${request.channel}`);
  return handler(null, ...request.args);
}

if (require.main === module) {
  (async () => {
    const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    let result;
    try {
      result = await run(request);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    fs.writeFileSync(process.argv[3], JSON.stringify({ ...result, location: 'vm' }), {
      mode: 0o600,
    });
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = {
  run,
  vmShimCordis: require('@deepseek-ai/cordis'),
  vmShimTools: require('../ds-compat/shims/dsh-tools'),
  vmShimSchema: require('@deepseek-ai/schemastery'),
  vmShimLlm: require('@deepseek-ai/dsh-llm'),
  vmShimValues: require('@deepseek-ai/dsh-util-values'),
  vmShimBrand: require('@deepseek-ai/dsh-brand'),
  vmShimScope: require('@deepseek-ai/dsh-scope'),
};
