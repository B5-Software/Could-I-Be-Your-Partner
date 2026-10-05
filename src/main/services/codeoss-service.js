/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const {
  app,
  BrowserWindow,
  WebContentsView,
  protocol,
  nativeTheme,
  session,
  ipcMain,
} = require('electron');
const { WebSocketServer, WebSocket } = require('ws');
const lock = require('../../../integrations/codeoss/runtime-lock.json');
const { workbenchColors } = require('../../../integrations/codeoss/theme.cjs');
const { VmFs } = require('../vm/vm-fs');
const { shellQuote } = require('../vm/vm-paths');
const { CodeOSSOverlay } = require('./codeoss-overlay');
const { resolveTerminalShell } = require('../core/terminal-shell');

const SCHEMES = [
  {
    scheme: 'vscode-webview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      allowServiceWorkers: true,
    },
  },
  {
    scheme: 'vscode-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'vscode-remote-resource',
    privileges: { secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'vscode-managed-remote-resource',
    privileges: { secure: true, supportFetchAPI: true, corsEnabled: true },
  },
];

class CodeOSSService {
  constructor({
    getMainWindow,
    getSettings,
    getVmService,
    dataDirectory,
    onWorkspaceChanged,
    publishEvent,
  }) {
    this.getMainWindow = getMainWindow;
    this.getSettings = getSettings;
    this.getVmService = getVmService;
    this.onWorkspaceChanged = onWorkspaceChanged;
    this.publishEvent = publishEvent;
    this.profile = path.join(dataDirectory, 'codeoss');
    this.sharedDataPath = path.join(this.profile, 'shared-data');
    const resourcePlatform =
      process.platform === 'win32'
        ? 'win'
        : process.platform === 'darwin'
          ? 'mac'
          : process.platform;
    this.runtime = app.isPackaged
      ? path.join(process.resourcesPath, 'codeoss/app')
      : path.join(
          __dirname,
          '../../../assets/codeoss',
          `${resourcePlatform}-${process.arch}`,
          'app',
        );
    this.pending = new Map();
    this.agentRequests = new Map();
    this.peers = new Set();
    this.workbenches = new Set();
    this.appearanceUpdates = new WeakMap();
    this.visible = false;
    this.sequence = 0;
    this.target = { location: 'host', path: '', uri: '' };
    this.hostArgv = [...process.argv];
    this.scopeArgv = [
      process.execPath,
      '--user-data-dir',
      this.profile,
      '--shared-data-dir',
      this.sharedDataPath,
      '--extensions-dir',
      path.join(this.profile, 'extensions'),
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      ...this.hostArgv.filter((arg) =>
        /^--(?:trace|inspect(?:-brk)?-extensions(?:=\d+)?|disable-extensions)$/.test(arg),
      ),
    ];
    fs.mkdirSync(this.profile, { recursive: true });
    this.token = crypto.randomBytes(32).toString('hex');
    if (!app.isReady()) protocol.registerSchemesAsPrivileged(SCHEMES);
    globalThis.__cibypWorkbenchHost = this;
    this.bootstrapReady = new Promise((resolve) => {
      this.resolveBootstrap = resolve;
    });
    this.serverReady = this.startBridge();
    this.switchQueue = Promise.resolve();
    this.overlay = new CodeOSSOverlay(this.getMainWindow);
    this.interactionRevision = 0;
    this.onWorkbenchInteraction = (event) => {
      if (event.sender === this.view?.webContents) this.dismissHostHover();
    };
    ipcMain.on('vscode:cibyp-interaction', this.onWorkbenchInteraction);
    app.on('will-quit', () => this.dispose());
  }

  argv() {
    return this.scopeArgv;
  }
  relaunchArgv() {
    // Electron development builds require CIBYP's entry path as the first arg.
    // The IDE's --user-data-dir profile is never an Electron application path.
    return this.hostArgv.slice(1);
  }
  argvFile() {
    return path.join(this.profile, 'argv.json');
  }
  preserveWorkingDirectory() {
    /* CIBYP owns process.cwd(); Code-OSS receives explicit workspace URIs. */
  }
  session() {
    return session.fromPartition('persist:cibyp-codeoss');
  }
  scopeWindowEnvironment(configuration, window) {
    configuration.userEnv = {
      ...configuration.userEnv,
      CIBYP_CODE_WINDOW_ID: String(window.id),
    };
  }
  ownerFor(contents) {
    return this.view?.webContents === contents ? this.embeddedWindow : undefined;
  }
  isEmbeddedWindow(window) {
    return !!window && window === this.embeddedWindow;
  }
  setUserData() {
    /* Code-OSS's profile is scoped by --user-data-dir; CIBYP owns app.userData. */
  }
  registerSchemes() {
    /* Registered synchronously before Electron ready. */
  }
  enableSandbox() {
    /* Each embedded renderer uses upstream sandboxed webPreferences. */
  }
  onReady(callback) {
    app
      .whenReady()
      .then(callback)
      .catch((error) => this.notifyState('error', error.message));
  }
  deferStart(callback) {
    this.startCode = callback;
    this.resolveBootstrap();
  }

  async startBridge() {
    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: 16 * 1024 * 1024,
      verifyClient: ({ req }) =>
        !req.headers.origin && req.headers.authorization === `Bearer ${this.token}`,
    });
    await new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
    process.env.CIBYP_CODE_BRIDGE_URL = `ws://127.0.0.1:${this.server.address().port}`;
    process.env.CIBYP_CODE_BRIDGE_TOKEN = this.token;
    this.server.on('error', (error) => console.error('[Code-OSS bridge]', error.message));
    this.server.on('connection', (socket) => {
      this.peers.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        this.peers.delete(socket);
        for (const [id, pending] of this.pending)
          if (pending.peer === socket) {
            clearTimeout(pending.timer);
            pending.reject(new Error('IDE connection closed'));
            this.pending.delete(id);
          }
        for (const [id, pending] of this.agentRequests)
          if (pending.peer === socket) {
            clearTimeout(pending.timer);
            pending.reject(new Error('IDE connection closed'));
            this.agentRequests.delete(id);
          }
      });
      socket.on('message', (buffer) => {
        let message;
        try {
          message = JSON.parse(buffer.toString());
        } catch {
          socket.close(1003);
          return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          socket.close(1003);
          return;
        }
        if (message.type === 'hello') {
          socket.windowId = Number(message.windowId);
          socket.workspace = message.workspace || [];
          this.send(socket, {
            type: 'event',
            event: 'personalization',
            data: this.personalization(),
          });
          if (this.isEmbeddedPeer(socket)) {
            this.adoptWorkspace(socket);
            this.notifyState('ready');
          }
        } else if (message.type === 'response') {
          const entry = this.pending.get(message.id);
          if (!entry || entry.peer !== socket) return;
          clearTimeout(entry.timer);
          this.pending.delete(message.id);
          message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
        } else if (message.type === 'request' && typeof message.id === 'string') {
          this.handleExtensionRequest(socket, message).then(
            (result) => this.send(socket, { type: 'response', id: message.id, result }),
            (error) =>
              this.send(socket, { type: 'response', id: message.id, error: error.message }),
          );
        } else if (message.type === 'event' && message.event === 'workspace') {
          socket.workspace = message.data || [];
          if (this.isEmbeddedPeer(socket)) this.adoptWorkspace(socket);
        } else if (message.type === 'event' && this.isEmbeddedPeer(socket)) {
          if (message.event === 'ide-state') this.emitRenderer('codeoss:ide-state', message.data);
          if (message.event === 'changes') this.emitRenderer('codeoss:changes', message.data);
        }
      });
    });
  }

  send(peer, data) {
    if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify(data));
  }
  emitRenderer(channel, data) {
    if (this.publishEvent) {
      this.publishEvent(channel, data);
      return;
    }
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }
  notifyState(state, error = '') {
    this.state = state;
    this.emitRenderer('codeoss:state', {
      state,
      error,
      version: lock.version,
      location: this.target.location,
    });
  }
  personalization() {
    const settings = this.getSettings();
    return {
      theme: settings.theme,
      dark:
        settings.theme?.mode === 'dark' ||
        (settings.theme?.mode !== 'light' && nativeTheme.shouldUseDarkColors),
      animations: settings.animations !== false,
      focusOutlines: settings.theme?.focusOutlines !== false,
      language: settings.language,
      model: settings.llm?.model || '',
      maxContext: settings.llm?.maxContextLength || 131072,
    };
  }
  syncPersonalization() {
    for (const contents of this.workbenches) this.applyWorkbenchAppearance(contents);
    for (const peer of this.peers)
      this.send(peer, { type: 'event', event: 'personalization', data: this.personalization() });
  }
  trackWorkbench(contents) {
    this.workbenches.add(contents);
    contents.on('did-finish-load', () => {
      this.applyWorkbenchAppearance(contents);
      this.applyBranding(contents);
      void contents
        .insertCSS(
          `
        .menubar-menu-items-holder[popover], .context-view[popover] {
          position: fixed; inset: auto; margin: 0; padding: 0; border: 0;
          overflow: visible; background: transparent; color: inherit;
        }
        .menubar-menu-items-holder[popover]::backdrop, .context-view[popover]::backdrop {
          background: transparent; pointer-events: none;
        }
      `,
        )
        .catch(() => {});
      void contents
        .executeJavaScript(
          `(() => {
        if (globalThis.__cibypInteractionInstalled) return;
        globalThis.__cibypInteractionInstalled = true;
        const interact = () => window.vscode.ipcRenderer.send('vscode:cibyp-interaction');
        document.addEventListener('keydown', interact, true);
        document.addEventListener('pointerdown', interact, true);
        window.addEventListener('focus', interact);
        // Keep upstream menu nodes/listeners, but paint them in Chromium's top
        // layer so titlebar/sidepane stacking and GPU layers cannot cover them.
        const promoteMenus = () => {
          for (const menu of document.querySelectorAll('.menubar-menu-items-holder, .context-view:has(.monaco-menu-container)')) {
            // Upstream empties a submenu when Escape returns to its parent.
            // Release its top-layer surface as well, including its hit area.
            if (!menu.childElementCount) {
              if (menu.matches(':popover-open')) menu.hidePopover();
              menu.removeAttribute('popover');
              continue;
            }
            if (!menu.getClientRects().length || menu.matches(':popover-open')) continue;
            menu.setAttribute('popover', 'manual');
            menu.showPopover();
          }
        };
        new MutationObserver(promoteMenus).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class']});
        promoteMenus();
      })()`,
        )
        .catch((error) => {
          if (!contents.isDestroyed()) console.warn('[Code-OSS interaction]', error.message);
        });
    });
    contents.once('destroyed', () => this.workbenches.delete(contents));
  }
  applyBranding(contents) {
    const icon = fs
      .readFileSync(path.join(__dirname, '../../../assets/icons/icons/256x256.png'))
      .toString('base64');
    void contents
      .insertCSS(
        `
      .monaco-workbench .window-appicon, .monaco-workbench .letterpress {
        background-image: url("data:image/png;base64,${icon}") !important;
        background-size: contain !important; background-repeat: no-repeat !important;
        background-position: center !important; mask: none !important; -webkit-mask: none !important;
      }
      body:not([data-cibyp-immersive="true"]) .window-appicon,
      body:not([data-cibyp-immersive="true"]) .letterpress { display: none !important; }
      .monaco-workbench .window-appicon::before { content: none !important; }
      .monaco-workbench .window-appicon { background-size: 18px 18px !important; width: 28px !important; height: 28px !important; }
      .monaco-workbench .letterpress { background-size: 128px 128px !important; opacity: .12; }
      :is(button, [role="button"], a, input, textarea, select, summary, [tabindex]):focus { outline-color: var(--vscode-focusBorder) !important; }
    `,
      )
      .catch(() => {});
    void contents
      .executeJavaScript(
        `document.body.dataset.cibypImmersive = ${JSON.stringify(String(this.immersive === true))}`,
      )
      .catch(() => {});
  }
  applyWorkbenchAppearance(contents) {
    if (contents.isDestroyed()) return;
    const data = this.personalization();
    const terminal = this.getSettings().terminal || {};
    const shell = this.target.location === 'vm' ? terminal.vm || {} : terminal;
    const appearance = {
      dark: data.dark,
      animations: data.animations,
      colors: workbenchColors(data),
      terminalOverride:
        (!!shell.shell && shell.shell !== 'auto') ||
        (Array.isArray(shell.args) && shell.args.length > 0),
    };
    const operation = (this.appearanceUpdates.get(contents) || Promise.resolve())
      .then(() => {
        if (contents.isDestroyed()) return;
        return contents.executeJavaScript(
          `globalThis.__cibypAppearance=${JSON.stringify(appearance)};globalThis.__cibypApplyAppearance?.(globalThis.__cibypAppearance)`,
        );
      })
      .catch((error) => {
        if (!contents.isDestroyed()) console.warn('[Code-OSS appearance]', error.message);
      });
    this.appearanceUpdates.set(contents, operation);
  }
  workspaceKey(value) {
    if (!value) return '';
    try {
      const uri = new URL(value);
      const key = `${uri.protocol}//${uri.host}${decodeURIComponent(uri.pathname)}`;
      return process.platform === 'win32' && uri.protocol === 'file:' ? key.toLowerCase() : key;
    } catch {
      return String(value);
    }
  }
  matchesPeer(peer) {
    if (this.webWindowIds?.has(peer.windowId))
      return peer.workspace?.some(
        (folder) =>
          folder.location === this.target.location &&
          (process.platform === 'win32' && folder.location === 'host'
            ? folder.path.toLowerCase() === this.target.path.toLowerCase()
            : folder.path === this.target.path),
      );
    return (
      !this.target.uri ||
      peer.workspace?.some((folder) => {
        try {
          return this.workspaceKey(folder.uri) === this.workspaceKey(this.target.uri);
        } catch {
          return false;
        }
      })
    );
  }
  isEmbeddedPeer(peer) {
    return peer.windowId === this.embeddedWindow?.id || this.webWindowIds?.has(peer.windowId);
  }
  adoptWorkspace(peer) {
    const selected = peer.workspace[0];
    try {
      const uri = selected ? new URL(selected.uri) : null;
      if (uri && !['file:', 'vscode-remote:'].includes(uri.protocol)) return;
      if (uri?.protocol === 'vscode-remote:' && uri.host !== 'cibyp-vm+default') return;
      const location =
        selected?.location === 'vm' || uri?.protocol === 'vscode-remote:' ? 'vm' : 'host';
      let directory = uri
        ? location === 'vm'
          ? decodeURIComponent(uri.pathname)
          : fileURLToPath(uri)
        : '';
      if (
        location === 'host' &&
        process.platform === 'win32' &&
        directory.toLowerCase() === this.target.path.toLowerCase()
      )
        directory = this.target.path;
      const changed = this.target.path !== directory || this.target.location !== location;
      this.target = { location, path: directory, uri: selected?.uri || '' };
      if (changed) this.onWorkspaceChanged?.(this.target);
      this.emitRenderer('codeoss:workspace', { ...selected, ...this.target });
    } catch (error) {
      this.notifyState('error', error.message);
    }
  }
  activePeer() {
    return [...this.peers].find(
      (peer) =>
        peer.readyState === WebSocket.OPEN && this.isEmbeddedPeer(peer) && this.matchesPeer(peer),
    );
  }

  async request(method, params, timeoutMs = 30000) {
    const peer = this.activePeer();
    if (!peer) throw new Error('IDE extension host is not connected');
    const id = `main-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IDE request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, peer });
      this.send(peer, { type: 'request', id, method, params });
    });
  }

  async bootstrap() {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      await this.serverReady;
      const markerFile = path.join(this.runtime, 'cibyp-runtime.json');
      if (!fs.existsSync(markerFile))
        throw new Error('缺少 Code-OSS 桌面资源，请运行 npm run prepare:codeoss 后重新启动。');
      if (JSON.parse(fs.readFileSync(markerFile)).commit !== lock.commit)
        throw new Error('Code-OSS 运行时版本不匹配，请重新准备资源。');
      await import(pathToFileURL(path.join(this.runtime, 'out/main.js')).href);
      await Promise.race([
        this.bootstrapReady,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Code-OSS bootstrap timeout')), 30000),
        ),
      ]);
    })();
    return this.bootstrapPromise;
  }

  async resolveWorkspace(directory) {
    return require('./workspace-target').resolveWorkspaceTarget(this.getVmService(), directory);
  }

  open(directory) {
    const operation = async () => {
      const target = await this.resolveWorkspace(directory);
      if (this.started && (!this.view || this.view.webContents.isDestroyed())) {
        this.target = target;
        const native = this.nativeCodeWindow;
        await native.windowsMainService.open({
          context: 3,
          cli: { ...native.environmentMainService.args, _: [], 'folder-uri': [], 'file-uri': [] },
          forceNewWindow: true,
          forceEmpty: !target.uri,
          urisToOpen: target.uri
            ? [{ folderUri: native.environmentMainService.userHome.constructor.parse(target.uri) }]
            : undefined,
          remoteAuthority: target.location === 'vm' ? 'cibyp-vm+default' : undefined,
        });
        this.onWorkspaceChanged?.(target);
        this.notifyState('starting');
        return { ok: true, ...target };
      }
      if (this.started && this.workspaceKey(target.uri) === this.workspaceKey(this.target.uri)) {
        if (!this.activePeer() && this.state === 'error') this.view.webContents.reload();
        this.syncPersonalization();
        this.notifyState(this.activePeer() ? 'ready' : 'starting');
        return { ok: true, ...this.target };
      }
      if (this.started) {
        if (!this.activePeer()) throw new Error('工作台尚未连接，请等待扩展宿主就绪');
        const accepted = await this.request('ide.openWorkspace', target);
        if (accepted?.cancelled) return { ok: false, cancelled: true };
        this.target = target;
        this.onWorkspaceChanged?.(target);
      } else {
        this.target = target;
        if (target.uri) this.scopeArgv.push('--folder-uri', target.uri);
        await this.bootstrap();
        this.started = true;
        this.startCode();
        this.onWorkspaceChanged?.(target);
      }
      this.notifyState('starting');
      return { ok: true, ...target };
    };
    const task = this.switchQueue.then(operation);
    this.switchQueue = task.catch(() => {});
    return task.catch((error) => {
      this.notifyState('error', error.message);
      return { ok: false, error: error.message };
    });
  }

  createWindow(options, nativeCodeWindow) {
    options = {
      ...options,
      icon: path.join(__dirname, '../../../assets/icons/icons/256x256.png'),
      webPreferences: { ...options.webPreferences, session: this.session() },
    };
    if (this.embeddedWindow && !this.embeddedWindow.isDestroyed()) {
      const window = new BrowserWindow(options);
      this.trackWorkbench(window.webContents);
      return window;
    }
    const parent = this.getMainWindow();
    if (!parent || parent.isDestroyed()) throw new Error('CIBYP window is unavailable');
    this.nativeCodeWindow = nativeCodeWindow;
    const owner = new BrowserWindow({
      ...options,
      show: false,
      skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    const view = new WebContentsView({
      webPreferences: { ...options.webPreferences, backgroundThrottling: false },
    });
    Object.defineProperty(owner, 'webContents', { value: view.webContents, configurable: true });
    this.embeddedWindow = owner;
    this.view = view;
    this.trackWorkbench(view.webContents);
    view.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown') this.dismissHostHover();
    });
    parent.contentView.addChildView(view);
    view.setBounds(this.bounds || { x: 0, y: 80, width: 1, height: 1 });
    view.setVisible(this.visible);
    owner.show = () => {
      if (this.visible) view.setVisible(true);
    };
    owner.hide = () => view.setVisible(false);
    owner.focus = () => {
      if (this.visible) {
        parent.focus();
        view.webContents.focus();
        owner.emit('focus');
      }
    };
    owner.isFocused = () => this.visible && view.webContents.isFocused();
    owner.isVisible = () => this.visible && parent.isVisible();
    for (const method of [
      'minimize',
      'maximize',
      'unmaximize',
      'restore',
      'setFullScreen',
      'setAlwaysOnTop',
      'isMaximized',
      'isMinimized',
      'isFullScreen',
      'isAlwaysOnTop',
    ])
      owner[method] = (...args) => parent[method](...args);
    // Upstream restoration must not move or resize CIBYP's outer shell.
    for (const method of ['setBounds', 'setSize', 'setContentSize', 'setPosition', 'center'])
      owner[method] = () => {};
    owner.getContentBounds = () => ({
      ...(this.bounds || { x: 0, y: 0, width: 1000, height: 700 }),
    });
    owner.getContentSize = () => [this.bounds?.width || 1000, this.bounds?.height || 700];
    const forwardFocus = () => {
      if (this.visible) owner.emit('focus');
    };
    parent.on('focus', forwardFocus);
    const windowEvents = [
      'maximize',
      'unmaximize',
      'minimize',
      'restore',
      'enter-full-screen',
      'leave-full-screen',
      'always-on-top-changed',
    ].map((name) => {
      const listener = (...args) => owner.emit(name, ...args);
      parent.on(name, listener);
      return [name, listener];
    });
    const closeOwner = () => {
      if (!owner.isDestroyed()) owner.close();
    };
    parent.once('closed', closeOwner);
    owner.once('closed', () => {
      this.overlay.destroy();
      parent.removeListener('focus', forwardFocus);
      for (const [name, listener] of windowEvents) parent.removeListener(name, listener);
      parent.removeListener('closed', closeOwner);
      if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      this.view = null;
      this.embeddedWindow = null;
      this.notifyState('closed');
    });
    view.webContents.on('render-process-gone', (_event, detail) =>
      this.notifyState('error', `工作台进程退出：${detail.reason}`),
    );
    return owner;
  }

  popupMenu(menu, contents, options) {
    const embedded = contents === this.view?.webContents;
    const window = embedded ? this.getMainWindow() : BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed()) return options.callback?.();
    // Electron popup coordinates are relative to the owning window, in DIP.
    // The workbench sends coordinates relative to its embedded native surface.
    const bounds = embedded ? this.view.getBounds() : { x: 0, y: 0 };
    if (embedded) this.dismissHostHover();
    menu.popup({
      ...options,
      window,
      x: Number.isFinite(options.x) ? Math.round(bounds.x + options.x) : undefined,
      y: Number.isFinite(options.y) ? Math.round(bounds.y + options.y) : undefined,
    });
  }

  dismissHostHover() {
    this.interactionRevision++;
    this.overlay.update(null);
    this.emitRenderer('codeoss:interaction', { revision: this.interactionRevision });
  }

  setLayout({ visible, bounds, overlay, interactionRevision = 0, immersive = false } = {}) {
    if (this.immersive !== immersive) {
      this.immersive = immersive;
      for (const contents of this.workbenches)
        if (!contents.isDestroyed())
          void contents
            .executeJavaScript(
              `document.body.dataset.cibypImmersive = ${JSON.stringify(String(immersive))}`,
            )
            .catch(() => {});
    }
    this.visible = visible === true;
    if (bounds) {
      const parent = this.getMainWindow();
      const [width, height] = parent && !parent.isDestroyed() ? parent.getContentSize() : [0, 0];
      const x = Math.max(0, Math.min(width, Math.round(Number(bounds.x) || 0)));
      const y = Math.max(0, Math.min(height, Math.round(Number(bounds.y) || 0)));
      this.bounds = {
        x,
        y,
        width: Math.max(0, Math.min(width - x, Math.round(Number(bounds.width) || 0))),
        height: Math.max(0, Math.min(height - y, Math.round(Number(bounds.height) || 0))),
      };
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.bounds) this.view.setBounds(this.bounds);
      this.view.setVisible(this.visible);
    }
    this.overlay.update(
      this.visible && this.view && interactionRevision >= this.interactionRevision ? overlay : null,
    );
    return { ok: true };
  }

  async handleExtensionRequest(peer, { method, params = {}, id }) {
    if (method === 'personalization.get') return this.personalization();
    if (method === 'terminal.resolve') {
      if (!this.isEmbeddedPeer(peer))
        throw new Error('Shell settings belong to the active CIBYP workbench');
      return resolveTerminalShell(this.getSettings(), this.target.location, this.getVmService());
    }
    if (method === 'vm.resolve') return this.resolveVm();
    if (method === 'vm.forward') {
      const port = Number(params.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid guest port');
      return this.getVmService().forwardPort(port, params.localPort || null);
    }
    if (method === 'vm.unforward') return this.getVmService().unforwardPort(Number(params.port));
    if (method.startsWith('agent.') && !this.isEmbeddedPeer(peer))
      throw new Error(
        '请在 CIBYP 主窗口的 Code 工作台中使用 Agent。独立 IDE 窗口的文件与会话不会混入当前工作区。',
      );
    if (
      ![
        'agent.send',
        'agent.focus',
        'agent.cancel',
        'agent.approve',
        'agent.sessions',
        'agent.newSession',
        'agent.selectSession',
        'app.settings',
      ].includes(method)
    )
      throw new Error(`Unknown bridge method: ${method}`);
    const key = `extension-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.agentRequests.delete(key);
          reject(new Error('CIBYP Agent request timed out'));
        },
        method === 'agent.send' ? 3600000 : 30000,
      );
      this.agentRequests.set(key, { resolve, reject, timer, peer, extensionRequestId: id });
      this.emitRenderer('codeoss:agent-request', {
        id: key,
        method,
        params: { ...params, workspace: peer.workspace },
      });
    });
  }

  agentResponse({ id, result, error }) {
    const entry = this.agentRequests.get(id);
    if (!entry) return { ok: false };
    clearTimeout(entry.timer);
    this.agentRequests.delete(id);
    error ? entry.reject(new Error(error)) : entry.resolve(result);
    return { ok: true };
  }
  async interceptFile(channel, args) {
    if (
      !this.started ||
      !this.activePeer() ||
      !['fs:readFile', 'fs:writeFile', 'fs:createFile'].includes(channel)
    )
      return null;
    if (
      require('../vm/tool-location').isVmOperation(this.getVmService) !==
      (this.target.location === 'vm')
    )
      return null;
    let file = String(args[0] || '');
    if (this.target.location === 'vm') {
      const result = new VmFs({ vmService: this.getVmService() }).resolveVmPath(file);
      if (!result.ok) return null;
      file = result.vm;
    }
    const root = this.target.path;
    const relative =
      this.target.location === 'vm' ? path.posix.relative(root, file) : path.relative(root, file);
    if (!root || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const params = {
      path: file,
      location: this.target.location,
      content: args[1],
      options: args[2],
    };
    if (channel === 'fs:readFile') params.encoding = args[1];
    const result = await this.request(
      channel === 'fs:readFile' ? 'ide.readDocument' : 'ide.writeDocument',
      params,
    );
    return result?.handled ? result.result : null;
  }

  async resolveVm() {
    const vm = this.getVmService();
    if (vm.runtime.location !== 'vm' || vm.emergencyHost)
      throw new Error('VM workspace is no longer active');
    if (vm.instance?.state !== 'ready') await vm.start();
    const token = crypto.randomBytes(32).toString('hex');
    const command = `cibyp-codeoss-server --cibyp-start ${shellQuote(lock.commit)} ${shellQuote(token)}`;
    const result = await vm.instance.exec(command, { timeoutMs: 60000 });
    if (result.code !== 0)
      throw new Error(result.stderr || 'VM 镜像缺少匹配的 Code-OSS 后端，请更新 CIBYP OS 镜像。');
    let data;
    try {
      data = JSON.parse(result.stdout.trim().split('\n').at(-1));
    } catch {
      throw new Error('VM Code-OSS 后端启动结果无效');
    }
    if (data.commit !== lock.commit || !Number.isInteger(data.port))
      throw new Error('VM Code-OSS 后端版本不匹配');
    if (this.vmForward && this.vmForward.instance === vm.instance)
      vm.unforwardPort(this.vmForward.port);
    const forward = await vm.forwardPort(data.port);
    this.vmForward = { instance: vm.instance, port: forward.hostPort };
    return { host: '127.0.0.1', port: forward.hostPort, connectionToken: data.token || token };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ipcMain.removeListener('vscode:cibyp-interaction', this.onWorkbenchInteraction);
    this.overlay.destroy();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Application closed'));
    }
    for (const entry of this.agentRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Application closed'));
    }
    this.pending.clear();
    this.agentRequests.clear();
    for (const peer of this.peers) peer.terminate();
    this.server?.close();
    if (this.vmForward) this.getVmService().unforwardPort(this.vmForward.port);
  }
}

module.exports = { CodeOSSService };
