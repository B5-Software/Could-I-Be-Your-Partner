/* SPDX-License-Identifier: GPL-3.0-or-later */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface QuantOrder {
  id: string;
  side: string;
  type: string;
  quantity: string;
  limitPrice?: string;
  fillPrice?: string;
  fee?: string;
  status: string;
  createdAt: number;
}
export interface QuantMetrics {
  finalEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  fees: string;
  fills: number;
  bars: number;
  cash: string;
  position: string;
}
export interface QuantRun {
  id: string;
  createdAt: number;
  datasetId: string;
  config: Record<string, string | number | null | number[] | QuantAmmScenarioLeg[]>;
  metrics: QuantMetrics;
  equity?: { time: number; value: number }[];
  assumptions?: string[];
  dataSource?: string;
  dataSeries?: QuantBaseSeries;
  codeVersion?: string;
  walkForward?: {
    candidateCount: number;
    discardedPrefixBars: number;
    windows: {
      index: number;
      training: { start: number; end: number; bars: number };
      testing: { start: number; end: number; bars: number };
      selected: { fast: number; slow: number };
      metrics: QuantMetrics;
      trainingScores: {
        fast: number;
        slow: number;
        returnPct: number;
        maxDrawdownPct: number;
        fills: number;
      }[];
    }[];
  };
  ammScenario?: {
    anchor: { block: number; blockHash: string; time: number };
    status: 'completed' | 'stopped-on-revert';
    totalSwapGas: string;
    legs: {
      index: number;
      side: 'buy' | 'sell';
      status: 'reverted' | 'filled' | 'partial-input';
      spentAtoms?: string;
      amountOutAtoms?: string;
      deltaOutAtoms?: string;
      baselineOutAtoms?: string;
      sqrtBeforeX96: string;
      sqrtAfterX96: string;
      gasUsed: string;
    }[];
  };
  ammReplay?: {
    eventCount: number;
    canceledSignals: number;
    pendingAtEnd: 'buy' | 'sell' | null;
    attempts: {
      side: 'buy' | 'sell';
      signal: { block: number; logIndex: number };
      execution: { block: number; blockHash: string };
      amountInAtoms: string;
      amountOutAtoms: string;
      initializedTicksCrossed: number;
      quoteGasEstimate: string;
      status: 'adverse-price' | 'network-cost-limit' | 'filled';
      networkFee?: {
        l2Wei: string;
        l1Wei: string;
        operatorWei: string;
        usdcAtoms: string;
        totalWei: string;
      };
    }[];
    networkFees?: { mode: 'fixed' | 'historical'; usdcAtoms: string; totalWei?: string };
  };
}
export interface QuantAmmScenarioLeg {
  side: 'buy' | 'sell';
  amountIn: string;
  minimumOut?: string;
}
export interface QuantDataset {
  id: string;
  label: string;
  source: string;
  count: number;
  start: number;
  end: number;
  amm?: { chainId: number; fee: number; interval: number; swapCount: number };
  series?: {
    interval: number;
    segmentCount: number;
    slots: number;
    gaps: number;
    requestedStart: number;
  };
}

export interface QuantBaseSeries {
  chainId: number;
  pool: string;
  fee: number;
  interval: number;
  requestedStart: number;
  startTime: number;
  endTime: number;
  slots: number;
  gaps: number;
  emptyRanges: { startTime: number; endTime: number }[];
  segments: { id: string; startTime: number; endTime: number }[];
}

export interface QuantBaseTrade {
  block: number;
  logIndex: number;
  time: number;
  transactionHash: string;
  wethDeltaAtoms: string;
  usdcDeltaAtoms: string;
  side: 'buy' | 'sell' | null;
}
export interface QuantBaseRecorder {
  phase: 'idle' | 'waiting' | 'capturing' | 'retrying' | 'paused';
  canResume?: boolean;
  datasetId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  nextAt?: number | null;
  batches?: number;
  count?: number;
  lastError?: string | null;
  pauseReason?: 'manual' | 'market-changed' | 'review' | null;
}
export interface QuantSummary {
  id: string;
  name: string;
  venue: string;
  product: string;
  paperStatus: string;
  updatedAt: number;
}
export interface QuantWorkspace extends QuantSummary {
  network?: {
    id: number;
    name: string;
    explorer: string;
    historyWindow: { maxCount: number; defaultCount: number };
    recorder: QuantBaseRecorder;
  };
  nativePaper?: { accountId: string; pendingOrder?: { orderId: string } };
  researchCount?: number;
  research?: {
    evidenceId: string;
    kind: 'search' | 'article';
    title: string;
    url: string | null;
    retrievedAt: string;
    publishedAtReported: string | null;
    completeDocument: boolean;
    sourceOffset: number;
  }[];
  market: {
    venue: string;
    product: string;
    interval: number;
    pool?: string;
    poolFee?: number;
    customRpc?: boolean;
  };
  preferences: {
    layout: 'professional' | 'immersive';
    chatWidth: number;
    datasetId: string | null;
  };
  risk: {
    maxOrder: string;
    maxExposure: string;
    maxPosition: string;
    feeBps: number;
    slippageBps: number;
  };
  quote: {
    price: string;
    time: number;
    observedAt: number;
    quality: string;
    block?: string;
    pool?: string;
    book?: {
      bids: { price: string; quantity: string }[];
      asks: { price: string; quantity: string }[];
    };
  } | null;
  candles: Candle[];
  datasets: QuantDataset[];
  runs: QuantRun[];
  orders: QuantOrder[];
  paper: {
    status: string;
    cash: string;
    position: string;
    equity: string;
    availableCash: string;
    availablePosition: string;
    reservedCash: string;
    fees: string;
  };
  audit: { id: string; time: number; type: string; reason?: string }[];
  lastError?: { code: string; time: number };
}
export interface NativePaperAccount {
  halt?: { id: string; at_ns: string } | null;
  id: string;
  name: string;
  active: boolean;
  openOrders: number;
  assets: Record<string, { total: string; reserved: string; available: string }>;
  risk: {
    max_open_orders: number;
    max_order_notional: Record<string, string>;
    max_asset_position: Record<string, string>;
  };
}
export interface NativePaperOrder {
  request: {
    id: string;
    account: string;
    strategy: string;
    instrument: string;
    side: string;
    price: string;
    quantity: string;
  };
  status: string;
  filled: string;
  notional: string;
  fees: string;
  reserved: string;
  reserved_asset: string;
  created_at_ns: string;
  updated_at_ns: string;
  execution: { attached: boolean; held: boolean; [key: string]: unknown };
}
export interface NativePaperExecution {
  fees: string;
  notional: string;
  fill: {
    id: string;
    order: string;
    price: string;
    quantity: string;
    source?: { event_id: string; venue: string; provider_time_ns?: string; time_ns: string };
  };
  account: string;
  strategy: string;
  instrument: string;
  side: string;
  recorded_at_ns: string;
}
export interface NativePaperStatus {
  connected: boolean;
  engineState?: string;
  accountId: string | null;
  account: NativePaperAccount | null;
  sources: QuantNativeSource[];
  pendingOrder?: { orderId: string } | null;
  accountsPage?: {
    items: { id: string; name: string }[];
    next: number | null;
    total: number;
  } | null;
  historyPage?: {
    items: (NativePaperOrder | NativePaperExecution)[];
    next: number | null;
    total: number;
  } | null;
}
export interface QuantChatView {
  session: { key: string; busy: boolean; model: string; lastError?: string };
  displayMessages: {
    id?: string;
    role: string;
    name?: string;
    content: unknown;
    reasoning?: string;
    reasoningSummary?: string;
  }[];
  messages?: { metadata?: { messageId?: string; kind?: string } }[];
}
export interface QuantNativeStatus {
  available: boolean;
  state: 'stopped' | 'starting' | 'connected' | 'stopping' | 'failed';
  mode: 'paper';
  liveExecution: false;
  development?: boolean;
  reason?: string;
  lastError?: string | null;
  version?: string;
  summary?: {
    enabled: boolean;
    faulted: boolean;
    accounts: number;
    instruments: number;
    orders: number;
    openOrders: number;
  };
}
export interface QuantNativeSource {
  product: string;
  instrument?: string;
  phase:
    | 'stopped'
    | 'resolving'
    | 'connecting'
    | 'snapshot'
    | 'ready'
    | 'delayed'
    | 'reconnecting'
    | 'blocked'
    | 'failed';
  desired: boolean;
  lastError?: string | null;
  sourceLagMs?: number | null;
  coverage?: { bids: number; asks: number; bidFloor: string; askCeiling: string } | null;
  clock?: { estimatedOffsetMs: number; uncertaintyMs: number; calibratedAt: number } | null;
  assumptions?: {
    feeBps: number;
    feeKind: string;
    tick: string;
    lot: string;
    minNotional: string;
    quoteCurrency: string;
  };
}
export interface QuantNativeBook {
  valid: boolean;
  eligible: boolean;
  bids: [string, string][];
  asks: [string, string][];
  source: QuantNativeSource;
  assumptions: NonNullable<QuantNativeSource['assumptions']>;
}
