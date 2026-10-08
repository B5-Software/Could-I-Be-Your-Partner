/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Lsp } = require('@deepseek-ai/dsh-lsp');
function range(value) {
  return (
    value && {
      start: { line: value.start.line - 1, character: value.start.column - 1 },
      end: { line: value.end.line - 1, character: value.end.column - 1 },
    }
  );
}
class CibypLanguage extends Lsp {
  constructor(ctx, options) {
    super(ctx);
    this.options = options;
  }
  async query(request, signal) {
    try {
      return await super.query(request, signal);
    } catch (error) {
      if (error.code !== 'LSP_UNAVAILABLE' || !this.options.invoke) throw error;
    }
    signal?.throwIfAborted();
    const action = {
      goToDefinition: 'definition',
      findReferences: 'references',
      goToImplementation: 'implementation',
      hover: 'hover',
    }[request.operation];
    if (!action) throw new Error('Unsupported language operation');
    const result = await this.options.invoke(
      'codeoss:language',
      {
        action,
        path: request.filePath,
        line: request.position.line + 1,
        column: request.position.character + 1,
      },
      request.workspaceRoot,
    );
    signal?.throwIfAborted();
    if (result.ok === false) throw new Error(result.error);
    const items = result.items || [];
    return action === 'hover'
      ? {
          kind: 'hover',
          hover: items.length
            ? {
                contents: items.flatMap((item) => item.contents || []).join('\n\n'),
                ...(items[0].range ? { range: range(items[0].range) } : {}),
              }
            : null,
        }
      : {
          kind: 'locations',
          locations: items.map((item) => ({ uri: item.uri, range: range(item.range) })),
          resolvedWorkspaceUri: pathToFileURL(path.resolve(request.workspaceRoot)).href,
        };
  }
}
module.exports = { CibypLanguage };
