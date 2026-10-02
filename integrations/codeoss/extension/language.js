/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const vscode = require('vscode');

function range(value) {
  return (
    value && {
      start: { line: value.start.line + 1, column: value.start.character + 1 },
      end: { line: value.end.line + 1, column: value.end.character + 1 },
    }
  );
}
function location(uri, value) {
  return {
    path: uri.scheme === 'file' ? uri.fsPath : uri.path,
    uri: uri.toString(true),
    range: range(value),
  };
}
function safe(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return value.slice(0, 3000);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5 || seen.has(value)) return '[truncated]';
  seen.add(value);
  if (value instanceof vscode.Uri) return value.toString(true);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safe(item, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 60)
      .map(([key, item]) => [key, safe(item, depth + 1, seen)]),
  );
}
function edits(edit) {
  return (
    edit
      ?.entries()
      .flatMap(([uri, values]) =>
        values.map((item) => ({ ...location(uri, item.range), text: item.newText })),
      ) || []
  );
}
function bounded(items, limit, incomplete = false) {
  const result = [];
  let size = 0;
  for (const item of items.slice(0, limit)) {
    const value = safe(item);
    size += JSON.stringify(value).length;
    if (size > 24000) break;
    result.push(value);
  }
  return {
    ok: true,
    items: result,
    total: items.length,
    truncated: incomplete || result.length < items.length,
  };
}
function extensionCommands() {
  return vscode.extensions.allAcrossExtensionHosts.flatMap((extension) =>
    (extension.packageJSON.contributes?.commands || []).map((item) => ({
      command: item.command,
      title: item.title,
      extension: extension.id,
    })),
  );
}
async function query(params = {}) {
  const limit = Math.max(1, Math.min(100, Number(params.limit) || 30));
  const matches = (item) =>
    !params.query ||
    JSON.stringify(item).toLowerCase().includes(String(params.query).toLowerCase());
  if (params.action === 'extensions')
    return bounded(
      vscode.extensions.allAcrossExtensionHosts
        .map((extension) => ({
          id: extension.id,
          version: extension.packageJSON.version,
          active: extension.isActive,
          languages: (extension.packageJSON.contributes?.languages || []).map((item) => item.id),
        }))
        .filter(matches),
      limit,
    );
  if (params.action === 'commands') return bounded(extensionCommands().filter(matches), limit);
  if (params.action === 'command') {
    if (
      !extensionCommands().some((item) => item.command === params.command) ||
      String(params.command).startsWith('_')
    )
      throw new Error('Choose a public command contributed by an installed extension.');
    if (
      !Array.isArray(params.arguments || []) ||
      JSON.stringify(params.arguments || []).length > 16000
    )
      throw new Error('Invalid command arguments.');
    const result = safe(
      await vscode.commands.executeCommand(params.command, ...(params.arguments || [])),
    );
    const encoded = JSON.stringify(result);
    return encoded?.length > 24000
      ? { ok: true, result: encoded.slice(0, 24000), truncated: true }
      : { ok: true, result };
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a workspace before using its language services.');
  const uri = params.path
    ? folder.uri.scheme === 'file'
      ? vscode.Uri.file(path.resolve(folder.uri.fsPath, params.path))
      : folder.uri.with({ path: path.posix.resolve(folder.uri.path, params.path) })
    : vscode.window.activeTextEditor?.document.uri;
  if (uri && !vscode.workspace.getWorkspaceFolder(uri))
    throw new Error('The requested document is outside the active workspace.');
  if (params.action === 'diagnostics') {
    const data = uri
      ? [[uri, vscode.languages.getDiagnostics(uri)]]
      : vscode.languages.getDiagnostics();
    return bounded(
      data.flatMap(([file, diagnostics]) =>
        diagnostics.map((item) => ({
          ...location(file, item.range),
          message: item.message,
          severity: item.severity,
          source: item.source,
          code: item.code,
        })),
      ),
      limit,
    );
  }
  if (params.action === 'workspaceSymbols') {
    if (typeof params.query !== 'string') throw new Error('Provide a symbol query.');
    const items = await vscode.commands.executeCommand(
      'vscode.executeWorkspaceSymbolProvider',
      params.query,
    );
    return bounded(
      (items || []).map((item) => ({
        name: item.name,
        kind: item.kind,
        ...location(item.location.uri, item.location.range),
      })),
      limit,
    );
  }
  if (!uri) throw new Error('Provide a workspace file path or select an editor.');
  const document = await vscode.workspace.openTextDocument(uri);
  const line = Number(params.line || 1),
    column = Number(params.column || 1);
  if (
    !Number.isInteger(line) ||
    line < 1 ||
    line > document.lineCount ||
    !Number.isInteger(column) ||
    column < 1 ||
    column > document.lineAt(line - 1).text.length + 1
  )
    throw new Error('Positions are 1-based and must be inside the document.');
  const position = new vscode.Position(line - 1, column - 1);
  let items;
  const providers = {
    definition: 'vscode.executeDefinitionProvider',
    typeDefinition: 'vscode.executeTypeDefinitionProvider',
    implementation: 'vscode.executeImplementationProvider',
    references: 'vscode.executeReferenceProvider',
  };
  if (providers[params.action]) {
    items = (
      (await vscode.commands.executeCommand(providers[params.action], uri, position)) || []
    ).map((item) =>
      location(
        item.uri || item.targetUri,
        item.range || item.targetSelectionRange || item.targetRange,
      ),
    );
  } else if (params.action === 'hover') {
    items = (
      (await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position)) || []
    ).map((item) => ({
      range: range(item.range),
      contents: item.contents.map((content) =>
        typeof content === 'string' ? content : content.value,
      ),
    }));
  } else if (params.action === 'symbols') {
    const collect = (values) =>
      (values || []).flatMap((item) => [
        {
          name: item.name,
          kind: item.kind,
          range: range(item.selectionRange || item.range || item.location?.range),
        },
        ...collect(item.children),
      ]);
    items = collect(
      await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri),
    );
  } else if (params.action === 'completion') {
    const result = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      uri,
      position,
      undefined,
      Math.min(limit, 10),
    );
    return bounded(
      (result?.items || [])
        .map((item) => ({
          label: item.label,
          kind: item.kind,
          detail: item.detail,
          documentation:
            typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
          insertText:
            typeof item.insertText === 'string' ? item.insertText : item.insertText?.value,
        }))
        .filter(matches),
      limit,
      result?.isIncomplete,
    );
  } else if (params.action === 'codeActions') {
    items = (
      (await vscode.commands.executeCommand(
        'vscode.executeCodeActionProvider',
        uri,
        new vscode.Range(position, position),
        undefined,
        Math.min(limit, 10),
      )) || []
    ).map((item) => ({
      title: item.title,
      kind: item.kind?.value,
      preferred: item.isPreferred,
      disabled: item.disabled?.reason,
      command: item.command,
      edits: edits(item.edit),
    }));
  } else if (params.action === 'rename') {
    if (typeof params.newName !== 'string' || !params.newName.trim() || params.newName.length > 120)
      throw new Error('Provide the new symbol name.');
    items = edits(
      await vscode.commands.executeCommand(
        'vscode.executeDocumentRenameProvider',
        uri,
        position,
        params.newName,
      ),
    );
  } else if (params.action === 'format') {
    items = (
      (await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, {
        tabSize: 2,
        insertSpaces: true,
      })) || []
    ).map((item) => ({ ...location(uri, item.range), text: item.newText }));
  } else throw new Error('Unknown language-service action.');
  return {
    ...bounded(items, limit),
    documentVersion: document.version,
    dirty: document.isDirty,
    preview: ['rename', 'format', 'codeActions'].includes(params.action),
  };
}
async function languageQuery(params) {
  let timer;
  try {
    return await Promise.race([
      query(params),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('The extension language service did not respond within 15 seconds.')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { languageQuery };
