/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { registerExternalRequest, augmentSSEResponse } = require('../llm-retry');
const { providerFailure } = require('./provider-failure');
let loaded;

async function loadSdk() {
  return (loaded ||= Promise.all([
    import('@opencode/ai'),
    import('@opencode/ai/promise'),
    import('@opencode/ai/providers/openai-compatible'),
    import('@opencode/ai/providers/anthropic'),
    import('@opencode/ai/providers/openai'),
  ])
    .then(([api, promise, chat, anthropic, openai]) => ({
      api,
      client: promise.make(),
      chat,
      anthropic,
      openai,
    }))
    .catch((error) => {
      loaded = null;
      throw error;
    }));
}

function prepareInput(req, sdk) {
  const body = req.body;
  const { protocol } = req.opencodeSdk;
  const baseURL = req.url.replace(/\/(chat\/completions|responses|messages)\/?$/, '');
  const provider =
    protocol === 'anthropic' ? sdk.anthropic : protocol === 'responses' ? sdk.openai : sdk.chat;
  const model = provider
    .configure({ baseURL, auth: sdk.api.Auth.none, headers: req.headers })
    .model(body.model);
  const names = new Map();
  for (const message of body.messages || [])
    for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  const messages = (body.messages || []).map((message) => {
    if (message.role === 'tool') {
      const name = message.name || names.get(message.tool_call_id);
      if (!name) throw new Error('OpenCode SDK cannot pair a tool result: ' + message.tool_call_id);
      return sdk.api.Message.tool({
        id: message.tool_call_id,
        name,
        result: { type: 'text', value: message.content || '' },
      });
    }
    const content = [];
    for (const part of typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content || []) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'image_url') {
        const url = part.image_url?.url || '';
        const inline = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
        if (!inline && !/^https?:\/\//i.test(url))
          throw new Error('Unsupported OpenCode SDK image attachment');
        content.push({
          type: 'media',
          media: new sdk.api.Media.Asset({
            source: inline
              ? { type: 'base64', mediaType: inline[1], data: inline[2] }
              : { type: 'url', url, mediaType: 'image/png' },
          }),
        });
      } else throw new Error('Unsupported OpenCode SDK message part: ' + part.type);
    }
    if (message.role === 'assistant') {
      const reasoning = message.reasoning || message.reasoning_content;
      const opaque =
        message.providerReasoning?.items?.filter(
          (item) => item.format === 'opencode-ai' && item.data?.providerMetadata,
        ) || [];
      for (const item of opaque)
        content.unshift({
          type: 'reasoning',
          text: item.data.text || '',
          providerMetadata: item.data.providerMetadata,
        });
      if (!opaque.length && typeof reasoning === 'string' && reasoning)
        content.unshift({ type: 'reasoning', text: reasoning });
      for (const call of message.tool_calls || [])
        content.push({
          type: 'tool-call',
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}'),
        });
    }
    return { role: message.role === 'developer' ? 'system' : message.role, content };
  });
  const native = { ...req.opencodeSdk.body };
  for (const key of [
    'model',
    'messages',
    'system',
    'input',
    'tools',
    'tool_choice',
    'stream',
    'stream_options',
    'max_tokens',
    'max_output_tokens',
    'temperature',
  ])
    delete native[key];
  return {
    model,
    messages,
    tools: (body.tool_choice === 'none' ? [] : body.tools || []).map((tool) => {
      const definition = tool.function || tool;
      return {
        name: definition.name,
        description: definition.description || definition.name,
        inputSchema: definition.parameters || { type: 'object', properties: {} },
      };
    }),
    ...(body.tool_choice
      ? {
          toolChoice:
            typeof body.tool_choice === 'string'
              ? body.tool_choice
              : body.tool_choice.function?.name || body.tool_choice.name || 'auto',
        }
      : {}),
    generation: {
      maxTokens: body.max_tokens || 8192,
      ...(body.temperature != null ? { temperature: body.temperature } : {}),
    },
    http: { body: native },
  };
}

function sdkFailure(error) {
  const source =
    error?.http?.response?.body || error?.responseBody || error?.message || String(error);
  const failure = providerFailure(source, {
    status: error?.status || error?.http?.status,
    kind: error?.code === 'CIBYP_PRIVACY_UNAVAILABLE' ? 'privacy' : undefined,
  });
  if (error?.code) failure.code ||= error.code;
  return failure;
}

function sdkUsage(usage) {
  if (!usage) return undefined;
  const input = usage.inputTokens || 0,
    output = usage.outputTokens || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage.totalTokens ?? input + output,
    prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens || 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens || 0 },
  };
}

async function fetchOpenCode(req, options = {}) {
  const controller = new AbortController();
  const unregister = registerExternalRequest(controller, options);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error('OpenCode SDK request timed out')),
    options.timeoutMs || 300000,
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    unregister();
  };
  try {
    signal.throwIfAborted();
    const sdk = await loadSdk();
    const input = prepareInput(req, sdk);
    signal.throwIfAborted();
    const run = async (send) => {
      let index = 0,
        finished = false;
      const summaries =
        (req.opencodeSdk.body.reasoning?.summary &&
          req.opencodeSdk.body.reasoning.summary !== 'none') ||
        req.opencodeSdk.body.thinking?.display === 'summarized';
      let reasoningIndex = 0;
      for await (const event of sdk.client.llm.stream(input, { signal })) {
        signal.throwIfAborted();
        if (event.type === 'text-delta')
          send({ choices: [{ index: 0, delta: { content: event.text } }] });
        else if (event.type === 'reasoning-delta')
          send({
            choices: [
              {
                index: 0,
                delta: { [summaries ? 'reasoning_summary' : 'reasoning_content']: event.text },
              },
            ],
          });
        else if (event.type === 'reasoning-end' && event.providerMetadata)
          send({
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_details: [
                    {
                      type: 'reasoning.encrypted',
                      format: 'opencode-ai',
                      id: event.id,
                      index: reasoningIndex++,
                      data: { providerMetadata: event.providerMetadata, text: event.text || '' },
                    },
                  ],
                },
              },
            ],
          });
        else if (event.type === 'tool-call')
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: index++,
                      id: event.id,
                      type: 'function',
                      function: { name: event.name, arguments: JSON.stringify(event.input) },
                    },
                  ],
                },
              },
            ],
          });
        else if (event.type === 'step-finish') {
          const reason =
            event.reason?.normalized || event.finishReason?.normalized || event.finishReason;
          if (reason === 'error')
            throw new Error('OpenCode SDK provider returned an unsuccessful generation');
          finished = true;
          send({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason:
                  reason === 'tool-calls'
                    ? 'tool_calls'
                    : reason === 'content-filter'
                      ? 'content_filter'
                      : reason || 'stop',
              },
            ],
            usage: sdkUsage(event.usage),
          });
        }
      }
      if (!finished) throw new Error('OpenCode SDK stream ended without a completed generation');
    };
    const encoder = new TextEncoder();
    const response = augmentSSEResponse(
      new Response(
        new ReadableStream({
          start(stream) {
            const send = (value) =>
              stream.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n'));
            void run(send)
              .then(() => {
                stream.enqueue(encoder.encode('data: [DONE]\n\n'));
                stream.close();
              })
              .catch((error) => {
                try {
                  const failure = sdkFailure(error);
                  send({
                    type: 'error',
                    error: { message: failure.error, code: failure.code },
                    ...failure,
                  });
                  stream.close();
                } catch {
                  /* reader was canceled */
                }
              })
              .finally(release);
          },
          cancel() {
            controller.abort();
            release();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
      'openai',
    );
    return { ok: true, response, controller, releaseController: release };
  } catch (error) {
    release();
    return signal.aborted
      ? { ok: false, kind: 'aborted', error: 'OpenCode SDK request stopped', retryable: false }
      : sdkFailure(error);
  }
}

module.exports = { fetchOpenCode, prepareInput, sdkFailure, sdkUsage };
