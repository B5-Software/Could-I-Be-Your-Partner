/* SPDX-License-Identifier: GPL-3.0-or-later */
// Local DSH provider fixture: no credentials, network, private plugin or second Agent loop.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'cibyp-model-provider-fixture';
export const inject = ['llm'];
class FixtureAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
    this.billingMode = 'subscription';
  }
  providerInfo(id) {
    return { id, name: 'DSH Fixture' };
  }
  async listModels(provider) {
    return [{ provider, id: 'fixture-model', name: 'Fixture Model' }];
  }
  async resolveModel(provider, id) {
    return {
      provider,
      id,
      name: 'Fixture Model',
      context: { contextWindow: 32768 },
      defaultMaxTokens: 8192,
      inputModalities: ['text', 'image'],
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'auto', name: 'Auto' },
        ],
        defaultEffort: 'off',
      },
    };
  }
  async usage() {
    return { subscription: true, windows: [{ period: '5hour', usedPercent: 40 }] };
  }
  async *stream(request) {
    this.config.onRequest?.(request);
    if (this.config.waitForAbort) {
      await new Promise((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', resolve, { once: true });
      });
      request.signal.throwIfAborted();
    }
    const blocks = [
      { type: 'reasoning', text: 'Readable reasoning' },
      { type: 'text', text: this.config.reply || 'Hello from the plugin' },
      ...(this.config.emitTool && request.tools?.length
        ? [
            {
              type: 'tool-call',
              id: 'call-fixture',
              name: request.tools[0].name,
              arguments: '{"path":"sample.txt"}',
            },
          ]
        : []),
    ];
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type };
      if (block.type === 'tool-call')
        yield {
          type: 'tool-call-delta',
          index,
          id: block.id,
          name: block.name,
          argumentsDelta: block.arguments,
        };
      else
        yield {
          type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta',
          index,
          text: block.text,
        };
      yield { type: 'block-end', index, block };
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 20, cacheReadTokens: 10, outputTokens: 8, totalTokens: 38 },
    };
    yield {
      type: 'finish',
      reason: { kind: blocks.some((b) => b.type === 'tool-call') ? 'tool-calls' : 'stop' },
      replayState: {
        response: { model: request.model },
        blocks: blocks.map(() => ({ signature: 'opaque-fixture' })),
      },
    };
  }
}
export function apply(ctx, config = {}) {
  const registration = ctx.llm.registerAdapter(['fixture'], new FixtureAdapter(config));
  ctx.effect(() => registration);
}
