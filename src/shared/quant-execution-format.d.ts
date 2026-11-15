import type {
  ExecutionArrival,
  ExecutionArrivalComparison,
  ExecutionBenchmark,
  ExecutionSettlement,
} from './quant-execution-types';
import type labels from './quant-execution-labels.json';
export function executionAmount(value: string, decimals: number): string;
export function signedAmount(value: string, decimals: number): string;
export function executionPercent(value: string, total: string): number;
export function executionSettlementRows(
  side: 'buy' | 'sell',
  settlement: ExecutionSettlement | undefined,
  label: (key: keyof typeof labels.zh) => string,
): [string, string][];
export function executionBenchmarkRows(
  benchmark: ExecutionBenchmark,
  label: (key: keyof typeof labels.zh) => string,
  locale?: string,
): [string, string][];
export function executionArrivalRows(
  arrival: ExecutionArrival | undefined,
  comparison: ExecutionArrivalComparison | undefined,
  label: (key: keyof typeof labels.zh) => string,
  locale?: string,
): [string, string][];
