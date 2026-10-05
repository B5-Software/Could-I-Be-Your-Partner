/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const lock = require('../../../integrations/codeoss/runtime-lock.json');
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function checksum(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// REH-web is upstream's full browser workbench plus its extension host. It is
// started lazily, once per execution location, by the same backend owner.
class CodeOSSWebService {
  constructor({ bridge, dataDirectory, getVmService }) {
    this.bridge = bridge;
    this.directory = path.join(dataDirectory, 'codeoss-web');
    this.getVmService = getVmService;
    this.servers = new Map();
    this.tickets = new Map();
    this.abort = new AbortController();
  }
  async archive(key) {
    const asset = lock.web[key];
    if (!asset) throw new Error('Code-OSS Web Host is unavailable for ' + key);
    const directory = path.join(this.directory, 'downloads');
    await fsp.mkdir(directory, { recursive: true });
    const archive = path.join(directory, key + '-' + lock.version + '.tar.gz');
    if (fs.existsSync(archive) && (await checksum(archive)) === asset.sha256) return archive;
    const response = await fetch(asset.url, {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(600000)]),
    });
    if (!response.ok) throw new Error('Code-OSS Web Host download: HTTP ' + response.status);
    const staging = archive + '.partial';
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(staging));
      if ((await checksum(staging)) !== asset.sha256)
        throw new Error('Code-OSS Web Host checksum mismatch');
      await fsp.rename(staging, archive);
    } finally {
      await fsp.rm(staging, { force: true });
    }
    return archive;
  }
  async runtime() {
    const key = process.platform + '-' + (process.platform === 'win32' ? 'x64' : process.arch);
    const root = path.join(this.directory, lock.version, key);
    const marker = path.join(root, '.cibyp-ready');
    if ((await fsp.readFile(marker, 'utf8').catch(() => '')) !== lock.web[key].sha256) {
      await fsp.mkdir(root, { recursive: true });
      await require('tar').x({
        file: await this.archive(key),
        cwd: root,
        filter: (name) => !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'),
      });
      const productFile = path.join(root, 'product.json');
      const product = JSON.parse(await fsp.readFile(productFile, 'utf8'));
      Object.assign(product, {
        nameShort: 'CIBYP',
        nameLong: 'Could I Be Your Partner',
        applicationName: 'cibyp',
        telemetryEnabled: false,
      });
      await fsp.writeFile(productFile, JSON.stringify(product));
      await fsp.writeFile(marker, lock.web[key].sha256);
    }
    const extension = path.join(root, 'extensions/cibyp-workbench');
    await fsp.mkdir(extension, { recursive: true });
    const source = path.join(this.bridge.runtime, 'extensions/cibyp-workbench');
    if (!fs.existsSync(path.join(source, 'dist/extension.cjs')))
      throw new Error('CIBYP Code-OSS bridge is missing; prepare the bundled runtime first');
    await fsp.cp(source, extension, { recursive: true });
    const packageFile = path.join(extension, 'package.json');
    const manifest = JSON.parse(await fsp.readFile(packageFile, 'utf8'));
    manifest.extensionKind = ['workspace'];
    await fsp.writeFile(packageFile, JSON.stringify(manifest));
    return root;
  }
  async start(location) {
    this.abort.signal.throwIfAborted();
    if (this.servers.has(location)) return this.servers.get(location);
    const operation = this.startServer(location).catch((error) => {
      this.servers.delete(location);
      throw error;
    });
    this.servers.set(location, operation);
    return operation;
  }
  async startServer(location) {
    await this.bridge.serverReady;
    const id = crypto.randomBytes(24).toString('hex');
    const base = '/codeoss/' + id;
    const windowId = location === 'vm' ? -9002 : -9001;
    this.bridge.webWindowIds ||= new Set();
    this.bridge.webWindowIds.add(windowId);
    const env = {
      ...process.env,
      CIBYP_CODE_WINDOW_ID: String(windowId),
      CIBYP_CODE_LOCATION: location,
    };
    const profile = this.bridge.profile;
    const args = [
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--server-base-path',
      base,
      '--without-connection-token',
      '--accept-server-license-terms',
      '--disable-telemetry',
      '--user-data-dir',
      profile,
      '--extensions-dir',
      path.join(this.bridge.profile, 'extensions'),
      '--enable-proposed-api',
      'cibyp.workbench',
    ];
    let server;
    if (location === 'host') {
      const root = await this.runtime();
      this.abort.signal.throwIfAborted();
      const child = spawn(
        path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
        [path.join(root, 'out/server-main.js'), ...args],
        { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      server = { id, base, child, location };
      let output = '';
      let failure;
      const accept = (buffer) => {
        output = (output + String(buffer)).slice(-32768);
        server.output = output;
        const match =
          /(?:Extension host agent listening on|Web UI available at http:\/\/[^:]+:)(\d+)/i.exec(
            output,
          );
        if (match) server.port = Number(match[1]);
      };
      child.stdout.on('data', accept);
      child.stderr.on('data', accept);
      child.once('error', (error) => {
        failure = error;
      });
      child.once('exit', (code) => {
        failure ||= new Error('Code-OSS Web Host exited: ' + code + '\n' + output);
        this.servers.delete(location);
        this.tickets.delete(id);
        this.bridge.webWindowIds.delete(windowId);
      });
      const until = Date.now() + 30000;
      while (!server.port && Date.now() < until) {
        if (failure) throw failure;
        await sleep(100);
      }
      if (!server.port) {
        child.kill();
        throw new Error('Code-OSS Web Host startup timed out\n' + output);
      }
    } else {
      const vm = this.getVmService();
      if (vm.instance?.state !== 'ready') await vm.start();
      const info = await vm.instance.exec('uname -m', { timeoutMs: 10000 });
      const key = 'linux-' + (/aarch64|arm64/.test(info.stdout) ? 'arm64' : 'x64');
      const root = '/home/cibyp/.local/share/cibyp/codeoss-web/' + lock.version;
      const archive = await this.archive(key);
      const asset = lock.web[key];
      await vm.instance.exec('mkdir -p ' + quote(root), { timeoutMs: 10000 });
      const sftp = await vm.instance.ssh.sftp();
      const exists = await vm.instance.exec('test -f ' + quote(root + '/.cibyp-ready'), {
        timeoutMs: 10000,
      });
      if (exists.code !== 0) {
        await sftp.fastPut(archive, root + '/runtime.tar.gz');
        const prepared = await vm.instance.exec(
          'cd ' +
            quote(root) +
            ' && printf "%s  runtime.tar.gz\\n" ' +
            quote(asset.sha256) +
            ' | sha256sum -c - && tar -xzf runtime.tar.gz && touch .cibyp-ready',
          { timeoutMs: 120000 },
        );
        if (prepared.code !== 0) throw new Error(prepared.stderr || prepared.stdout);
      }
      // Reuse the compiled bridge and run it inside the guest extension host.
      const extension = path.join(this.bridge.runtime, 'extensions/cibyp-workbench');
      const guestExtension = root + '/extensions/cibyp-workbench';
      await vm.instance.exec('mkdir -p ' + quote(guestExtension + '/dist'), { timeoutMs: 10000 });
      const manifest = JSON.parse(await fsp.readFile(path.join(extension, 'package.json')));
      manifest.extensionKind = ['workspace'];
      await sftp.writeFile(guestExtension + '/package.json', JSON.stringify(manifest));
      await sftp.fastPut(
        path.join(extension, 'dist/extension.cjs'),
        guestExtension + '/dist/extension.cjs',
      );
      const bridgeAddress = process.env.CIBYP_CODE_BRIDGE_URL.replace('127.0.0.1', '10.0.2.2');
      const guestArgs = args.map((arg, index) =>
        args[index - 1] === '--user-data-dir'
          ? '/home/cibyp/.local/share/cibyp/codeoss-web/profile'
          : args[index - 1] === '--extensions-dir'
            ? '/home/cibyp/.local/share/cibyp/codeoss/extensions'
            : arg,
      );
      const command =
        'CIBYP_CODE_BRIDGE_URL=' +
        quote(bridgeAddress) +
        ' CIBYP_CODE_BRIDGE_TOKEN=' +
        quote(process.env.CIBYP_CODE_BRIDGE_TOKEN) +
        ' CIBYP_CODE_WINDOW_ID=' +
        quote(windowId) +
        ' CIBYP_CODE_LOCATION=vm nohup ' +
        quote(root + '/node') +
        ' ' +
        quote(root + '/out/server-main.js') +
        ' ' +
        guestArgs.map(quote).join(' ') +
        ' >' +
        quote(root + '/server.log') +
        ' 2>&1 < /dev/null & echo $!';
      const launched = await vm.instance.exec(command, { timeoutMs: 10000 });
      const pid = Number(launched.stdout.trim());
      let port;
      const until = Date.now() + 30000;
      while (!port && Date.now() < until) {
        const result = await vm.instance.exec('cat ' + quote(root + '/server.log'), {
          timeoutMs: 10000,
        });
        port = Number(/Extension host agent listening on (\d+)/.exec(result.stdout)?.[1]);
        if (!port) await sleep(300);
      }
      if (!port) throw new Error('VM Code-OSS Web Host startup timed out');
      const forward = await vm.forwardPort(port);
      server = { id, base, location, port: forward.hostPort, guestPid: pid, vm };
    }
    this.tickets.set(id, server);
    return server;
  }
  async open(directory) {
    const target = await this.bridge.resolveWorkspace(directory);
    const server = await this.start(target.location);
    this.bridge.target = target;
    this.bridge.onWorkspaceChanged?.(target);
    this.bridge.notifyState('ready');
    return {
      ok: true,
      ...target,
      webUrl:
        server.base +
        '/?folder=' +
        encodeURIComponent(
          target.location === 'host' && process.platform === 'win32'
            ? '/' + target.path.replace(/\\/g, '/')
            : target.path,
        ),
    };
  }
  route(url) {
    const id = /^\/codeoss\/([a-f0-9]{48})(?:\/|\?|$)/.exec(url)?.[1];
    return id && this.tickets.get(id);
  }
  proxy(req, res) {
    const target = this.route(req.url);
    if (!target) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url.split('?')[0] === target.base + '/_cibyp-brand.js') {
      const icon = fs
        .readFileSync(path.join(__dirname, '../../../assets/icons/icons/256x256.png'))
        .toString('base64');
      res.setHeader('Content-Type', 'text/javascript');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        `(() => {const style=document.createElement('style');style.textContent=${JSON.stringify(`
        .monaco-workbench .window-appicon, .monaco-workbench .letterpress, .welcomePage .logo { background-image:url("data:image/png;base64,${icon}")!important;background-size:contain!important;background-repeat:no-repeat!important;background-position:center!important;mask:none!important;-webkit-mask:none!important; }
        body:not([data-cibyp-immersive="true"]) .window-appicon, body:not([data-cibyp-immersive="true"]) .letterpress, body:not([data-cibyp-immersive="true"]) .welcomePage .logo {display:none!important;}
        .window-appicon::before {content:none!important;}
        .monaco-workbench .window-appicon {background-size:18px 18px!important;width:28px!important;height:28px!important;}
        .monaco-workbench .letterpress {background-size:128px 128px!important;opacity:.12;}
      `)};document.head.append(style);window.addEventListener('message',event=>{if(event.source===window.parent&&event.data?.type==='cibyp-workbench-layout')document.body.dataset.cibypImmersive=String(event.data.immersive===true)});})();`,
      );
      return;
    }
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: '127.0.0.1:' + target.port,
          origin: 'http://127.0.0.1:' + target.port,
          'x-original-host': req.headers.host,
          'x-forwarded-host': req.headers.host,
          'x-forwarded-port': '',
          'x-forwarded-prefix': target.base,
        },
      },
      (response) => {
        const headers = { ...response.headers };
        delete headers['x-frame-options'];
        headers['referrer-policy'] = 'no-referrer';
        // The authenticated outer page owns embedding policy.
        if (
          String(headers['content-type']).includes('text/html') &&
          [target.base, target.base + '/'].includes(req.url.split('?')[0])
        ) {
          delete headers['content-length'];
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            res.writeHead(response.statusCode, headers);
            res.end(
              Buffer.concat(chunks)
                .toString('utf8')
                .replace(
                  '</head>',
                  '<script src="' + target.base + '/_cibyp-brand.js"></script></head>',
                ),
            );
          });
          return;
        }
        res.writeHead(response.statusCode, headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Code-OSS Web Host is unavailable');
    });
    req.pipe(upstream);
  }
  upgrade(req, socket, head) {
    const target = this.route(req.url);
    if (!target) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      const headers = {
        ...req.headers,
        host: '127.0.0.1:' + target.port,
        origin: 'http://127.0.0.1:' + target.port,
        'x-original-host': req.headers.host,
        'x-forwarded-host': req.headers.host,
        'x-forwarded-port': '',
        'x-forwarded-prefix': target.base,
      };
      upstream.write(
        req.method +
          ' ' +
          req.url +
          ' HTTP/1.1\r\n' +
          Object.entries(headers)
            .map(([key, value]) => key + ': ' + value)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  }
  async stop() {
    this.abort.abort(new Error('Code-OSS Web Host is stopping'));
    for (const operation of this.servers.values()) {
      const server = await operation.catch(() => null);
      server?.child?.kill();
      if (server?.guestPid) {
        await server.vm.instance
          .exec('kill ' + server.guestPid, { timeoutMs: 10000 })
          .catch(() => {});
        server.vm.unforwardPort(server.port);
      }
    }
    this.servers.clear();
    this.tickets.clear();
  }
}
module.exports = { CodeOSSWebService };
