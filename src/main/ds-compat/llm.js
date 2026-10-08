/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { LlmRuntime, LlmAdapter } = require('@deepseek-ai/dsh-llm');
const { currentExecution } = require('./execution-context');

function toHostMessages(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return { ...message };
    const text = [],
      reasoning = [],
      tools = [];
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'reasoning') reasoning.push(block.text);
      else if (block.type === 'tool-call')
        tools.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        });
      else if (block.type === 'image') {
        const url = block.attachment?.dataUrl || block.attachment?.url;
        if (!url || !/^data:image\//.test(url))
          throw new Error('Image attachment requires a CIBYP-owned data URL');
        text.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'file')
        text.push(
          block.attachment?.path
            ? `[File: ${block.attachment.name || 'attachment'}]\n${block.attachment.path}`
            : '[File attachment]',
        );
      else throw new Error('Unsupported model content block: ' + block.type);
    }
    return {
      role: message.role,
      content: text.some((x) => typeof x !== 'string')
        ? text.map((x) => (typeof x === 'string' ? { type: 'text', text: x } : x))
        : text.join('\n'),
      ...(reasoning.length ? { reasoning_content: reasoning.join('\n') } : {}),
      ...(tools.length ? { tool_calls: tools } : {}),
      ...(message.toolCallId || message.source?.callId
        ? { tool_call_id: message.toolCallId || message.source.callId }
        : {}),
    };
  });
}
function usage(value = {}) {
  const cache = value.prompt_tokens_details?.cached_tokens || value.cache_read_input_tokens || 0;
  const input = value.prompt_tokens ?? value.input_tokens ?? 0,
    output = value.completion_tokens ?? value.output_tokens ?? 0;
  return {
    inputTokens: Math.max(0, input - cache),
    outputTokens: output,
    cacheReadTokens: cache,
    ...(value.total_tokens !== undefined ? { totalTokens: value.total_tokens } : {}),
    ...(value.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: value.completion_tokens_details.reasoning_tokens }
      : {}),
  };
}
class CibypLlmAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
  }
  providerInfo(id) {
    return { id, name: 'CIBYP · ' + id };
  }
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    };
  }
  async listModels(provider) {
    const settings = (await this.options.getSettings?.()) || {};
    const pool = (settings.llm?.pool || []).filter(
      (e) => e.enabled !== false && (provider === 'cibyp' || e.provider === provider),
    );
    if (
      settings.llm?.model &&
      (provider === 'cibyp' || settings.llm.provider === provider) &&
      !pool.some((e) => e.model === settings.llm.model)
    )
      pool.push(settings.llm);
    return pool.map((e) => ({ provider, id: e.model, name: e.name || e.model }));
  }
  async *stream(request) {
    if (!this.options.invoke) throw new Error('CIBYP model backend is unavailable');
    const requestId = 'ds-plugin-' + randomUUID(),
      signal = request.signal;
    signal?.throwIfAborted();
    const sessionKey = request.sessionId || request.sessionKey || currentExecution().agent?.id;
    const settings = (await this.options.getSettings?.()) || {},
      route = request.provider;
    // A route is an existing CIBYP model-pool route. This never rewrites global settings.
    const entry = (settings.llm?.pool || []).find(
      (e) =>
        e.enabled !== false &&
        e.model === request.model &&
        (route === 'cibyp' || e.provider === route),
    );
    const opts = {
      requestId,
      sessionKey,
      cibypPluginPromptApplied: true,
      ...(entry ? { poolEntryId: entry.id } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(route && route !== 'cibyp' ? { provider: route } : {}),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      reasoningEffort: request.reasoningEffort,
      stop: request.stop,
      tools: request.tools?.map((t) => ({ type: 'function', function: t })),
    };
    const prepared = [];
    for (const message of request.messages || []) {
      if (!Array.isArray(message.content)) {
        prepared.push(message);
        continue;
      }
      const content = [];
      for (const block of message.content) {
        if (block.type === 'image' && !block.attachment?.dataUrl && !block.attachment?.url) {
          const image = await this.options.attachments().readImage(block.attachment, signal);
          content.push({
            ...block,
            attachment: {
              ...block.attachment,
              dataUrl: `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
            },
          });
        } else if (block.type === 'file' && !block.attachment?.path) {
          const target = this.options.attachments().fileHostPath(block.attachment);
          if (!target) throw new Error('Attachment provider cannot expose a file to CIBYP');
          content.push({
            ...block,
            attachment: { ...block.attachment, path: target, name: block.attachment.fileName },
          });
        } else content.push(block);
      }
      prepared.push({ ...message, content });
    }
    const messages = toHostMessages(prepared);
    if (request.system) messages.unshift({ role: 'system', content: request.system });
    const queue = [],
      blocks = new Map();
    let wake,
      finished = false,
      failure,
      response;
    const put = (value) => {
      queue.push(value);
      wake?.();
      wake = undefined;
    };
    const delta = (type, text) => {
      if (!text) return;
      let record = blocks.get(type);
      if (!record) {
        record = { index: blocks.size, text: '' };
        blocks.set(type, record);
        put({ type: 'block-start', index: record.index, blockType: type });
      }
      record.text += text;
      put({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: record.index, text });
    };
    const unsub =
      this.options.subscribe?.('llm:stream-chunk', (chunk) => {
        if (chunk.requestId !== requestId) return;
        delta('reasoning', chunk.reasoning);
        delta('text', chunk.content);
      }) || (() => {});
    const abort = () => {
      this.options.cancelRequest?.({ requestId });
      wake?.();
      wake = undefined;
    };
    signal?.addEventListener('abort', abort, { once: true });
    const pending = Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return this.options.invoke('llm:chatStream', messages, { ...opts, signal });
      })
      .then((result) => {
        signal?.throwIfAborted();
        if (!result?.ok)
          throw Object.assign(new Error(result?.error || 'CIBYP model request failed'), {
            code: result?.kind || 'LLM_ERROR',
          });
        response = result.data || {};
        const message = response.choices?.[0]?.message || response;
        // Backends without a chunk subscription still produce a complete canonical stream.
        if (!blocks.has('reasoning'))
          delta('reasoning', message.reasoning_content || message.reasoning);
        if (!blocks.has('text')) delta('text', message.content || result.content);
        for (const [type, block] of blocks)
          put({ type: 'block-end', index: block.index, block: { type, text: block.text } });
        let index = blocks.size;
        for (const tool of message.tool_calls || []) {
          const block = {
            type: 'tool-call',
            id: tool.id,
            name: tool.function.name,
            arguments: tool.function.arguments,
          };
          put({ type: 'block-start', index, blockType: 'tool-call' });
          put({
            type: 'tool-call-delta',
            index,
            id: block.id,
            name: block.name,
            argumentsDelta: block.arguments,
          });
          put({ type: 'block-end', index: index++, block });
        }
        if (response.usage) put({ type: 'usage', usage: usage(response.usage) });
        const finish = response.choices?.[0]?.finish_reason;
        put({
          type: 'finish',
          reason: {
            kind: message.tool_calls?.length
              ? 'tool-calls'
              : finish === 'length'
                ? 'max-tokens'
                : 'stop',
          },
        });
      })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        finished = true;
        wake?.();
      });
    try {
      while (!finished || queue.length) {
        signal?.throwIfAborted();
        if (queue.length) yield queue.shift();
        else
          await new Promise((resolve) => {
            wake = resolve;
          });
      }
      if (failure) throw failure;
    } finally {
      unsub();
      signal?.removeEventListener('abort', abort);
      if (!finished) abort();
      void pending;
    }
  }
}
class CibypLlmService extends LlmRuntime {
  constructor(ctx, options = {}) {
    super(ctx);
    this.options = options;
    this.adapter = new CibypLlmAdapter({
      ...options,
      attachments: () => ctx.root.get('attachments'),
    });
    this.routeRegistration = this.registerAdapter(['cibyp'], this.adapter);
  }
  async refreshRoutes() {
    const settings = (await this.options.getSettings?.()) || {};
    const routes = new Set([
      'cibyp',
      settings.llm?.provider,
      ...(settings.llm?.pool || []).filter((e) => e.enabled !== false).map((e) => e.provider),
    ]);
    this.routeRegistration.replace([...routes].filter(Boolean));
  }
  async *stream(options) {
    await this.refreshRoutes();
    const settings = (await this.options.getSettings?.()) || {};
    yield* super.stream({
      ...options,
      model: options.model || settings.llm?.model,
      provider: options.provider || 'cibyp',
      signal: options.signal || currentExecution().signal,
    });
  }
  // Legacy plugins used chat(), while current SDK consumers use stream().
  async chat(request = {}, signal) {
    const content = [];
    let tokens, finish;
    for await (const chunk of this.stream({ ...request, signal: signal || request.signal })) {
      if (chunk.type === 'block-end') content.push(chunk.block);
      else if (chunk.type === 'usage') tokens = chunk.usage;
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
    if (finish?.kind === 'error' || finish?.kind === 'aborted')
      throw Object.assign(new Error(finish.failure?.message || finish.kind), { code: finish.kind });
    return {
      content: content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      reasoning: content
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text)
        .join(''),
      blocks: content,
      usage: tokens,
      model: request.model,
    };
  }
}
module.exports = { CibypLlmService, CibypLlmAdapter, toHostMessages, usage };
