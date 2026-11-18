/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const privacy = require('../../../renderer/js/privacy-filter');

const TOOL = 'quant_ask_user';
const SCOPE = 'quant-questionnaire';
const questionId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const validCallId = (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
const fail = (code) => {
  throw Error(code);
};
const text = (value, max) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
    fail('QUANT_QUESTIONNAIRE_INVALID');
  return value.trim();
};

function normalizeQuestions(input) {
  if (!Array.isArray(input) || !input.length || input.length > 4)
    fail('QUANT_QUESTIONNAIRE_INVALID');
  return input.map((item) => {
    const question = privacy.filterPrivacyInfo(text(item?.question, 360));
    const raw = item?.options ?? [];
    if (
      !Array.isArray(raw) ||
      raw.length > 6 ||
      (item.multiSelect === true && !raw.length) ||
      (item.custom === false && !raw.length)
    )
      fail('QUANT_QUESTIONNAIRE_INVALID');
    const options = raw.map((label) => privacy.filterPrivacyInfo(text(label, 100)));
    if (new Set(options).size !== options.length) fail('QUANT_QUESTIONNAIRE_INVALID');
    return {
      question,
      options,
      multiSelect: item.multiSelect === true,
      custom: item.custom !== false,
    };
  });
}

function normalizeAnswers(questions, answers) {
  if (!Array.isArray(answers) || (answers.length && answers.length !== questions.length))
    fail('QUANT_QUESTIONNAIRE_ANSWER');
  return answers.map((answer, index) => {
    const row = questions[index];
    if (row.multiSelect !== Array.isArray(answer)) fail('QUANT_QUESTIONNAIRE_ANSWER');
    const values = row.multiSelect ? answer : [answer];
    if (!values.length || values.length > row.options.length + 1)
      fail('QUANT_QUESTIONNAIRE_ANSWER');
    let normalized;
    try {
      normalized = values.map((value) => text(value, 600));
    } catch {
      fail('QUANT_QUESTIONNAIRE_ANSWER');
    }
    if (
      new Set(normalized).size !== normalized.length ||
      normalized.filter((value) => !row.options.includes(value)).length > Number(row.custom)
    )
      fail('QUANT_QUESTIONNAIRE_ANSWER');
    const protectedAnswers = normalized.map((value) => privacy.filterPrivacyInfo(value));
    return row.multiSelect ? protectedAnswers : protectedAnswers[0];
  });
}

function checkpoint(messages, callId) {
  const isCall = (message) =>
    message?.role === 'assistant' &&
    message.tool_calls?.length === 1 &&
    message.tool_calls[0]?.id === callId &&
    message.tool_calls[0]?.function?.name === TOOL;
  if (isCall(messages.at(-1))) return 'call';
  const tail = messages.at(-1);
  if (
    tail?.role === 'tool' &&
    tail.tool_call_id === callId &&
    tail.name === TOOL &&
    isCall(messages.at(-2))
  )
    return 'result';
  return null;
}

function answerResult(record) {
  return record.answers.length
    ? { ok: true, answers: record.answers, authority: 'none' }
    : { ok: false, cancelled: true, answers: [], authority: 'none' };
}

class QuantQuestions {
  constructor(service, write) {
    this.service = service;
    this.write = write;
    this.records = new Map();
    this.waiters = new Map();
  }
  file(id) {
    return path.join(this.service.directory, 'questionnaires', id + '.json');
  }
  record(id) {
    this.service.workspace(id);
    if (this.records.has(id)) return this.records.get(id);
    let record = null;
    try {
      const file = this.file(id);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
        fail('QUANT_QUESTIONNAIRE_STORAGE');
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        record.version !== 1 ||
        record.revision !== 1 ||
        !questionId.test(record.id) ||
        !validCallId(record.callId) ||
        record.conversationId !== this.service.workspace(id).conversationId ||
        !['pending', 'settled', 'stopped'].includes(record.state) ||
        (record.state === 'settled' && !Array.isArray(record.answers))
      )
        fail('QUANT_QUESTIONNAIRE_STORAGE');
      record.questions = normalizeQuestions(record.questions);
    } catch (error) {
      if (error.code !== 'ENOENT') fail('QUANT_QUESTIONNAIRE_STORAGE');
    }
    this.records.set(id, record);
    return record;
  }
  save(id, record) {
    this.write(this.file(id), record);
    this.records.set(id, record);
  }
  view(id, messages, busy) {
    const record = this.record(id);
    if (!record || record.state === 'stopped') return null;
    const stage = checkpoint(messages, record.callId);
    if (!stage || (record.state === 'pending' && stage !== 'call')) return null;
    if (record.state === 'settled' && busy) return null;
    return {
      kind: 'questions',
      scope: SCOPE,
      id: record.id,
      revision: record.revision,
      payload: {
        questions: structuredClone(record.questions),
        phase: record.state === 'pending' ? 'pending' : 'resume',
        recovered: !this.waiters.has(id),
      },
    };
  }
  publish(id, type, view) {
    try {
      this.service.publish({ type, key: 'quant:' + id, kind: 'questions', scope: SCOPE, ...view });
    } catch {
      // The persisted record remains available to attached frontends.
    }
  }
  async ask(id, input, callId, agent, signal) {
    const questions = normalizeQuestions(input.questions);
    const history = () => agent.contextManager?.getHistoryMessages() || [];
    if (!validCallId(callId) || checkpoint(history(), callId) !== 'call')
      fail('QUANT_QUESTIONNAIRE_CALL_ALONE');
    const old = this.record(id);
    if (this.waiters.has(id) || (old?.state === 'pending' && old.callId === callId))
      fail('QUANT_QUESTIONNAIRE_PENDING');
    await agent.saveToHistory({ strict: true });
    signal.throwIfAborted();
    if (checkpoint(history(), callId) !== 'call' || this.waiters.has(id))
      fail('QUANT_QUESTIONNAIRE_STALE');
    const record = {
      version: 1,
      state: 'pending',
      id: randomUUID(),
      revision: 1,
      callId,
      questions,
      conversationId: this.service.workspace(id).conversationId,
    };
    this.save(id, record);
    const pending = new Promise((resolve) => this.waiters.set(id, resolve));
    const cancel = () => {
      try {
        this.interrupt(id);
      } catch {
        /* Cancellation still releases the waiting loop. */
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      this.publish(id, 'interaction', this.view(id, history(), true));
      return await pending;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  respond(id, response, messages, busy) {
    const record = this.record(id);
    if (
      !record ||
      response.questionnaireId !== record.id ||
      response.revision !== record.revision ||
      record.state === 'stopped'
    )
      fail('QUANT_QUESTIONNAIRE_STALE');
    const stage = checkpoint(messages, record.callId);
    if (response.action === 'resume') {
      if (busy || record.state !== 'settled' || !stage) fail('QUANT_QUESTIONNAIRE_STALE');
      const result = answerResult(record);
      if (stage === 'result' && messages.at(-1).content !== JSON.stringify(result))
        fail('QUANT_QUESTIONNAIRE_STALE');
      return { resume: { callId: record.callId, result, recorded: stage === 'result' } };
    }
    if (response.action === 'dismiss') {
      if (busy || record.state !== 'settled' || !stage) fail('QUANT_QUESTIONNAIRE_STALE');
      this.save(id, { ...record, state: 'stopped' });
      this.publish(id, 'interaction-resolved', { id: record.id, revision: record.revision });
      return { ok: true };
    }
    if (response.action !== undefined && response.action !== 'answer')
      fail('QUANT_QUESTIONNAIRE_INVALID');
    const answers = normalizeAnswers(record.questions, response.answers);
    if (record.state === 'settled') {
      if (JSON.stringify(record.answers) === JSON.stringify(answers))
        return { ok: true, duplicate: true };
      fail('QUANT_QUESTIONNAIRE_STALE');
    }
    if (stage !== 'call' || (busy && !this.waiters.has(id))) fail('QUANT_QUESTIONNAIRE_STALE');
    const settled = { ...record, state: 'settled', answers };
    this.save(id, settled);
    const waiting = this.waiters.get(id);
    this.waiters.delete(id);
    waiting?.(answerResult(settled));
    this.publish(id, 'interaction-resolved', { id: record.id, revision: record.revision });
    if (!waiting) this.publish(id, 'interaction', this.view(id, messages, false));
    return { ok: true, resumeRequired: !waiting };
  }
  interrupt(id) {
    const waiting = this.waiters.get(id);
    try {
      if (!this.service.disposed) {
        const record = this.record(id);
        if (record?.state === 'pending') {
          this.save(id, { ...record, state: 'stopped' });
          this.publish(id, 'interaction-resolved', { id: record.id, revision: record.revision });
        }
      }
    } finally {
      this.waiters.delete(id);
      waiting?.({ ok: false, cancelled: true, answers: [], authority: 'none' });
    }
  }
}

module.exports = { QuantQuestions, TOOL, SCOPE, checkpoint };
