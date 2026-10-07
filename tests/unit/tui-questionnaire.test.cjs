/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { TuiApp } = require('../../src/tui/app');
const { stripAnsi } = require('../../src/tui/ansi');

function fixture(questions) {
  const replies = [];
  const runtime = {
    respond: async (key, answer) => {
      replies.push({ key, answer });
      return { ok: true };
    },
  };
  const app = new TuiApp({ runtime });
  app.activeKey = 'question-owner';
  app.state.modal = app._buildAskModal(questions, 0);
  return { app, replies, key: (key) => app.handleKey(key) };
}

test('custom answers, descriptions and review preserve text and send only on explicit submission', async () => {
  const { app, replies, key } = fixture([
    {
      question: 'Which?',
      options: [{ label: 'First', description: 'Description', value: 'first' }],
    },
  ]);
  assert.ok(app.frame().lines.map(stripAnsi).join('\n').includes('Description'));
  await key({ name: 'down' });
  await key({ name: 'enter' });
  assert.equal(app.state.modal.inputMode, true);
  await key({ name: 'paste', text: 'my own answer' });
  await key({ name: 'enter' });
  assert.equal(app.state.modal.phase, 'review');
  assert.deepEqual(replies, []);
  await key({ name: 'enter' });
  assert.deepEqual(replies, [{ key: 'question-owner', answer: { answers: ['my own answer'] } }]);
});

test('multiple selection survives backward navigation, combines free text and returns arrays', async () => {
  const { app, replies, key } = fixture([
    { question: 'Select features', options: ['A', 'B'], multiSelect: true },
    { question: 'Details' },
  ]);
  await key({ name: 'char', char: ' ' });
  await key({ name: 'down' });
  await key({ name: 'enter' });
  await key({ name: 'down' });
  await key({ name: 'enter' });
  await key({ name: 'paste', text: 'custom feature' });
  await key({ name: 'enter' });
  assert.equal(app.state.modal.inputMode, undefined);
  await app._chooseModalOption(3);
  await key({ name: 'paste', text: 'details' });
  await key({ name: 'tab', shift: true });
  assert.match(app.state.modal.options[0].label, /\[x\]/);
  await key({ name: 'tab' });
  assert.equal(app.state.modal.editor.value, 'details');
  await key({ name: 'enter' });
  await key({ name: 'enter' });
  assert.deepEqual(replies[0].answer.answers, [['A', 'B', 'custom feature'], 'details']);
});

test('cancel is explicit and never submits partial responses; empty answers stay editable', async () => {
  const { app, replies, key } = fixture([{ question: 'Details' }]);
  await key({ name: 'enter' });
  assert.equal(app.state.modal.inputMode, true);
  assert.ok(app.state.modal.error);
  await key({ name: 'escape' });
  assert.equal(app.state.modal.phase, 'cancel');
  assert.deepEqual(replies, []);
  await key({ name: 'escape' });
  assert.equal(app.state.modal.inputMode, true);
  await key({ name: 'escape' });
  await app._chooseModalOption(1);
  assert.deepEqual(replies[0].answer, { answers: [] });
});

test('an unconfirmed custom draft is retained but is not included in multiple-choice answers', async () => {
  const { app, replies, key } = fixture([
    { question: 'Choose', options: ['A'], multiSelect: true },
  ]);
  await app._chooseModalOption(1);
  await key({ name: 'paste', text: 'unconfirmed' });
  await key({ name: 'escape' });
  await app._chooseModalOption(0);
  await app._chooseModalOption(2);
  await key({ name: 'enter' });
  assert.deepEqual(replies[0].answer.answers, [['A']]);
});

test('review refuses skipped questions; submission errors retain the answers for retry', async () => {
  const { app, replies, key } = fixture([
    { question: 'One', options: ['yes'] },
    { question: 'Two' },
  ]);
  await key({ name: 'tab' });
  await key({ name: 'paste', text: 'second' });
  await key({ name: 'enter' });
  await key({ name: 'enter' });
  assert.equal(app.state.modal.questionIndex, 0);
  assert.ok(app.state.modal.error);
  await key({ name: 'enter' });
  await key({ name: 'enter' });
  app.runtime.respond = async () => {
    throw Error('Backend disconnected');
  };
  await key({ name: 'enter' });
  assert.equal(app.state.modal.phase, 'review');
  assert.match(app.state.modal.error, /disconnected/);
  assert.deepEqual(replies, []);
});

test('long questions and descriptions are scrollable and mouse hits choose the same option as keys', async () => {
  const { app, key } = fixture([
    {
      question: Array.from({ length: 30 }, (_, i) => `Question ${i}`).join('\n'),
      options: ['A', 'B'],
    },
  ]);
  app.resize(45, 18);
  for (let i = 0; i < 10; i++) await key({ name: 'pageup' });
  const top = app.frame();
  assert.match(top.lines.map(stripAnsi).join('\n'), /Question 0/);
  await key({ name: 'down' });
  const hit = app.frame().hits.modal.find((hit) => hit.index === 1);
  assert.ok(hit);
  await key({ name: 'mouse', button: 'left', press: true, x: 5, y: hit.row });
  await key({ name: 'mouse', button: 'left', press: false, x: 5, y: hit.row });
  assert.equal(app.state.modal.phase, 'review');
  assert.equal(app.state.modal.questionnaire.answers[0], 'B');
});
