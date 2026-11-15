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
  min_total_output_atoms?: string;
  max_arrival_cost_bps?: number;
  slices: number;
  interval_ms: number;
  slippage_bps: number;
  pool_fee: number;
  config_hash: string;
  max_fee_reserve_wei: string | null;
  vwap?: { profile_id: string; weth_volume_atoms: string[] };
};
export type ExecutionVwapProfile = {
  id: string;
  pool: string;
  slices: number;
  intervalMs: number;
  periods: number;
  startTime: number;
  endTime: number;
  finalizedBlock: number;
  finalizedBlockHash: string;
  swapCount: number;
  wethVolumeAtoms: string[];
};
export type ExecutionRun = {
  plan: ExecutionPlan;
  phase: 'running' | 'paused' | 'stopped' | 'completed' | 'expired';
  reason: string;
  generation: number;
  completed_slices: number;
  allocated_input_atoms: string;
  commands_created: number;
  pending: string | null;
  policy_id: string | null;
  updated_at_ns: string;
  arrival?: ExecutionArrival;
  fixed?: {
    start_at_ns: string;
    end_at_ns: string;
    next_slot: number;
    skipped_slices: number;
    skipped_input_atoms: string;
    observed_at_ns: string;
  };
};
export type ExecutionArrival = {
  pool: string;
  block: string;
  block_hash: string;
  block_time: number;
  sqrt_price_x96: string;
  weth_is_token0: boolean;
};
export type ExecutionArrivalComparison = {
  referencePriceAtoms: string;
  costUsdcAtoms: string | null;
  costBpsHundredths: string | null;
};
export type ExecutionCommand = {
  id: string;
  run: string;
  ordinal: number;
  generation: number;
  input_atoms: string;
  min_output_atoms?: string;
  min_arrival_output_atoms?: string;
  window?: { opens_at_ns: string; closes_at_ns: string };
  stage: string;
  lease: string | null;
  intent_ids: string[];
  hashes: string[];
  reason: string;
  created_at_ns: string;
  updated_at_ns: string;
  settlement?: ExecutionSettlement;
};
export type ExecutionSettlement = {
  receiptsMissing: number;
  fill: { inputAtoms: string; outputAtoms: string; observed: number; finalized: number };
  fees: {
    l2GasWei: string | null;
    l1DataFeeWei: string | null;
    operatorFeeWei: string | null;
    totalWei: string | null;
    l2Receipts: number;
    l1Receipts: number;
    operatorReceipts: number;
    finalizedTransactions: number;
  };
};
export type ExecutionPage<T> = { items: T[]; total: number; next: number | null };
export type ExecutionBenchmark = {
  pool: string;
  chainId: number;
  fee: number;
  firstBlock: number;
  firstBlockHash: string;
  firstTime: number;
  lastBlock: number;
  lastBlockHash: string;
  lastTime: number;
  finalizedBlock: number;
  finalizedBlockHash: string;
  swapCount: number;
  excludedTransactions: number;
  marketWethAtoms: string;
  marketUsdcAtoms: string;
  actualWethAtoms: string;
  actualUsdcAtoms: string;
  costBpsHundredths: string;
};
export type ExecutionView = {
  run: ExecutionRun;
  benchmarkReady?: boolean;
  benchmark?: ExecutionBenchmark;
  profile?: ExecutionVwapProfile;
  settlement?: ExecutionSettlement;
  arrivalComparison?: ExecutionArrivalComparison;
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
export {
  executionAmount,
  executionPercent,
  executionSettlementRows,
  executionBenchmarkRows,
  executionArrivalRows,
} from './quant-execution-format';
