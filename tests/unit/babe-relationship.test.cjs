/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BabeRelationship } = require('../../src/main/services/babe-relationship');
const protocol = require('../../src/shared/babe-relationship');
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-relationship-'));
  const settings = {
    babe: { initialAffection: 30, relationship: { enabled: true, pace: 'natural' } },
  };
  let time = Date.UTC(2026, 9, 1, 12);
  const args = {
    file: path.join(dir, 'babe-relationship.json'),
    getSettings: () => settings,
    now: () => time,
    ...extra,
  };
  const service = new BabeRelationship(args);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let turn = 0;
  const exchange = (text, metadata = {}, conversationId = 'one') => {
    const lease = service.begin({ text, conversationId, turnId: ++turn });
    return service.complete({
      token: lease.token,
      content: `谢谢你告诉我。<cibyp-relationship>${JSON.stringify({ kind: 'support', evidence: text, ...metadata })}</cibyp-relationship>`,
    });
  };
  return {
    service,
    args,
    settings,
    exchange,
    advance: (days) => {
      time += days * 86400000;
    },
  };
}
test('one durable relationship across chats, independent files, no penalty for absence', (t) => {
  const f = fixture(t, { legacy: () => ({ affection: 45 }) });
  assert.equal(f.service.snapshot().metrics.affection, 45);
  f.exchange('我喜欢下雨天一起读书', {
    memory: { kind: 'preference', content: '用户喜欢下雨天一起读书。' },
  });
  const first = f.service.snapshot();
  const restored = new BabeRelationship(f.args);
  assert.deepEqual(restored.snapshot().metrics, first.metrics);
  f.advance(40);
  assert.deepEqual(f.service.snapshot().metrics, first.metrics);
  assert.equal(f.service.snapshot().mood, 'calm');
  f.exchange('接着上次聊的话题吧', {}, 'another');
  assert.ok(f.service.context('en').content.includes('下雨天'));
  assert.equal(f.service.snapshot().memories.length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(f.args.file)), ['babe-relationship.json']);
});
test('unsupported or invented evidence cannot change affection; repetition and daily gains are bounded', (t) => {
  const f = fixture(t);
  f.exchange('你好呀', { kind: 'support', evidence: 'not in the human message', delta: 100 });
  assert.equal(f.service.snapshot().metrics.affection, 30);
  f.exchange('我愿意认真听你说话');
  const once = f.service.snapshot().metrics;
  f.exchange('我愿意认真听你说话');
  assert.deepEqual(f.service.snapshot().metrics, once);
  for (let i = 0; i < 30; i++) f.exchange('愿意认真听你说话 ' + i);
  assert.ok(f.service.snapshot().metrics.affection <= 36);
  assert.ok(f.service.snapshot().metrics.familiarity <= 11);
  assert.equal(f.service.snapshot().stage, 'acquaintance');
});
test('eligible scores never imply romance; explicit agreement and prerequisites both matter', (t) => {
  const f = fixture(t);
  f.exchange('我想和你交往', { milestone: 'dating' });
  assert.equal(f.service.snapshot().stage, 'strangers');
  const s = f.service.state;
  s.metrics = { affection: 70, trust: 60, familiarity: 40 };
  s.days = ['1', '2', '3', '4'];
  s.stage = 'close';
  f.exchange('今天天气很好', { milestone: 'dating' });
  assert.equal(f.service.snapshot().stage, 'close');
  f.exchange('我不想和你交往', { milestone: 'dating' });
  assert.equal(f.service.snapshot().stage, 'close');
  f.exchange('我们试着交往吧', { milestone: 'dating' });
  assert.equal(f.service.snapshot().stage, 'dating');
  assert.equal(f.service.snapshot().milestones.length, 1);
  f.exchange('我们互相承诺做伴侣', { milestone: 'partner' });
  assert.equal(f.service.snapshot().stage, 'dating', 'commitment has stricter prerequisites');
});
test('edits, deletion, reset and disabled capture invalidate pending updates without touching chats', (t) => {
  const f = fixture(t);
  f.exchange('不要叫我宝宝', {
    kind: 'respect',
    memory: { kind: 'boundary', content: '用户不喜欢被叫宝宝。' },
  });
  let view = f.service.snapshot();
  const pending = f.service.begin({ text: '我喜欢散步', conversationId: 'one', turnId: 'pending' });
  assert.equal(
    f.service.edit({ id: view.memories[0].id, revision: view.revision - 1, remove: true }).conflict,
    true,
  );
  view = f.service.edit({
    id: view.memories[0].id,
    revision: view.revision,
    content: '用户希望使用自己的名字。',
  });
  assert.equal(view.memories[0].edited, true);
  assert.equal(f.service.complete({ token: pending.token, content: '好的' }).skipped, true);
  view = f.service.edit({ id: view.memories[0].id, revision: view.revision, remove: true });
  assert.equal(view.memories.length, 0);
  f.settings.babe.relationship.enabled = false;
  f.service.settingsChanged();
  assert.equal(f.service.begin({ text: '新消息', conversationId: 'one' }).skipped, true);
  assert.match(f.service.context().content, /Relationship growth is paused/);
  assert.ok(!f.service.context().content.includes('<cibyp-relationship>'));
  f.settings.babe.relationship.start = 'partner';
  view = f.service.edit({ revision: view.revision, reset: true });
  assert.equal(view.stage, 'partner');
  assert.equal(view.daysTogether, 0);
});
test('secrets are excluded, corrupt storage fails visibly, and hidden metadata never enters display', (t) => {
  const f = fixture(t);
  f.exchange('密码: abcd1234', { memory: { kind: 'promise', content: '密码: abcd1234' } });
  assert.equal(f.service.snapshot().memories.length, 0);
  assert.doesNotMatch(fs.readFileSync(f.args.file, 'utf8'), /abcd1234/);
  const raw = 'Hello<cibyp-relationship>{"kind":"support"}</cibyp-relationship>';
  for (let i = 6; i < raw.length; i++) assert.equal(protocol.strip(raw.slice(0, i)), 'Hello');
  assert.equal(protocol.strip('Hello<canvas>scene</canvas>'), 'Hello<canvas>scene</canvas>');
  fs.writeFileSync(f.args.file, 'broken');
  const broken = new BabeRelationship(f.args);
  assert.equal(broken.snapshot().ok, false);
  assert.equal(fs.readFileSync(f.args.file, 'utf8'), 'broken');
});
