import type {
  ExecutionArrival,
  ExecutionArrivalComparison,
  ExecutionBenchmark,
  ExecutionEntryTrigger,
  ExecutionProtectiveExit,
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
export function executionEntryCondition(trigger: ExecutionEntryTrigger): string;
export function executionExitConditions(
  exit: ExecutionProtectiveExit,
  label: (key: keyof typeof labels.zh) => string,
): [string, string][];
export function executionEntryRows(
  observation: ExecutionArrival,
  label: (key: keyof typeof labels.zh) => string,
  locale?: string,
): [string, string][];
