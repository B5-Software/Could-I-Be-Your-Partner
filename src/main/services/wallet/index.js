/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { NativeSigner } = require('./native-signer');
const policyRules = require('./policy');
const { WalletAgentScopes, rootContext } = require('./agent-scopes');
const { captureCapital, checkCapital, requiresRecovery } = require('./capital');
const { assessEquity } = require('./portfolio-equity');
const { approval, assessCeiling } = require('./portfolio-allowance-ceiling');
const { WalletNetworks } = require('./networks');
const { randomUUID, createHash } = require('node:crypto');
const {
  Interface,
  Transaction,
  parseEther,
  parseUnits,
  formatEther,
  formatUnits,
  keccak256,
  getAddress,
  ZeroAddress,
} = require('ethers');
const { writeAtomic } = require('../quant');
const { MarketData, CHAINS, baseGasOracle, readOperatorFee } = require('../quant/market-data');
const executionReceipt = require('../quant/execution-receipt');
const { discoverTokens } = require('../quant/token-discovery');
const {
  PERMIT2,
  MAX_ORDERED_NONCE,
  permit2,
  usesPermit2,
  nonceValue,
  unorderedNonce,
  nonceMaintenance,
  describePermit2,
} = require('../quant/permit2');
const clone = (value) => structuredClone(value);
const fail = (code) => {
  throw new Error(code);
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const approvalDigest = (i) =>
  digest({
    version: 1,
    requestDigest: i.requestDigest,
    address: i.address,
    transaction: i.transaction,
    feeReserveWei: i.feeReserveWei,
    expiresAt: i.expiresAt,
    replacementOf: i.replacementOf || null,
    ...(i.agentScope ? { agentScope: i.agentScope } : {}),
    ...(i.capital ? { capital: i.capital } : {}),
    ...(i.networkRevision ? { networkRevision: i.networkRevision } : {}),
    ...(i.sourceApp ? { sourceApp: i.sourceApp } : {}),
  });
const unresolved = new Set([
  'approval-required',
  'approved',
  'signing',
  'signing-unknown',
  'submit-unknown',
  'submitted',
  'reorged',
]);
const oracle = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
const erc20 = new Interface([
  'function transfer(address,uint256) returns(bool)',
  'function approve(address,uint256) returns(bool)',
]);

async function baseFeeQuote(rpc, transaction, signal) {
  try {
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (
      typeof block?.hash !== 'string' ||
      !/^0x[\da-f]{64}$/i.test(block.hash) ||
      typeof block.timestamp !== 'string' ||
      !/^0x[\da-f]{1,16}$/i.test(block.timestamp)
    )
      fail('WALLET_FEE_QUOTE_UNAVAILABLE');
    const age = BigInt(Math.floor(Date.now() / 1000)) - BigInt(block.timestamp);
    if (age < -120n || age > 120n) fail('WALLET_FEE_QUOTE_UNAVAILABLE');
    const at = { blockHash: block.hash, requireCanonical: true };
    const unsigned = Transaction.from(transaction).unsignedSerialized;
    const l1Data = oracle.encodeFunctionData('getL1Fee', [unsigned]);
    const [l1, operator] = await Promise.all([
      rpc('eth_call', [{ to: baseGasOracle, data: l1Data }, at]),
      readOperatorFee(rpc, BigInt(transaction.gasLimit), at),
    ]);
    if (typeof l1 !== 'string' || !/^0x[\da-f]{64}$/i.test(l1))
      fail('WALLET_FEE_QUOTE_UNAVAILABLE');
    signal?.throwIfAborted();
    return { l1: BigInt(l1), operator };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error('WALLET_FEE_QUOTE_UNAVAILABLE', { cause: error });
  }
}

class WalletService {
  constructor({
    directory,
    publish = () => {},
    fetcher,
    signer,
    onEmergencyHalt = () => {},
    browserVault,
  } = {}) {
    if (!directory) fail('WALLET_STORAGE_UNAVAILABLE');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      fail('WALLET_STORAGE_UNAVAILABLE');
    this.directory = directory;
    this.publish = publish;
    this.onEmergencyHalt = onEmergencyHalt;
    this.networks = new WalletNetworks(this, writeAtomic, fetcher);
    this.market = new MarketData(fetcher, (key) => this.networks.profile(key));
    this.signerOverride = signer;
    this.file = path.join(directory, 'state.json');
    this.authorityFile = path.join(directory, 'authorization-fences.json');
    this.queue = Promise.resolve();
    this.pending = new Map();
    this.waiters = new Map();
    this.challenges = new Map();
    this.emergencyChallenges = new Map();
    this.unlocked = new Map();
    this.unlockEpochs = new Map();
    this.policyEpochs = new Map();
    this.policyFences = new Set();
    this.inFlight = new Map();
    this.budgetWake = new Set();
    this.budgetEpoch = 0;
    this.approvalPromises = new Map();
    this.disposed = false;
    this.state = { version: 1, wallets: [], intents: [], audit: [] };
    if (fs.existsSync(this.file)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        fail('WALLET_STORE_CORRUPT');
      }
      if (
        this.state.version !== 1 ||
        !Array.isArray(this.state.wallets) ||
        !Array.isArray(this.state.intents)
      )
        fail('WALLET_STORE_CORRUPT');
      for (const wallet of this.state.wallets) {
        const revisions = wallet.policy?.networkRevisions;
        if (
          revisions !== undefined &&
          (!revisions ||
            typeof revisions !== 'object' ||
            Array.isArray(revisions) ||
            Object.keys(revisions).length !== wallet.policy.chains.length ||
            Object.entries(revisions).some(([key, revision]) => {
              if (!this.networks.has(key) || !Number.isSafeInteger(revision) || revision < 1)
                return true;
              const network = this.networks.profile(key);
              return !wallet.policy.chains.includes(network.id) || network.revision < revision;
            }))
        )
          fail('WALLET_NETWORK_STORE_CORRUPT');
        if (wallet.trackedTokens !== undefined) {
          const entries = wallet.trackedTokens;
          if (
            !entries ||
            typeof entries !== 'object' ||
            Array.isArray(entries) ||
            Object.entries(entries).some(
              ([chain, tokens]) =>
                !this.networks.has(chain) ||
                !Array.isArray(tokens) ||
                tokens.length > 16 ||
                tokens.some(
                  (token) =>
                    typeof token !== 'string' ||
                    !/^0x[\da-f]{40}$/i.test(token) ||
                    /^0x0{40}$/i.test(token),
                ),
            )
          )
            fail('WALLET_STORE_CORRUPT');
        }
      }
      let changed = false;
      for (const intent of this.state.intents) {
        if (intent.config?.venue && !this.networks.has(intent.config.venue))
          fail('WALLET_NETWORK_STORE_CORRUPT');
        if (['approval-required', 'approved'].includes(intent.status)) {
          intent.status = 'expired';
          changed = true;
        }
        if (intent.status === 'signing') {
          intent.status = intent.hash ? 'submit-unknown' : 'signing-unknown';
          // A missing host hash does not prove the signer never committed.
          delete intent.submissionMayHaveOccurred;
          changed = true;
        }
      }
      if (changed) writeAtomic(this.file, this.state);
    }
    let authorityStat;
    try {
      authorityStat = fs.lstatSync(this.authorityFile);
    } catch (error) {
      if (error.code !== 'ENOENT') fail('WALLET_AUTHORIZATION_STORE_CORRUPT');
    }
    if (authorityStat) {
      try {
        const stat = authorityStat;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error();
        const saved = JSON.parse(fs.readFileSync(this.authorityFile, 'utf8'));
        if (
          saved.version !== 1 ||
          !saved.fences ||
          typeof saved.fences !== 'object' ||
          Array.isArray(saved.fences) ||
          Object.keys(saved.fences).length > 1000
        )
          throw Error();
        for (const [id, epoch] of Object.entries(saved.fences)) {
          if (
            !this.state.wallets.some((w) => w.id === id) ||
            typeof epoch !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(epoch)
          )
            throw Error();
          this.policyFences.add(id);
          this.policyEpochs.set(id, epoch);
        }
      } catch {
        fail('WALLET_AUTHORIZATION_STORE_CORRUPT');
      }
    }
    this.monitoring = false;
    this.emergency = new (require('./emergency-stop').EmergencyStop)(directory, writeAtomic);
    this.portfolios = new (require('./portfolios').WalletPortfolios)(this, writeAtomic);
    this.agentScopes = new WalletAgentScopes(this, writeAtomic);
    this.messages = new (require('./messages').WalletMessages)(this, writeAtomic);
    this.apps = new (require('./apps').WalletApps)(this, writeAtomic);
    this.browser = new (require('./browser-connector').WalletBrowserConnector)(this, writeAtomic, {
      vault: browserVault,
    });
    this.monitorCursor = 0;
    this.executionFeeCursor = 0;
    this.monitorTimer = setInterval(() => {
      void this.portfolios.allowanceMonitor.tick()?.catch(() => {});
      void this.monitor().catch(() => {
        this.monitorError = 'WALLET_BACKGROUND_SYNC_FAILED';
        this.emit();
      });
    }, 15000);
    this.monitorTimer.unref?.();
  }
  async monitor() {
    if (this.disposed || this.monitoring) return;
    this.monitoring = true;
    try {
      const expired = this.state.intents.filter(
        (i) => ['approval-required', 'approved'].includes(i.status) && i.expiresAt < Date.now(),
      );
      if (expired.length) {
        const ids = new Set(expired.map((intent) => intent.id));
        await this.mutate((state) => {
          for (const intent of state.intents)
            if (ids.has(intent.id) && ['approval-required', 'approved'].includes(intent.status)) {
              intent.status = 'expired';
              state.audit.push({ time: Date.now(), type: 'expired', intentId: intent.id });
            }
        });
        for (const intent of expired)
          this.waiters.get(intent.id)?.(
            this.publicIntent(this.state.intents.find((i) => i.id === intent.id)),
          );
      }
      // Read-only recovery: never automatically sign or rebroadcast after restart.
      const candidates = this.state.intents.filter(
        (i) =>
          requiresRecovery(i) ||
          (i.hash &&
            ['submit-unknown', 'submitted', 'included', 'safe', 'reorged'].includes(i.status)),
      );
      const batch = [];
      for (let i = 0; i < Math.min(8, candidates.length); i++)
        batch.push(candidates[(this.monitorCursor + i) % candidates.length]);
      this.monitorCursor = candidates.length
        ? (this.monitorCursor + batch.length) % candidates.length
        : 0;
      let syncError = null;
      for (const intent of batch) {
        if (this.disposed) break;
        try {
          await this.reconcile(intent.id);
        } catch (error) {
          /* Preserve evidence and distinguish native recovery from RPC errors. */
          const code = safeError(error);
          if (code.startsWith('WALLET_RECEIPT_')) syncError = code;
          else syncError ||= 'WALLET_RPC_UNAVAILABLE';
        }
      }
      if (!this.disposed) {
        const fees = this.state.intents.filter(
          (intent) => intent.execution && executionReceipt.operatorFeeTarget(intent),
        );
        const feeBatch = [];
        for (let i = 0; i < Math.min(2, fees.length); i++)
          feeBatch.push(fees[(this.executionFeeCursor + i) % fees.length]);
        this.executionFeeCursor = fees.length
          ? (this.executionFeeCursor + feeBatch.length) % fees.length
          : 0;
        await Promise.allSettled(feeBatch.map((intent) => this.reconcileOperatorFee(intent.id)));
      }
      const nextError = syncError;
      if (!this.disposed && this.monitorError !== nextError) {
        this.monitorError = nextError;
        this.emit();
      }
    } finally {
      this.monitoring = false;
    }
  }
  emit() {
    this.budgetEpoch++;
    for (const wake of this.budgetWake) wake();
    try {
      this.publish({
        type: 'wallet-changed',
        appRequests: [...(this.apps?.pending.keys() ?? [])],
        browserRequests: this.browser?.pendingIds() ?? [],
        messageRequests:
          this.messages?.items.filter((r) => r.status === 'approval-required').map((r) => r.id) ??
          [],
      });
    } catch {
      /* Durable state is authoritative. */
    }
  }
  mutate(fn, guard, rollback) {
    const result = this.queue.then(async () => {
      if (this.disposed) fail('WALLET_STOPPED');
      let committed = false;
      try {
        const next = clone(this.state),
          value = await fn(next);
        guard?.();
        writeAtomic(this.file, next);
        committed = true;
        this.state = next;
        this.emit();
        return clone(value);
      } catch (error) {
        // Roll back related files while this queue still excludes later writes.
        if (!committed) rollback?.();
        throw error;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  wallet(id, state = this.state) {
    return state.wallets.find((w) => w.id === id) || fail('WALLET_NOT_FOUND');
  }
  signingWallet(id, state = this.state) {
    const wallet = this.wallet(id, state);
    if (wallet.kind === 'watch') fail('WALLET_WATCH_ONLY');
    return wallet;
  }
  emergencyStatus() {
    return {
      ...this.emergency.status(),
      nativePausePending: Boolean(this.emergencyPausePending),
      nativePauseError: this.emergencyPauseError || null,
      needsReconciliation: this.state.intents.filter(
        (i) =>
          requiresRecovery(i) ||
          (i.hash &&
            i.submissionMayHaveOccurred !== false &&
            i.status !== 'finalized' &&
            !(i.status === 'reverted' && i.confirmation === 'finalized')),
      ).length,
    };
  }
  stopSigner(reason) {
    const child = this.child;
    this.child = null;
    if (child) this.signerExit = child.exited;
    child?.kill();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error(reason));
    }
    this.pending.clear();
    this.unlocked.clear();
  }
  haltLive(expectedGeneration) {
    const before = this.emergency.generation;
    try {
      this.emergency.halt(expectedGeneration);
    } finally {
      if (before !== this.emergency.generation) {
        this.messages.abort();
        this.challenges.clear();
        this.portfolios.challenges.clear();
        this.agentScopes.challenges.clear();
        this.emergencyChallenges.clear();
        const wallets = new Set([
          ...this.state.wallets.map((w) => w.id),
          ...this.unlockEpochs.keys(),
          ...this.unlocked.keys(),
        ]);
        for (const id of wallets) this.unlockEpochs.set(id, randomUUID());
        for (const operation of this.inFlight.values())
          operation.controller.abort(Error('WALLET_EMERGENCY_STOPPED'));
        this.stopSigner('WALLET_EMERGENCY_STOPPED');
        for (const [id, finish] of this.waiters) {
          const intent = this.state.intents.find((i) => i.id === id);
          if (intent) finish(this.publicIntent(intent));
        }
        const generation = this.emergency.generation,
          latchId = this.emergency.status().latchId;
        this.emergencySweep = this.mutate((state) => {
          for (const intent of state.intents)
            if (
              (intent.emergencyGeneration || 'initial') !== generation &&
              !intent.hash &&
              ['approval-required', 'approved', 'signing'].includes(intent.status)
            ) {
              intent.status = 'cancelled';
              intent.error = 'WALLET_EMERGENCY_STOPPED';
              intent.submissionMayHaveOccurred = false;
            }
          state.audit.push({ time: Date.now(), type: 'live-emergency-stop', latchId });
        }).catch(() => {
          this.monitorError = 'WALLET_EMERGENCY_CLEANUP_FAILED';
          this.emit();
        });
        this.pauseLiveNative();
        this.emit();
      }
    }
    if (
      this.emergency.halted &&
      !this.emergencyPausePending &&
      (this.emergencyPauseError || this.emergencyPausePending === undefined)
    )
      this.pauseLiveNative();
    return this.emergencyStatus();
  }
  pauseLiveNative() {
    this.emergencyPausePending = true;
    this.emergencyPauseError = null;
    let pending;
    try {
      pending = this.onEmergencyHalt();
    } catch {
      pending = Promise.reject(Error('WALLET_EMERGENCY_NATIVE_PAUSE_FAILED'));
    }
    if (!pending || typeof pending.then !== 'function') {
      this.emergencyPausePending = false;
      return;
    }
    this.emergencyPause = Promise.resolve(pending)
      .catch(() => {
        this.emergencyPauseError = 'WALLET_EMERGENCY_NATIVE_PAUSE_FAILED';
      })
      .finally(() => {
        this.emergencyPausePending = false;
        this.emit();
      });
  }
  assertNativeStopped() {
    if (this.emergencyPausePending) fail('WALLET_EMERGENCY_NATIVE_PAUSE_PENDING');
    if (this.emergencyPauseError) fail('WALLET_EMERGENCY_NATIVE_PAUSE_FAILED');
  }
  policy(wallet, chain) {
    if (wallet.kind === 'watch') return null;
    const p = wallet.policy,
      network = this.networks.has(chain) ? this.networks.profile(chain) : null;
    return !this.policyFences.has(wallet.id) &&
      !this.emergency.blocked(wallet) &&
      network &&
      !network.archived &&
      network.supportsType2 &&
      p?.mode === 'autonomous' &&
      p.nativeVersion === 2 &&
      p.chains.includes(network.id) &&
      (p.networkRevisions
        ? p.networkRevisions[chain] === network.revision
        : network.builtin && network.revision === 1) &&
      (!p.expiresAt || p.expiresAt > Date.now())
      ? p
      : null;
  }
  isUnlocked(id) {
    if (this.state.wallets.find((w) => w.id === id)?.kind === 'watch') return false;
    if (this.emergency.halted) return false;
    const until = this.unlocked.get(id);
    return until !== undefined && (!until || until > Date.now());
  }
  abortWallet(id, reason, policyOnly = false) {
    if (!policyOnly) this.messages.abort(id);
    for (const operation of this.inFlight.values())
      if (operation.walletId === id && (!policyOnly || operation.autonomous))
        operation.controller.abort(new Error(reason));
  }
  invalidateUnlock(id, reason) {
    const epoch = randomUUID();
    this.unlockEpochs.set(id, epoch);
    this.unlocked.delete(id);
    this.abortWallet(id, reason);
    this.emit();
    return epoch;
  }
  async changePolicy(id, update) {
    this.signingWallet(id);
    const epoch = randomUUID();
    this.policyEpochs.set(id, epoch);
    this.policyFences.add(id);
    this.abortWallet(id, 'WALLET_AUTHORIZATION_CHANGED', true);
    this.emit();
    this.writeAuthorityFences();
    const nativeFence = await this.signer('authority.revoke', { id });
    // Failed persistence keeps the local fence. Only a later successful explicit
    // policy change can clear it; an older completion cannot clear a newer fence.
    await update(epoch, nativeFence.generation);
    if (this.policyEpochs.get(id) === epoch) {
      const remaining = new Set(this.policyFences);
      remaining.delete(id);
      this.writeAuthorityFences(remaining);
      this.policyFences.delete(id);
    }
    this.emit();
    return this.publicWallet(this.wallet(id));
  }
  writeAuthorityFences(fences = this.policyFences) {
    writeAtomic(this.authorityFile, {
      version: 1,
      fences: Object.fromEntries([...fences].map((id) => [id, this.policyEpochs.get(id)])),
    });
  }
  publicWallet(w) {
    const policy = clone(w.policy || { mode: 'manual', chains: [] });
    if (policy.mode === 'autonomous') {
      policy.inactiveNetworks = policy.chains.filter((id) => {
        const network = this.networks.list().items.find((p) => p.id === id);
        return (
          !network ||
          !network.capabilities.autonomous ||
          (policy.networkRevisions
            ? policy.networkRevisions[network.key] !== network.revision
            : !network.builtin || network.revision !== 1)
        );
      });
      if (policy.inactiveNetworks.length === policy.chains.length) {
        policy.mode = 'manual';
        policy.renewalRequired = true;
      }
    }
    if (policy.mode === 'autonomous' && policy.nativeVersion !== 2) {
      policy.mode = 'manual';
      policy.renewalRequired = true;
    }
    if (this.policyFences.has(w.id) || this.emergency.blocked(w)) {
      policy.mode = 'manual';
      policy.suspended = true;
    }
    if (policy.expiresAt && policy.expiresAt <= Date.now()) {
      policy.mode = 'manual';
      policy.expired = true;
    }
    return {
      id: w.id,
      name: w.name,
      address: w.address,
      kind: w.kind === 'watch' ? 'watch' : 'local',
      trackedTokens: clone(w.trackedTokens || {}),
      createdAt: w.createdAt,
      unlocked: this.isUnlocked(w.id),
      unlockedUntil: this.unlocked.get(w.id) ?? null,
      policy,
      portfolioBlocked: this.portfolios.fences.has(w.id),
    };
  }
  publicIntent(intent, details = true) {
    const { config: _config, nativeSigning: _nativeSigning, ...safe } = clone(intent);
    const profile = this.networks.has(intent.config?.venue)
      ? this.networks.profile(intent.config.venue)
      : null;
    safe.networkBlocked =
      !profile ||
      profile.archived ||
      (intent.networkRevision !== undefined && profile.revision !== intent.networkRevision);
    safe.emergencyBlocked =
      (this.emergency.halted ||
        (intent.emergencyGeneration || 'initial') !== this.emergency.generation) &&
      ['approval-required', 'approved', 'signing'].includes(intent.status);
    if (!details) {
      const { calldata: _calldata, ...description } = safe.description || {};
      safe.description = description;
      safe.transaction = {
        ...safe.transaction,
        dataHash: keccak256(safe.transaction.data),
        dataBytes: (safe.transaction.data.length - 2) / 2,
      };
      delete safe.transaction.data;
    }
    return safe;
  }
  async signer(action, input) {
    if (this.state.wallets.find((w) => w.id === input?.id)?.kind === 'watch')
      fail('WALLET_WATCH_ONLY');
    if (this.signerOverride) return this.signerOverride(action, input);
    // A stop can arrive while an earlier exit promise is being awaited.
    // Always wait for the latest process to release its exclusive store lock.
    for (;;) {
      const exited = this.signerExit;
      await exited;
      if (exited === this.signerExit) break;
    }
    if (this.disposed) fail('WALLET_STOPPED');
    if (!this.child) {
      const child = new NativeSigner(this.directory);
      this.child = child;
      child.on('message', (message) => {
        if (this.child !== child) return;
        if (message.type === 'locked') {
          this.unlocked.delete(message.walletId);
          this.emit();
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      });
      const lost = (error) => {
        if (this.child !== child) return;
        this.child = null;
        this.signerExit = child.exited;
        this.unlocked.clear();
        const code = /^WALLET_RECEIPT_STORE_(FAILED|BUSY)$/.test(error?.message)
          ? error.message
          : 'WALLET_SIGNER_EXIT';
        for (const operation of this.inFlight.values()) operation.controller.abort(new Error(code));
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(code));
        }
        this.pending.clear();
        this.emit();
      };
      child.once('exit', lost);
      child.once('error', lost);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child?.kill();
        reject(new Error('WALLET_SIGNER_TIMEOUT'));
      }, 90000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, action, input }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('WALLET_SIGNER_UNAVAILABLE'));
        }
      });
    });
  }
  async create(input, importing = false, watchId) {
    if (
      typeof input.password !== 'string' ||
      input.password.length < 12 ||
      input.password.length > 1024
    )
      fail('WALLET_PASSWORD_LENGTH');
    const watched = new Map(
      this.state.wallets
        .filter((w) => w.kind === 'watch')
        .map((w) => [w.address.toLowerCase(), { id: w.id, address: w.address }]),
    );
    const selected = watchId ? this.wallet(watchId) : null;
    if (selected && selected.kind !== 'watch') fail('WALLET_WATCH_CHANGED');
    const id = randomUUID();
    const result = await this.signer(importing ? 'import' : 'create', {
      id,
      password: input.password,
      kind: input.kind,
      secret: input.secret,
      sourcePassword: input.sourcePassword,
    });
    const address = getAddress(result.address);
    if (selected && selected.address.toLowerCase() !== address.toLowerCase())
      fail('WALLET_KEYSTORE_ADDRESS_MISMATCH');
    const target = importing ? watched.get(address.toLowerCase()) : null;
    let keyFile,
      previousKey,
      wroteKey = false;
    const wallet = await this.mutate(
      (state) => {
        const duplicate = state.wallets.find(
          (w) => w.address.toLowerCase() === address.toLowerCase(),
        );
        if (target && (!duplicate || duplicate.id !== target.id || duplicate.kind !== 'watch'))
          fail('WALLET_WATCH_CHANGED');
        if (duplicate && !target) fail('WALLET_ALREADY_IMPORTED');
        const record = target
          ? { ...duplicate, kind: 'local' }
          : {
              id,
              address,
              name: String(input.name || 'Wallet').slice(0, 100),
              createdAt: Date.now(),
              policy: { mode: 'manual', chains: [] },
            };
        if (!/^[a-f0-9-]{36}$/.test(record.id)) fail('WALLET_STORE_CORRUPT');
        keyFile = path.join(this.directory, 'keystores', record.id + '.json');
        try {
          const stat = fs.lstatSync(keyFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
            fail('WALLET_STORAGE_UNAVAILABLE');
          previousKey = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        writeAtomic(keyFile, JSON.parse(result.keystore));
        wroteKey = true;
        if (target) state.wallets[state.wallets.findIndex((w) => w.id === target.id)] = record;
        else state.wallets.push(record);
        state.audit.push({
          time: Date.now(),
          type: target ? 'watch-imported' : importing ? 'wallet-imported' : 'wallet-created',
          walletId: record.id,
        });
        return record;
      },
      undefined,
      () => {
        if (!wroteKey) return;
        try {
          if (previousKey) writeAtomic(keyFile, previousKey);
          else fs.unlinkSync(keyFile);
        } catch {
          fail('WALLET_IMPORT_RECOVERY_REQUIRED');
        }
      },
    );
    return {
      ...this.publicWallet(wallet),
      ...(result.mnemonic ? { mnemonic: result.mnemonic } : {}),
    };
  }
  async prepare(config, input, context = { actor: 'frontend' }) {
    const emergencyGeneration = this.emergency.assert();
    const chain = this.networks.profile(config.venue, true);
    const sourceApp = context.sourceApp ? clone(context.sourceApp) : null;
    config = { ...config, rpcUrl: config.rpcUrl || chain.rpc };
    if (!chain.supportsType2) fail('WALLET_NETWORK_TYPE');
    const { walletId, commandId } = input;
    if (typeof commandId !== 'string' || !/^[\w:-]{1,180}$/.test(commandId))
      fail('WALLET_COMMAND_ID_REQUIRED');
    const to = getAddress(input.to);
    if (typeof input.value !== 'string' || !/^\d{1,16}(?:\.\d{1,18})?$/.test(input.value))
      fail('WALLET_INVALID_VALUE');
    const value = parseEther(input.value),
      data = input.data || '0x';
    if (typeof data !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(data) || data.length > 32770)
      fail('WALLET_INVALID_CALLDATA');
    if (context.actor === 'agent' && nonceMaintenance(to, data, chain.id))
      fail('WALLET_PERMIT2_MANUAL_REQUIRED');
    this.signingWallet(walletId);
    // Only trusted runtime context supplies identity, never tool arguments.
    if (context.agentContext && context.agentContext.workspaceId !== (context.workspaceId || null))
      fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    const agentScope =
      context.actor === 'agent'
        ? context.agentScopeBinding
          ? await this.agentScopes.fromBinding(
              context.agentScopeBinding,
              chain.id,
              context.workspaceId,
            )
          : await this.agentScopes.binding(
              context.agentContext ||
                rootContext(
                  context.workspaceId,
                  undefined,
                  this.networks.list().items.map((p) => p.id),
                ),
              walletId,
              chain.id,
            )
        : null;
    const request = {
      walletId,
      chainId: chain.id,
      to,
      value: String(value),
      data: data.toLowerCase(),
      workspaceId: context.workspaceId || null,
      ...(agentScope ? { agentScope } : {}),
      ...(sourceApp ? { sourceApp } : {}),
    };
    const fingerprint = digest(request);
    let prepareUnlockEpoch;
    return this.mutate(
      async (state) => {
        const wallet = this.signingWallet(walletId, state);
        this.portfolios.assert(walletId);
        this.agentScopes.assert(agentScope);
        const existing = state.intents.find((i) => i.commandId === commandId);
        if (existing) {
          if (
            existing.walletId !== walletId ||
            (existing.requestDigest || existing.digest) !== fingerprint ||
            (context.workflowDigest && existing.workflowDigest !== context.workflowDigest)
          )
            fail('WALLET_COMMAND_CONFLICT');
          return this.publicIntent(existing);
        }
        if (!this.isUnlocked(walletId)) fail('WALLET_LOCKED');
        const unlockEpoch = this.unlockEpochs.get(walletId);
        prepareUnlockEpoch = unlockEpoch;
        this.checkExecutionContext(context, state, wallet, config.venue);
        const rpc = (method, params) =>
          this.market.rpc(config.venue, config.rpcUrl, method, params, { signal: context.signal });
        if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chain.id)) fail('CHAIN_ID_MISMATCH');
        if (!chain.builtin) {
          const snapshot = await this.market.connect(config, { signal: context.signal });
          if (!/^0x[\da-f]{1,64}$/i.test(snapshot.block.baseFeePerGas || ''))
            fail('WALLET_NETWORK_TYPE');
          if (Date.now() - Number(snapshot.timestamp) * 1000 > 120000) fail('WALLET_CAPITAL_STALE');
        }
        let pending = state.intents.filter(
          (i) => i.walletId === walletId && i.chainId === chain.id && unresolved.has(i.status),
        );
        for (const item of pending)
          if (
            ['approval-required', 'approved'].includes(item.status) &&
            item.expiresAt < Date.now()
          )
            item.status = 'expired';
        pending = pending.filter((item) => unresolved.has(item.status));
        if (pending.some((item) => (item.requestDigest || item.digest) === fingerprint))
          fail('WALLET_DUPLICATE_ACTIVE_INTENT');
        if (
          pending.some((i) =>
            ['submit-unknown', 'signing', 'signing-unknown', 'reorged'].includes(i.status),
          )
        )
          fail('WALLET_RECONCILE_REQUIRED');
        const [count, gasPrice, balance] = await Promise.all([
          rpc('eth_getTransactionCount', [wallet.address, 'pending']),
          rpc('eth_gasPrice', []),
          rpc('eth_getBalance', [wallet.address, 'latest']),
        ]);
        const networkNonce = BigInt(count);
        const nonce = pending.reduce(
          (n, i) => (BigInt(i.transaction.nonce) >= n ? BigInt(i.transaction.nonce) + 1n : n),
          networkNonce,
        );
        if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) fail('WALLET_NONCE_RANGE');
        const price = BigInt(gasPrice);
        if (price <= 0n) fail('WALLET_FEE_UNAVAILABLE');
        let tip;
        try {
          tip = BigInt(await rpc('eth_maxPriorityFeePerGas', []));
        } catch {
          tip = price / 10n;
        }
        const call = { from: wallet.address, to, data, value: '0x' + value.toString(16) };
        if (context.approvalSimulation) {
          const layered = context.approvalSimulation === 'permit2';
          if (layered) {
            const code = await rpc('eth_getCode', [to, 'latest']);
            if (typeof code !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(code))
              fail('WALLET_ALLOWANCE_SIMULATION_FAILED');
            if (context.permit2SignatureNonce !== undefined) {
              const nonce = await this.market.permit2SignatureNonce(config, {
                address: wallet.address,
                nonce: context.permit2SignatureNonce,
              });
              if (nonce.unavailable) fail('WALLET_PERMIT2_NONCE_UNAVAILABLE');
            }
            if (context.permit2Ordered) {
              const { token, spender, nonce } = context.permit2Ordered;
              const live = await this.market.tokenAllowance(config, {
                address: wallet.address,
                protocol: 'permit2',
                token,
                spender,
              });
              if (live.permit2.nonce !== nonce) fail('WALLET_PERMIT2_NONCE_CHANGED');
            }
          }
          const result = await rpc('eth_call', [call, 'latest']);
          const success = layered ? '0x' : '0x' + '1'.padStart(64, '0');
          if (result !== success) fail('WALLET_ALLOWANCE_SIMULATION_FAILED');
        }
        const estimate = BigInt(await rpc('eth_estimateGas', [call]));
        if (estimate < 21000n || estimate > 30000000n) fail('WALLET_GAS_ESTIMATE_RANGE');
        const gasLimit = (estimate * 120n + 99n) / 100n,
          maxFee = price * 2n + tip;
        const transaction = {
          type: 2,
          chainId: chain.id,
          nonce: Number(nonce),
          to,
          data,
          value: String(value),
          gasLimit: String(gasLimit),
          maxFeePerGas: String(maxFee),
          maxPriorityFeePerGas: String(tip),
        };
        const capital = await captureCapital(this.signer.bind(this), walletId, transaction);
        const { l1, operator: operatorEstimate } =
          chain.feeModel === 'op-stack'
            ? await baseFeeQuote(rpc, transaction, context.signal)
            : { l1: 0n, operator: 0n };
        // L1 is an estimate (not a protocol-enforced maximum). Reserve headroom,
        // expose that distinction and never offer a false exact "send max".
        const reserveL1 =
            chain.feeModel === 'op-stack'
              ? l1 * 2n + parseEther('0.00001')
              : parseEther(chain.additionalFeeNative),
          feeReserve = gasLimit * maxFee + reserveL1 + operatorEstimate;
        const policy = context.actor === 'agent' ? this.policy(wallet, config.venue) : null;
        if (!this.isUnlocked(walletId) || this.unlockEpochs.get(walletId) !== unlockEpoch)
          fail('WALLET_UNLOCK_CHANGED');
        const execution = this.checkExecutionContext(
          context,
          state,
          wallet,
          config.venue,
          feeReserve,
        );
        const feeCap = parseEther(policy?.maxFeeEth || '0.01');
        if (feeCap && feeReserve > feeCap) fail('WALLET_FEE_CAP');
        const reserved = pending.reduce(
          (sum, i) => sum + BigInt(i.transaction.value) + BigInt(i.feeReserveWei),
          0n,
        );
        if (
          execution &&
          ![execution.commandId + ':approve', execution.commandId + ':swap'].includes(commandId)
        )
          fail('WALLET_EXECUTION_SCOPE_INVALID');
        const nonceState = await this.signer('nonce.inspect', {
          id: walletId,
          transaction,
          expectedAddress: wallet.address,
        });
        const replacementOf = nonceState.hash || null;
        if (replacementOf && !/^0x[a-f0-9]{64}$/.test(replacementOf))
          fail('WALLET_RECEIPT_MISMATCH');
        const canReplace = policy?.limits?.allowReplacement === true;
        if (replacementOf && execution && !canReplace) fail('WALLET_NATIVE_NONCE_CONFIRMATION');
        const intent = {
          id: randomUUID(),
          commandId,
          workflowDigest: context.workflowDigest || null,
          ...(execution ? { execution } : {}),
          requestDigest: fingerprint,
          ...(agentScope ? { agentScope } : {}),
          digest: '',
          approvalVersion: 1,
          replacementOf,
          emergencyGeneration,
          walletId,
          address: wallet.address,
          chainId: chain.id,
          network: chain.name,
          nativeSymbol: chain.nativeSymbol,
          networkRevision: chain.revision,
          workspaceId: context.workspaceId || null,
          transaction,
          capital,
          ...(sourceApp ? { sourceApp } : {}),
          config: { venue: config.venue, rpcUrl: config.rpcUrl || '' },
          description: decodeCall(to, data, value, chain.id),
          createdAt: Date.now(),
          expiresAt: Math.min(
            Date.now() + 300000,
            Number.isSafeInteger(input.validUntil) ? input.validUntil : Infinity,
          ),
          valueEth: formatEther(value),
          feeReserveWei: String(feeReserve),
          l1FeeEstimateWei: String(l1),
          operatorFeeEstimateWei: String(operatorEstimate),
          additionalFeeReserveWei: chain.feeModel === 'op-stack' ? '0' : String(reserveL1),
          executionFeeMaxWei: String(gasLimit * maxFee),
          feeEstimateIsNotGuaranteed: true,
          status: policy && (!replacementOf || canReplace) ? 'approved' : 'approval-required',
          authorization:
            policy && (!replacementOf || canReplace)
              ? { mode: 'autonomous', policyId: policy.id }
              : { mode: 'manual' },
        };
        const capitalChecked = await checkCapital(
          this.market,
          config,
          intent,
          state.intents,
          context.signal,
        );
        if (!capitalChecked && value + feeReserve + reserved > BigInt(balance))
          fail('WALLET_INSUFFICIENT_BALANCE');
        intent.digest = approvalDigest(intent);
        state.intents.push(intent);
        state.audit.push({
          time: Date.now(),
          type: 'intent-prepared',
          intentId: intent.id,
          authorization: intent.authorization.mode,
        });
        return this.publicIntent(intent);
      },
      () => {
        this.emergency.assert(emergencyGeneration);
        this.networks.assert(config.venue, chain.revision);
        if (prepareUnlockEpoch !== undefined) {
          if (!this.isUnlocked(walletId) || this.unlockEpochs.get(walletId) !== prepareUnlockEpoch)
            fail('WALLET_UNLOCK_CHANGED');
          this.portfolios.assert(walletId);
          this.agentScopes.assert(agentScope);
          context.signal?.throwIfAborted();
          context.checkAuthority?.();
        }
      },
    );
  }
  async transact(config, input, context = { actor: 'agent' }) {
    let intent = await this.prepare(config, input, context);
    if (intent.status === 'approval-required') {
      if (context.returnPending) return intent;
      intent = await this.awaitApproval(intent.id, context.signal);
    }
    if (intent.status !== 'approved') return intent;
    if (context.signal?.aborted) {
      return this.mutate((state) => {
        const record = state.intents.find((i) => i.id === intent.id);
        if (record.status === 'approved') record.status = 'cancelled';
        return this.publicIntent(record);
      });
    }
    return this.broadcast(intent.id, context.signal, context.checkAuthority);
  }
  checkExecutionContext(context, state, wallet, venue, reserve = 0n) {
    this.emergency.assert();
    if (context.signal?.aborted) fail('WALLET_OPERATION_CANCELLED');
    if (context.checkAuthority) context.checkAuthority();
    if (context.expectedPolicyId !== undefined) {
      const policy = context.actor === 'agent' && this.policy(wallet, venue);
      if (!policy || policy.id !== context.expectedPolicyId) fail('WALLET_AUTHORIZATION_CHANGED');
    }
    const execution = context.execution;
    if (!execution) return null;
    if (
      context.expectedPolicyId === undefined ||
      typeof context.checkAuthority !== 'function' ||
      !execution ||
      typeof execution !== 'object' ||
      !/^[\w:-]{1,128}$/.test(execution.planId) ||
      !/^live:[a-f0-9]{64}$/.test(execution.commandId) ||
      !/^[a-f0-9]{64}$/.test(execution.scopeHash) ||
      !/^[1-9]\d{0,37}$/.test(execution.feeBudgetWei)
    )
      fail('WALLET_EXECUTION_SCOPE_INVALID');
    const previous = state.intents.filter((i) => i.execution?.planId === execution.planId);
    let reserved = 0n;
    for (const intent of previous) {
      if (
        intent.execution.scopeHash !== execution.scopeHash ||
        intent.execution.feeBudgetWei !== execution.feeBudgetWei ||
        intent.walletId !== wallet.id ||
        intent.chainId !== CHAINS[venue].id ||
        intent.workspaceId !== (context.workspaceId || null)
      )
        fail('WALLET_EXECUTION_SCOPE_CHANGED');
      // Conservative cumulative estimate, including approvals and failed
      // attempts. L1 fees are estimates, not a chain-enforced spending cap.
      reserved += BigInt(intent.feeReserveWei);
    }
    if (reserved + reserve > BigInt(execution.feeBudgetWei)) fail('WALLET_EXECUTION_FEE_BUDGET');
    return {
      planId: execution.planId,
      commandId: execution.commandId,
      scopeHash: execution.scopeHash,
      feeBudgetWei: execution.feeBudgetWei,
    };
  }
  async awaitApproval(id, signal) {
    const current = this.state.intents.find((i) => i.id === id) || fail('WALLET_INTENT_NOT_FOUND');
    if (current.status !== 'approval-required') return this.publicIntent(current);
    if (this.approvalPromises.has(id)) return this.approvalPromises.get(id);
    const promise = new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('WALLET_APPROVAL_CANCELLED'));
        return;
      }
      const finish = (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(id);
        resolve(value);
      };
      const abort = () => {
        void this.decide(id, false, current.digest).then(finish, reject);
      };
      const timer = setTimeout(
        () => {
          void this.decide(id, false, current.digest).then(finish, reject);
        },
        Math.max(1, current.expiresAt - Date.now()),
      );
      timer.unref?.();
      this.waiters.set(id, finish);
      signal?.addEventListener('abort', abort, { once: true });
      // Cover an approval arriving between prepare() and registering the waiter.
      const latest = this.state.intents.find((i) => i.id === id);
      if (latest?.status !== 'approval-required') finish(this.publicIntent(latest));
    });
    this.approvalPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      this.approvalPromises.delete(id);
    }
  }
  async decide(id, approved, expectedDigest, replacementOf) {
    const current = this.state.intents.find((i) => i.id === id);
    if (!approved && current?.digest === expectedDigest)
      this.inFlight.get(id)?.controller.abort(Error('WALLET_OPERATION_CANCELLED'));
    const intent = await this.mutate(async (state) => {
      const record = state.intents.find((i) => i.id === id) || fail('WALLET_INTENT_NOT_FOUND');
      if (record.digest !== expectedDigest) fail('WALLET_INTENT_CHANGED');
      if (!approved && ['approval-required', 'approved', 'signing'].includes(record.status))
        await this.signer('operation.deny', { id: record.walletId, operationId: record.id });
      if (!approved && record.status === 'approved') {
        record.status = 'denied';
        record.submissionMayHaveOccurred = false;
        state.audit.push({ time: Date.now(), type: 'denied', intentId: id });
        return this.publicIntent(record);
      }
      if (record.status !== 'approval-required') return this.publicIntent(record);
      if (approved && record.replacementOf && record.replacementOf !== replacementOf)
        fail('WALLET_NATIVE_NONCE_CONFIRMATION');
      if (approved && record.expiresAt >= Date.now()) {
        this.networks.assert(record.config.venue, record.networkRevision);
        if (record.approvalVersion !== 1 || approvalDigest(record) !== expectedDigest)
          fail('WALLET_INTENT_CHANGED');
        const epoch = this.unlockEpochs.get(record.walletId);
        if (!this.isUnlocked(record.walletId)) fail('WALLET_LOCKED');
        await this.signer('operation.approve', {
          id: record.walletId,
          operationId: record.id,
          transaction: record.transaction,
          feeReserveWei: record.feeReserveWei,
          expiresAt: record.expiresAt,
          replacementOf: record.replacementOf || undefined,
          ...(record.agentScope
            ? { agentScopeId: record.agentScope.id, agentSubject: record.agentScope.subject }
            : {}),
        });
        this.emergency.assert(record.emergencyGeneration || 'initial');
        if (this.unlockEpochs.get(record.walletId) !== epoch) fail('WALLET_UNLOCK_CHANGED');
      }
      record.status = record.expiresAt < Date.now() ? 'expired' : approved ? 'approved' : 'denied';
      state.audit.push({ time: Date.now(), type: record.status, intentId: id });
      return this.publicIntent(record);
    });
    this.waiters.get(id)?.(intent);
    return intent;
  }
  async broadcast(id, signal, checkAuthority) {
    let epochs;
    // The signing reservation is durable BEFORE signing; only the winning caller
    // may proceed. Other retries observe state instead of signing a second payment.
    const claimed = await this.mutate((state) => {
      const intent = state.intents.find((i) => i.id === id) || fail('WALLET_INTENT_NOT_FOUND');
      if (intent.status !== 'approved') return null;
      this.emergency.assert(intent.emergencyGeneration || 'initial');
      if (intent.expiresAt < Date.now()) {
        intent.status = 'expired';
        return null;
      }
      if (!this.isUnlocked(intent.walletId)) fail('WALLET_LOCKED');
      if (intent.authorization.mode === 'autonomous') {
        const p = this.policy(this.wallet(intent.walletId, state), intent.config.venue);
        if (!p || p.id !== intent.authorization.policyId) {
          if (intent.execution) {
            intent.status = 'cancelled';
            intent.error = 'WALLET_AUTHORIZATION_CHANGED';
            intent.submissionMayHaveOccurred = false;
            return null;
          }
          intent.status = 'approval-required';
          intent.authorization = { mode: 'manual' };
          return null;
        }
      }
      intent.status = 'signing';
      epochs = {
        unlock: this.unlockEpochs.get(intent.walletId),
        policy: this.policyEpochs.get(intent.walletId),
        portfolio: this.portfolios.epochs.get(intent.walletId) ?? null,
        agentScopes: this.agentScopes.epoch(intent.agentScope),
      };
      return clone(intent);
    });
    if (!claimed) return this.publicIntent(this.state.intents.find((i) => i.id === id));
    const controller = new AbortController();
    const operation = {
      walletId: claimed.walletId,
      network: claimed.config.venue,
      autonomous: claimed.authorization.mode === 'autonomous',
      agentScope: claimed.agentScope,
      controller,
    };
    this.inFlight.set(id, operation);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const authorized = (state = this.state) => {
      if (this.disposed) fail('WALLET_STOPPED');
      this.networks.assert(claimed.config.venue, claimed.networkRevision);
      this.portfolios.assert(claimed.walletId, epochs.portfolio);
      this.agentScopes.assert(claimed.agentScope, epochs.agentScopes);
      this.emergency.assert(claimed.emergencyGeneration || 'initial');
      if (controller.signal.aborted) throw controller.signal.reason;
      if (signal?.aborted) fail('WALLET_OPERATION_CANCELLED');
      checkAuthority?.();
      if (claimed.execution && !checkAuthority) fail('WALLET_EXECUTION_OWNER_REQUIRED');
      if (!this.isUnlocked(claimed.walletId)) fail('WALLET_LOCKED');
      if (this.unlockEpochs.get(claimed.walletId) !== epochs.unlock) fail('WALLET_UNLOCK_CHANGED');
      if (claimed.expiresAt <= Date.now()) fail('WALLET_INTENT_EXPIRED');
      if (operation.autonomous) {
        const policy = this.policy(this.wallet(claimed.walletId, state), claimed.config.venue);
        if (
          !policy ||
          policy.id !== claimed.authorization.policyId ||
          this.policyEpochs.get(claimed.walletId) !== epochs.policy
        )
          fail('WALLET_AUTHORIZATION_CHANGED');
      }
    };
    let raw,
      portfolioRisk,
      portfolioAllowanceRisk,
      attempted = false,
      signingInvoked = false,
      signatureReturned = false;
    try {
      authorized();
      if (claimed.approvalVersion !== 1 || approvalDigest(claimed) !== claimed.digest)
        fail('WALLET_INTENT_CHANGED');
      const rpc = (method, params) =>
        this.market.rpc(claimed.config.venue, claimed.config.rpcUrl, method, params, {
          signal: requestSignal,
        });
      if (BigInt(await rpc('eth_chainId', [])) !== BigInt(claimed.chainId))
        fail('CHAIN_ID_MISMATCH');
      if (!this.networks.profile(claimed.config.venue).builtin) {
        const snapshot = await this.market.connect(claimed.config, { signal: requestSignal });
        if (!/^0x[\da-f]{1,64}$/i.test(snapshot.block.baseFeePerGas || ''))
          fail('WALLET_NETWORK_TYPE');
        if (Date.now() - Number(snapshot.timestamp) * 1000 > 120000) fail('WALLET_CAPITAL_STALE');
      }
      const pendingNonce = BigInt(
        await rpc('eth_getTransactionCount', [claimed.address, 'pending']),
      );
      if (pendingNonce !== BigInt(claimed.transaction.nonce)) fail('WALLET_NONCE_CHANGED');
      authorized();
      const store = await this.signer('receipt.status', { id: claimed.walletId });
      if (store?.version !== 1 || !/^[a-f0-9]{64}$/.test(store.storeId))
        fail('WALLET_RECEIPT_REQUIRED');
      if (
        operation.autonomous &&
        this.wallet(claimed.walletId).policy.nativeStoreId !== store.storeId
      )
        fail('WALLET_NATIVE_AUTH_REQUIRED');
      const nativeSigning = {
        version: 1,
        storeId: store.storeId,
        operationId: id,
        unsignedHash: keccak256(Transaction.from(claimed.transaction).unsignedSerialized),
      };
      const swap = decodeCall(
        claimed.transaction.to,
        claimed.transaction.data,
        BigInt(claimed.transaction.value),
        claimed.chainId,
      );
      const chain = this.networks.profile(claimed.config.venue);
      const checkFees = async () => {
        if (chain.feeModel !== 'op-stack') return;
        const { l1, operator } = await baseFeeQuote(rpc, claimed.transaction, requestSignal);
        const executionMax =
          BigInt(claimed.transaction.gasLimit) * BigInt(claimed.transaction.maxFeePerGas);
        if (executionMax + l1 + operator > BigInt(claimed.feeReserveWei))
          fail('WALLET_FEE_RESERVE_EXCEEDED');
      };
      const simulateSwap = async () => {
        if (swap.kind !== 'uniswap-v3-swap') return;
        const { simulateBaseSwap } = require('../quant/base-swap');
        await simulateBaseSwap(
          rpc,
          claimed.address,
          claimed.transaction,
          parseUnits(swap.minimumAmountOut, swap.tokenOut === 'WETH' ? 18 : 6),
        );
      };
      const checkEquity = async (state, phase) => {
        if (claimed.chainId !== 8453) return null;
        const reply = await this.signer('portfolio.equity.guard', {
          id: claimed.walletId,
          expectedAddress: claimed.address,
        });
        if (reply?.guard === null) return null;
        const guard = reply?.guard;
        if (
          !guard?.id ||
          !Number.isSafeInteger(guard.revision) ||
          !/^\d{1,24}$/.test(guard.floorUsdAtomic || '') ||
          !Array.isArray(guard.members)
        )
          fail('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
        let evidence;
        try {
          evidence = await assessEquity(
            this.market,
            claimed.config,
            guard,
            state.intents,
            requestSignal,
          );
        } catch (error) {
          portfolioRisk = {
            portfolioId: guard.id,
            revision: guard.revision,
            floorUsdAtomic: guard.floorUsdAtomic,
            phase,
            status: 'unavailable',
            error: safeError(error),
          };
          throw error;
        }
        portfolioRisk = { ...evidence, phase };
        if (evidence.status !== 'satisfied') fail('WALLET_PORTFOLIO_EQUITY_LOW');
        if (
          BigInt(await rpc('eth_getTransactionCount', [claimed.address, 'pending'])) !==
          BigInt(claimed.transaction.nonce)
        )
          fail('WALLET_NONCE_CHANGED');
        return {
          portfolioId: evidence.portfolioId,
          revision: evidence.revision,
          blockHash: evidence.blockHash,
          operationId: id,
          unsignedHash: nativeSigning.unsignedHash,
          checkedAt: evidence.checkedAt,
          availableUsdAtomic: evidence.availableUsdAtomic,
        };
      };
      const grant = [8453, 84532].includes(claimed.chainId) ? approval(claimed.transaction) : null;
      const checkAllowance = async (state, phase) => {
        if (!grant?.amount) return null;
        const { guard } = await this.signer('portfolio.allowance.guard', {
          id: claimed.walletId,
          expectedAddress: claimed.address,
          chainId: claimed.chainId,
        });
        if (guard === null) return null;
        if (!guard?.rule?.token) fail('WALLET_PORTFOLIO_ALLOWANCE_UNAVAILABLE');
        if (grant.token.toLowerCase() !== guard.rule.token.toLowerCase()) return null;
        let evidence;
        try {
          const { baselineReportId } = guard.rule;
          const anchor =
            this.portfolios.allowanceMonitor.checkpointFor(guard.id, baselineReportId) ??
            this.portfolios.allowances.load(guard.id, baselineReportId);
          evidence = await assessCeiling(
            this,
            claimed.config,
            guard,
            anchor,
            claimed,
            grant,
            state.intents,
            requestSignal,
          );
        } catch (error) {
          requestSignal.throwIfAborted();
          const errorCode = error.message?.startsWith('WALLET_PORTFOLIO_ALLOWANCE_')
            ? error.message
            : 'WALLET_PORTFOLIO_ALLOWANCE_UNAVAILABLE';
          portfolioAllowanceRisk = {
            portfolioId: guard.id,
            revision: guard.revision,
            token: grant.token,
            phase,
            status: 'unavailable',
            error: errorCode,
          };
          fail(errorCode);
        }
        portfolioAllowanceRisk = { ...evidence, phase };
        if (evidence.status !== 'satisfied') fail('WALLET_PORTFOLIO_ALLOWANCE_EXCEEDED');
        if (
          BigInt(await rpc('eth_getTransactionCount', [claimed.address, 'pending'])) !==
          BigInt(claimed.transaction.nonce)
        )
          fail('WALLET_NONCE_CHANGED');
        return {
          portfolioId: evidence.portfolioId,
          revision: evidence.revision,
          blockHash: evidence.blockHash,
          operationId: id,
          unsignedHash: nativeSigning.unsignedHash,
          checkedAt: evidence.checkedAt,
          previousPairAtoms: evidence.previousPairAtoms,
          projectedAtoms: evidence.projectedAtoms,
        };
      };
      let portfolioEquity, portfolioAllowance;
      await this.mutate(async (state) => {
        authorized(state);
        portfolioEquity = await checkEquity(state, 'sign');
        if (!portfolioEquity)
          await checkCapital(this.market, claimed.config, claimed, state.intents, requestSignal);
        portfolioAllowance = await checkAllowance(state, 'sign');
        authorized(state);
        state.intents.find((i) => i.id === id).nativeSigning = nativeSigning;
      });
      await Promise.all([checkFees(), simulateSwap()]);
      authorized();
      signingInvoked = true;
      const signed = await this.signer('sign', {
        id: claimed.walletId,
        transaction: claimed.transaction,
        storeId: store.storeId,
        operationId: id,
        expiresAt: claimed.expiresAt,
        ...(claimed.replacementOf ? { replacementOf: claimed.replacementOf } : {}),
        feeReserveWei: claimed.feeReserveWei,
        ...(portfolioEquity && { portfolioEquity }),
        ...(portfolioAllowance && { portfolioAllowance }),
        ...(claimed.agentScope
          ? { agentScopeId: claimed.agentScope.id, agentSubject: claimed.agentScope.subject }
          : {}),
        ...(operation.autonomous ? { policyId: claimed.authorization.policyId } : {}),
        ...(claimed.execution
          ? {
              execution: {
                planId: claimed.execution.planId,
                scopeHash: claimed.execution.scopeHash,
                feeBudgetWei: claimed.execution.feeBudgetWei,
              },
            }
          : {}),
      });
      signatureReturned = true;
      raw = signed.raw;
      authorized();
      const decoded = Transaction.from(raw);
      if (
        decoded.from?.toLowerCase() !== claimed.address.toLowerCase() ||
        decoded.unsignedSerialized !== Transaction.from(claimed.transaction).unsignedSerialized
      )
        fail('WALLET_SIGNER_RESPONSE_MISMATCH');
      const txHash = keccak256(raw);
      this.checkSigningReceipt(claimed, nativeSigning, signed.receipt, txHash);
      await Promise.all([checkFees(), simulateSwap()]);
      authorized();
      await this.mutate(async (state) => {
        authorized(state);
        await checkEquity(state, 'broadcast');
        await checkAllowance(state, 'broadcast');
        authorized(state);
        const intent = state.intents.find((i) => i.id === id);
        if (portfolioRisk) intent.portfolioRisk = portfolioRisk;
        if (portfolioAllowanceRisk) intent.portfolioAllowanceRisk = portfolioAllowanceRisk;
        intent.hash = txHash;
        intent.status = 'submit-unknown';
        intent.submissionMayHaveOccurred = true;
      });
      authorized();
      // No auto retry here. A lost acknowledgement can still mean accepted.
      attempted = true;
      const returned = await rpc('eth_sendRawTransaction', [raw]);
      if (String(returned).toLowerCase() !== txHash.toLowerCase()) fail('WALLET_RPC_HASH_MISMATCH');
      await this.mutate((state) => {
        const intent = state.intents.find((i) => i.id === id);
        intent.status = 'submitted';
        intent.submittedAt = Date.now();
      });
    } catch (error) {
      await this.mutate((state) => {
        const intent = state.intents.find((i) => i.id === id);
        const reason = controller.signal.aborted
          ? controller.signal.reason
          : signal?.aborted
            ? new Error('WALLET_OPERATION_CANCELLED')
            : error;
        const code = safeError(reason);
        if (portfolioRisk) intent.portfolioRisk = portfolioRisk;
        if (portfolioAllowanceRisk) intent.portfolioAllowanceRisk = portfolioAllowanceRisk;
        const uncertain =
          signingInvoked &&
          !signatureReturned &&
          !/^WALLET_(?:UNLOCK_CHANGED|AUTHORIZATION_CHANGED|OPERATION_CANCELLED|EMERGENCY_STOPPED|EMERGENCY_CHANGED)$/.test(
            code,
          );
        if (uncertain) delete intent.submissionMayHaveOccurred;
        else intent.submissionMayHaveOccurred = attempted;
        if (!signingInvoked) delete intent.nativeSigning;
        intent.status = attempted
          ? 'submit-unknown'
          : uncertain
            ? 'signing-unknown'
            : /^WALLET_(?:UNLOCK_CHANGED|AUTHORIZATION_CHANGED|OPERATION_CANCELLED|EMERGENCY_STOPPED|EMERGENCY_CHANGED)$/.test(
                  code,
                )
              ? 'cancelled'
              : code === 'WALLET_INTENT_EXPIRED'
                ? 'expired'
                : 'failed';
        intent.error = code;
      });
    } finally {
      if (this.inFlight.get(id) === operation) this.inFlight.delete(id);
      raw = null;
    }
    return this.publicIntent(this.state.intents.find((i) => i.id === id));
  }
  checkSigningReceipt(intent, binding, receipt, hash) {
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.storeId !== binding.storeId ||
      receipt.operationId !== intent.id ||
      receipt.walletId !== intent.walletId ||
      receipt.address?.toLowerCase() !== intent.address.toLowerCase() ||
      receipt.chainId !== intent.chainId ||
      receipt.nonce !== intent.transaction.nonce ||
      receipt.unsignedHash !== binding.unsignedHash ||
      receipt.unsignedHash !== keccak256(Transaction.from(intent.transaction).unsignedSerialized) ||
      !/^0x[a-f0-9]{64}$/.test(receipt.hash) ||
      (hash && receipt.hash !== hash)
    )
      fail('WALLET_RECEIPT_MISMATCH');
  }
  async reconcile(id, signal) {
    let intent = this.state.intents.find((i) => i.id === id) || fail('WALLET_INTENT_NOT_FOUND');
    if (requiresRecovery(intent) && !this.inFlight.has(id)) {
      const binding = intent.nativeSigning;
      // Old releases had no receipt ledger. Missing or replaced evidence must
      // remain unknown, never release the reservation based on an empty store.
      if (!binding || binding.version !== 1) fail('WALLET_RECEIPT_UNAVAILABLE');
      signal?.throwIfAborted();
      const result = await this.signer('receipt.get', {
        id: intent.walletId,
        storeId: binding.storeId,
        operationId: id,
      });
      if (result.found) this.checkSigningReceipt(intent, binding, result.receipt);
      else if (result.found !== false || result.version !== 1 || result.storeId !== binding.storeId)
        fail('WALLET_RECEIPT_MISMATCH');
      signal?.throwIfAborted();
      await this.mutate((state) => {
        const record = state.intents.find((i) => i.id === id);
        if (!requiresRecovery(record) || this.inFlight.has(id)) return;
        const knownUnsent =
          record.submissionMayHaveOccurred === false &&
          ['failed', 'cancelled', 'expired'].includes(record.status);
        if (result.found) {
          record.hash = result.receipt.hash;
          // Recovering a durable signature is not evidence of a dispatch.
          // Preserve an already established pre-broadcast cancellation/failure.
          if (!knownUnsent) {
            record.status = 'submit-unknown';
            record.submissionMayHaveOccurred = true;
          }
        } else {
          if (!knownUnsent) record.status = 'expired';
          record.submissionMayHaveOccurred = false;
          record.nativeSignatureAbsent = true;
        }
        if (!knownUnsent) delete record.error;
        state.audit.push({
          time: Date.now(),
          type: 'native-signing-recovered',
          intentId: id,
          signed: result.found,
        });
      });
      intent = this.state.intents.find((i) => i.id === id);
    }
    if (!intent.hash || intent.submissionMayHaveOccurred === false)
      return this.publicIntent(intent);
    const status = await this.market.chainStatus(
      intent.config,
      { hash: intent.hash },
      {
        signal,
        ...(intent.execution && executionReceipt.supportedChain(intent.chainId)
          ? {
              observeReceipt: (receipt, chain) =>
                executionReceipt.observe(intent, receipt, chain, decodeCall),
            }
          : {}),
      },
    );
    signal?.throwIfAborted();
    return this.mutate((state) => {
      const record = state.intents.find((i) => i.id === id),
        result = status.transaction;
      if (record.hash !== intent.hash || record.submissionMayHaveOccurred === false)
        return this.publicIntent(record);
      const observedBlockHash = result.observedBlockHash;
      const previous = record.executionReceipt;
      if (
        previous &&
        executionReceipt.finalized(record) &&
        observedBlockHash === previous.blockHash &&
        ['included', 'safe'].includes(result.confirmation)
      )
        return this.publicIntent(record);
      if (result.state !== 'pending-or-unknown') {
        record.status = result.state;
        record.block = result.block;
        record.confirmation = result.confirmation;
      } else if (['included', 'safe', 'finalized'].includes(record.status))
        record.status = 'reorged';
      if (record.execution && result.confirmation === 'finalized') {
        if (result.evidence) {
          const sameBlock =
            previous?.txHash === result.evidence.txHash &&
            previous.blockHash === result.evidence.blockHash;
          record.executionReceipt = sameBlock
            ? {
                ...result.evidence,
                fill: result.evidence.fill ?? previous.fill,
                l2GasWei: result.evidence.l2GasWei ?? previous.l2GasWei,
                l1DataFeeWei: result.evidence.l1DataFeeWei ?? previous.l1DataFeeWei,
                gasUsed: result.evidence.gasUsed ?? previous.gasUsed,
                feeQuote: previous.feeQuote,
                operatorFeeWei:
                  (result.evidence.gasUsed ?? previous.gasUsed) === previous.gasUsed
                    ? (previous.operatorFeeWei ?? null)
                    : null,
              }
            : result.evidence;
        } else if (
          record.executionReceipt?.txHash !== record.hash?.toLowerCase() ||
          record.executionReceipt?.blockHash !== observedBlockHash
        ) {
          delete record.executionReceipt;
        }
      } else if (
        record.status === 'reorged' ||
        (result.confirmation && result.confirmation !== 'finalized')
      ) {
        delete record.executionReceipt;
      }
      record.lastReconciledAt = Date.now();
      return this.publicIntent(record);
    });
  }
  async reconcileOperatorFee(id, signal) {
    const intent = this.state.intents.find((record) => record.id === id);
    const target = intent?.execution && executionReceipt.operatorFeeTarget(intent);
    if (!target || this.disposed) return;
    const deadline = AbortSignal.timeout(5000);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let fee;
    try {
      fee = await this.market.baseOperatorFee(
        intent.config,
        intent.chainId,
        target.blockHash,
        target.gasUsed,
        readSignal,
      );
    } catch {
      signal?.throwIfAborted();
      return;
    }
    signal?.throwIfAborted();
    if (deadline.aborted || this.disposed) return;
    await this.mutate((state) => {
      const current = state.intents.find((record) => record.id === id);
      const observed = current?.execution && executionReceipt.operatorFeeTarget(current);
      if (
        observed?.txHash === target.txHash &&
        observed.blockHash === target.blockHash &&
        observed.gasUsed === target.gasUsed
      )
        current.executionReceipt.operatorFeeWei = String(fee);
    });
  }
  async waitForInclusion(id, signal) {
    const end = Date.now() + 90000;
    while (Date.now() < end && !signal?.aborted && !this.disposed) {
      const intent = await this.reconcile(id);
      if (
        [
          'included',
          'safe',
          'finalized',
          'reverted',
          'failed',
          'denied',
          'expired',
          'cancelled',
        ].includes(intent.status)
      )
        return intent;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    return this.publicIntent(this.state.intents.find((i) => i.id === id));
  }
  async request(action, input = {}, context = {}) {
    if (action.startsWith('browser.')) return this.browser.action(action.slice(8), input);
    if (action.startsWith('message.')) return this.messages.action(action.slice(8), input);
    if (action.startsWith('app.')) return this.apps.action(action.slice(4), input);
    if (action.startsWith('network.')) return this.networks.request(action.slice(8), input);
    if (action === 'transaction.prepare')
      return this.prepare(
        { venue: input.chain },
        {
          walletId: input.id,
          commandId: 'ui:' + randomUUID(),
          to: input.to,
          value: input.value,
          data: input.data || '0x',
        },
        { actor: 'frontend' },
      );
    if (action === 'period.history') {
      const offset = input.offset ?? 0,
        limit = input.limit ?? 2;
      if (
        !['grant', 'portfolio', 'scope'].includes(input.kind) ||
        typeof input.id !== 'string' ||
        !/^[-\w:]{1,128}$/.test(input.id) ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 200000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 5
      )
        fail('WALLET_PERIOD_INVALID');
      return this.signer('period.history', {
        id: 'period-history',
        budgetId: input.id,
        kind: input.kind,
        offset,
        limit,
      });
    }
    if (action.startsWith('scope.')) return this.agentScopes.request(action.slice(6), input);
    if (action.startsWith('portfolio.'))
      return this.portfolios.request(action.slice(10), input, context);
    if (action === 'emergency.status') return this.emergencyStatus();
    if (action === 'emergency.halt') return this.haltLive(input.expectedGeneration);
    if (action === 'emergency.challenge') {
      this.assertNativeStopped();
      if (!this.emergency.halted || this.emergency.storageError) fail('WALLET_EMERGENCY_CHANGED');
      const challenge = {
        id: randomUUID(),
        latchId: this.emergency.status().latchId,
        expiresAt: Date.now() + 120000,
      };
      this.emergencyChallenges.set(challenge.id, challenge);
      return clone(challenge);
    }
    if (action === 'emergency.reset') {
      this.assertNativeStopped();
      const challenge = this.emergencyChallenges.get(input.challengeId);
      this.emergencyChallenges.delete(input.challengeId);
      if (
        !challenge ||
        challenge.expiresAt <= Date.now() ||
        input.ack !== 'RESET LIVE' ||
        input.confirmed !== true
      )
        fail('WALLET_CONFIRMATION_REQUIRED');
      if (!this.emergency.halted || challenge.latchId !== this.emergency.status().latchId)
        fail('WALLET_EMERGENCY_CHANGED');
      await this.mutate((state) => {
        this.assertNativeStopped();
        if (!this.emergency.halted || challenge.latchId !== this.emergency.status().latchId)
          fail('WALLET_EMERGENCY_CHANGED');
        for (const wallet of state.wallets) wallet.policy = { mode: 'manual', chains: [] };
        for (const intent of state.intents)
          if (
            !intent.hash &&
            ['approval-required', 'approved', 'signing'].includes(intent.status)
          ) {
            intent.status = 'cancelled';
            intent.error = 'WALLET_EMERGENCY_STOPPED';
            intent.submissionMayHaveOccurred = false;
          }
        state.audit.push({
          time: Date.now(),
          type: 'live-emergency-reset',
          latchId: challenge.latchId,
        });
      });
      this.emergency.reset(challenge.latchId);
      this.emit();
      return this.emergencyStatus();
    }
    if (action === 'intent.inspect') {
      const intent =
        this.state.intents.find((i) => i.id === input.id) || fail('WALLET_INTENT_NOT_FOUND');
      return this.publicIntent(intent);
    }
    if (action === 'history') {
      const offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail('WALLET_HISTORY_RANGE');
      const records = this.state.intents
        .filter(
          (i) =>
            (!input.walletId || i.walletId === input.walletId) &&
            (!input.status || i.status === input.status) &&
            (!input.workspaceId || i.workspaceId === input.workspaceId),
        )
        .slice()
        .reverse();
      return {
        items: records.slice(offset, offset + limit).map((i) => this.publicIntent(i, false)),
        total: records.length,
        next: offset + limit < records.length ? offset + limit : null,
      };
    }
    if (action === 'list')
      return {
        syncError: this.monitorError || null,
        appRequests: [...this.apps.pending.keys()],
        browserRequests: this.browser.pendingIds(),
        messageRequests: this.messages.items
          .filter((r) => r.status === 'approval-required')
          .map((r) => r.id),
        emergency: this.emergencyStatus(),
        wallets: this.state.wallets.map((w) => this.publicWallet(w)),
        intents: this.state.intents
          .filter(
            (intent, index) =>
              index >= this.state.intents.length - 100 || unresolved.has(intent.status),
          )
          .reverse()
          .map((i) => this.publicIntent(i, i.status === 'approval-required')),
      };
    if (action === 'create' || action === 'import') return this.create(input, action === 'import');
    if (action === 'watch.import') {
      const target = this.wallet(input.id);
      if (target.kind !== 'watch') fail('WALLET_WATCH_CHANGED');
      return this.create(input, true, target.id);
    }
    if (action === 'watch.add') {
      const address = getAddress(input.address);
      if (address === ZeroAddress) fail('INVALID_ADDRESS');
      const record = await this.mutate((state) => {
        if (state.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase()))
          fail('WALLET_ALREADY_IMPORTED');
        const wallet = {
          id: randomUUID(),
          kind: 'watch',
          address,
          name:
            String(input.name || '')
              .replace(/[\x00-\x1f\x7f]/g, '')
              .trim()
              .slice(0, 100) || 'Watch account',
          createdAt: Date.now(),
          policy: { mode: 'manual', chains: [] },
        };
        state.wallets.push(wallet);
        state.audit.push({ time: Date.now(), type: 'watch-added', walletId: wallet.id });
        return wallet;
      });
      return this.publicWallet(record);
    }
    if (action === 'watch.remove') {
      return this.mutate((state) => {
        const wallet = state.wallets.find((w) => w.id === input.id);
        if (!wallet) return { removed: false };
        if (wallet.kind !== 'watch') fail('WALLET_WATCH_REMOVE_LOCAL');
        state.wallets = state.wallets.filter((w) => w.id !== wallet.id);
        state.audit.push({ time: Date.now(), type: 'watch-removed', walletId: wallet.id });
        return { removed: true };
      });
    }
    if (action === 'asset.discover') {
      const network = this.networks.profile(input.chain, true);
      const wallet = this.wallet(input.id);
      const report = await discoverTokens(
        this.market,
        { venue: network.key, rpcUrl: network.rpc },
        {
          ...input,
          address: wallet.address,
        },
        context.signal,
      );
      this.networks.assert(network.key, network.revision);
      const current = this.wallet(input.id);
      if (current.address !== wallet.address) fail('WALLET_NOT_FOUND');
      const tracked = new Set(
        [network.usdc, network.weth, ...(current.trackedTokens?.[network.key] ?? [])]
          .filter(Boolean)
          .map((address) => address.toLowerCase()),
      );
      return {
        ...report,
        networkRevision: network.revision,
        items: report.items.map((row) => ({
          ...row,
          tracked: tracked.has(row.token.toLowerCase()),
        })),
      };
    }
    if (['assets', 'asset.track', 'asset.untrack'].includes(action)) {
      const network = this.networks.profile(input.chain);
      const wallet = this.wallet(input.id);
      if (action === 'assets') {
        const tokens = wallet.trackedTokens?.[input.chain] ?? [];
        return {
          ...(await this.market.tokenHoldings(
            { venue: input.chain },
            { address: wallet.address, tokens },
            { readSymbols: true },
          )),
          trackedTokens: tokens,
        };
      }
      const token = getAddress(input.token);
      if (token === ZeroAddress) fail('INVALID_ADDRESS');
      return this.mutate(
        (state) => {
          const wallet = this.wallet(input.id, state);
          const tokens = (wallet.trackedTokens?.[input.chain] ?? []).filter(
            (value) => value.toLowerCase() !== token.toLowerCase(),
          );
          if (
            action === 'asset.track' &&
            ![network.usdc, network.weth].includes(token.toLowerCase())
          )
            tokens.push(token);
          if (tokens.length > 16) fail('WALLET_ASSET_RANGE');
          wallet.trackedTokens = { ...wallet.trackedTokens, [input.chain]: tokens };
          return this.publicWallet(wallet);
        },
        input.expectedNetworkRevision === undefined
          ? undefined
          : () => this.networks.assert(input.chain, input.expectedNetworkRevision),
      );
    }
    if (action === 'policy.usage') {
      const wallet = this.wallet(input.id),
        policy = wallet.policy;
      if (!policy?.id || policy.nativeVersion !== 2) return null;
      return this.signer('authority.inspect', {
        id: wallet.id,
        policyId: policy.id,
        storeId: policy.nativeStoreId,
      });
    }
    if (action === 'balance') {
      const wallet = this.wallet(input.id);
      this.networks.profile(input.chain);
      return this.market.chainStatus({ venue: input.chain }, { address: wallet.address });
    }
    if (
      [
        'permit2.ordered.prepare',
        'permit2.signature.inspect',
        'permit2.signature.prepare',
      ].includes(action)
    ) {
      if (!Object.hasOwn(CHAINS, input.chain)) fail('WALLET_CHAIN_UNAVAILABLE');
      const wallet = this.wallet(input.id),
        config = { venue: input.chain };
      if (action === 'permit2.signature.inspect') {
        const observation = await this.market.permit2SignatureNonce(config, {
          address: wallet.address,
          nonce: input.nonce,
        });
        return { ...observation, commandId: 'permit2-signature:' + randomUUID() };
      }
      const context = { actor: 'frontend', approvalSimulation: 'permit2' };
      let data;
      if (action === 'permit2.ordered.prepare') {
        const token = getAddress(input.token),
          spender = getAddress(input.spender);
        if (token === ZeroAddress || spender === ZeroAddress) fail('INVALID_ADDRESS');
        const observed = nonceValue(input.nonce, MAX_ORDERED_NONCE - 1n);
        context.permit2Ordered = { token, spender, nonce: String(observed) };
        data = permit2.encodeFunctionData('invalidateNonces', [token, spender, observed + 1n]);
      } else {
        const { nonce, wordPos, mask } = unorderedNonce(input.nonce);
        context.permit2SignatureNonce = String(nonce);
        data = permit2.encodeFunctionData('invalidateUnorderedNonces', [wordPos, mask]);
      }
      return this.prepare(
        config,
        { walletId: wallet.id, commandId: input.commandId, to: PERMIT2, value: '0', data },
        context,
      );
    }
    if (['allowance.discover', 'allowance.inspect', 'allowance.revoke.prepare'].includes(action)) {
      if (!Object.hasOwn(CHAINS, input.chain)) fail('WALLET_CHAIN_UNAVAILABLE');
      const wallet = this.wallet(input.id);
      const config = { venue: input.chain };
      if (action === 'allowance.discover')
        return this.market.discoverTokenApprovals(config, { ...input, address: wallet.address });
      if (action === 'allowance.inspect') {
        const observation = await this.market.tokenAllowance(config, {
          address: wallet.address,
          token: input.token,
          spender: input.spender,
          protocol: input.protocol,
        });
        return { ...observation, commandId: 'allowance-revoke:' + randomUUID() };
      }
      const token = getAddress(input.token),
        spender = getAddress(input.spender);
      if (token === ZeroAddress || spender === ZeroAddress) fail('INVALID_ADDRESS');
      const layered = usesPermit2(input.protocol);
      return this.prepare(
        config,
        {
          walletId: wallet.id,
          commandId: input.commandId,
          to: layered ? PERMIT2 : token,
          value: '0',
          data: layered
            ? permit2.encodeFunctionData('lockdown', [[[token, spender]]])
            : erc20.encodeFunctionData('approve', [spender, 0n]),
        },
        { actor: 'frontend', approvalSimulation: layered ? 'permit2' : 'erc20' },
      );
    }
    if (action === 'unlock') {
      const emergencyGeneration = this.emergency.assert();
      const wallet = this.signingWallet(input.id),
        keystore = fs.readFileSync(
          path.join(this.directory, 'keystores', wallet.id + '.json'),
          'utf8',
        );
      const epoch = this.invalidateUnlock(wallet.id, 'WALLET_UNLOCK_CHANGED');
      const result = await this.signer('unlock', {
        id: wallet.id,
        keystore,
        password: input.password,
        minutes: input.minutes,
        expectedAddress: wallet.address,
      });
      if (this.unlockEpochs.get(wallet.id) !== epoch) fail('WALLET_UNLOCK_CHANGED');
      this.emergency.assert(emergencyGeneration);
      if (result.address.toLowerCase() !== wallet.address.toLowerCase())
        fail('WALLET_KEYSTORE_ADDRESS_MISMATCH');
      this.unlocked.set(wallet.id, result.until);
      this.emit();
      return this.publicWallet(wallet);
    }
    if (action === 'lock') {
      this.wallet(input.id);
      this.invalidateUnlock(input.id, 'WALLET_LOCKED');
      await this.signer('lock', { id: input.id });
      this.emit();
      return { ok: true };
    }
    if (action === 'password.change') {
      const wallet = this.signingWallet(input.id);
      if (
        typeof input.newPassword !== 'string' ||
        input.newPassword.length < 12 ||
        input.newPassword.length > 1024
      )
        fail('WALLET_PASSWORD_LENGTH');
      await this.request('policy.revoke', { id: wallet.id });
      const policyEpoch = this.policyEpochs.get(wallet.id);
      const epoch = this.invalidateUnlock(wallet.id, 'WALLET_LOCKED');
      await this.signer('lock', { id: wallet.id });
      const file = path.join(this.directory, 'keystores', wallet.id + '.json');
      const result = await this.signer('reencrypt', {
        id: wallet.id,
        keystore: fs.readFileSync(file, 'utf8'),
        password: input.password,
        newPassword: input.newPassword,
        expectedAddress: wallet.address,
      });
      if (result.address.toLowerCase() !== wallet.address.toLowerCase())
        fail('WALLET_KEYSTORE_ADDRESS_MISMATCH');
      await this.mutate((state) => {
        if (this.unlockEpochs.get(wallet.id) !== epoch) fail('WALLET_UNLOCK_CHANGED');
        if (this.policyEpochs.get(wallet.id) !== policyEpoch) fail('WALLET_AUTHORIZATION_CHANGED');
        writeAtomic(file, JSON.parse(result.keystore));
        state.audit.push({
          time: Date.now(),
          type: 'wallet-encryption-upgraded',
          walletId: wallet.id,
        });
      });
      this.emit();
      return { ok: true, locked: true };
    }
    if (action === 'policy.challenge') {
      this.emergency.assert();
      this.signingWallet(input.id);
      if (
        !Array.isArray(input.chains) ||
        !input.chains.length ||
        input.chains.length > 18 ||
        new Set(input.chains).size !== input.chains.length
      )
        fail('WALLET_CHAIN_UNAVAILABLE');
      const networks = input.chains.map((id) => this.networks.byId(id, true));
      if (networks.some((p) => !p.supportsType2)) fail('WALLET_NETWORK_TYPE');
      const hours = input.hours ?? 24;
      if (!Number.isInteger(hours) || hours < 0 || hours > 720) fail('WALLET_POLICY_DURATION');
      const cap = input.maxFeeEth ?? '0.01';
      if (typeof cap !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(cap)) fail('WALLET_FEE_CAP');
      parseEther(cap);
      const challenge = {
        id: randomUUID(),
        walletId: input.id,
        chains: [...new Set(input.chains)],
        networkRevisions: Object.fromEntries(networks.map((p) => [p.key, p.revision])),
        hours,
        maxFeeEth: cap,
        limits: policyRules.limits(input.limits),
        expiresAt: Date.now() + 120000,
      };
      if (
        [...challenge.limits.tokens, ...(challenge.limits.period?.tokens ?? [])].some(
          (token) => !challenge.chains.includes(token.chainId),
        )
      )
        fail('WALLET_POLICY_SCOPE_INVALID');
      this.challenges.set(challenge.id, challenge);
      return clone(challenge);
    }
    if (action === 'policy.grant') {
      const emergencyGeneration = this.emergency.assert();
      const challenge = this.challenges.get(input.challengeId);
      this.challenges.delete(input.challengeId);
      if (
        !challenge ||
        challenge.expiresAt < Date.now() ||
        input.ack !== 'ALLOW LIVE' ||
        input.confirmed !== true
      )
        fail('WALLET_CONFIRMATION_REQUIRED');
      const checkNetworks = () => {
        for (const [key, revision] of Object.entries(challenge.networkRevisions))
          this.networks.assert(key, revision);
      };
      checkNetworks();
      return this.changePolicy(challenge.walletId, async (epoch, generation) => {
        const policy = {
          id: randomUUID(),
          mode: 'autonomous',
          nativeVersion: 2,
          emergencyGeneration,
          chains: challenge.chains,
          networkRevisions: challenge.networkRevisions,
          confirmedAt: Date.now(),
          expiresAt: challenge.hours ? Date.now() + challenge.hours * 3600000 : 0,
          maxFeeEth: challenge.maxFeeEth,
          limits: challenge.limits,
        };
        const registered = await this.signer('authority.grant', {
          id: challenge.walletId,
          grant: {
            authorityVersion: 2,
            requireAgentScope: true,
            limits: policyRules.nativeLimits(policy.limits),
            generation,
            policyId: policy.id,
            walletId: challenge.walletId,
            address: this.wallet(challenge.walletId).address,
            chains: policy.chains,
            expiresAt: policy.expiresAt,
            maxFeeWei: parseEther(policy.maxFeeEth).toString(),
          },
        });
        if (!/^[a-f0-9]{64}$/.test(registered.storeId)) fail('WALLET_RECEIPT_REQUIRED');
        policy.nativeStoreId = registered.storeId;
        return this.mutate(
          (state) => {
            const wallet = this.wallet(challenge.walletId, state);
            wallet.policy = policy;
            state.audit.push({
              time: Date.now(),
              type: 'autonomous-live-authorized',
              walletId: wallet.id,
              policyId: wallet.policy.id,
            });
            return this.publicWallet(wallet);
          },
          () => {
            this.emergency.assert(emergencyGeneration);
            checkNetworks();
            if (this.policyEpochs.get(challenge.walletId) !== epoch)
              fail('WALLET_AUTHORIZATION_CHANGED');
          },
        );
      });
    }
    if (action === 'policy.revoke')
      return this.changePolicy(input.id, () =>
        this.mutate((state) => {
          const wallet = this.wallet(input.id, state);
          wallet.policy = { mode: 'manual', chains: [] };
          state.audit.push({
            time: Date.now(),
            type: 'autonomous-live-revoked',
            walletId: wallet.id,
          });
          return this.publicWallet(wallet);
        }),
      );
    if (action === 'intent.approve' || action === 'intent.deny') {
      if (action === 'intent.approve') this.emergency.assert();
      if (
        action === 'intent.approve' &&
        this.state.intents.find((i) => i.id === input.id)?.execution
      )
        fail('WALLET_EXECUTION_OWNER_REQUIRED');
      const intent = await this.decide(
        input.id,
        action === 'intent.approve',
        input.digest,
        input.replacementOf,
      );
      if (action === 'intent.approve' && intent.status === 'approved' && !intent.sourceApp)
        return this.broadcast(intent.id);
      return intent;
    }
    if (action === 'intent.reconcile') return this.reconcile(input.id);
    if (action === 'keystore.export') {
      const wallet = this.signingWallet(input.id);
      return {
        name: wallet.name + '.json',
        text: fs.readFileSync(path.join(this.directory, 'keystores', wallet.id + '.json'), 'utf8'),
      };
    }
    fail('UNKNOWN_WALLET_ACTION');
  }
  dispose() {
    const browserStopped = this.browser.dispose();
    this.apps.dispose();
    const messagesStopped = this.messages.dispose();
    this.disposed = true;
    const allowanceMonitorStopped = this.portfolios.allowanceMonitor.dispose();
    this.budgetEpoch++;
    for (const wake of this.budgetWake) wake();
    this.portfolios.challenges.clear();
    this.networks.challenges.clear();
    this.agentScopes.challenges.clear();
    for (const operation of this.inFlight.values())
      operation.controller.abort(new Error('WALLET_STOPPED'));
    clearInterval(this.monitorTimer);
    this.stopSigner('WALLET_STOPPED');
    this.unlocked.clear();
    for (const [id, finish] of this.waiters) finish({ id, status: 'cancelled' });
    this.waiters.clear();
    return Promise.allSettled([
      this.signerExit,
      messagesStopped,
      browserStopped,
      allowanceMonitorStopped,
    ]);
  }
}
function decodeCall(to, data, value, chainId) {
  if (data === '0x') return { kind: 'native-transfer', to, valueEth: formatEther(value) };
  const permit = describePermit2(to, data, value, chainId);
  if (permit) return permit;
  const chain = Object.values(CHAINS).find((chain) => chain.id === chainId);
  const token = (address) =>
    chain && address.toLowerCase() === chain.usdc
      ? { symbol: 'USDC', decimals: 6 }
      : chain && address.toLowerCase() === chain.weth
        ? { symbol: 'WETH', decimals: 18 }
        : null;
  try {
    const call = erc20.parseTransaction({ data });
    if (call) {
      const asset = token(to);
      return {
        kind: call.name,
        contract: to,
        recipient: call.args[0],
        rawTokenAmount: String(call.args[1]),
        deploymentRecognized: Boolean(asset),
        ...(!asset ? { calldata: data } : {}),
        unlimited: call.name === 'approve' && call.args[1] === 2n ** 256n - 1n,
        ...(asset
          ? { token: asset.symbol, tokenAmount: formatUnits(call.args[1], asset.decimals) }
          : {}),
      };
    }
  } catch {
    /* Unknown calldata is displayed verbatim and never described as a safe transfer. */
  }
  try {
    const { deployments, routerAbi } = require('../quant/base-swap');
    const deployment = Object.entries(CHAINS).find(([_key, value]) => value.id === chainId)?.[0];
    if (deployment && to.toLowerCase() === deployments[deployment].router) {
      const outer = routerAbi.parseTransaction({ data });
      const swap =
        outer?.name === 'multicall' && outer.args[1].length === 1
          ? routerAbi.parseTransaction({ data: outer.args[1][0] })
          : outer;
      if (swap?.name === 'exactInputSingle') {
        const args = swap.args[0],
          input = token(args.tokenIn),
          output = token(args.tokenOut);
        if (input && output)
          return {
            kind: 'uniswap-v3-swap',
            router: to,
            tokenIn: input.symbol,
            tokenOut: output.symbol,
            amountIn: formatUnits(args.amountIn, input.decimals),
            minimumAmountOut: formatUnits(args.amountOutMinimum, output.decimals),
            recipient: args.recipient,
            poolFee: Number(args.fee),
            deadline: outer.name === 'multicall' ? String(outer.args[0]) : null,
            valueEth: formatEther(value),
          };
      }
    }
  } catch {
    /* Only known deployments and the complete supported calldata are described as a swap. */
  }
  return {
    kind: 'contract-call',
    contract: to,
    selector: data.slice(0, 10),
    calldata: data,
    valueEth: formatEther(value),
  };
}
function safeError(error) {
  return /^[A-Z][A-Z_\d-]{1,100}$/.test(error.message || '')
    ? error.message
    : 'WALLET_TRANSACTION_FAILED';
}
module.exports = { WalletService, decodeCall };
