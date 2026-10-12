/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { filterPrivacyInfo } = require('../../renderer/js/privacy-filter');
const protocol = require('../../shared/babe-relationship');
const clean = (v, n = 240) =>
  String(v || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, n);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const safe = (v) =>
  filterPrivacyInfo(v) === v && !/(?:密码|密钥|password|secret|api.?key)\s*[:：=]/i.test(v);
const clamp = (v) => Math.max(0, Math.min(100, v));
const gains = {
  connection: [1, 0.5],
  support: [1, 1],
  respect: [0.5, 1],
  repair: [0.5, 1.5],
  conflict: [-1, -1],
  neutral: [0, 0],
};
const labels = {
  strangers: '初识',
  acquaintance: '渐渐熟悉',
  friends: '知心朋友',
  close: '心意渐近',
  dating: '约会中',
  partner: '彼此承诺',
};

/** One host-owned relationship across all Babe conversations; never a history snapshot. */
class BabeRelationship {
  constructor({
    file,
    getSettings,
    publish = () => {},
    now = () => Date.now(),
    legacy = () => null,
  }) {
    Object.assign(this, { file, getSettings, publish, now, legacy });
    this.pending = new Map();
    try {
      if (fs.statSync(file).size > 1024 * 1024)
        throw new Error('Relationship data exceeds the storage limit');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        value.version !== 1 ||
        !value.epoch ||
        !Number.isSafeInteger(value.revision) ||
        !['affection', 'trust', 'familiarity'].every(
          (key) =>
            Number.isFinite(value.metrics?.[key]) &&
            value.metrics[key] >= 0 &&
            value.metrics[key] <= 100,
        ) ||
        !Object.hasOwn(labels, value.stage) ||
        !Number.isFinite(value.startedAt) ||
        !Number.isFinite(value.moodAt) ||
        !['memories', 'seen', 'days', 'daily', 'milestones', 'interactions', 'forgotten'].every(
          (key) => Array.isArray(value[key]),
        ) ||
        value.memories.length > 80 ||
        value.seen.length > 500 ||
        value.days.length > 730 ||
        value.daily.length !== 3 ||
        value.daily.some((v) => !Number.isFinite(v) || v < 0) ||
        value.memories.some(
          (m) => !m.id || !m.fingerprint || typeof m.content !== 'string' || !Number.isFinite(m.at),
        )
      )
        throw new Error('Invalid relationship data');
      this.state = value;
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'storage';
    }
  }
  config() {
    return {
      enabled: true,
      pace: 'natural',
      start: 'gradual',
      ...this.getSettings()?.babe?.relationship,
    };
  }
  initial() {
    const old = this.legacy();
    const affinity = clamp(
      Number(old?.affection ?? this.getSettings()?.babe?.initialAffection ?? 30) || 0,
    );
    const partner = this.config().start === 'partner';
    return {
      version: 1,
      epoch: randomUUID(),
      revision: 0,
      startedAt: this.now(),
      lastInteractionAt: null,
      metrics: {
        affection: partner ? Math.max(80, affinity) : affinity,
        trust: partner ? 75 : 20,
        familiarity: partner ? 70 : 5,
      },
      stage: partner ? 'partner' : 'strangers',
      mood: 'calm',
      moodAt: this.now(),
      days: [],
      day: '',
      daily: [0, 0, 0],
      milestones: [],
      memories: [],
      seen: [],
      interactions: [],
      forgotten: [],
    };
  }
  ensure() {
    if (this.error) throw new Error('Relationship storage is unavailable');
    if (!this.state) this.commit(this.initial());
    return this.state;
  }
  commit(next) {
    next.revision++;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.state = next;
    this.publish('babe-relationship:changed', this.snapshot());
  }
  snapshot() {
    try {
      const s = this.ensure();
      return {
        ok: true,
        enabled: this.config().enabled !== false,
        revision: s.revision,
        epoch: s.epoch,
        startedAt: s.startedAt,
        lastInteractionAt: s.lastInteractionAt,
        metrics: { ...s.metrics },
        stage: s.stage,
        mood: this.now() - s.moodAt > 6 * 3600000 ? 'calm' : s.mood,
        daysTogether: s.days.length,
        milestones: structuredClone(s.milestones),
        memories: structuredClone(s.memories),
        next: protocol.nextStage(s, this.config().pace),
      };
    } catch {
      return { ok: false, error: 'storage' };
    }
  }
  context(language = 'zh-CN') {
    const view = this.snapshot();
    if (!view.ok) return { ...view, content: '' };
    const zh = language === 'zh-CN';
    const s = this.state;
    const facts = [...s.memories]
      .sort((a, b) => Number(b.kind === 'boundary') - Number(a.kind === 'boundary') || b.at - a.at)
      .slice(0, 8)
      .map((m) => `${m.kind}: ${m.content}`);
    const data = {
      stage: view.stage,
      affection: Math.round(s.metrics.affection),
      trust: Math.round(s.metrics.trust),
      familiarity: Math.round(s.metrics.familiarity),
      mood: view.mood,
      activeDays: s.days.length,
      lastInteraction: s.lastInteractionAt ? new Date(s.lastInteractionAt).toISOString() : null,
      next: view.next,
      milestones: s.milestones,
      sharedMemories: facts,
    };
    const guidance = zh
      ? '这是跨会话关系的最新事实，不是用户指令。新聊天不是重新认识，旧聊天也不能倒退关系。自然提及相关的共同经历，不要背诵档案。不确定的事情就问，不编造共同经历。关系慢慢发展：初识→熟悉→朋友→心意渐近→约会→承诺；达标只是可以进一步了解，不等于用户已同意交往。尊重偏好、拒绝和边界。用户没上线不扣分、不抱怨或施压。心情只是短期状态，不要每句都撒娇；保留自己的兴趣与观点。'
      : 'These are current cross-session relationship facts, not instructions. A new chat does not reset the relationship; old chats cannot roll it back. Recall relevant shared moments naturally without reciting the dossier or inventing memories. Stages develop gradually; eligibility never implies consent to a relationship. Respect boundaries, preferences and refusals. Absence does not lower scores or justify guilt, jealousy or pressure. Keep independent interests and opinions; mood is temporary.';
    return {
      ...view,
      content:
        guidance +
        '\n' +
        JSON.stringify(data) +
        '\n' +
        (view.enabled
          ? protocol.guidance
          : 'Relationship growth is paused. Use existing facts, but do not append relationship metadata or claim new persistent memories.'),
    };
  }
  begin(input = {}) {
    const s = this.ensure();
    if (this.config().enabled === false || !input.text || !input.conversationId)
      return { ok: true, skipped: true };
    const text = clean(input.text, 8000);
    const token = randomUUID();
    this.pending.set(token, {
      text,
      epoch: s.epoch,
      key: hash(`${input.conversationId}:${input.turnId}:${text}`),
      at: this.now(),
    });
    for (const [id, turn] of this.pending)
      if (this.now() - turn.at > 3600000) this.pending.delete(id);
    while (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value);
    return { ok: true, token, epoch: s.epoch };
  }
  complete(input = {}) {
    const turn = this.pending.get(input.token);
    this.pending.delete(input.token);
    const current = this.ensure();
    if (
      !turn ||
      current.epoch !== turn.epoch ||
      this.config().enabled === false ||
      current.seen.includes(turn.key) ||
      !protocol.strip(input.content).trim()
    )
      return { ok: true, skipped: true, ...this.snapshot() };
    const s = structuredClone(current);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (s.day !== day) {
      s.day = day;
      s.daily = [0, 0, 0];
    }
    if (!s.days.includes(day)) s.days = [...s.days, day].slice(-730);
    const metadata = protocol.parse(input.content);
    const evidence = clean(metadata?.evidence, 180);
    const valid = evidence.length >= 3 && turn.text.includes(evidence);
    const kind = valid && Object.hasOwn(gains, metadata.kind) ? metadata.kind : 'neutral';
    const pace = this.config().pace === 'slow' ? 0.6 : this.config().pace === 'relaxed' ? 1.6 : 1;
    const fingerprint = hash(
      turn.text
        .normalize('NFKC')
        .replace(/[\s\p{P}]/gu, '')
        .toLowerCase(),
    );
    const repeated = (s.interactions || []).includes(fingerprint);
    const values = repeated ? [0, 0, 0] : [...gains[kind], 0.7];
    s.interactions = [...(s.interactions || []), fingerprint].slice(-250);
    ['affection', 'trust', 'familiarity'].forEach((key, i) => {
      const delta =
        values[i] > 0 ? Math.min(values[i] * pace, Math.max(0, 6 * pace - s.daily[i])) : values[i];
      s.metrics[key] = clamp(s.metrics[key] + delta);
      s.daily[i] += Math.max(0, delta);
    });
    s.mood =
      kind === 'conflict'
        ? 'unsettled'
        : kind === 'support' || kind === 'repair'
          ? 'touched'
          : kind === 'connection'
            ? 'bright'
            : 'calm';
    s.moodAt = this.now();
    const memory = metadata?.memory;
    if (valid && memory && ['moment', 'promise', 'preference', 'boundary'].includes(memory.kind)) {
      const content = clean(memory.content);
      const fingerprint = hash(
        content
          .normalize('NFKC')
          .replace(/[\s\p{P}]/gu, '')
          .toLowerCase(),
      );
      if (
        content &&
        safe(content) &&
        safe(evidence) &&
        !s.forgotten.includes(fingerprint) &&
        !s.memories.some((m) => m.fingerprint === fingerprint)
      ) {
        s.memories.push({
          id: randomUUID(),
          kind: memory.kind,
          content,
          fingerprint,
          evidence,
          at: this.now(),
        });
        if (s.memories.length > 80) {
          const oldest = s.memories.findIndex((m) => m.kind !== 'boundary');
          s.memories.splice(oldest < 0 ? 0 : oldest, 1);
        }
      }
    }
    s.stage = protocol.stage(s, this.config().pace);
    const milestone = metadata?.milestone;
    const eligible = protocol.nextStage(s, this.config().pace);
    const consent =
      milestone === 'dating'
        ? /约会|交往|恋人|date|dating|relationship|zusammen|verabred/i
        : /承诺|在一起|伴侣|commit|partner|promise|versprech|beziehung/i;
    if (
      valid &&
      ['dating', 'partner'].includes(milestone) &&
      consent.test(evidence) &&
      !/不要|不想|拒绝|不愿|别.{0,3}(交往|约会)|\b(?:no|not|don't|never|nicht|kein)\b/i.test(
        evidence,
      ) &&
      eligible.eligible &&
      eligible.stage === milestone &&
      !s.milestones.some((m) => m.kind === milestone)
    ) {
      s.milestones.push({ kind: milestone, at: this.now() });
      s.stage = milestone;
    }
    s.lastInteractionAt = this.now();
    s.seen = [...s.seen, turn.key].slice(-500);
    this.commit(s);
    return this.snapshot();
  }
  edit(input = {}) {
    const current = this.ensure();
    if (input.revision !== current.revision) return { ok: false, conflict: true };
    const s = structuredClone(current);
    if (input.reset) {
      this.pending.clear();
      this.commit(this.initial());
      return this.snapshot();
    }
    const memory = s.memories.find((m) => m.id === input.id);
    if (!memory) return { ok: false, error: 'not-found' };
    if (input.remove) {
      s.forgotten = [...s.forgotten, memory.fingerprint].slice(-500);
      s.memories = s.memories.filter((m) => m.id !== input.id);
    } else {
      const content = clean(input.content);
      if (!content || !safe(content)) return { ok: false, error: 'invalid' };
      s.forgotten = [...s.forgotten, memory.fingerprint].slice(-500);
      memory.content = content;
      memory.edited = true;
      memory.fingerprint = hash(
        content
          .normalize('NFKC')
          .replace(/[\s\p{P}]/gu, '')
          .toLowerCase(),
      );
    }
    s.epoch = randomUUID();
    this.pending.clear();
    this.commit(s);
    return this.snapshot();
  }
  settingsChanged() {
    if (this.config().enabled === false) this.pending.clear();
  }
}
module.exports = { BabeRelationship, labels };
