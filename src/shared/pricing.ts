/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */

export interface TokenUsage {
  prompt?: number;
  completion?: number;
  cached?: number;
  cacheCreation?: number;
}
export interface ModelPricing {
  inputPerM?: number | string;
  outputPerM?: number | string;
  cacheReadPerM?: number | string;
  cacheWritePerM?: number | string;
  promptPerK?: number | string;
  completionPerK?: number | string;
  hasCacheWrite?: boolean;
}
export interface PeakHours {
  enabled?: boolean;
  start?: number | string;
  end?: number | string;
  inputMul?: number | string;
  outputMul?: number | string;
  cacheReadMul?: number | string;
  cacheWriteMul?: number | string;
}

function finite(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function calculateTokenCost(
  usage: TokenUsage,
  pricing: ModelPricing,
  peak: PeakHours = {},
  timestamp: number | string | Date = Date.now(),
  timezone?: string,
) {
  const date = new Date(timestamp);
  let hour = date.getHours();
  if (timezone) {
    try {
      const formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(date);
      hour = Number(formatted);
    } catch {
      /* Invalid user timezone falls back to the local timezone. */
    }
  }
  const start = Math.min(24, finite(peak.start));
  const end = Math.min(24, finite(peak.end, 24));
  const isPeak =
    !!peak.enabled && (start <= end ? hour >= start && hour < end : hour >= start || hour < end);
  const multiplier = (value: unknown) => (isPeak ? finite(value, 1) : 1);
  const inputPerM = finite(pricing.inputPerM, finite(pricing.promptPerK) * 1000);
  const outputPerM = finite(pricing.outputPerM, finite(pricing.completionPerK) * 1000);
  const cached = finite(usage.cached);
  const created = finite(usage.cacheCreation);
  const inputCost =
    (Math.max(0, finite(usage.prompt) - cached - created) / 1e6) *
    inputPerM *
    multiplier(peak.inputMul);
  const cacheReadCost =
    (cached / 1e6) * finite(pricing.cacheReadPerM, inputPerM * 0.1) * multiplier(peak.cacheReadMul);
  const outputCost = (finite(usage.completion) / 1e6) * outputPerM * multiplier(peak.outputMul);
  const cacheWriteCost = pricing.hasCacheWrite
    ? (created / 1e6) *
      finite(pricing.cacheWritePerM, inputPerM * 1.25) *
      multiplier(peak.cacheWriteMul)
    : 0;
  return {
    inputCost,
    cacheReadCost,
    outputCost,
    cacheWriteCost,
    totalCost: inputCost + cacheReadCost + outputCost + cacheWriteCost,
    isPeak,
  };
}
