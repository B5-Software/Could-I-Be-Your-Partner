/* SPDX-License-Identifier: GPL-3.0-or-later */
export type ExecutionPlan = {
  agent_scope?: { id: string; subject: string };
  template: string;
  id: string;
  owner: string;
  wallet: string;
  chain_id: number;
  side: 'buy' | 'sell';
  total_input_atoms: string;
  slices: number;
  interval_ms: number;
  slippage_bps: number;
  pool_fee: number;
  config_hash: string;
  max_fee_reserve_wei: string | null;
};
export type ExecutionRun = {
  plan: ExecutionPlan;
  phase: 'running' | 'paused' | 'stopped' | 'completed';
  reason: string;
  generation: number;
  completed_slices: number;
  allocated_input_atoms: string;
  commands_created: number;
  pending: string | null;
  policy_id: string | null;
  updated_at_ns: string;
};
export type ExecutionCommand = {
  id: string;
  run: string;
  ordinal: number;
  generation: number;
  input_atoms: string;
  stage: string;
  lease: string | null;
  intent_ids: string[];
  hashes: string[];
  reason: string;
  created_at_ns: string;
  updated_at_ns: string;
};
export type ExecutionPage<T> = { items: T[]; total: number; next: number | null };
export type ExecutionView = {
  run: ExecutionRun;
  feeUsage: { reservedEstimateWei: string; budgetWei: string | null; chainEnforced: false };
  lastError: string | null;
};
export type ExecutionWallet = {
  id: string;
  name: string;
  address: string;
  unlocked: boolean;
  policy: { mode: string; chains: number[]; expiresAt?: number | null };
};
export { executionAmount, executionPercent } from './quant-execution-format';
