/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { registerExternalRequest, augmentSSEResponse } = require('../llm-retry');
function messagesFromHost(messages, provider, model) {
  return (messages || []).map((message) => {
    const content =
      typeof message.content === 'string'
        ? message.content
          ? [{ type: 'text', text: message.content }]
          : []
        : (message.content || []).map((block) =>
            block.type === 'image_url'
              ? { type: 'image', attachment: { dataUrl: block.image_url?.url } }
              : block,
          );
    if (message.role === 'assistant' && (message.reasoning_content || message.reasoning))
      content.unshift({ type: 'reasoning', text: message.reasoning_content || message.reasoning });
    for (const call of message.tool_calls || [])
      content.push({
        type: 'tool-call',
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    const source =
      message.role === 'assistant'
        ? {
            kind: 'model',
            provider,
            model,
            ...(message.providerReasoning?.transport === 'openai' &&
            message.providerReasoning.items?.[0]?.format === 'dsh-plugin'
              ? { replayState: message.providerReasoning.items[0].data }
              : {}),
          }
        : message.role === 'tool'
          ? { kind: 'tool', callId: message.tool_call_id }
          : message.role === 'system'
            ? { kind: 'system-prompt' }
            : { kind: 'user' };
    return {
      id: randomUUID(),
      role: message.role,
      content,
      source,
      ...(message.role === 'tool' ? { toolCallId: message.tool_call_id } : {}),
    };
  });
}
function createPluginModels(getHost) {
  async function service() {
    const host = await getHost();
    await host.init();
    return host.ctx.llm;
  }
  return {
    async providers() {
      const llm = await service();
      return llm
        .listProviders()
        .filter((p) => llm.pluginAdapter(p.id))
        .map((p) => ({
          ...p,
          id: 'dsh:' + p.id,
          billingMode: llm.pluginAdapter(p.id).billingMode || 'api',
        }));
    },
    async models(provider) {
      const llm = await service(),
        id = provider.slice(4);
      if (!llm.pluginAdapter(id)) throw new Error('Enable the model provider plugin first');
      const models = await llm.listModels(id);
      return {
        ok: true,
        models: await Promise.all(
          models.map(async (m) => {
            const info = await llm.resolveModelInfo(id, m.id);
            return {
              ...m,
              contextLength: info.context?.contextWindow,
              vision: info.inputModalities?.includes('image'),
            };
          }),
        ),
      };
    },
    async usage(provider, options) {
      const llm = await service(),
        adapter = llm.pluginAdapter(provider.slice(4));
      if (!adapter?.usage) return { ok: true, unavailable: true, windows: [] };
      try {
        return { ok: true, ...(await adapter.usage(options)) };
      } catch (error) {
        return { ok: false, error: error.message, windows: [] };
      }
    },
    async info(provider, model) {
      const llm = await service(),
        id = provider.slice(4);
      if (!llm.pluginAdapter(id)) throw new Error('Enable the model provider plugin first');
      return llm.resolveModelInfo(id, model);
    },
    async fetch(body, options = {}) {
      const controller = new AbortController(),
        releaseRequest = registerExternalRequest(controller, options);
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 300000);
      const signal = AbortSignal.any([
        controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        controller.abort();
        releaseRequest();
      };
      try {
        const llm = await service(),
          provider = body.pluginProvider.slice(4);
        if (!llm.pluginAdapter(provider))
          throw new Error('Model provider plugin is unavailable or disabled');
        const run = async (emit) => {
          const blocks = [];
          let usage, finish, replay;
          for await (const chunk of llm.stream({
            provider,
            model: body.model,
            messages: messagesFromHost(body.messages, provider, body.model),
            tools: body.tool_choice === 'none' ? [] : body.tools?.map((t) => t.function || t),
            temperature: body.temperature,
            maxTokens: body.max_tokens,
            reasoningEffort: body.reasoningEffort,
            sessionId: options.sessionKey,
            signal,
          })) {
            signal.throwIfAborted();
            if (chunk.type === 'text-delta') emit({ content: chunk.text });
            else if (chunk.type === 'reasoning-delta') emit({ reasoning_content: chunk.text });
            else if (chunk.type === 'block-end') blocks.push(chunk.block);
            else if (chunk.type === 'usage')
              usage = {
                prompt_tokens:
                  (chunk.usage.inputTokens || 0) +
                  (chunk.usage.cacheReadTokens || 0) +
                  (chunk.usage.cacheWriteTokens || 0),
                completion_tokens: chunk.usage.outputTokens || 0,
                total_tokens: chunk.usage.totalTokens,
                prompt_tokens_details: { cached_tokens: chunk.usage.cacheReadTokens || 0 },
              };
            else if (chunk.type === 'finish') {
              finish = chunk.reason;
              if (['error', 'aborted'].includes(finish.kind))
                throw new Error(finish.failure?.message || finish.kind);
              replay = chunk.replayState;
            }
          }
          if (!finish) throw new Error('Plugin model stream ended without a terminal result');
          const calls = blocks
            .filter((b) => b.type === 'tool-call')
            .map((b) => ({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: b.arguments },
            }));
          if (calls.length) emit({ tool_calls: calls.map((call, index) => ({ ...call, index })) });
          const projected = [
            blocks.findIndex((b) => b.type === 'reasoning'),
            blocks.findIndex((b) => b.type === 'text'),
            ...blocks.flatMap((b, i) => (b.type === 'tool-call' ? [i] : [])),
          ].filter((i) => i >= 0);
          const opaque = replay
            ? [
                {
                  type: 'reasoning.encrypted',
                  format: 'dsh-plugin',
                  data: {
                    response: replay.response,
                    blocks: projected.map((i) => replay.blocks?.[i] || {}),
                  },
                },
              ]
            : null;
          if (opaque) emit({ reasoning_details: opaque });
          return {
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: blocks
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join(''),
                  reasoning_content: blocks
                    .filter((b) => b.type === 'reasoning')
                    .map((b) => b.text)
                    .join(''),
                  ...(opaque ? { reasoning_details: opaque } : {}),
                  ...(calls.length ? { tool_calls: calls } : {}),
                },
                finish_reason: calls.length
                  ? 'tool_calls'
                  : finish.kind === 'max-tokens'
                    ? 'length'
                    : 'stop',
              },
            ],
            usage,
          };
        };
        if (!body.stream) {
          try {
            const result = await run(() => {});
            return { ok: true, response: Response.json(result), releaseController: release };
          } finally {
            release();
          }
        }
        const encoder = new TextEncoder();
        const response = new Response(
          new ReadableStream({
            start(stream) {
              const send = (data) =>
                stream.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\n\n'));
              void run((delta) => send({ choices: [{ index: 0, delta }] }))
                .then((result) => {
                  send({
                    choices: [
                      { index: 0, delta: {}, finish_reason: result.choices[0].finish_reason },
                    ],
                    usage: result.usage,
                  });
                  stream.enqueue(encoder.encode('data: [DONE]\n\n'));
                  stream.close();
                })
                .catch((error) => {
                  try {
                    send({ error: { message: error.message } });
                    stream.close();
                  } catch {}
                })
                .finally(release);
            },
            cancel: release,
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
        return {
          ok: true,
          response: augmentSSEResponse(response, 'openai'),
          releaseController: release,
        };
      } catch (error) {
        release();
        return { ok: false, error: error.message, kind: signal.aborted ? 'cancelled' : 'plugin' };
      }
    },
  };
}
module.exports = { createPluginModels, messagesFromHost };
