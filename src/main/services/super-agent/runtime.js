/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
class RuntimeAdapter {
  constructor(runtime, service) {
    this.runtime = runtime;
    this.service = service;
    this.keys = new Set();
  }
  async session(key, role, config, mode = 'chat') {
    let s = this.runtime.sessions.get(key);
    if (!s) {
      s = this.runtime.createSession({ key, mode, profile: 'superagent-' + role });
      this.keys.add(key);
    }
    await this.runtime.initialize({ key });
    const settings = await this.runtime.getSettings(),
      id = role === 'worker' ? config.workerModel : config.routerModel;
    const entry = id ? settings.llm?.pool?.find((r) => r.id === id && r.enabled !== false) : null;
    if (id && !entry) throw Error('SUPER_MODEL_UNAVAILABLE');
    // Only a pool identity is persisted; credentials stay in the existing credential store.
    s.agent.llmOverride = entry
      ? {
          model: entry.model,
          provider: entry.provider,
          poolEntryId: entry.id,
          reasoningEffort: entry.effort || 'auto',
        }
      : null;
    s.agent.settings.agent = {
      ...s.agent.settings.agent,
      maxIterations: role === 'worker' ? 40 : 12,
    };
    return s;
  }
  async route(key, events, tasks, config) {
    try {
      await this.session(key, 'router', config);
      const result = await this.runtime.sendMessage(
        key,
        JSON.stringify({
          policy: config.proactive ? config.rules : '',
          events: events.map((e) => ({
            ...e,
            text: e.text.slice(0, 800),
            totalChars: e.text.length,
            ...(e.text.length > 800 ? { readMore: e.id } : {}),
          })),
          existingTasks: tasks.map(({ id, title, scope, status, summary }) => ({
            id,
            title,
            scope,
            status,
            summary: summary.slice(0, 160),
          })),
        }),
      );
      if (!result.ok) throw Error(result.error);
    } finally {
      await this.drop(key);
    }
  }
  async run(task, events, config, checkpoint) {
    const existing = this.runtime.sessions.has(task.workerKey);
    const s = await this.session(task.workerKey, 'worker', config, task.mode);
    if (task.workspacePath && s.agent.workspacePath !== task.workspacePath) {
      const changed = await this.runtime.setWorkspace(task.workerKey, task.workspacePath);
      if (!changed.ok) throw Error(changed.error);
    }
    if (!existing && task.conversationId) {
      const restored = await this.runtime.openHistory(task.workerKey, task.conversationId);
      if (!restored.ok) throw Error('SUPER_HISTORY_UNAVAILABLE');
      await this.session(task.workerKey, 'worker', config, task.mode);
    }
    if (task.observation) {
      const readonly = new Set([
        'readFile',
        'listDirectory',
        'localSearch',
        'getSystemInfo',
        'calculator',
        'webSearch',
        'webFetch',
        'super_report',
        'super_recall',
      ]);
      s.agent._toolScope = readonly;
      s.agent.allowedToolNames = readonly;
      const definitions = s.agent.getEnabledToolDefinitions.bind(s.agent);
      if (!s.superReadonly) {
        s.agent.getEnabledToolDefinitions = () => definitions().filter((r) => readonly.has(r.name));
        s.superReadonly = true;
      }
    }
    const save = () =>
      checkpoint({
        conversationId: s.agent.conversationId || '',
        workspacePath: s.agent.workspacePath || '',
      });
    save();
    this.service.authorize(task.workerKey);
    const result = await this.runtime.sendMessage(
      task.workerKey,
      JSON.stringify({
        superAgentInput: true,
        taskId: task.id,
        title: task.title,
        mode: task.mode,
        recovery: task.attempts > 1,
        policy: task.observation
          ? 'Read-only background investigation under owner policy: ' + config.rules
          : 'Carry out the admitted user request using normal approvals.',
        events,
        reminder: 'Finish with super_report; do not claim completion from an ordinary answer.',
      }),
    );
    save();
    if (!result.ok) throw Error(result.error);
    await s.agent.saveToHistory({ strict: true });
    const consumed = new Set();
    for (const m of s.agent.contextManager.getHistoryMessages()) {
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      try {
        const envelope = JSON.parse(m.content.replace(/^【用户追加消息】/, ''));
        if (envelope.superAgentInput === true && envelope.taskId === task.id)
          for (const e of envelope.events || []) consumed.add(e.id);
      } catch {
        /* ordinary runtime observations are not task input acknowledgements */
      }
    }
    const ids = this.service.find(this.service.store.state, task.id).inputIds;
    let cursor = 0;
    while (cursor < ids.length && consumed.has(ids[cursor])) cursor++;
    checkpoint({ consumed: cursor });
  }
  async followup(task, event) {
    if (!this.runtime.sessions.get(task.workerKey)?.busy) return;
    this.service.authorize(task.workerKey);
    await this.runtime.inject(
      task.workerKey,
      JSON.stringify({
        superAgentInput: true,
        taskId: task.id,
        events: [event],
        instruction:
          'A new admitted user follow-up. Adjust this task and its report; it does not broaden permissions.',
      }),
    );
  }
  async review(key, task, config) {
    try {
      await this.session(key, 'watchdog', config);
      const result = await this.runtime.sendMessage(
        key,
        JSON.stringify({
          task,
          instruction:
            'Check for substantial progress without accessing private files or broadening the task.',
        }),
      );
      if (!result.ok) throw Error(result.error);
    } finally {
      await this.drop(key);
    }
  }
  stop(key) {
    if (key && this.runtime.sessions.has(key)) this.runtime.stop(key);
  }
  async drop(key) {
    const s = this.runtime.sessions.get(key);
    if (s?.busy) {
      this.stop(key);
      await s.finished;
    }
    if (s) await this.runtime.close(key);
    this.keys.delete(key);
  }
  async close() {
    await Promise.allSettled([...this.keys].map((key) => this.drop(key)));
  }
}
module.exports = { RuntimeAdapter };
