/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { z } = require('zod');
function setupProjections(ctx) {
  ctx.sessionProjections.register({
    key: 'turnBoundary',
    stateVersion: 2,
    stateSchema: z.object({
      openTurnStartSeq: z.number().int().nonnegative().nullable(),
      lastStepStartSeq: z.number().int().nonnegative().nullable(),
      lastStepBoundary: z
        .object({ kind: z.enum(['start', 'end']), seq: z.number().int().nonnegative() })
        .nullable(),
      lastTurn: z.number().int().nonnegative(),
    }),
    init: () => ({
      openTurnStartSeq: null,
      lastStepStartSeq: null,
      lastStepBoundary: null,
      lastTurn: 0,
    }),
    apply: (state, event) => {
      if (event.type === 'turn/start')
        return { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn };
      if (event.type === 'turn/end') return { ...state, openTurnStartSeq: null };
      if (event.type === 'step/start')
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: { kind: 'start', seq: event.seq },
        };
      if (event.type === 'step/end')
        return { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } };
      return state;
    },
  });
  ctx.sessionProjections.register({
    key: 'inbox',
    stateVersion: 1,
    stateSchema: z.object({ 'next-turn': z.array(z.any()), 'next-step': z.array(z.any()) }),
    init: () => ({ 'next-turn': [], 'next-step': [] }),
    apply: (state, event) => {
      if (event.type !== 'agent/inbox/spliced') return state;
      const op = event.data,
        queue = [...state[op.target]];
      if (
        !Number.isSafeInteger(op.start) ||
        op.start < 0 ||
        op.start > queue.length ||
        !Number.isSafeInteger(op.removedCount || 0) ||
        op.removedCount < 0 ||
        (op.removedCount || 0) > queue.length - op.start
      )
        throw new Error('Invalid durable inbox splice');
      queue.splice(op.start, op.removedCount || 0, ...op.inserted);
      return { ...state, [op.target]: queue };
    },
  });
}
module.exports = { setupProjections };
