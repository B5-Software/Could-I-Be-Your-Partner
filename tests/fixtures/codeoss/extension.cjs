/* Runs in the real local/remote workspace extension host. Never shipped. */
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function waitFor(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Fixture condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !fs.existsSync(path.join(folder.uri.fsPath, '.cibyp-codeoss-test'))) return;
  const root = folder.uri.fsPath;
  const passed = [];
  try {
    const uri = vscode.Uri.joinPath(folder.uri, 'sample.js');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const typescript = vscode.extensions.getExtension('vscode.typescript-language-features');
    assert(typescript);
    await typescript.activate();
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider('javascript', {
        provideCompletionItems: () => [new vscode.CompletionItem('cibypFixtureCompletion')],
      }),
    );
    const completions = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      uri,
      new vscode.Position(0, 0),
    );
    assert(completions.items.some((item) => item.label === 'cibypFixtureCompletion'));
    passed.push('extension completion provider and TypeScript language extension');
    const git = await vscode.extensions.getExtension('vscode.git').activate();
    await waitFor(() => git.getAPI(1).repositories.length > 0);
    passed.push('native Git repository discovery');
    const terminal = vscode.window.createTerminal({ name: 'CIBYP integration', cwd: root });
    terminal.show();
    terminal.sendText(
      `node -e "require('fs').writeFileSync('terminal-result.txt',process.platform)"`,
    );
    await waitFor(() => fs.existsSync(path.join(root, 'terminal-result.txt')));
    assert.equal(fs.readFileSync(path.join(root, 'terminal-result.txt'), 'utf8'), process.platform);
    passed.push('native PTY terminal executes in workspace host');
    fs.writeFileSync(
      path.join(root, 'debug.cjs'),
      "require('fs').writeFileSync(require('path').join(__dirname,'debug-result.txt'),process.platform);\n",
    );
    assert(
      await vscode.debug.startDebugging(folder, {
        type: 'node',
        request: 'launch',
        name: 'Fixture debug',
        program: path.join(root, 'debug.cjs'),
        console: 'internalConsole',
        cwd: root,
      }),
    );
    await waitFor(() => fs.existsSync(path.join(root, 'debug-result.txt')));
    assert.equal(fs.readFileSync(path.join(root, 'debug-result.txt'), 'utf8'), process.platform);
    await waitFor(() => !vscode.debug.activeDebugSession);
    passed.push('native Node debugger');
    // UI extensions live in the App, so these APIs are tested on a host workspace.
    const cibypExtension = vscode.extensions.getExtension('cibyp.workbench');
    if (cibypExtension) {
      const api = await cibypExtension.activate();
      const params = { path: uri.fsPath, location: 'host' };
      const read = await api.readDocument(params);
      assert.equal(read.result.content, doc.getText());
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), '// unsaved user edit\n');
      assert(await vscode.workspace.applyEdit(edit));
      const write = await api.applyEdit({ ...params, content: '// unsafe overwrite\n' });
      assert.equal(write.result.conflict, true);
      assert(doc.getText().startsWith('// unsaved user edit'));
      await doc.save();
      assert.equal(
        (await api.applyEdit({ ...params, content: '// stale overwrite\n' })).result.conflict,
        true,
      );
      await api.readDocument(params);
      const before = doc.getText();
      assert.equal(
        (await api.applyEdit({ ...params, content: '// reviewed AI change\n' })).result.ok,
        true,
      );
      assert.equal(doc.getText(), '// reviewed AI change\n');
      await api.revertChange(api.getChanges()[0]);
      assert.equal(doc.getText(), before);
      const created = path.join(root, 'ai-created.js');
      assert.equal(
        (
          await api.applyEdit({
            path: created,
            location: 'host',
            content: 'const created = true;\n',
          })
        ).result.ok,
        true,
      );
      const checkpoint = api.getChanges().find((item) => item.uri.fsPath === created);
      assert(checkpoint);
      await api.revertChange(checkpoint);
      assert.equal(fs.existsSync(created), false);
      passed.push('AI edit conflicts, checkpoints, new-file creation and safe revert');
      if (fs.existsSync(path.join(root, '.cibyp-codeoss-ai'))) {
        await api.sendTask(
          '请调用 createFile，在当前工作区创建 agent-result.js，内容为 const throughAgent = true;，然后汇报完成。',
        );
        assert(fs.existsSync(path.join(root, 'agent-result.js')));
        passed.push('native extension → CIBYP Agent → LLM → real file tool → IDE checkpoint');
      }
    }
    await vscode.window.showTextDocument(doc);
    vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 10);
    fs.writeFileSync(
      path.join(root, 'fixture-result.json'),
      JSON.stringify({ ok: true, platform: process.platform, passed }),
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(root, 'fixture-result.json'),
      JSON.stringify({ ok: false, error: error.stack, passed }),
    );
  }
}

module.exports = { activate };
