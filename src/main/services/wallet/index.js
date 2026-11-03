/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { NativeSigner } = require('./native-signer');
const policyRules = require('./policy');
const { WalletAgentScopes, rootContext } = require('./agent-scopes');
const { randomUUID, createHash } = require('node:crypto');
const {
  Interface,
  Transaction,
  parseEther,
  formatEther,
  formatUnits,
  keccak256,
  getAddress,
} = require('ethers');
const { writeAtomic } = require('../quant');
const { MarketData, CHAINS } = require('../quant/market-data');
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

class WalletService {
  constructor({ directory, publish = () => {}, fetcher, signer, onEmergencyHalt = () => {} } = {}) {
    if (!directory) fail('WALLET_STORAGE_UNAVAILABLE');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      fail('WALLET_STORAGE_UNAVAILABLE');
    this.directory = directory;
    this.publish = publish;
    this.onEmergencyHalt = onEmergencyHalt;
    this.market = new MarketData(fetcher);
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
      let changed = false;
      for (const intent of this.state.intents) {
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
    this.monitorCursor = 0;
    this.monitorTimer = setInterval(() => {
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
          i.status === 'signing-unknown' ||
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
      this.publish({ type: 'wallet-changed' });
    } catch {
      /* Durable state is authoritative. */
    }
  }
  mutate(fn, guard) {
    const result = this.queue.then(async () => {
      if (this.disposed) fail('WALLET_STOPPED');
      const next = clone(this.state),
        value = await fn(next);
      guard?.();
      writeAtomic(this.file, next);
      this.state = next;
      this.emit();
      return clone(value);
    });
    this.queue = result.catch(() => {});
    return result;
  }
  wallet(id, state = this.state) {
    return state.wallets.find((w) => w.id === id) || fail('WALLET_NOT_FOUND');
  }
  emergencyStatus() {
    return {
      ...this.emergency.status(),
      nativePausePending: Boolean(this.emergencyPausePending),
      nativePauseError: this.emergencyPauseError || null,
      needsReconciliation: this.state.intents.filter(
        (i) =>
          (i.hash || i.status === 'signing-unknown') &&
          i.submissionMayHaveOccurred !== false &&
          i.status !== 'finalized' &&
          !(i.status === 'reverted' && i.confirmation === 'finalized'),
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
    const p = wallet.policy;
    return !this.policyFences.has(wallet.id) &&
      !this.emergency.blocked(wallet) &&
      p?.mode === 'autonomous' &&
      p.nativeVersion === 2 &&
      p.chains.includes(CHAINS[chain]?.id) &&
      (!p.expiresAt || p.expiresAt > Date.now())
      ? p
      : null;
  }
  isUnlocked(id) {
    if (this.emergency.halted) return false;
    const until = this.unlocked.get(id);
    return until !== undefined && (!until || until > Date.now());
  }
  abortWallet(id, reason, policyOnly = false) {
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
    this.wallet(id);
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
      createdAt: w.createdAt,
      unlocked: this.isUnlocked(w.id),
      unlockedUntil: this.unlocked.get(w.id) ?? null,
      policy,
      portfolioBlocked: this.portfolios.fences.has(w.id),
    };
  }
  publicIntent(intent, details = true) {
    const { config: _config, nativeSigning: _nativeSigning, ...safe } = clone(intent);
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
  async create(input, importing = false) {
    if (
      typeof input.password !== 'string' ||
      input.password.length < 12 ||
      input.password.length > 1024
    )
      fail('WALLET_PASSWORD_LENGTH');
    const id = randomUUID();
    const result = await this.signer(importing ? 'import' : 'create', {
      id,
      password: input.password,
      kind: input.kind,
      secret: input.secret,
      sourcePassword: input.sourcePassword,
    });
    const address = getAddress(result.address);
    const wallet = await this.mutate((state) => {
      if (state.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase()))
        fail('WALLET_ALREADY_IMPORTED');
      const record = {
        id,
        address,
        name: String(input.name || 'Wallet').slice(0, 100),
        createdAt: Date.now(),
        policy: { mode: 'manual', chains: [] },
      };
      writeAtomic(
        path.join(this.directory, 'keystores', id + '.json'),
        JSON.parse(result.keystore),
      );
      state.wallets.push(record);
      state.audit.push({
        time: Date.now(),
        type: importing ? 'wallet-imported' : 'wallet-created',
        walletId: id,
      });
      return record;
    });
    return {
      ...this.publicWallet(wallet),
      ...(result.mnemonic ? { mnemonic: result.mnemonic } : {}),
    };
  }
  async prepare(config, input, context = { actor: 'frontend' }) {
    const emergencyGeneration = this.emergency.assert();
    const chain = CHAINS[config.venue];
    if (!chain) fail('WALLET_CHAIN_UNAVAILABLE');
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
              context.agentContext || rootContext(context.workspaceId),
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
    };
    const fingerprint = digest(request);
    return this.mutate(
      async (state) => {
        const wallet = this.wallet(walletId, state);
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
        this.checkExecutionContext(context, state, wallet, config.venue);
        const rpc = (method, params) =>
          this.market.rpc(config.venue, config.rpcUrl, method, params, { signal: context.signal });
        if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chain.id)) fail('CHAIN_ID_MISMATCH');
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
        const unsigned = Transaction.from(transaction).unsignedSerialized;
        const l1Data = oracle.encodeFunctionData('getL1Fee', [unsigned]);
        const result = await rpc('eth_call', [
          { to: '0x420000000000000000000000000000000000000f', data: l1Data },
          'latest',
        ]);
        const l1 = oracle.decodeFunctionResult('getL1Fee', result)[0];
        // L1 is an estimate (not a protocol-enforced maximum). Reserve headroom,
        // expose that distinction and never offer a false exact "send max".
        const reserveL1 = l1 * 2n + parseEther('0.00001'),
          feeReserve = gasLimit * maxFee + reserveL1;
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
        if (value + feeReserve + reserved > BigInt(balance)) fail('WALLET_INSUFFICIENT_BALANCE');
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
          workspaceId: context.workspaceId || null,
          transaction,
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
          executionFeeMaxWei: String(gasLimit * maxFee),
          feeEstimateIsNotGuaranteed: true,
          status: policy && (!replacementOf || canReplace) ? 'approved' : 'approval-required',
          authorization:
            policy && (!replacementOf || canReplace)
              ? { mode: 'autonomous', policyId: policy.id }
              : { mode: 'manual' },
        };
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
      () => this.emergency.assert(emergencyGeneration),
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
      autonomous: claimed.authorization.mode === 'autonomous',
      agentScope: claimed.agentScope,
      controller,
    };
    this.inFlight.set(id, operation);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const authorized = (state = this.state) => {
      if (this.disposed) fail('WALLET_STOPPED');
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
      await this.mutate((state) => {
        authorized(state);
        state.intents.find((i) => i.id === id).nativeSigning = nativeSigning;
      });
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
      authorized();
      await this.mutate((state) => {
        authorized(state);
        const intent = state.intents.find((i) => i.id === id);
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
        const uncertain =
          signingInvoked &&
          !signatureReturned &&
          !/^WALLET_(?:UNLOCK_CHANGED|AUTHORIZATION_CHANGED|OPERATION_CANCELLED|EMERGENCY_STOPPED|EMERGENCY_CHANGED)$/.test(
            code,
          );
        if (uncertain) delete intent.submissionMayHaveOccurred;
        else intent.submissionMayHaveOccurred = attempted;
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
    if (intent.status === 'signing-unknown' && !this.inFlight.has(id)) {
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
        if (record.status !== 'signing-unknown') return;
        if (result.found) {
          record.hash = result.receipt.hash;
          record.status = 'submit-unknown';
          record.submissionMayHaveOccurred = true;
        } else {
          record.status = 'expired';
          record.submissionMayHaveOccurred = false;
        }
        delete record.error;
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
    const status = await this.market.chainStatus(intent.config, { hash: intent.hash }, { signal });
    return this.mutate((state) => {
      const record = state.intents.find((i) => i.id === id),
        result = status.transaction;
      if (result.state !== 'pending-or-unknown') {
        record.status = result.state;
        record.block = result.block;
        record.confirmation = result.confirmation;
      } else if (['included', 'safe', 'finalized'].includes(record.status))
        record.status = 'reorged';
      record.lastReconciledAt = Date.now();
      return this.publicIntent(record);
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
  async request(action, input = {}) {
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
    if (action.startsWith('portfolio.')) return this.portfolios.request(action.slice(10), input);
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
      if (!CHAINS[input.chain]) fail('WALLET_CHAIN_UNAVAILABLE');
      return this.market.chainStatus({ venue: input.chain }, { address: wallet.address });
    }
    if (action === 'unlock') {
      const emergencyGeneration = this.emergency.assert();
      const wallet = this.wallet(input.id),
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
      const wallet = this.wallet(input.id);
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
      this.wallet(input.id);
      if (
        !Array.isArray(input.chains) ||
        !input.chains.length ||
        input.chains.some((id) => ![8453, 84532].includes(id))
      )
        fail('WALLET_CHAIN_UNAVAILABLE');
      const hours = input.hours ?? 24;
      if (!Number.isInteger(hours) || hours < 0 || hours > 720) fail('WALLET_POLICY_DURATION');
      const cap = input.maxFeeEth ?? '0.01';
      if (typeof cap !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(cap)) fail('WALLET_FEE_CAP');
      parseEther(cap);
      const challenge = {
        id: randomUUID(),
        walletId: input.id,
        chains: [...new Set(input.chains)],
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
      return this.changePolicy(challenge.walletId, async (epoch, generation) => {
        const policy = {
          id: randomUUID(),
          mode: 'autonomous',
          nativeVersion: 2,
          emergencyGeneration,
          chains: challenge.chains,
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
      if (action === 'intent.approve' && intent.status === 'approved')
        return this.broadcast(intent.id);
      return intent;
    }
    if (action === 'intent.reconcile') return this.reconcile(input.id);
    if (action === 'keystore.export') {
      const wallet = this.wallet(input.id);
      return {
        name: wallet.name + '.json',
        text: fs.readFileSync(path.join(this.directory, 'keystores', wallet.id + '.json'), 'utf8'),
      };
    }
    fail('UNKNOWN_WALLET_ACTION');
  }
  dispose() {
    this.disposed = true;
    this.budgetEpoch++;
    for (const wake of this.budgetWake) wake();
    this.portfolios.challenges.clear();
    this.agentScopes.challenges.clear();
    for (const operation of this.inFlight.values())
      operation.controller.abort(new Error('WALLET_STOPPED'));
    clearInterval(this.monitorTimer);
    this.stopSigner('WALLET_STOPPED');
    this.unlocked.clear();
    for (const [id, finish] of this.waiters) finish({ id, status: 'cancelled' });
    this.waiters.clear();
    return this.signerExit;
  }
}
function decodeCall(to, data, value, chainId) {
  if (data === '0x') return { kind: 'native-transfer', to, valueEth: formatEther(value) };
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
