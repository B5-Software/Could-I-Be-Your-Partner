/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReasoningData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const text = (value) => (typeof value === 'string' ? value : '');
  const join = (values) => values.filter(Boolean).join('\n\n');
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function readable(full, summary) {
    return {
      reasoning: join([full, summary && summary !== full ? summary : '']),
      reasoningKind: full ? (summary && summary !== full ? 'mixed' : 'full') : 'summary',
    };
  }
  function responses(items) {
    const blocks = (items || []).filter((item) => item?.type === 'reasoning');
    const summary = join(
      blocks.map((item) =>
        join(
          (Array.isArray(item.summary) ? item.summary : [])
            .filter((b) => b && (!b.type || b.type === 'summary_text'))
            .map((b) => text(b.text)),
        ),
      ),
    );
    const full = join(
      blocks.map(
        (item) =>
          join(
            (item.content || [])
              .filter((b) => b?.type === 'reasoning_text')
              .map((b) => text(b.text)),
          ) || text(item.text),
      ),
    );
    return {
      ...readable(full, summary),
      ...(blocks.length
        ? { providerReasoning: { transport: 'responses', items: clone(blocks) } }
        : {}),
    };
  }
  function anthropic(items, model) {
    const blocks = (items || []).filter(
      (item) => item && ['thinking', 'redacted_thinking'].includes(item.type),
    );
    // .thinking is the provider's readable text (possibly summarized). The
    // signature and redacted .data are opaque protocol state, never UI text.
    return {
      reasoning: join(blocks.filter((b) => b.type === 'thinking').map((b) => text(b.thinking))),
      reasoningKind: /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:[4-9]|preview)/i.test(
        model || '',
      )
        ? 'summary'
        : 'provider',
      ...(blocks.length
        ? { providerReasoning: { transport: 'anthropic', items: clone(blocks) } }
        : {}),
    };
  }
  function openai(message) {
    const details = Array.isArray(message?.reasoning_details) ? message.reasoning_details : [];
    const full =
      text(message?.reasoning_content) ||
      text(message?.reasoning) ||
      join(details.filter((b) => b?.type === 'reasoning.text').map((b) => text(b.text)));
    const summary =
      text(message?.reasoning_summary) ||
      join(details.filter((b) => b?.type === 'reasoning.summary').map((b) => text(b.summary)));
    return {
      ...readable(full, summary),
      ...(details.length
        ? { providerReasoning: { transport: 'openai', items: clone(details) } }
        : {}),
    };
  }
  function presentation(message) {
    return {
      reasoning:
        text(message?.reasoning) ||
        text(message?.reasoning_content) ||
        text(message?.reasoning_summary),
      reasoningKind: message?.reasoningKind || 'provider',
    };
  }
  function label(kind, translate) {
    const summary = kind === 'summary';
    return translate
      ? translate(
          summary ? 'ui.reasoning.summary' : 'ui.reasoning.text',
          summary ? '推理摘要' : '推理内容',
        )
      : summary
        ? 'Reasoning summary'
        : 'Reasoning';
  }
  // Only the persisted/exported copy is stripped. The live protocol context
  // must retain signatures through a tool round even when retention is off.
  function retention(value, enabled) {
    if (Array.isArray(value)) return value.map((item) => retention(item, enabled));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (
        !enabled &&
        ['providerReasoning', 'reasoning_details', 'encrypted_content', 'signature'].includes(key)
      )
        continue;
      if (!enabled && value.type === 'redacted_thinking' && key === 'data') continue;
      out[key] = retention(item, enabled);
    }
    return out;
  }
  function markdown(message) {
    const display = presentation(message);
    const lines = display.reasoning
      ? ['### ' + label(display.reasoningKind), '', display.reasoning, '']
      : [];
    if (message?.providerReasoning) {
      const payload = JSON.stringify(message.providerReasoning, null, 2);
      const fences = (payload.match(/`+/g) || []).reduce((n, v) => Math.max(n, v.length + 1), 3);
      const fence = '`'.repeat(fences);
      lines.push(
        '<details><summary>Encrypted reasoning / opaque provider state</summary>',
        '',
        fence + 'json',
        payload,
        fence,
        '',
        '</details>',
        '',
      );
    }
    return lines.join('\n');
  }
  return { responses, anthropic, openai, presentation, label, retention, markdown };
});
