/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_TOOLS = [
  'readFile',
  'listDirectory',
  'localSearch',
  'createFile',
  'editFile',
  'copyFile',
  'makeDirectory',
  'getSystemInfo',
  'calculator',
  'webSearch',
  'webFetch',
  'runJavaScriptCode',
];
const CONTROL_TOOLS = ['sendAgentMessage', 'listSubAgents', 'interruptSubAgent'];
const MAX_SUB_AGENT_RECORDS = 100;

// Native tools are adapters to the SAME SDK continuation service used by plugins.
// There is no second Agent loop or frontend-owned worker here.
class NativeSubagents {
  constructor({ file, host, getRuntime, sync }) {
    Object.assign(this, { file, host, getRuntime, sync });
    this.children = {};
    this.waiters = new Map();
    try {
      if (fs.statSync(file).size > 32 * 1024 * 1024)
        throw new Error('Subagent catalog is too large');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.children))
        throw new Error('Invalid subagent catalog');
      for (const row of data.children) {
        if (
          !/^native-sub-[a-f0-9-]{36}$/.test(row.id) ||
          typeof row.parentId !== 'string' ||
          !Array.isArray(row.tools) ||
          !row.model ||
          !['chat', 'code', 'babe'].includes(row.mode) ||
          !Number.isSafeInteger(row.maxIterations)
        )
          throw new Error('Invalid subagent delegation policy');
        this.children[row.id] = row;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = error.message;
    }
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(
      temp,
      JSON.stringify({
        version: 1,
        children: Object.values(this.children).map(({ messages, ...row }) => row),
      }),
    );
    fs.renameSync(temp, this.file);
  }
  config(id) {
    return this.children[id];
  }
  runtimeSession(identity) {
    return [...this.getRuntime().sessions.values()].find(
      (s) =>
        s.agent.messagingId === identity ||
        s.key === identity ||
        s.agent.conversationId === identity,
    );
  }
  async sender(key) {
    const session = this.getRuntime().sessions.get(key);
    if (!session || session.profile === 'settings-assistant')
      throw new Error('Agent is unavailable');
    if (!session.initialized) await this.getRuntime().initialize({ key });
    await this.host.init();
    await this.sync();
    const agent = this.host.agentsService.get(session.agent.messagingId || key);
    if (!agent) throw new Error('Agent mailbox is unavailable');
    return { session, agent };
  }
  async start(key, args = {}) {
    if (this.error) throw new Error('Subagent catalog cannot be read: ' + this.error);
    const task = String(args.task || '')
      .trim()
      .slice(0, 16000);
    if (!task) throw new Error('task is required');
    const { session, agent: parent } = await this.sender(key);
    const enabled = new Set(session.agent.getEnabledToolDefinitions().map((t) => t.name));
    const tools = (Array.isArray(args.tools) ? args.tools : DEFAULT_TOOLS).filter((name) =>
      enabled.has(name),
    );
    const id = 'native-sub-' + randomUUID();
    const row = {
      id,
      parentId: parent.id,
      task,
      context: String(args.context || '').slice(0, 16000),
      tools: [...new Set(tools)],
      model: {
        model: session.agent.getActiveModelId(),
        provider: session.agent._llmOptions().provider || session.agent.settings.llm.provider,
        poolEntryId: session.agent._llmOptions().poolEntryId,
        reasoningEffort: session.agent.getActiveReasoningEffort(),
      },
      mode: session.mode,
      workspacePath: session.agent.codeWorkspacePath || session.agent.workspacePath,
      hostWorkspacePath: session.hostWorkspacePath || null,
      maxIterations: Math.max(1, Math.min(200, Math.floor(Number(args.maxIterations) || 30))),
      status: 'queued',
      startTime: Date.now(),
      endTime: null,
      iterations: 0,
      toolUseCount: 0,
    };
    this.children[id] = row;
    try {
      this.persist();
    } catch (error) {
      delete this.children[id];
      throw error;
    }
    const completion =
      args.wait !== false ? new Promise((resolve) => this.waiters.set(id, resolve)) : null;
    try {
      const accepted = await this.host.ctx.subagents.startContinuable({
        childId: id,
        provider: 'cibyp',
        label: task.slice(0, 80),
        signal: new AbortController().signal,
        request: { parent, maxDepth: 4, prompt: [{ type: 'text', text: task }] },
      });
      this.notify(row, 'sub-agent-start', { ...this.view(row), messageId: accepted.messageId });
      if (!completion)
        return { ok: true, accepted: true, subAgentId: id, messageId: accepted.messageId };
      return await completion;
    } catch (error) {
      this.waiters.delete(id);
      row.status = 'error';
      row.error = error.message;
      row.endTime = Date.now();
      this.persist();
      throw error;
    }
  }
  async control(key, args = {}) {
    if (args.action === 'interrupt-all') {
      this.interruptChildren(key);
      return { ok: true };
    }
    const { agent: sender } = await this.sender(key);
    if (args.action === 'list') {
      return {
        ok: true,
        selfId: sender.id,
        parentId: sender.session.header.parentSession || null,
        children: Object.values(this.children)
          .filter((row) => row.parentId === sender.id)
          .map((row) => ({
            id: row.id,
            task: row.task.slice(0, 160),
            status: row.status,
            startTime: row.startTime,
            endTime: row.endTime,
            iterations: row.iterations,
            toolUseCount: row.toolUseCount,
            error: row.error || null,
            usage: this.view(row).usage,
          })),
      };
    }
    const target = String(args.targetId || '');
    if (!target) throw new Error('targetId is required');
    if (args.action === 'interrupt') {
      const row = this.children[target];
      if (!row || row.parentId !== sender.id)
        throw new Error('Only a direct child may be interrupted');
      this.host.ctx.subagents.interrupt(target, { kind: 'ancestor', agent: sender });
      return { ok: true, subAgentId: target, interrupted: true };
    }
    if (args.action !== 'send') throw new Error('Unknown subagent action');
    const text = String(args.message || '').trim();
    if (!text || text.length > 32000) throw new Error('Message must contain 1–32000 characters');
    const messageId = await this.host.ctx.subagents.sendMessage(
      sender,
      target,
      [{ type: 'text', text }],
      { signal: new AbortController().signal },
    );
    return { ok: true, accepted: true, messageId, targetId: target };
  }
  view(row) {
    const session = this.runtimeSession(row.id);
    const a = session?.agent;
    return {
      ...row,
      messages: a?.contextManager?.getHistoryMessages() || row.messages || [],
      usage: a?.sessionUsage || row.usage || {},
    };
  }
  notify(row, type, data) {
    const parent = this.runtimeSession(row.parentId)?.agent;
    if (!parent) return;
    const record = this.view(row);
    const old = parent.subAgents.find((item) => item.id === row.id);
    if (old) Object.assign(old, record);
    else parent.subAgents.push(record);
    while (parent.subAgents.length > MAX_SUB_AGENT_RECORDS) {
      const at = parent.subAgents.findIndex((item) => !['queued', 'running'].includes(item.status));
      if (at < 0) break;
      parent.subAgents.splice(at, 1);
    }
    parent.onMessage?.(type, data);
    parent.saveToHistory();
  }
  event(event) {
    const session = this.getRuntime().sessions.get(event.key);
    const row = this.children[session?.agent.messagingId || event.key];
    if (!row) return;
    if (event.type === 'model-response') {
      row.iterations++;
      if (event.usage)
        this.runtimeSession(row.parentId)?.agent._accumulateUsage(event.usage, event.model);
    }
    if (event.type === 'tool-call' && event.status === 'done') row.toolUseCount++;
    if (event.type === 'message' && event.role === 'assistant')
      this.notify(row, 'sub-agent-message', { id: row.id, task: row.task, content: event.content });
    if (event.type !== 'status') return;
    row.status =
      event.status === 'running'
        ? 'running'
        : event.status === 'error' || session?.lastError
          ? 'error'
          : session?.stopRequested
            ? 'stopped'
            : 'done';
    if (row.status === 'running') return;
    row.endTime = Date.now();
    row.messages = session?.agent.contextManager.getHistoryMessages() || row.messages || [];
    row.usage = session?.agent.sessionUsage || row.usage || {};
    const result =
      [...row.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content)
        ?.content || '';
    row.error = session?.lastError || null;
    const answer = {
      ok: row.status === 'done',
      subAgentId: row.id,
      status: row.status,
      result,
      error: row.error,
      iterations: row.iterations,
    };
    try {
      this.persist();
    } catch (error) {
      row.status = 'error';
      row.error = 'Cannot persist subagent state: ' + error.message;
      answer.ok = false;
      answer.status = 'error';
      answer.error = row.error;
    }
    this.notify(row, 'sub-agent-done', {
      ...this.view(row),
      result,
      duration: row.endTime - row.startTime,
    });
    this.waiters.get(row.id)?.(answer);
    this.waiters.delete(row.id);
  }
  interruptChildren(key) {
    const parent = this.getRuntime().sessions.get(key)?.agent;
    const bridge = parent && this.host.agentsService?.get(parent.messagingId || key);
    if (!bridge) return;
    this.host.agentsService.bridges.get(bridge.id)?.park();
    for (const row of Object.values(this.children).filter(
      (r) => r.parentId === bridge.id && r.status === 'running',
    )) {
      try {
        this.host.ctx.subagents.interrupt(row.id, { kind: 'ancestor', agent: bridge });
      } catch {
        /* a completed child may already be released */
      }
    }
  }
}
module.exports = { NativeSubagents, CONTROL_TOOLS };
