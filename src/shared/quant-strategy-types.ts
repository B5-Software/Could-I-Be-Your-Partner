export interface NativeStrategyDefinition {
  id: string;
  owner: string;
  name: string;
  revision: number;
  account: string;
  instrument: string;
  maker: {
    quantity: string;
    sides: 'both' | 'buy' | 'sell';
    bid_offset_ticks: number;
    ask_offset_ticks: number;
    reprice_ticks: number;
    refresh_ms: number;
    ttl_ms: number;
    min_inventory: string;
    max_inventory: string;
    max_notional: string;
    max_fees: string;
    max_decisions: number;
  };
}
export interface NativeStrategyVersion {
  definition: NativeStrategyDefinition;
  hash: string;
}
export interface NativeStrategyRun {
  run: {
    id: string;
    strategy: string;
    revision: number;
    mode: 'paper' | 'shadow';
    decisions: number;
    created_at_ns: string;
  };
  phase: 'running' | 'paused' | 'stopped' | 'completed';
  reason: string;
  account: string;
  instrument: string;
  stats: {
    gross_filled: string;
    fees: string;
    open_notional: string;
    pending_fees: string;
    orders: number;
  };
}
export interface NativeStrategyDecision {
  ordinal: number;
  at_ns: string;
  observation: Record<string, unknown>;
  intents: { id: string; side: 'buy' | 'sell'; quantity: string; price: string }[];
  outcomes: { order_id: string; status: string; error: string | null }[];
}
