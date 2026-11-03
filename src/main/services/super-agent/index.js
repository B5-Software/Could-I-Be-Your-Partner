/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { SuperStore, digest } = require('./store');
const { RuntimeAdapter } = require('./runtime');
const copy = (v) => structuredClone(v);
const text = (v, max = 16000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0'))
    throw Error('SUPER_INVALID_INPUT');
  return v.trim();
};
const identity = (v) =>
  /^[\w:-]{1,128}$/.test(text(v, 128))
    ? v
    : (() => {
        throw Error('SUPER_INVALID_INPUT');
      })();
class SuperAgentService {
  constructor({
    directory,
    runtime,
    publish = () => {},
    adapter,
    now = Date.now,
    autoStart = true,
  }) {
    Object.assign(this, { runtime, publish, now });
    this.store = new SuperStore(directory);
    this.adapter = adapter || new RuntimeAdapter(runtime, this);
    this.active = new Map();
    this.routerEvents = new Set();
    this.turns = new Map();
    this.config = {};
    try {
      this.store.change((s) => {
        for (const e of s.events) if (e.status === 'routing') e.status = 'pending';
        for (const task of s.tasks)
          if (task.status === 'running') {
            task.status = 'needs_attention';
            task.reason = 'SUPER_INTERRUPTED';
            task.generation++;
            this.deliver(s, task, 'SUPER_INTERRUPTED');
          }
      });
    } catch (error) {
      this.store.close();
      throw error;
    }
    if (autoStart) {
      this.timer = setInterval(() => void this.tick().catch((e) => this.fail(e)), 1000);
      this.timer.unref();
      void this.tick().catch((e) => this.fail(e));
    }
  }
  fail(error) {
    this.error = String(error.message || error).slice(0, 400);
    if (this.store.error) {
      this.adapter.stop(this.routerKey);
      this.adapter.stop(this.watchKey);
      for (const t of this.store.state.tasks.filter((t) => t.status === 'running'))
        this.adapter.stop(t.workerKey);
    }
    this.changed();
  }
  changed() {
    this.publish({
      type: 'superagent',
      revision: this.store.state.revision,
      error: this.error || null,
    });
  }
  async settings() {
    const value = (await this.runtime.getSettings())?.superAgent || {};
    this.config = {
      enabled: value.enabled !== false,
      maxWorkers: Math.max(1, Math.min(8, Number(value.maxWorkers) || 2)),
      maxAttempts: Math.max(1, Math.min(100, Number(value.maxAttempts) || 12)),
      maxTokens: Math.max(1000, Math.min(10000000, Number(value.maxTokens) || 100000)),
      routerModel: value.routerModel || '',
      workerModel: value.workerModel || '',
      watchdog: value.watchdog !== false,
      proactive: value.proactive === true,
      rules: String(value.rules || '').slice(0, 4000),
      sources: Array.isArray(value.sources)
        ? value.sources.filter((s) => ['github', 'automation', 'notification'].includes(s))
        : [],
    };
    return this.config;
  }
  find(s, id) {
    return (
      s.tasks.find((t) => t.id === id) ||
      (() => {
        throw Error('SUPER_TASK_NOT_FOUND');
      })()
    );
  }
  deliver(s, task, summary) {
    s.deliveries.push({
      id: randomUUID(),
      taskId: task.id,
      generation: task.generation,
      summary,
      status: task.status,
      at: this.now(),
      read: false,
    });
  }
  publicTask(task) {
    const { inputIds, pendingReport, ...rest } = task;
    return { ...copy(rest), inputs: inputIds.length };
  }
  async request(action, input = {}) {
    try {
      return await this.perform(action, input);
    } catch (error) {
      if (this.store.error) {
        this.fail(Error('SUPER_STORAGE_UNAVAILABLE'));
        throw Error('SUPER_STORAGE_UNAVAILABLE', { cause: error });
      }
      throw error;
    }
  }
  async perform(action, input = {}) {
    if (this.closed) throw Error('SUPER_STOPPED');
    await this.settings();
    if (action === 'status')
      return {
        config: this.config,
        paused: this.store.state.paused,
        revision: this.store.state.revision,
        error: this.error || null,
        counts: Object.fromEntries(
          ['queued', 'running', 'waiting', 'needs_attention', 'completed', 'stopped'].map((v) => [
            v,
            this.store.state.tasks.filter((t) => t.status === v).length,
          ]),
        ),
        pending: this.store.state.events.filter((e) =>
          ['pending', 'routing', 'needs_attention'].includes(e.status),
        ).length,
      };
    if (action === 'list' || action === 'deliveries' || action === 'events') {
      const offset = input.offset ?? 0,
        limit = input.limit ?? 30;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw Error('SUPER_INVALID_INPUT');
      const rows = (
        action === 'list'
          ? this.store.state.tasks
          : action === 'events'
            ? this.store.state.events
            : this.store.state.deliveries
      )
        .filter((r) => !input.taskId || r.taskId === input.taskId)
        .slice()
        .reverse();
      return {
        items: rows
          .slice(offset, offset + limit)
          .map((v) => (action === 'list' ? this.publicTask(v) : copy(v))),
        total: rows.length,
        next: offset + limit < rows.length ? offset + limit : null,
      };
    }
    if (action === 'get') {
      const t = this.find(this.store.state, input.id);
      return {
        task: this.publicTask(t),
        events: t.inputIds.map((id) => copy(this.store.state.events.find((e) => e.id === id))),
        view: t.workerKey ? this.runtime.getView?.(t.workerKey) || null : null,
      };
    }
    if (action === 'recall') return this.recall(input);
    if (action === 'configure') {
      const allowed = [
        'enabled',
        'maxWorkers',
        'maxAttempts',
        'maxTokens',
        'routerModel',
        'workerModel',
        'watchdog',
        'proactive',
        'rules',
        'sources',
      ];
      if (Object.keys(input).some((k) => !allowed.includes(k))) throw Error('SUPER_INVALID_INPUT');
      for (const key of ['enabled', 'watchdog', 'proactive'])
        if (input[key] !== undefined && typeof input[key] !== 'boolean')
          throw Error('SUPER_INVALID_INPUT');
      for (const [key, min, max] of [
        ['maxWorkers', 1, 8],
        ['maxAttempts', 1, 100],
        ['maxTokens', 1000, 10000000],
      ])
        if (
          input[key] !== undefined &&
          (!Number.isInteger(input[key]) || input[key] < min || input[key] > max)
        )
          throw Error('SUPER_INVALID_INPUT');
      const settings = await this.runtime.getSettings();
      for (const key of ['routerModel', 'workerModel'])
        if (
          input[key] !== undefined &&
          (typeof input[key] !== 'string' ||
            (input[key] &&
              !settings.llm?.pool?.some((r) => r.id === input[key] && r.enabled !== false)))
        )
          throw Error('SUPER_MODEL_UNAVAILABLE');
      if (
        input.rules !== undefined &&
        (typeof input.rules !== 'string' || input.rules.length > 4000)
      )
        throw Error('SUPER_INVALID_INPUT');
      if (
        input.sources !== undefined &&
        (!Array.isArray(input.sources) ||
          input.sources.some((s) => !['github', 'automation', 'notification'].includes(s)))
      )
        throw Error('SUPER_INVALID_INPUT');
      await this.runtime.saveSettings({ superAgent: { ...settings.superAgent, ...input } });
      await this.settings();
      if (!this.config.enabled) await this.pauseAll();
      this.changed();
      return this.request('status');
    }
    if (action === 'pause') {
      await this.pauseAll();
      return { ok: true };
    }
    if (action === 'resume') {
      this.store.change((s) => {
        s.paused = false;
      });
      this.changed();
      this.kick();
      return { ok: true };
    }
    if (action === 'ack') {
      this.store.change((s) => {
        const d = s.deliveries.find((r) => r.id === input.id);
        if (d) d.read = true;
      });
      return { ok: true };
    }
    if (!this.config.enabled) throw Error('SUPER_DISABLED');
    if (action === 'submit' || action === 'observe') {
      const observation = action === 'observe';
      if (
        observation &&
        (!this.config.proactive ||
          !this.config.rules ||
          !this.config.sources.includes(input.source))
      )
        return { ignored: true };
      const operationId = identity(input.operationId),
        body = text(input.text),
        threadId = identity(input.threadId || 'thread-' + randomUUID());
      const mode = input.mode || 'chat';
      if (!['chat', 'code'].includes(mode)) throw Error('SUPER_INVALID_INPUT');
      const scope = observation ? 'observe:' + input.source : 'owner:' + mode;
      const old = this.store.state.events.find((e) => e.operationId === operationId);
      const fingerprint = digest({
        text: body,
        mode,
        taskId: input.taskId || '',
        source: observation ? input.source : 'local',
      });
      if (old) {
        if (old.fingerprint !== fingerprint) throw Error('SUPER_OPERATION_CONFLICT');
        return copy(old);
      }
      const event = this.store.change((s) => {
        if (s.events.length >= 10000) throw Error('SUPER_STORAGE_LIMIT');
        const e = {
          id: randomUUID(),
          operationId,
          fingerprint,
          threadId,
          scope,
          mode,
          text: body,
          source: observation ? input.source : 'local',
          observation,
          at: this.now(),
          status: 'pending',
        };
        s.events.push(e);
        const bound = input.taskId
          ? this.find(s, input.taskId)
          : s.tasks.find(
              (t) => t.scope === scope && t.threadIds.includes(threadId) && t.status !== 'stopped',
            );
        if (bound) {
          if (bound.scope !== scope) throw Error('SUPER_SCOPE_FORBIDDEN');
          this.attach(s, bound, e);
        }
        return e;
      });
      this.changed();
      if (event.taskId && this.active.has(event.taskId)) {
        const task = this.find(this.store.state, event.taskId);
        if (task.status === 'running')
          void this.adapter.followup?.(copy(task), copy(event)).catch((e) => this.fail(e));
      }
      this.kick();
      return event;
    }
    if (action === 'stop' || action === 'retry') {
      const task = this.store.change((s) => {
        const t = this.find(s, input.id);
        if (input.generation !== undefined && input.generation !== t.generation)
          throw Error('SUPER_TASK_CHANGED');
        if (action === 'retry' && (this.active.has(t.id) || t.status === 'running'))
          throw Error('SUPER_TASK_BUSY');
        t.generation++;
        t.updatedAt = this.now();
        t.status = action === 'stop' ? 'stopped' : 'queued';
        t.reason = action === 'stop' ? 'SUPER_USER_STOPPED' : '';
        t.pendingReport = null;
        this.deliver(s, t, t.reason || 'SUPER_RESUMED');
        return t;
      });
      if (action === 'stop') this.adapter.stop(task.workerKey);
      this.changed();
      this.kick();
      return this.publicTask(task);
    }
    if (action === 'retry-event') {
      this.store.change((s) => {
        const e = s.events.find((v) => v.id === input.id);
        if (!e || e.status !== 'needs_attention') throw Error('SUPER_INVALID_INPUT');
        e.status = 'pending';
      });
      this.error = null;
      this.kick();
      return { ok: true };
    }
    if (action === 'respond') {
      const t = this.find(this.store.state, input.id),
        v = this.runtime.getView(t.workerKey);
      if (
        !v?.pendingInteraction ||
        v.pendingInteraction.id !== input.interactionId ||
        v.pendingInteraction.revision !== input.revision
      )
        throw Error('SUPER_INTERACTION_CHANGED');
      return this.runtime.respond(t.workerKey, input.response);
    }
    throw Error('SUPER_UNKNOWN_ACTION');
  }
  attach(s, t, e) {
    if (t.status === 'stopped') throw Error('SUPER_TASK_STOPPED');
    e.taskId = t.id;
    e.status = 'assigned';
    t.inputIds.push(e.id);
    if (!t.threadIds.includes(e.threadId)) t.threadIds.push(e.threadId);
    // An interrupted/blocked task requires an explicit human retry; a fresh event cannot erase its fence.
    if (['completed', 'waiting'].includes(t.status)) t.status = 'queued';
    t.updatedAt = this.now();
  }
  recall({ id, offset = 0, maxChars = 6000 }) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(maxChars) ||
      maxChars < 1 ||
      maxChars > 16000
    )
      throw Error('SUPER_INVALID_INPUT');
    const task = this.store.state.tasks.find((t) => t.id === id),
      event = this.store.state.events.find((e) => e.id === id);
    if (!task && !event) throw Error('SUPER_TASK_NOT_FOUND');
    const body = JSON.stringify(
      task ? { task: this.publicTask(task), events: task.inputIds } : event,
    );
    return {
      id,
      text: body.slice(offset, offset + maxChars),
      totalChars: body.length,
      next: offset + maxChars < body.length ? offset + maxChars : null,
    };
  }
  async tool(key, name, input) {
    if (this.store.error) throw Error('SUPER_STORAGE_UNAVAILABLE');
    if (this.closed || this.store.state.paused || !this.config.enabled) throw Error('SUPER_PAUSED');
    const binding = this.turns.get(key);
    if (!binding) throw Error('SUPER_TOOL_FORBIDDEN');
    if (name === 'super_recall') {
      if (binding.role === 'worker' || binding.role === 'watchdog') {
        const t = this.find(this.store.state, binding.id);
        if (input.id !== t.id && !t.inputIds.includes(input.id))
          throw Error('SUPER_SCOPE_FORBIDDEN');
      }
      return this.recall(input);
    }
    if (name === 'super_route' && binding.role === 'router') {
      if (
        !this.routerEvents.has(input.eventId) ||
        !['create', 'attach', 'ignore'].includes(input.action)
      )
        throw Error('SUPER_TOOL_FORBIDDEN');
      const result = this.store.change((s) => {
        const e = s.events.find((v) => v.id === input.eventId);
        if (e.status !== 'routing') return { taskId: e.taskId || null, status: e.status };
        if (input.action === 'ignore') {
          e.status = 'ignored';
          e.reason = text(input.reason || 'No actionable request', 1000);
          return { status: e.status };
        }
        let t;
        if (input.action === 'attach') {
          t = this.find(s, input.taskId);
          if (t.scope !== e.scope || t.status === 'stopped') throw Error('SUPER_SCOPE_FORBIDDEN');
        } else {
          if (s.tasks.length >= 1000) throw Error('SUPER_STORAGE_LIMIT');
          t = {
            id: randomUUID(),
            title: text(input.title, 160),
            scope: e.scope,
            mode: e.mode,
            observation: e.observation,
            status: 'queued',
            inputIds: [],
            threadIds: [],
            generation: 1,
            attempts: 0,
            tokens: 0,
            consumed: 0,
            createdAt: this.now(),
            updatedAt: this.now(),
            lastProgress: this.now(),
            summary: '',
            evidence: [],
            workerKey: '',
            conversationId: '',
            workspacePath: '',
          };
          s.tasks.push(t);
        }
        this.attach(s, t, e);
        return { taskId: t.id, status: t.status };
      });
      this.changed();
      return result;
    }
    if (name === 'super_report' && binding.role === 'worker') {
      if (!['completed', 'waiting', 'blocked'].includes(input.status))
        throw Error('SUPER_INVALID_INPUT');
      const summary = text(input.summary, 8000),
        evidence = (input.evidence || []).map((v) => text(v, 1000));
      if (evidence.length > 8 || (input.status === 'completed' && !evidence.length))
        throw Error('SUPER_EVIDENCE_REQUIRED');
      if (
        input.wakeAt !== undefined &&
        (!Number.isSafeInteger(input.wakeAt) ||
          (input.wakeAt !== 0 &&
            (input.wakeAt < this.now() + 1000 || input.wakeAt > this.now() + 604800000)))
      )
        throw Error('SUPER_INVALID_INPUT');
      this.store.change((s) => {
        const t = this.find(s, binding.id);
        if (t.generation !== binding.generation || t.status !== 'running')
          throw Error('SUPER_TASK_CHANGED');
        t.pendingReport = { status: input.status, summary, evidence, wakeAt: input.wakeAt || 0 };
      });
      return { ok: true, instruction: 'Report saved. End this turn now.' };
    }
    if (
      name === 'super_watch' &&
      binding.role === 'watchdog' &&
      input.taskId === binding.id &&
      ['observe', 'pause'].includes(input.action)
    ) {
      const reason = text(input.reason, 2000);
      const current = this.find(this.store.state, binding.id);
      if (current.generation !== binding.generation || current.status !== 'running')
        throw Error('SUPER_TASK_CHANGED');
      if (input.action === 'pause') this.fence(binding.id, 'SUPER_WATCHDOG_PAUSED', reason);
      else
        this.store.change((s) => {
          const t = this.find(s, binding.id);
          t.watchdogNote = reason;
          t.reviewedAt = this.now();
        });
      this.changed();
      return { ok: true };
    }
    throw Error('SUPER_TOOL_FORBIDDEN');
  }
  authorize(key) {
    if (this.store.error) throw Error('SUPER_STORAGE_UNAVAILABLE');
    const binding = this.turns.get(key);
    if (
      this.closed ||
      !this.config.enabled ||
      this.store.state.paused ||
      binding?.role !== 'worker'
    )
      throw Error('SUPER_TOOL_FORBIDDEN');
    const task = this.find(this.store.state, binding.id);
    if (task.generation !== binding.generation || task.status !== 'running')
      throw Error('SUPER_TASK_CHANGED');
    return task;
  }
  fence(id, reason, summary = '') {
    const t = this.store.change((s) => {
      const t = this.find(s, id);
      t.generation++;
      t.status = 'needs_attention';
      t.reason = reason;
      t.summary = summary || t.summary;
      t.updatedAt = this.now();
      this.deliver(s, t, summary || reason);
      return t;
    });
    this.adapter.stop(t.workerKey);
    this.changed();
  }
  async pauseAll() {
    this.store.change((s) => {
      s.paused = true;
      for (const e of s.events) if (e.status === 'routing') e.status = 'pending';
    });
    for (const t of this.store.state.tasks.filter((v) => v.status === 'running'))
      this.fence(t.id, 'SUPER_PAUSED');
    this.adapter.stop(this.routerKey);
    this.adapter.stop(this.watchKey);
    this.changed();
  }
  kick() {
    queueMicrotask(() => void this.tick().catch((e) => this.fail(e)));
  }
  async tick() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      await this.settings();
      if (!this.config.enabled && !this.store.state.paused && this.active.size)
        await this.pauseAll();
      if (!this.config.enabled || this.store.state.paused || this.store.error) return;
      const due = this.store.state.tasks.filter(
        (t) => t.status === 'waiting' && t.wakeAt && t.wakeAt <= this.now(),
      );
      if (due.length)
        this.store.change((s) => {
          for (const t of s.tasks)
            if (due.some((d) => d.id === t.id)) {
              t.status = 'queued';
              t.wakeAt = 0;
            }
        });
      if (!this.routing) {
        const events = this.store.state.events.filter((e) => e.status === 'pending').slice(0, 8);
        if (events.length) {
          this.routing = true;
          void this.route(events)
            .catch((e) => this.fail(e))
            .finally(() => {
              this.routing = false;
              this.kick();
            });
        }
      }
      for (const t of this.store.state.tasks.filter((t) => t.status === 'queued')) {
        if (this.active.size >= this.config.maxWorkers) break;
        if (this.active.has(t.id)) continue;
        if (t.attempts >= this.config.maxAttempts || t.tokens >= this.config.maxTokens) {
          this.fence(t.id, 'SUPER_BUDGET_REACHED');
          continue;
        }
        const promise = this.work(t.id)
          .catch((e) => this.fail(e))
          .finally(() => {
            this.active.delete(t.id);
            this.kick();
          });
        this.active.set(t.id, promise);
      }
      if (this.config.watchdog && !this.reviewing) {
        const t = this.store.state.tasks.find(
          (t) =>
            t.status === 'running' &&
            !this.runtime.getView?.(t.workerKey)?.pendingInteraction &&
            this.now() - (t.reviewedAt || t.updatedAt) > 300000,
        );
        if (t) {
          this.reviewing = true;
          void this.review(t)
            .catch((e) => this.fail(e))
            .finally(() => {
              this.reviewing = false;
            });
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  async route(events) {
    this.routerKey = 'super-router-' + randomUUID();
    const key = this.routerKey;
    this.routerEvents = new Set(events.map((e) => e.id));
    this.store.change((s) => {
      for (const e of s.events) if (this.routerEvents.has(e.id)) e.status = 'routing';
    });
    this.turns.set(key, { role: 'router' });
    try {
      await this.adapter.route(
        key,
        copy(events),
        this.store.state.tasks.slice(-60).map((t) => this.publicTask(t)),
        this.config,
      );
    } finally {
      this.turns.delete(key);
      if (!this.closed)
        this.store.change((s) => {
          for (const e of s.events)
            if (this.routerEvents.has(e.id) && e.status === 'routing') {
              e.status = 'needs_attention';
              e.reason = 'SUPER_ROUTING_FAILED';
            }
        });
      this.routerEvents.clear();
      this.changed();
    }
  }
  async work(id) {
    const task = this.store.change((s) => {
      const t = this.find(s, id);
      t.generation++;
      t.status = 'running';
      t.attempts++;
      t.updatedAt = this.now();
      t.lastProgress = this.now();
      t.pendingReport = null;
      t.workerKey ||= 'super-worker-' + t.id;
      return t;
    });
    const key = task.workerKey,
      generation = task.generation,
      events = task.inputIds
        .slice(task.consumed, task.consumed + 4)
        .map((id) => this.store.state.events.find((e) => e.id === id));
    this.turns.set(key, { role: 'worker', id, generation });
    this.changed();
    try {
      await this.adapter.run(copy(task), copy(events), this.config, (metadata) => {
        this.store.change((s) => {
          const t = this.find(s, id);
          if (t.generation === generation) Object.assign(t, metadata);
        });
      });
      if (this.closed) return;
      this.store.change((s) => {
        const t = this.find(s, id);
        if (t.generation !== generation || t.status !== 'running') return;
        const report = t.pendingReport;
        t.consumed = Math.max(t.consumed, task.consumed + events.length);
        t.updatedAt = this.now();
        if (report) {
          t.status = report.status === 'blocked' ? 'needs_attention' : report.status;
          t.reason = report.status === 'blocked' ? 'SUPER_BLOCKED' : '';
          Object.assign(t, {
            summary: report.summary,
            evidence: report.evidence,
            wakeAt: report.wakeAt,
          });
        } else {
          t.status = 'needs_attention';
          t.reason = 'SUPER_REPORT_REQUIRED';
        }
        if (t.inputIds.length > t.consumed && report && report.status !== 'blocked')
          t.status = 'queued';
        t.pendingReport = null;
        this.deliver(s, t, t.summary || t.reason);
      });
    } catch (error) {
      if (!this.closed) {
        const current = this.find(this.store.state, id);
        if (current.generation === generation && current.status === 'running')
          this.fence(id, 'SUPER_EXECUTION_FAILED', String(error.message || error).slice(0, 1000));
      }
    } finally {
      this.turns.delete(key);
      this.changed();
    }
  }
  event(event) {
    const rootKey = this.runtime.sessions?.get(event.key)?.superAgentRootKey;
    const binding = this.turns.get(event.key) || this.turns.get(rootKey);
    if (!binding || binding.role !== 'worker' || this.closed) return;
    const t = this.find(this.store.state, binding.id);
    if (t.status !== 'running' || t.generation !== binding.generation) return;
    if (event.type === 'model-response' || event.type === 'tool-call') {
      this.store.change((s) => {
        const t = this.find(s, binding.id);
        t.lastProgress = this.now();
        if (event.type === 'model-response')
          t.tokens += Math.max(0, Number(event.usage?.total_tokens) || 0);
        if (event.type === 'tool-call' && event.status === 'done') {
          const signature = digest({ name: event.name, args: event.args });
          t.repeated = t.lastTool === signature ? (t.repeated || 0) + 1 : 1;
          t.lastTool = signature;
          t.lastToolName = event.name;
          t.progress ||= [];
          t.progress.push({
            at: this.now(),
            tool: String(event.name || '').slice(0, 100),
            repeated: t.repeated,
          });
          t.progress = t.progress.slice(-20);
        }
      });
      const current = this.find(this.store.state, binding.id);
      if (current.tokens >= this.config.maxTokens) this.fence(t.id, 'SUPER_BUDGET_REACHED');
      else if (this.config.watchdog && current.repeated >= 8)
        this.fence(t.id, 'SUPER_REPEATED_ACTION');
    }
    if (event.type === 'interaction' || event.type === 'status') this.changed();
  }
  async review(task) {
    const key = 'super-watchdog-' + randomUUID();
    this.watchKey = key;
    this.store.change((s) => {
      this.find(s, task.id).reviewedAt = this.now();
    });
    this.turns.set(key, { role: 'watchdog', id: task.id, generation: task.generation });
    try {
      await this.adapter.review(key, this.publicTask(task), this.config);
    } finally {
      this.turns.delete(key);
    }
  }
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.adapter.stop(this.routerKey);
    this.adapter.stop(this.watchKey);
    for (const t of this.store.state.tasks.filter((t) => t.status === 'running'))
      this.adapter.stop(t.workerKey);
    await Promise.allSettled([...this.active.values(), this.adapter.close?.()]);
    this.store.close();
  }
}
module.exports = { SuperAgentService };
