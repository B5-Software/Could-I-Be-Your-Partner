/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentRegistry, agentEvents } = require('@deepseek-ai/dsh-agent');
const { SessionStore } = require('@deepseek-ai/dsh-session');
const { createScope } = require('@deepseek-ai/dsh-scope');
const {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  freezeMessage,
} = require('@deepseek-ai/dsh-llm');
const { execution, bounded } = require('./execution-context');
function messageText(message) {
  if (typeof message === 'string') return message;
  if (typeof message?.content === 'string') return message.content;
  return (message?.content || [])
    .map(
      (block) =>
        block.text ||
        (block.attachment?.path
          ? `[${block.attachment.name || 'attachment'}] ${block.attachment.path}`
          : ''),
    )
    .filter(Boolean)
    .join('\n');
}
function normalize(message) {
  if (message?.id && Array.isArray(message.content) && message.source)
    return freezeMessage(message);
  return createUserMessage({
    content: [{ type: 'text', text: messageText(message) }],
    source: message?.source || { kind: 'user' },
  });
}
class CibypSessionsService extends SessionStore {
  constructor(ctx, options) {
    super(ctx);
    this.options = options;
    this.pending = new Map();
    this.handles = new Map();
    this.root = path.join(options.dataDir, 'plugin-session-journals');
    ctx.on('session/event', (session) => this.persist(session), { global: true });
    ctx.effect(() => async () => {
      await Promise.all([...this.pending.values()]);
      await Promise.all([...this.handles.values()].map((handle) => handle.close()));
    });
  }
  async restore(id, meta = {}, seed, inheritedEventCount) {
    const persistence = this.ctx.root.get('sessionPersistence');
    let handle, saved;
    try {
      handle = await persistence.open(id, 'write');
      saved = await handle.read();
    } catch (error) {
      if (error.code !== 'SESSION_NOT_FOUND') throw error;
    }
    let session;
    try {
      session = this.prepare(id, {
        meta: handle?.header || meta,
        seed: seed || saved?.events || [],
        inheritedEventCount: handle ? handle.inheritedEventCount : inheritedEventCount,
      });
      handle ||= await persistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount || 0,
      });
      this.handles.set(id, handle);
      return session;
    } catch (error) {
      await handle?.close();
      throw error;
    }
  }
  persist(session) {
    const events = session.snapshotEvents();
    const previous = this.pending.get(session.id) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        let handle = this.handles.get(session.id);
        if (!handle) {
          handle = await this.ctx.root
            .get('sessionPersistence')
            .create(session.header, { inheritedEventCount: session.inheritedEventCount || 0 });
          this.handles.set(session.id, handle);
        }
        const saved = await handle.read();
        if (events.length > saved.events.length)
          await handle.append(events.slice(saved.events.length));
      });
    this.pending.set(session.id, task);
    task.catch((error) =>
      this.ctx.logger.warn('Plugin session persistence failed: ' + error.message),
    );
    return task;
  }
  async flush(session) {
    await this.persist(session);
    await this.handles.get(session.id)?.flush();
    return true;
  }
  async release(session) {
    await this.flush(session);
    await this.handles.get(session.id)?.close();
    this.handles.delete(session.id);
    this.pending.delete(session.id);
  }
}
class CibypAgentsService extends AgentRegistry {
  constructor(ctx, options) {
    super(ctx);
    this.options = options;
    this.metadata = new Map();
    this.aliases = new Map();
    this.bridges = new Map();
    this.creating = new Set();
    this.attaching = new Map();
    this.syncing = Promise.resolve();
    this.setFactory({
      createAgent: (owner, config) => this.createOwned(owner, config, false),
      resume: (owner, config) => this.createOwned(owner, config, true),
    });
  }
  get(id) {
    return super.get(this.aliases.get(String(id)) || String(id));
  }
  has(id) {
    return !!this.get(id);
  }
  sync(entries) {
    const task = this.syncing.then(() => this.syncNow(entries));
    this.syncing = task.catch(() => {});
    return task;
  }
  async syncNow(entries) {
    const present = new Set();
    for (const data of entries || []) {
      if (!data?.key) continue;
      present.add(data.key);
      this.metadata.set(data.key, { ...data });
      if (data.id) this.aliases.set(String(data.id), data.key);
      if (!super.get(data.key) && !this.creating.has(data.key))
        await this.attach(this.ctx, data.key, { meta: data.cwd ? { cwd: data.cwd } : {} });
      const bridge = this.bridges.get(data.key);
      bridge?.changed();
    }
    for (const [key, bridge] of this.bridges)
      if (!present.has(key)) {
        await bridge.detach();
        this.metadata.delete(key);
        for (const [alias, mapped] of this.aliases) if (mapped === key) this.aliases.delete(alias);
      }
  }
  async createOwned(owner, config = {}, resume) {
    config.signal?.throwIfAborted();
    if (!this.options.transport?.request)
      throw new Error('CIBYP shared Agent backend is unavailable');
    const id = config.resumeSessionId || config.sessionId || randomUUID();
    if (this.get(id) || this.creating.has(id)) throw new Error('Agent is already live: ' + id);
    this.creating.add(id);
    let response, bridge;
    try {
      response = await this.options.transport.request(
        resume ? 'ds:agentResume' : 'ds:agentCreate',
        {
          sessionId: id,
          cwd: config.meta?.cwd || config.cwd,
          ...config.agentOptions,
          instructions: undefined,
          seedMessages: config.seed
            ? require('./llm').toHostMessages(
                this.ctx.root
                  .get('sessions')
                  .prepare(id, {
                    meta: config.meta || {},
                    seed: config.seed,
                    inheritedEventCount: config.inheritedEventCount,
                  })
                  .deriveMessages(),
              )
            : undefined,
        },
        30000,
        config.signal,
      );
      if (response?.error || !response?.sessionKey)
        throw new Error(response?.error || 'Agent creation failed');
      const key = response.sessionKey;
      this.metadata.set(key, {
        key,
        id: response.id,
        mode: response.mode || 'chat',
        cwd: response.cwd,
        status: response.status || 'idle',
        title: response.title,
      });
      if (response.id) this.aliases.set(String(response.id), key);
      if (this.bridges.has(key)) throw new Error('Backend returned an already live Agent: ' + key);
      bridge = await this.attach(
        owner,
        key,
        { ...config, meta: { ...(response.cwd ? { cwd: response.cwd } : {}), ...config.meta } },
        resume ? 'resume' : 'startup',
      );
      let disposal;
      const dispose = () =>
        (disposal ||= (async () => {
          await bridge.agent.cancel({ kind: 'disposed' });
          await this.options.transport.request('ds:agentClose', { sessionKey: key });
          await bridge.detach();
        })());
      owner.effect(() => dispose);
      if (config.instructions) bridge.agent.followup(config.instructions);
      return Object.assign(bridge.agent, { agent: bridge.agent, dispose });
    } catch (error) {
      if (response?.sessionKey && !bridge && !this.bridges.has(response.sessionKey)) {
        await this.options.transport
          .request('ds:agentClose', { sessionKey: response.sessionKey })
          .catch(() => {});
        this.metadata.delete(response.sessionKey);
      }
      throw error;
    } finally {
      this.creating.delete(id);
    }
  }
  attach(owner, key, config = {}, source = 'startup') {
    if (this.bridges.has(key)) return Promise.resolve(this.bridges.get(key));
    if (this.attaching.has(key)) return this.attaching.get(key);
    const task = this.attachNow(owner, key, config, source);
    this.attaching.set(key, task);
    task
      .finally(() => {
        if (this.attaching.get(key) === task) this.attaching.delete(key);
      })
      .catch(() => {});
    return task;
  }
  async attachNow(owner, key, config = {}, source = 'startup') {
    const entry = () => this.metadata.get(key) || {};
    const store = this.ctx.root.get('sessions');
    if (!store) throw new Error('CIBYP plugin Session service is unavailable');
    const session =
      store.get(key) ||
      (await store.restore(key, config.meta || {}, config.seed, config.inheritedEventCount));
    const pending = { 'next-turn': [], 'next-step': [] };
    for (const event of session.snapshotEvents())
      if (event.type === 'agent/inbox/spliced') {
        const op = event.data;
        pending[op.target]?.splice(op.start, op.removedCount || 0, ...op.inserted);
      }
    let pumping,
      disposed = false,
      working = false,
      maintenance,
      maintenanceController,
      lastStatus,
      turn =
        session
          .snapshotEvents()
          .filter((e) => e.type === 'turn/start')
          .at(-1)?.data.turn || 0,
      step = 0,
      openTurn = false,
      requested = 0,
      modelResponse = false,
      pendingAssistant,
      subagentDescriptor = config.subagentDescriptor;
    const service = this;
    const inbox = {
      get nextTurn() {
        return [...pending['next-turn']];
      },
      get nextStep() {
        return [...pending['next-step']];
      },
      clear() {
        inbox.splice('next-step', 0, pending['next-step'].length, []);
        inbox.splice('next-turn', 0, pending['next-turn'].length, []);
      },
      append(target, message) {
        inbox.splice(target, pending[target]?.length || 0, 0, [message]);
      },
      prepend(target, message) {
        inbox.splice(target, 0, 0, [message]);
      },
      replace(id, message) {
        for (const target of Object.keys(pending)) {
          const index = pending[target].findIndex((m) => m.id === id);
          if (index !== -1) {
            inbox.splice(target, index, 1, [message]);
            return true;
          }
        }
        return false;
      },
      remove(id) {
        for (const target of Object.keys(pending)) {
          const index = pending[target].findIndex((m) => m.id === id);
          if (index !== -1) {
            inbox.splice(target, index, 1, []);
            return true;
          }
        }
        return false;
      },
      splice(target, start, count, inserted, claimed = false) {
        if (disposed) throw new Error('Agent scope disposed');
        const queue = pending[target];
        if (!queue) throw new TypeError('Invalid inbox target');
        const at = start < 0 ? Math.max(queue.length + start, 0) : Math.min(start, queue.length);
        const values = inserted.map(normalize),
          removed = queue.slice(at, at + Math.max(0, count));
        if (!removed.length && !values.length) return [];
        const ids = [...pending['next-turn'], ...pending['next-step']]
          .filter((m) => !removed.includes(m))
          .map((m) => m.id);
        for (const message of values) {
          if (ids.includes(message.id)) throw new Error('Message is already pending');
          ids.push(message.id);
        }
        session.append('agent/inbox/spliced', {
          target,
          start: at,
          removedCount: removed.length,
          inserted: values,
        });
        queue.splice(at, removed.length, ...values);
        for (const message of removed)
          dispatch.emit(claimed ? 'agent/inbox/claimed' : 'agent/inbox/discarded', {
            message,
            ...(claimed ? { turn: openTurn ? turn : turn + 1 } : {}),
          });
        for (const message of values) dispatch.emit('agent/inbox/inserted', { message });
        return removed;
      },
      push(message) {
        inbox.append('next-turn', message);
      },
      get events() {
        return inbox.nextTurn;
      },
    };
    const agent = {
      id: key,
      session,
      inbox,
      options: {
        provider: 'cibyp',
        ...(entry().model ? { model: entry().model } : {}),
        ...config.agentOptions,
      },
      get status() {
        return working || ['running', 'queued'].includes(entry().status) ? 'running' : 'idle';
      },
      get title() {
        return entry().title || '';
      },
      get mode() {
        return entry().mode || 'chat';
      },
      send(message, target = 'next-turn', wakeup = true) {
        inbox.append(target, message);
        if (wakeup) void pump();
      },
      followup(message) {
        agent.send(message);
      },
      steer(message) {
        agent.send(message, 'next-step');
      },
      inject(message) {
        inbox.append('next-step', message);
      },
      async cancel(cause, { keepInbox } = {}) {
        maintenanceController?.abort(cause);
        if (!keepInbox) inbox.clear();
        await service.options.transport.send('ds:pluginAgentMessage', {
          sessionKey: key,
          kind: 'stop',
          cause,
        });
        await agent.whenIdle();
      },
      stop() {
        return agent.cancel({ kind: 'user' });
      },
      async whenIdle() {
        while (pumping || maintenance || agent.status === 'running') {
          if (pumping) await pumping;
          else if (maintenance) await maintenance;
          else
            await new Promise((r) => {
              waiters.add(r);
            });
        }
      },
      runMaintenance(task) {
        if (maintenance || agent.status !== 'idle') throw new Error('Agent is busy');
        const controller = (maintenanceController = new AbortController());
        maintenance = Promise.resolve()
          .then(() => task(controller.signal))
          .finally(() => {
            maintenance = undefined;
            maintenanceController = undefined;
            changed();
          });
        return maintenance;
      },
    };
    const scope = createScope(
      owner,
      agent,
      config.parentAgent ? { parent: config.parentAgent } : undefined,
    );
    agent.ctx = scope.ctx;
    const dispatch = agentEvents(this.ctx, agent),
      waiters = new Set();
    const changed = () => {
      const status = agent.status;
      if (status !== lastStatus) {
        lastStatus = status;
        dispatch.emit('agent/status', { status });
      }
      for (const r of waiters) r();
      waiters.clear();
      if (status === 'idle') void pump();
    };
    const pump = () => {
      if (
        disposed ||
        pumping ||
        maintenance ||
        agent.status !== 'idle' ||
        (!pending['next-turn'].length && !pending['next-step'].length)
      )
        return pumping;
      pumping = (async () => {
        working = true;
        changed();
        while (!disposed && (pending['next-turn'].length || pending['next-step'].length)) {
          const messages = [
            ...inbox.splice('next-step', 0, pending['next-step'].length, [], true),
            ...inbox.splice('next-turn', 0, 1, [], true),
          ];
          try {
            await execution.run({ agent, cwd: entry().cwd, mode: agent.mode }, () =>
              service.options.transport.send('ds:pluginAgentMessage', {
                sessionKey: key,
                kind: 'plugin-turn',
                text: messages.map(messageText).join('\n\n'),
              }),
            );
          } catch (error) {
            dispatch.emit('agent/error', { error });
            break;
          }
        }
      })().finally(() => {
        working = false;
        pumping = undefined;
        changed();
      });
      pumping.catch((e) => this.ctx.logger.warn('Plugin Agent delivery failed: ' + e.message));
      return pumping;
    };
    let detachEntry, detachSession, detachPromise;
    const detach = () =>
      (detachPromise ||= (async () => {
        disposed = true;
        detachEntry?.();
        this.bridges.delete(key);
        changed();
        await scope.dispose();
        await store.release(session);
        detachSession?.();
      })());
    const startTurn = () => {
      if (!openTurn) {
        turn++;
        step = 0;
        requested = 0;
        modelResponse = false;
        openTurn = true;
        session.append('turn/start', { turn });
        if (subagentDescriptor) {
          session.append('subagent/descriptor', subagentDescriptor);
          subagentDescriptor = undefined;
        }
      }
    };
    const toolName = (wire) => {
      if (!wire?.startsWith('ds__')) return wire;
      const tools = service.ctx.root.get('tools');
      return (
        [...tools.registrations].find((def) => `ds__${def.pluginId}__${def.name}` === wire)?.name ||
        wire
      );
    };
    const flushAssistant = () => {
      if (!pendingAssistant) return;
      session.append(
        'assistant/message',
        {
          turn,
          step,
          stream: [],
          message: createAssistantMessage({
            content: pendingAssistant,
            source: {
              kind: 'model',
              provider: agent.options.provider || 'cibyp',
              model: agent.options.model || 'cibyp',
            },
          }),
        },
        { surfaceOp: 'append' },
      );
      pendingAssistant = undefined;
    };
    const bridge = {
      agent,
      changed,
      detach,
      dispatch,
      get turn() {
        return turn;
      },
      get step() {
        return step;
      },
      async beforeRequest(messages, options) {
        startTurn();
        modelResponse = false;
        const signal = options.signal || AbortSignal.timeout(30000);
        const queued = inbox.splice('next-step', 0, pending['next-step'].length, [], true);
        const incoming =
          requested === 0
            ? messages
                .filter((message) => message.role === 'user')
                .slice(-1)
                .map(normalize)
            : [];
        const proposed = [...incoming, ...queued];
        const decision = await bounded(
          dispatch.waterfall(
            'agent/pre-step',
            { messages: proposed, turn, step: step + 1, signal },
            async () => ({ kind: 'enter', messages: proposed }),
          ),
          signal,
        );
        signal.throwIfAborted();
        if (decision.kind === 'reject')
          throw Object.assign(new Error('A plugin rejected this Agent step'), {
            code: 'PLUGIN_STEP_REJECTED',
          });
        if (requested) {
          session.append('step/end', { turn, step });
          step++;
          session.append('step/start', { turn, step });
        } else if (!step) {
          step = 1;
          session.append('step/start', { turn, step });
        }
        requested++;
        const settings = (await service.options.getSettings?.()) || {};
        const route =
          (settings.llm?.pool || []).find((entry) => entry.id === options.poolEntryId) ||
          settings.llm ||
          {};
        const baseline = {
          provider: options.provider || route.provider,
          model: options.model || route.model,
          temperature: options.temperature,
          maxTokens: options.max_tokens,
        };
        const configured = await bounded(
          dispatch.waterfall('agent/request', { turn, step, signal }, async () => baseline),
          signal,
        );
        signal.throwIfAborted();
        const out = messages.map((message) => ({ ...message }));
        if (incoming.length) {
          const at = out.findLastIndex((message) => message.role === 'user');
          out.splice(
            at,
            1,
            ...decision.messages.map((message) => ({
              role: 'user',
              content: messageText(message),
            })),
          );
        } else
          out.push(
            ...decision.messages.map((message) => ({
              role: 'user',
              content: messageText(message),
            })),
          );
        for (const message of decision.messages)
          if (!incoming.some((old) => old.id === message.id))
            session.append('user/message', message, { surfaceOp: 'append' });
        return {
          messages: out,
          options: {
            ...options,
            ...(configured.provider && configured.provider !== baseline.provider
              ? { provider: configured.provider, poolEntryId: undefined }
              : {}),
            ...(configured.model && configured.model !== baseline.model
              ? { model: configured.model, poolEntryId: undefined }
              : {}),
            ...(configured.temperature !== undefined
              ? { temperature: configured.temperature }
              : {}),
            ...(configured.maxTokens !== undefined ? { max_tokens: configured.maxTokens } : {}),
          },
        };
      },
      async stopping() {
        if (!openTurn) return { contexts: [] };
        await bounded(
          dispatch.serial('agent/turn-stopping', { turn, signal: AbortSignal.timeout(30000) }),
        );
        return {
          contexts: inbox
            .splice('next-step', 0, pending['next-step'].length, [], true)
            .map(messageText),
        };
      },
      event: (event) => {
        if (event.type === 'status') {
          if (event.status === 'running' && !openTurn) startTurn();
          else if (event.status !== 'running' && openTurn) {
            flushAssistant();
            if (step) session.append('step/end', { turn, step });
            session.append('turn/end', {
              turn,
              reason:
                event.status === 'error'
                  ? { kind: 'error', error: { message: 'CIBYP turn failed', code: 'UNKNOWN' } }
                  : event.status === 'interrupted'
                    ? { kind: 'aborted', reason: { kind: 'user' } }
                    : { kind: 'completed' },
            });
            openTurn = false;
          }
          const data = service.metadata.get(key);
          if (data) data.status = event.status;
          changed();
        } else if (event.type === 'title' && typeof event.title === 'string') {
          const data = service.metadata.get(key);
          if (data) data.title = event.title;
          session.append('session/title', { title: event.title });
        } else if (event.type === 'model-response') {
          startTurn();
          if (!step) {
            step = 1;
            session.append('step/start', { turn, step });
          }
          const message = event.message || {},
            content = [];
          if (message.reasoning || message.reasoning_content)
            content.push({
              type: 'reasoning',
              text: message.reasoning || message.reasoning_content,
            });
          if (message.content) content.push({ type: 'text', text: messageText(message) });
          for (const tool of message.tool_calls || [])
            content.push({
              type: 'tool-call',
              id: tool.id,
              name: toolName(tool.function.name),
              arguments: tool.function.arguments,
            });
          session.append(
            'assistant/message',
            {
              turn,
              step,
              stream: [],
              message: createAssistantMessage({
                content,
                source: {
                  kind: 'model',
                  provider: agent.options.provider || 'cibyp',
                  model: event.model || agent.options.model || 'cibyp',
                },
              }),
              ...(event.usage ? { usage: require('./llm').usage(event.usage) } : {}),
            },
            { surfaceOp: 'append' },
          );
          modelResponse = true;
          pendingAssistant = undefined;
        } else if (event.type === 'tool-call' && event.callId) {
          startTurn();
          if (!step) {
            step = 1;
            session.append('step/start', { turn, step });
          }
          const name = toolName(event.name);
          if (event.status === 'running')
            session.append('tool/call', {
              turn,
              step,
              callId: event.callId,
              name,
              arguments: JSON.stringify(event.args || {}),
            });
          else
            session.append(
              'tool/result',
              {
                turn,
                step,
                message: createToolResultMessage({
                  callId: event.callId,
                  name,
                  content: [{ type: 'text', text: event.result || '' }],
                  isError: event.status !== 'done',
                }),
              },
              { surfaceOp: 'append' },
            );
        } else if (event.type === 'message' && ['user', 'assistant'].includes(event.role)) {
          startTurn();
          if (!step) {
            step = 1;
            session.append('step/start', { turn, step });
          }
          const content = [
            {
              type: 'text',
              text: messageText(
                typeof event.content === 'object' ? event.content : { content: event.content },
              ),
            },
          ];
          if (event.role === 'user')
            session.append(
              'user/message',
              createUserMessage({ content, source: { kind: 'user' } }),
              { surfaceOp: 'append' },
            );
          else if (!modelResponse) pendingAssistant = content;
        }
      },
    };
    try {
      const commit = await config.setup?.(agent.ctx, agent);
      commit?.commit();
      if (!store.get(key)) {
        detachSession = store.enter(session);
        store.announce(session);
      }
      detachEntry = this.enter(agent, config.parentAgent);
      this.bridges.set(key, bridge);
      await this.announce(agent, source, config.signal);
      changed();
      return bridge;
    } catch (error) {
      await detach();
      throw error;
    }
  }
  consumeRuntimeEvent(event) {
    this.bridges.get(event.key)?.event(event);
  }
  beforeRequest(agent, messages, options) {
    return this.bridges.get(agent.id)?.beforeRequest(messages, options) || { messages, options };
  }
  turnStopping(id) {
    return this.bridges.get(id)?.stopping() || { contexts: [] };
  }
}
module.exports = { CibypAgentsService, CibypSessionsService, messageText };
