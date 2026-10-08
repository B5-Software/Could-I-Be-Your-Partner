/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { Service } = require('@deepseek-ai/cordis');
const { CompactionEngine, compactCheckpointSource } = require('@deepseek-ai/dsh-compaction');
const { SubagentRuntime } = require('@deepseek-ai/dsh-subagent');
const { createUserMessage } = require('@deepseek-ai/dsh-llm');
const { WebServer } = require('@deepseek-ai/dsh-host-webserver');
const { messageText } = require('./agents');

class CibypCompaction extends CompactionEngine {
  constructor(ctx, options) {
    super(ctx);
    this.options = options;
    this.active = new Set();
  }
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger?.kind !== 'context-overflow') return null; // Normal pressure stays with CIBYP's own context manager.
    return this.compactNow(agent, signal);
  }
  async compactNow(agent, signal, sourceCommandId) {
    if (this.active.has(agent.id)) throw new Error('Compaction already active');
    signal?.throwIfAborted();
    this.active.add(agent.id);
    const session = agent.session,
      compactionId = randomUUID();
    const nodes = session.surface.nodes;
    if (!nodes.length) {
      this.active.delete(agent.id);
      return null;
    }
    const startSeq = session.append('compaction/start', {
      compactionId,
      turn: null,
      ...(sourceCommandId ? { sourceCommandId } : {}),
    }).seq;
    let error;
    try {
      const result = await this.options.transport.request(
        'ds:compact',
        { sessionKey: agent.id },
        undefined,
        signal,
      );
      if (!result?.ok) {
        if (result?.skipped) return null;
        throw new Error(result?.message || result?.error || 'CIBYP compaction failed');
      }
      const summary = [{ type: 'text', text: result.summary }];
      const shadowedSeqs = nodes.filter(
        (seq) => session.deriveEventMessage(session.eventAt(seq))?.role !== 'system',
      );
      if (!shadowedSeqs.length) return null;
      const shadowedRange = { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) };
      const summarySeq = session.append('compaction/summary', {
        compactionId,
        turn: null,
        summary,
        shadowedRange,
        shadowedSeqs,
        shadowedTokenCount: 0,
        provider: 'cibyp',
        model: agent.options?.model || 'cibyp',
      }).seq;
      session.append(
        'user/message',
        createUserMessage({ content: summary, source: compactCheckpointSource(compactionId) }),
        {
          surfaceOp: { op: 'replace', startSeq: shadowedRange.start, endSeq: shadowedRange.end },
          sourceEventSeqs: shadowedSeqs,
        },
      );
      const endSeq = session.append('compaction/end', { compactionId, turn: null }).seq;
      await this.ctx.sessions.flush(session);
      return {
        compactionId,
        sourceCommandId,
        startSeq,
        summarySeq,
        endSeq,
        summary,
        shadowedRange,
        shadowedSeqs,
        shadowedTokenCount: 0,
      };
    } catch (e) {
      error = e;
      throw e;
    } finally {
      if (session.snapshotEvents().at(-1)?.type !== 'compaction/end')
        session.append('compaction/end', {
          compactionId,
          turn: null,
          ...(error ? { error: error.message } : {}),
        });
      this.active.delete(agent.id);
    }
  }
  compactRegion() {
    throw new Error(
      'CIBYP preserves its own context checkpoints; arbitrary DS surface-range compaction is unavailable',
    );
  }
}
CibypCompaction.inject = ['sessions'];

async function setupAuxiliaryServices(host, options) {
  const ctx = host.ctx;
  await ctx.plugin(
    class Compaction extends CibypCompaction {
      constructor(c) {
        super(c, options);
      }
    },
  );
  await ctx.plugin(SubagentRuntime, {});
  ctx.subagents.registerProvider({
    name: 'cibyp',
    inheritsParentContext: false,
    capabilities: {
      agentOptions: true,
      depthLimit: true,
      persona: false,
      toolFilter: false,
      outputSchema: false,
    },
    async start(request) {
      request.signal.throwIfAborted();
      const depth = (request.parent.session.header.delegationDepth || 0) + 1;
      if (request.maxDepth !== undefined && depth > request.maxDepth)
        throw new Error('Subagent depth limit reached');
      const owned = await ctx.agents.create({
        sessionId: randomUUID(),
        parentAgent: request.parent,
        meta: {
          ...(request.parent.session.header.cwd ? { cwd: request.parent.session.header.cwd } : {}),
          parentSession: request.parent.id,
          origin: 'subagent',
          delegationDepth: depth,
        },
        agentOptions: { ...request.parent.options, ...request.agentOptions },
        subagentDescriptor: request.descriptor,
        signal: request.signal,
      });
      const agent = owned.agent;
      let deliveryFailed = false;
      const detachError = agent.ctx.on('agent/error', () => {
        deliveryFailed = true;
      });
      const abort = () => {
        void agent.cancel({ kind: 'user' });
      };
      request.signal.addEventListener('abort', abort, { once: true });
      try {
        request.signal.throwIfAborted();
        agent.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }));
      } catch (error) {
        detachError();
        request.signal.removeEventListener('abort', abort);
        await owned.dispose();
        throw error;
      }
      const result = agent
        .whenIdle()
        .then(() => {
          const messages = agent.session.deriveMessages();
          const assistant = messages.findLast(
            (message) => message.role === 'assistant' && message.content.length,
          );
          const reason = agent.session
            .snapshotEvents()
            .findLast((event) => event.type === 'turn/end')?.data.reason?.kind;
          return {
            output: assistant?.content || [],
            stopReason:
              request.signal.aborted || reason === 'aborted'
                ? 'aborted'
                : deliveryFailed || reason === 'error'
                  ? 'error'
                  : reason === 'max-tokens' || reason === 'refusal'
                    ? reason
                    : 'completed',
          };
        })
        .finally(() => {
          detachError();
          request.signal.removeEventListener('abort', abort);
        });
      return { id: agent.id, localAgent: agent, result, dispose: owned.dispose };
    },
    async prepareContinuable() {
      return {};
    },
  });
  // DS web panels have their own loopback carrier. They cannot claim CIBYP's UI
  // or replace its shared backend listener; lifecycle follows the plugin host.
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  // Legacy capability plugins read deployment facts through webRuntime. Expose
  // only our plugin carrier's immutable facts, never DSH's application startup.
  await ctx.plugin(
    class WebCarrierInfo extends Service {
      static inject = ['webServer'];
      constructor(c) {
        super(c, 'webRuntime');
        Object.defineProperties(this, {
          trustedHosts: { value: Object.freeze([]), enumerable: true },
          host: { get: () => c.webServer.host, enumerable: true },
          port: { get: () => c.webServer.port, enumerable: true },
          publicUrl: {
            get: () => `http://${c.webServer.host}:${c.webServer.port}`,
            enumerable: true,
          },
        });
      }
    },
  );
  await ctx.plugin(
    class SessionAlias extends Service {
      static inject = ['sessions'];
      constructor(c) {
        super(c, 'session');
        this.get = (id) => c.sessions.get(id);
      }
    },
  );
}
module.exports = { setupAuxiliaryServices, CibypCompaction };
