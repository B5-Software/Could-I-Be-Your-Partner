export type WalletEmergency = {
  halted: boolean;
  generation: string;
  latchId: string | null;
  stoppedAt: number | null;
  storageError: string | null;
  nativePausePending: boolean;
  nativePauseError: string | null;
  needsReconciliation: number;
};
