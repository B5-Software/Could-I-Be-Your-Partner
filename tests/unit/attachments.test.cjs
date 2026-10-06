/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, presentation } = require('../../src/shared/attachments');
const { ContextManager } = require('../../src/renderer/js/context-manager');

test('attachments preserve an empty caption and durable file references without persisting binary or promises', () => {
  const files = normalize([
    {
      name: '../photo.png',
      path: '/workspace/photo.png',
      isImage: true,
      size: 1024,
      data: 'private binary',
      pendingSave: Promise.resolve(),
    },
  ]);
  assert.equal(files[0].name, 'photo.png');
  assert.ok(!JSON.stringify(files).includes('private binary'));
  const context = new ContextManager();
  context.addUserMessage('Model can use /workspace/photo.png', {
    displayContent: '',
    attachments: files,
  });
  const restored = new ContextManager();
  restored.loadFromHistory(JSON.parse(JSON.stringify(context.getHistoryMessages())));
  assert.deepEqual(presentation(restored.getHistoryMessages()[0]), {
    content: '',
    attachments: files,
  });
  assert.match(restored.getMessages()[0].content, /\/workspace\/photo.png/);
});

test('generated legacy attachment suffix migrates to cards without hiding ordinary user paths', () => {
  const legacy = presentation({
    role: 'user',
    content:
      'Please review\n\n[文件附件: notes.md]\n⚠️ 精确文件路径（必须逐字使用，禁止修改任何字符）: /workspace/notes.md',
  });
  assert.equal(legacy.content, 'Please review');
  assert.equal(legacy.attachments[0].name, 'notes.md');
  assert.equal(legacy.attachments[0].path, '/workspace/notes.md');
  assert.equal(
    presentation({ role: 'user', content: 'Please review /workspace/notes.md' }).content,
    'Please review /workspace/notes.md',
  );
});
