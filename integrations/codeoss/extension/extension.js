/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const path = require('node:path');
const WebSocket = require('ws');

let toolbarTerminal;
async function openWorkspaceTerminal() {
  // A remote workspace URI lets Code-OSS resolve the guest shell and PTY. Do not
  // restore a terminated terminal or reuse a host filesystem cwd in VM mode.
  if (
    !toolbarTerminal ||
    toolbarTerminal.exitStatus ||
    !vscode.window.terminals.includes(toolbarTerminal)
  ) {
    toolbarTerminal = vscode.window.createTerminal({
      name: 'CIBYP',
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
      isTransient: true,
    });
  }
  toolbarTerminal.show(false);
  return { ok: true };
}

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
function editorState() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return {};
  return {
    path:
      editor.document.uri.scheme === 'vscode-remote'
        ? editor.document.uri.path
        : editor.document.uri.fsPath,
    dirty: editor.document.isDirty,
    selection: {
      start: editor.selection.start.line + 1,
      end: editor.selection.end.line + 1,
      selected: !editor.selection.isEmpty,
    },
  };
}
function contextSnapshot() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { workspace: workspaceFolders(), diagnostics: [] };
  const selection = editor.document.getText(editor.selection);
  const full = editor.document.getText();
  const start = editor.document.offsetAt(editor.selection.start);
  const content = selection
    ? selection.slice(0, 24000)
    : full.slice(Math.max(0, start - 8000), Math.max(0, start - 8000) + 24000);
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
    truncated: selection ? selection.length > content.length : full.length > content.length,
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
  list() {
    return [...this.items.values()].map((item) => ({
      id: item.snapshot.toString(),
      path: item.uri.scheme === 'vscode-remote' ? item.uri.path : item.uri.fsPath,
      label: vscode.workspace.asRelativePath(item.uri),
      created: item.before === null,
    }));
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

async function activate(context) {
  const bridge = new Bridge(context);
  const changes = new Changes(context);
  const output = vscode.window.createOutputChannel('CIBYP');
  context.subscriptions.push(bridge, output);
  context.subscriptions.push(
    bridge.onEvent((event) => {
      if (event.event === 'connected') publishEditorState();
    }),
  );
  function publishEditorState() {
    bridge.send({ type: 'event', event: 'ide-state', data: editorState() });
    bridge.send({ type: 'event', event: 'changes', data: changes.list() });
  }
  let stateTimer;
  const scheduleEditorState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(
      () => bridge.send({ type: 'event', event: 'ide-state', data: editorState() }),
      75,
    );
  };
  context.subscriptions.push(
    { dispose: () => clearTimeout(stateTimer) },
    changes.events.event(() =>
      bridge.send({ type: 'event', event: 'changes', data: changes.list() }),
    ),
    vscode.window.onDidChangeActiveTextEditor(scheduleEditorState),
    vscode.window.onDidChangeTextEditorSelection(scheduleEditorState),
    vscode.workspace.onDidSaveTextDocument(scheduleEditorState),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) scheduleEditorState();
    }),
  );
  bridge.handlers.set('ide.changes', async ({ action = 'list', id }) => {
    if (!['list', 'open', 'accept', 'revert'].includes(action))
      throw new Error('Unknown change action');
    let result;
    if (action !== 'list') {
      const item = [...changes.items.values()].find((item) => item.snapshot.toString() === id);
      if (!item) throw new Error('This checkpoint has changed; refresh the changes list.');
      result = await changes[action](item);
    }
    return { ...result, changes: changes.list() };
  });
  bridge.handlers.set('ide.context', () => contextSnapshot());
  bridge.handlers.set('ide.language', require('./language').languageQuery);
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
    if (params.command === 'workbench.action.terminal.toggleTerminal')
      return openWorkspaceTerminal();
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
  const focusAgent = (draft) => bridge.request('agent.focus', { draft });
  const commands = {
    'cibyp.agent.focus': () => focusAgent(),
    'cibyp.agent.explain': () => focusAgent('解释当前选中的代码，包括作用、潜在问题和改进建议。'),
    'cibyp.agent.refactor': () =>
      focusAgent('重构当前选中的代码，保持功能一致，改善结构并验证修改。'),
    'cibyp.agent.review': () => focusAgent('审查当前工作区的 Git 变更，找出实际缺陷并说明影响。'),
    'cibyp.agent.settings': () => bridge.request('app.settings'),
  };
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
  await bridge.ready();
  publishEditorState();
  // Appearance is managed in the renderer's memory configuration layer. Never
  // write User/settings.json while syncing colors or initializing the resolver.
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
