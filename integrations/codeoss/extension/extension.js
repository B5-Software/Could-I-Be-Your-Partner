/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const markdown = require('markdown-it')({ html: false, linkify: true });
const { workbenchColors } = require('../theme.cjs');

class Bridge {
  constructor(context) {
    this.context = context;
    this.sequence = 0;
    this.pending = new Map();
    this.events = new vscode.EventEmitter();
    this.onEvent = this.events.event;
    this.handlers = new Map();
    this.connect();
  }
  connect() {
    if (this.disposed) return;
    const url = process.env.CIBYP_CODE_BRIDGE_URL;
    if (!url || !process.env.CIBYP_CODE_BRIDGE_TOKEN) return;
    const socket = (this.socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${process.env.CIBYP_CODE_BRIDGE_TOKEN}` },
    }));
    socket.on('error', () => {});
    socket.on('open', () => {
      this.send({
        type: 'hello',
        windowId: process.env.CIBYP_CODE_WINDOW_ID,
        workspace: workspaceFolders(),
      });
      this.events.fire({ event: 'connected' });
    });
    socket.on('message', async (buffer) => {
      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch {
        return;
      }
      if (message.type === 'response') {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
      } else if (message.type === 'event') {
        this.events.fire(message);
      } else if (message.type === 'request') {
        const handler = this.handlers.get(message.method);
        try {
          if (!handler) throw new Error(`Unknown IDE method: ${message.method}`);
          this.send({
            type: 'response',
            id: message.id,
            result: await handler(message.params || {}),
          });
        } catch (error) {
          this.send({ type: 'response', id: message.id, error: error.message });
        }
      }
    });
    socket.on('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CIBYP connection closed'));
      }
      this.pending.clear();
      this.events.fire({ event: 'disconnected' });
      this.reconnect = setTimeout(() => this.connect(), 1500);
    });
  }
  send(data) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data));
  }
  async ready() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const subscription = this.onEvent((event) => {
        if (event.event === 'connected') {
          clearTimeout(timer);
          subscription.dispose();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        subscription.dispose();
        reject(new Error('CIBYP connection unavailable'));
      }, 15000);
    });
  }
  async request(method, params = {}, timeoutMs = 30000) {
    await this.ready();
    const id = `extension-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CIBYP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'request', id, method, params });
    });
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.reconnect);
    this.socket?.close();
    this.events.dispose();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Extension disposed'));
    }
    this.pending.clear();
  }
}

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => ({
    uri: folder.uri.toString(true),
    path: folder.uri.scheme === 'vscode-remote' ? folder.uri.path : folder.uri.fsPath,
    name: folder.name,
    location: folder.uri.scheme === 'vscode-remote' ? 'vm' : 'host',
  }));
}
function targetUri(params) {
  return params.location === 'vm'
    ? vscode.Uri.from({
        scheme: 'vscode-remote',
        authority: vscode.workspace.workspaceFolders?.[0]?.uri.authority || 'cibyp-vm+default',
        path: params.path,
      })
    : vscode.Uri.file(params.path);
}
function documentKey(uri) {
  const key = uri.toString();
  return process.platform === 'win32' && uri.scheme === 'file' ? key.toLowerCase() : key;
}
function contextSnapshot() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { workspace: workspaceFolders(), diagnostics: [] };
  const selection = editor.document.getText(editor.selection);
  const full = editor.document.getText();
  const start = editor.document.offsetAt(editor.selection.start);
  const content =
    selection || full.slice(Math.max(0, start - 8000), Math.max(0, start - 8000) + 24000);
  return {
    workspace: workspaceFolders(),
    uri: editor.document.uri.toString(true),
    path:
      editor.document.uri.scheme === 'vscode-remote'
        ? editor.document.uri.path
        : editor.document.uri.fsPath,
    language: editor.document.languageId,
    version: editor.document.version,
    dirty: editor.document.isDirty,
    selection: {
      start: editor.selection.start.line + 1,
      end: editor.selection.end.line + 1,
      selected: !!selection,
    },
    content,
    truncated: !selection && full.length > content.length,
    diagnostics: vscode.languages
      .getDiagnostics(editor.document.uri)
      .slice(0, 30)
      .map((item) => ({
        line: item.range.start.line + 1,
        message: item.message,
        severity: item.severity,
        source: item.source,
      })),
  };
}

class Changes {
  constructor(context) {
    this.items = new Map();
    this.snapshots = new Map();
    this.readVersions = new Map();
    this.events = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.events.event;
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('cibyp-checkpoint', {
        provideTextDocumentContent: (uri) => this.snapshots.get(uri.toString()) || '',
      }),
      this.events,
    );
  }
  getChildren() {
    return [...this.items.values()];
  }
  getTreeItem(item) {
    const tree = new vscode.TreeItem(path.basename(item.uri.path));
    tree.description = vscode.workspace.asRelativePath(item.uri);
    tree.tooltip = item.uri.fsPath;
    tree.resourceUri = item.uri;
    tree.command = { command: 'cibyp.changes.open', title: '查看 AI 修改', arguments: [item] };
    return tree;
  }
  record(uri, before, after) {
    const key = documentKey(uri);
    const existing = this.items.get(key);
    const snapshot = vscode.Uri.from({
      scheme: 'cibyp-checkpoint',
      path: uri.path,
      query: crypto.randomUUID(),
    });
    const item = { uri, before: existing ? existing.before : before, after, snapshot };
    if (existing) this.snapshots.delete(existing.snapshot.toString());
    this.items.set(key, item);
    this.snapshots.set(snapshot.toString(), item.before || '');
    this.events.fire();
    vscode.commands.executeCommand('setContext', 'cibyp.hasChanges', true);
  }
  async open(item) {
    if (item)
      await vscode.commands.executeCommand(
        'vscode.diff',
        item.snapshot,
        item.uri,
        `${path.basename(item.uri.path)} · CIBYP 修改`,
      );
  }
  accept(item) {
    if (!item) return;
    this.items.delete(documentKey(item.uri));
    this.snapshots.delete(item.snapshot.toString());
    this.events.fire();
    vscode.commands.executeCommand('setContext', 'cibyp.hasChanges', this.items.size > 0);
  }
  async revert(item) {
    if (!item) return;
    const document = await vscode.workspace.openTextDocument(item.uri);
    if (document.isDirty || document.getText() !== item.after) {
      void vscode.window.showWarningMessage(
        '这份文件在 AI 修改后又发生了变化，请在差异视图中手动合并，避免覆盖后续编辑。',
      );
      return { ok: false, conflict: true };
    }
    const edit = new vscode.WorkspaceEdit();
    if (item.before === null) edit.deleteFile(item.uri);
    else
      edit.replace(
        item.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        item.before,
      );
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('撤销修改失败');
    if (item.before !== null && !(await document.save())) throw new Error('撤销内容保存失败');
    this.accept(item);
  }
  async read(params) {
    if (params.encoding && !/^utf-?8$/i.test(params.encoding)) return { handled: false };
    const uri = targetUri(params);
    let doc = vscode.workspace.textDocuments.find(
      (item) => documentKey(item.uri) === documentKey(uri),
    );
    try {
      if (!doc) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) return { handled: false };
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
      doc ||= await vscode.workspace.openTextDocument(uri);
    } catch {
      return { handled: false };
    }
    this.readVersions.set(documentKey(uri), doc.version);
    return {
      handled: true,
      result: {
        ok: true,
        content: doc.getText(),
        encoding: 'utf-8',
        eol: doc.eol === vscode.EndOfLine.CRLF ? 'crlf' : 'lf',
        dirty: doc.isDirty,
        documentVersion: doc.version,
        source: 'codeoss',
        location: params.location,
      },
    };
  }
  async write(params) {
    const uri = targetUri(params);
    let doc = vscode.workspace.textDocuments.find(
      (item) => documentKey(item.uri) === documentKey(uri),
    );
    if (doc?.isDirty)
      return {
        handled: true,
        result: {
          ok: false,
          error: '文件含有未保存的编辑。请先保存，或在 IDE 中确认合并后重试；AI 未覆盖编辑内容。',
          conflict: true,
          documentVersion: doc.version,
        },
      };
    if (
      typeof params.content !== 'string' ||
      (params.options?.encoding && !/^utf-?8$/i.test(params.options.encoding))
    )
      return { handled: false };
    const readVersion = this.readVersions.get(documentKey(uri));
    if (doc && readVersion && readVersion !== doc.version)
      return {
        handled: true,
        result: { ok: false, error: '文件在读取后发生了变化，请重新读取再修改。', conflict: true },
      };
    let before = null;
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch (error) {
        try {
          await vscode.workspace.fs.stat(uri);
          return { handled: false };
        } catch (statError) {
          if (statError.code !== 'FileNotFound') throw error;
        }
      }
    }
    if (doc) before = doc.getText();
    const content = params.options?.append ? (before || '') + params.content : params.content;
    const edit = new vscode.WorkspaceEdit();
    if (doc)
      edit.replace(
        uri,
        new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)),
        content,
      );
    else {
      edit.createFile(uri, { overwrite: false });
      edit.insert(uri, new vscode.Position(0, 0), content);
    }
    if (!(await vscode.workspace.applyEdit(edit)))
      return { handled: true, result: { ok: false, error: 'IDE 拒绝应用文件修改' } };
    doc ||= await vscode.workspace.openTextDocument(uri);
    const saved = await doc.save();
    this.record(uri, before, doc.getText());
    if (!saved)
      return {
        handled: true,
        result: { ok: false, error: '文件修改已进入编辑器，但保存失败，请在 IDE 中检查。' },
      };
    this.readVersions.set(documentKey(uri), doc.version);
    return {
      handled: true,
      result: { ok: true, path: params.path, source: 'codeoss', location: params.location },
    };
  }
}

class AgentView {
  constructor(context, bridge) {
    this.context = context;
    this.bridge = bridge;
    this.streams = new Map();
    this.attachments = [];
  }
  async resolveWebviewView(view) {
    this.view = view;
    const nonce = crypto.randomBytes(16).toString('hex');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    const script = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media/agent.js'),
    );
    const style = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media/agent.css'),
    );
    view.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body>
      <header><select id="sessions" aria-label="Agent 会话"></select><button id="new" title="新会话">＋</button><button id="settings" title="模型与预算设置">⚙</button></header>
      <div id="model" class="muted">正在连接 CIBYP…</div><main id="messages" aria-live="polite"></main>
      <div id="approval" hidden><strong>工具需要确认</strong><pre id="approval-text"></pre><button id="approve">允许</button><button id="reject">拒绝</button></div>
      <footer><div id="attachments"></div><label><input id="context" type="checkbox" checked>附带当前选区 / 文件与诊断</label><textarea id="prompt" rows="4" placeholder="描述编程任务，Enter 发送，Shift+Enter 换行" aria-label="编程任务"></textarea><div class="actions"><button id="attach" title="附加文件">＋ 文件</button><span id="status" class="muted">就绪</span><button id="stop" hidden>停止</button><button id="send">发送</button></div></footer>
      <script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage(
      async (message) => {
        try {
          if (message.type === 'ready') {
            await this.refresh();
          } else if (
            message.type === 'send' &&
            typeof message.text === 'string' &&
            message.text.trim()
          ) {
            const text = message.text.slice(0, 200000);
            if (!vscode.workspace.isTrusted)
              throw new Error('请先在 Code-OSS 中信任当前工作区，再执行 Agent 编程任务。');
            this.post('user', { text });
            this.post('running', true);
            await this.bridge.request(
              'agent.send',
              {
                text,
                context: message.context ? contextSnapshot() : null,
                attachments: this.attachments,
              },
              3600000,
            );
            this.post('running', false);
            this.attachments = [];
            this.post('attachments', []);
            await this.refresh();
          } else if (message.type === 'stop') await this.bridge.request('agent.cancel');
          else if (message.type === 'approve')
            await this.bridge.request('agent.approve', { approved: message.approved === true });
          else if (message.type === 'new') {
            await this.bridge.request('agent.newSession');
            await this.refresh();
          } else if (message.type === 'session') {
            await this.bridge.request('agent.selectSession', { key: message.key });
            await this.refresh();
          } else if (message.type === 'attach') {
            const files = await vscode.window.showOpenDialog({
              canSelectMany: true,
              canSelectFiles: true,
              canSelectFolders: false,
              defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
              title: '添加 Agent 上下文文件',
            });
            for (const uri of files || []) {
              const file = {
                path: uri.scheme === 'vscode-remote' ? uri.path : uri.fsPath,
                name: path.basename(uri.path),
              };
              if (!this.attachments.some((item) => item.path === file.path))
                this.attachments.push(file);
            }
            this.post('attachments', this.attachments);
          } else if (message.type === 'removeAttachment') {
            this.attachments.splice(Number(message.index), 1);
            this.post('attachments', this.attachments);
          } else if (message.type === 'settings') await this.bridge.request('app.settings');
          else if (message.type === 'openLink' && typeof message.url === 'string') {
            const uri = vscode.Uri.parse(message.url);
            if (['http', 'https'].includes(uri.scheme)) await vscode.env.openExternal(uri);
          }
        } catch (error) {
          this.post('error', error.message);
          this.post('running', false);
        }
      },
      undefined,
      this.context.subscriptions,
    );
  }
  post(type, data) {
    this.view?.webview.postMessage({ type, data });
  }
  event(message) {
    if (message.event === 'personalization') {
      this.personalization = message.data;
      this.post('personalization', message.data);
    }
    if (message.event === 'agent') {
      const data = { ...message.data };
      const key = `${data.sessionKey || ''}:${data.data?.requestId || ''}`;
      if (data.type === 'stream-start')
        this.streams.set(key, { content: '', ended: false, sessionKey: data.sessionKey });
      const entry = this.streams.get(key);
      if (data.type === 'stream-chunk' && data.data?.content) {
        if (entry?.ended) return;
        if (entry) {
          entry.content += data.data.content;
          data.html = markdown.render(entry.content);
        }
      }
      if (data.type === 'stream-end') {
        if (entry?.ended) return;
        if (entry) entry.ended = true;
        data.html = markdown.render(data.data?.content || entry?.content || '');
      }
      if (data.type === 'assistant')
        data.html = markdown.render(
          typeof data.data === 'string' ? data.data : data.data?.content || '',
        );
      if (this.streams.size > 100) this.streams.delete(this.streams.keys().next().value);
      this.post('agent', data);
    }
    if (message.event === 'disconnected') this.post('error', 'CIBYP 连接暂时断开，正在重连。');
    if (message.event === 'connected') this.refresh().catch(() => {});
  }
  async refresh() {
    this.post('personalization', await this.bridge.request('personalization.get'));
    const sessions = await this.bridge.request('agent.sessions');
    sessions.messages = (sessions.messages || []).map((message) => ({
      ...message,
      html: markdown.render(message.content || ''),
    }));
    this.post('sessions', sessions);
    if (sessions.running) {
      const active = [...this.streams.values()].findLast(
        (entry) => entry.sessionKey === sessions.activeKey && !entry.ended,
      );
      if (active?.content)
        this.post('agent', {
          type: 'stream-chunk',
          sessionKey: sessions.activeKey,
          html: markdown.render(active.content),
        });
    }
    this.post('attachments', this.attachments);
  }
}

async function applyPersonalization(data) {
  const configuration = vscode.workspace.getConfiguration();
  const colors = {
    ...configuration.inspect('workbench.colorCustomizations')?.globalValue,
    ...workbenchColors(data),
  };
  const settings = {
    'workbench.colorTheme': data.dark ? 'Dark Modern' : 'Light Modern',
    'workbench.colorCustomizations': colors,
    'workbench.reduceMotion': data.animations ? 'auto' : 'on',
    'telemetry.telemetryLevel': 'off',
  };
  for (const [key, value] of Object.entries(settings)) {
    if (JSON.stringify(configuration.inspect(key)?.globalValue) !== JSON.stringify(value))
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

async function activate(context) {
  const bridge = new Bridge(context);
  const changes = new Changes(context);
  const agent = new AgentView(context, bridge);
  const output = vscode.window.createOutputChannel('CIBYP');
  context.subscriptions.push(
    bridge,
    output,
    vscode.window.registerWebviewViewProvider('cibyp.agent', agent, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider('cibyp.changes', changes),
  );
  let themeUpdates = Promise.resolve();
  context.subscriptions.push(
    bridge.onEvent((event) => {
      agent.event(event);
      if (event.event === 'personalization')
        themeUpdates = themeUpdates
          .then(() => applyPersonalization(event.data))
          .catch((error) => output.appendLine(error.message));
    }),
  );
  bridge.handlers.set('ide.context', () => contextSnapshot());
  bridge.handlers.set('ide.readDocument', (params) => changes.read(params));
  bridge.handlers.set('ide.writeDocument', (params) => changes.write(params));
  bridge.handlers.set('ide.command', async (params) => {
    const allowed = new Set([
      'workbench.action.terminal.toggleTerminal',
      'workbench.view.extensions',
      'workbench.view.scm',
      'workbench.action.showCommands',
      'workbench.action.debug.start',
      'cibyp.agent.focus',
    ]);
    if (!allowed.has(params.command)) throw new Error('Command is not exposed to CIBYP');
    return vscode.commands.executeCommand(params.command);
  });
  bridge.handlers.set('ide.openWorkspace', async (params) => {
    const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty);
    if (dirty.length) {
      const answer = await vscode.window.showWarningMessage(
        '切换工作区前，需要处理未保存的文件。',
        { modal: true },
        '保存并切换',
        '取消',
      );
      if (answer !== '保存并切换' || !(await vscode.workspace.saveAll(true)))
        return { cancelled: true };
    }
    setTimeout(
      () =>
        vscode.commands
          .executeCommand(
            'vscode.openFolder',
            params.uri ? vscode.Uri.parse(params.uri) : undefined,
            { forceReuseWindow: true },
          )
          .then(undefined, (error) => output.appendLine(error.message)),
      100,
    );
    return { accepted: true };
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      bridge.send({ type: 'event', event: 'workspace', data: workspaceFolders() }),
    ),
  );
  const commands = {
    'cibyp.agent.focus': () => vscode.commands.executeCommand('cibyp.agent.focus'),
    'cibyp.agent.explain': async () => {
      await vscode.commands.executeCommand('workbench.view.extension.cibyp');
      agent.post('draft', '解释当前选中的代码，包括作用、潜在问题和改进建议。');
    },
    'cibyp.agent.refactor': async () => {
      await vscode.commands.executeCommand('workbench.view.extension.cibyp');
      agent.post('draft', '重构当前选中的代码，保持功能一致，改善结构并验证修改。');
    },
    'cibyp.agent.review': async () => {
      await vscode.commands.executeCommand('workbench.view.extension.cibyp');
      agent.post('draft', '审查当前工作区的 Git 变更，找出实际缺陷并说明影响。');
    },
    'cibyp.agent.settings': () => bridge.request('app.settings'),
    'cibyp.changes.open': (item) => changes.open(item),
    'cibyp.changes.accept': (item) => changes.accept(item),
    'cibyp.changes.revert': (item) => changes.revert(item),
  };
  // The view's generated focus command already exists; registering it again would recurse.
  delete commands['cibyp.agent.focus'];
  for (const [command, handler] of Object.entries(commands))
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  if (vscode.workspace.registerRemoteAuthorityResolver) {
    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver('cibyp-vm', {
        async resolve() {
          const authority = await bridge.request('vm.resolve', {}, 180000);
          return new vscode.ResolvedAuthority(
            authority.host,
            authority.port,
            authority.connectionToken,
          );
        },
        async getCanonicalURI(uri) {
          return uri;
        },
        async tunnelFactory(options) {
          const tunnel = await bridge.request('vm.forward', {
            port: options.remoteAddress.port,
            localPort: options.localAddressPort,
          });
          const closed = new vscode.EventEmitter();
          return {
            remoteAddress: options.remoteAddress,
            localAddress: `127.0.0.1:${tunnel.hostPort}`,
            onDidDispose: closed.event,
            dispose: async () => {
              await bridge.request('vm.unforward', { port: tunnel.hostPort });
              closed.fire();
              closed.dispose();
            },
          };
        },
      }),
    );
  }
  if (vscode.chat?.createChatParticipant) {
    const participant = vscode.chat.createChatParticipant(
      'cibyp.agent',
      async (request, _chatContext, stream, token) => {
        const subscription = bridge.onEvent((event) => {
          if (event.event !== 'agent') return;
          const data = event.data;
          if (data.type === 'stream-chunk' && data.data?.content)
            stream.markdown(data.data.content);
          else if (data.type === 'tool_call')
            stream.progress(`工具：${data.data?.name || data.data?.toolName || ''}`);
          else if (data.type === 'error') stream.markdown(`\n${String(data.data)}`);
        });
        const cancel = token.onCancellationRequested(() =>
          bridge.request('agent.cancel').catch(() => {}),
        );
        try {
          await bridge.request(
            'agent.send',
            { text: request.prompt, context: contextSnapshot() },
            3600000,
          );
        } finally {
          subscription.dispose();
          cancel.dispose();
        }
        return {};
      },
    );
    participant.iconPath = new vscode.ThemeIcon('sparkle');
    context.subscriptions.push(participant);
  }
  await bridge.ready();
  // Resolver activation must finish before workspace configuration becomes ready.
  // Awaiting configuration.update here deadlocks remote workspace initialization.
  void bridge
    .request('personalization.get')
    .then((data) => {
      themeUpdates = themeUpdates
        .then(() => applyPersonalization(data))
        .catch((error) => output.appendLine(error.message));
    })
    .catch((error) => output.appendLine(error.message));
  return {
    version: 1,
    getContext: contextSnapshot,
    readDocument: (params) => changes.read(params),
    applyEdit: (params) => changes.write(params),
    getChanges: () => [...changes.items.values()],
    acceptChange: (item) => changes.accept(item),
    revertChange: (item) => changes.revert(item),
    sendTask: (text, includeContext = true) =>
      bridge.request(
        'agent.send',
        { text, context: includeContext ? contextSnapshot() : null },
        3600000,
      ),
  };
}

module.exports = { activate };
