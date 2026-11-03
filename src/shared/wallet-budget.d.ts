export type WalletPeriodSnapshot = {
  identity: { kind: string; id: string };
  seconds: number;
  originMs: number;
  startMs: number;
  endMs: number;
  clockRollback: boolean;
  limits: Record<string, unknown>;
  usage: Record<string, unknown>;
};
export type WalletBudgetSnapshot = {
  period?: WalletPeriodSnapshot | null;
  revoked: boolean;
  expiresAt: number;
  limits: Record<string, unknown>;
  usage: Record<string, unknown>;
};
export type WalletBudgetRow = {
  period?: boolean;
  label: string;
  used: string;
  limit: string;
  asset: string;
  contract?: string;
  breakdown?: boolean;
  usedText: string;
  limitText: string | null;
};
export function walletBudget(snapshot: WalletBudgetSnapshot | null): WalletBudgetRow[];
export function walletScopeValues(limits: Record<string, unknown>): Record<string, unknown>;
