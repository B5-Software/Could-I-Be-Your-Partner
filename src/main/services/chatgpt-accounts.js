/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const crypto = require('node:crypto');
const http = require('node:http');
const { AccountVault } = require('./account-vault');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => crypto.randomBytes(32).toString('base64url');
const scopes = (value) =>
  Array.isArray(value)
    ? value
    : String(value || '')
        .split(/\s+/)
        .filter(Boolean);
const publicAccount = (account) => ({
  id: account.id,
  email: account.email,
  name: account.name,
  label: account.label,
  signedIn: !!account.accessToken,
  planEnabled: scopes(account.scope).includes('chatgpt.tokens.use.direct'),
});

async function validateIdToken(token, { clientId, nonce, subject, keys, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid OpenAI identity token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  const jwk = keys.find(
    (key) =>
      key.kid === header.kid &&
      key.kty === 'RSA' &&
      (!key.use || key.use === 'sig') &&
      (!key.alg || key.alg === 'RS256'),
  );
  if (
    header.alg !== 'RS256' ||
    header.crit ||
    !jwk ||
    !crypto.verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    )
  )
    throw new Error('OpenAI identity signature validation failed');
  if (
    claims.iss !== ISSUER ||
    ![claims.aud].flat().includes(clientId) ||
    (claims.azp && claims.azp !== clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= now ||
    (claims.nbf && claims.nbf * 1000 > now + 30000) ||
    !claims.sub ||
    (nonce !== undefined && claims.nonce !== nonce) ||
    (subject && claims.sub !== subject)
  )
    throw new Error('OpenAI identity validation failed');
  return claims;
}

class ChatGPTAccounts {
  constructor({
    file,
    vault,
    fetchImpl,
    openExternal,
    quotaReader = require('./codex-limits').readCodexLimits,
    onChange = () => {},
    loginTimeoutMs = 5 * 60 * 1000,
  }) {
    this.vault = vault || new AccountVault(file);
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.openExternal = openExternal;
    this.onChange = onChange;
    this.loginTimeoutMs = loginTimeoutMs;
    this.quotaReader = quotaReader;
    this.refreshes = new Map();
    this.controllers = new Map();
    this.pending = null;
    this.queue = Promise.resolve();
  }
  async init() {
    if (!this.loading)
      this.loading = (async () => {
        this.data = (await this.vault.load()) || {
          version: 1,
          hostId: 'urn:uuid:' + crypto.randomUUID(),
          activeId: null,
          accounts: [],
        };
        if (this.data.version !== 1 || !Array.isArray(this.data.accounts))
          throw new Error('Invalid ChatGPT account store');
      })();
    return this.loading;
  }
  mutate(fn) {
    const result = this.queue.then(async () => {
      await this.init();
      const previous = structuredClone(this.data);
      try {
        const value = await fn();
        await this.vault.save(this.data);
        this.changed();
        return value;
      } catch (error) {
        // Retain object identities used by pending refreshes, while rolling back failed writes.
        for (const old of previous.accounts) {
          const current = this.data.accounts.find((a) => a.id === old.id);
          if (current) {
            for (const key of Object.keys(current)) delete current[key];
            Object.assign(current, old);
          }
        }
        previous.accounts = previous.accounts.map(
          (old) => this.data.accounts.find((a) => a.id === old.id) || old,
        );
        this.data = previous;
        throw error;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  changed() {
    this.onChange(this.snapshot());
  }
  snapshot() {
    return {
      accounts: (this.data?.accounts || []).map(publicAccount),
      activeId: this.data?.activeId || null,
      pending: this.pending ? { id: this.pending.id, stage: this.pending.stage } : null,
      error: this.error || null,
    };
  }
  async status() {
    await this.init();
    return this.snapshot();
  }
  async request(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      const error = new Error(
        `OpenAI request failed (${response.status}${
          value.error?.code || value.error
            ? ': ' +
              String(value.error?.code || value.error)
                .replace(/[^\w.-]/g, '')
                .slice(0, 80)
            : ''
        })`,
      );
      error.status = response.status;
      error.oauthCode = value.error?.code || value.error;
      throw error;
    }
    return response;
  }
  async discovery() {
    if (!this.discoveryData) {
      const d = await (await this.request(ISSUER + '/.well-known/openid-configuration')).json();
      for (const key of [
        'authorization_endpoint',
        'token_endpoint',
        'jwks_uri',
        'revocation_endpoint',
      ]) {
        if (!d[key]) {
          if (key === 'revocation_endpoint') continue;
          throw new Error('Incomplete OpenAI discovery');
        }
        if (new URL(d[key]).origin !== ISSUER) throw new Error('Invalid OpenAI discovery endpoint');
      }
      if (d.issuer !== ISSUER) throw new Error('Invalid OpenAI issuer');
      this.discoveryData = d;
    }
    return this.discoveryData;
  }
  async identity(token, expected) {
    const d = await this.discovery();
    const jwks = await (await this.request(d.jwks_uri)).json();
    return validateIdToken(token, { ...expected, keys: jwks.keys || [] });
  }
  async login(accountId) {
    if (this.disposed || this.startingLogin)
      throw new Error('A ChatGPT login is already starting or the application is closing');
    this.startingLogin = true;
    const generation = (this.loginGeneration = (this.loginGeneration || 0) + 1);
    try {
      await this.init();
      this.cancelLogin(false);
      this.error = null;
      const selected = accountId ? this.data.accounts.find((a) => a.id === accountId) : null;
      if (accountId && !selected) throw new Error('ChatGPT account not found');
      const d = await this.discovery();
      await this.vault.save(this.data);
      if (this.disposed || this.loginGeneration !== generation) throw new Error('Login cancelled');
      const pending = {
        id: crypto.randomUUID(),
        selected,
        state: random(),
        nonce: random(),
        verifier: random(),
        stage: 'waiting',
        controller: new AbortController(),
      };
      const server = http.createServer((req, res) => this.callback(req, res, pending));
      pending.server = server;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      if (this.disposed || this.loginGeneration !== generation) {
        server.close();
        throw new Error('Login cancelled');
      }
      server.on('error', () => {
        if (this.pending === pending) this.failLogin(pending, 'Login callback listener failed');
      });
      pending.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      pending.timer = setTimeout(
        () => this.failLogin(pending, 'ChatGPT login timed out; please try again'),
        this.loginTimeoutMs,
      );
      pending.timer.unref();
      this.pending = pending;
      const url = new URL(d.authorization_endpoint);
      const params = {
        client_id: selected?.clientId || 'dynamic_agent_client',
        ext_agent_host_id: this.data.hostId,
        response_type: 'code',
        redirect_uri: pending.redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state: pending.state,
        nonce: pending.nonce,
        code_challenge_method: 'S256',
        code_challenge: crypto.createHash('sha256').update(pending.verifier).digest('base64url'),
      };
      if (!selected) params.agent_name_hint = 'Could I Be Your Partner';
      if (selected?.idToken) params.id_token_hint = selected.idToken;
      if (selected?.email) params.login_hint = selected.email;
      // Missing plan consent can be granted from settings during explicit reauthorization.
      if (selected && !publicAccount(selected).planEnabled) params.prompt = 'consent';
      url.search = new URLSearchParams(params).toString();
      this.changed();
      try {
        await this.openExternal(url.href);
      } catch {
        this.failLogin(pending, 'Cannot open the browser for ChatGPT login');
        throw new Error(this.error);
      }
      return { ok: true, loginId: pending.id };
    } finally {
      this.startingLogin = false;
    }
  }
  cancelLogin(invalidate = true) {
    if (invalidate) this.loginGeneration = (this.loginGeneration || 0) + 1;
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.controller.abort();
    p.server.close();
    if (!p.consumed) p.server.closeAllConnections?.();
    this.changed();
  }
  failLogin(pending, error) {
    if (this.pending !== pending) return;
    this.error = error;
    this.cancelLogin();
  }
  async callback(req, res, pending) {
    const reply = (status, message) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Referrer-Policy': 'no-referrer',
      });
      res.end(
        `<html><body style="font:16px system-ui;padding:48px"><h1>Could I Be Your Partner</h1><p>${message}</p></body></html>`,
      );
    };
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== '/auth/callback') return reply(404, 'Not found');
    if (
      this.pending !== pending ||
      pending.consumed ||
      u.searchParams.get('state') !== pending.state
    )
      return reply(400, 'Invalid or expired login attempt.');
    pending.consumed = true;
    if (u.searchParams.has('error')) {
      reply(400, 'Authorization was declined. Return to CIBYP to try again.');
      this.failLogin(pending, 'ChatGPT authorization was declined');
      return;
    }
    pending.stage = 'verifying';
    this.changed();
    try {
      const clientId = u.searchParams.get('client_id') || pending.selected?.clientId;
      const code = u.searchParams.get('code');
      if (
        !code ||
        !clientId ||
        clientId === 'dynamic_agent_client' ||
        (pending.selected && clientId !== pending.selected.clientId)
      )
        throw new Error('Incomplete or mismatched ChatGPT registration');
      const d = await this.discovery();
      const tokens = await (
        await this.request(d.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: pending.verifier,
            redirect_uri: pending.redirectUri,
            resource: RESOURCE,
          }),
          signal: AbortSignal.any([pending.controller.signal, AbortSignal.timeout(20000)]),
        })
      ).json();
      const claims = await this.identity(tokens.id_token, {
        clientId,
        nonce: pending.nonce,
        subject: pending.selected?.subject,
      });
      if (
        !tokens.access_token ||
        !Number.isFinite(tokens.expires_in) ||
        tokens.expires_in <= 0 ||
        tokens.token_type?.toLowerCase() !== 'bearer'
      )
        throw new Error('Invalid ChatGPT credential response');
      await this.mutate(() => {
        if (this.pending !== pending) throw new Error('Login cancelled');
        const id = crypto
          .createHash('sha256')
          .update(clientId + '\0' + claims.sub)
          .digest('hex')
          .slice(0, 24);
        const existing = this.data.accounts.find((a) => a.id === id);
        const account = {
          id,
          clientId,
          subject: claims.sub,
          email: claims.email || '',
          name: claims.name || '',
          label: claims.email || claims.name || 'ChatGPT',
          codexAccountId: claims['https://api.openai.com/auth']?.chatgpt_account_id,
          planType: claims['https://api.openai.com/auth']?.chatgpt_plan_type,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token,
          scope: scopes(tokens.scope),
          expiresAt: Date.now() + tokens.expires_in * 1000,
          earliestRefreshAt: tokens.earliest_refresh_at,
        };
        if (existing) Object.assign(existing, account);
        else this.data.accounts.push(account);
        this.stopRequests();
        this.data.activeId = id;
      });
      reply(200, 'Signed in. You can close this page and return to CIBYP.');
      this.cancelLogin();
    } catch (error) {
      reply(400, 'Sign-in failed. Return to CIBYP for details.');
      this.failLogin(pending, error.message);
    }
  }
  stopRequests(id) {
    this.limitCache = null;
    for (const [controller, owner] of this.controllers) if (!id || owner === id) controller.abort();
  }
  async switchAccount(id) {
    this.cancelLogin();
    return this.mutate(() => {
      const account = this.data.accounts.find((a) => a.id === id);
      if (!account?.accessToken) throw new Error('Sign in to this ChatGPT account first');
      this.stopRequests();
      this.data.activeId = id;
      return { ok: true };
    });
  }
  async logout(id) {
    await this.init();
    this.cancelLogin();
    const account = this.data.accounts.find((a) => a.id === (id || this.data.activeId));
    if (!account) return { ok: true, revoked: true };
    this.stopRequests(account.id);
    const token = account.refreshToken;
    let revoked = !token;
    // Clear credentials before network I/O, so no new inference/refresh can start.
    await this.mutate(() => {
      delete account.accessToken;
      delete account.refreshToken;
      delete account.idToken;
      account.scope = [];
      if (this.data.activeId === account.id) this.data.activeId = null;
    });
    if (token) {
      try {
        const d = await this.discovery();
        if (d.revocation_endpoint) {
          await this.request(d.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token,
              token_type_hint: 'refresh_token',
              client_id: account.clientId,
            }),
          });
          revoked = true;
        }
      } catch {
        /* local logout remains effective */
      }
    }
    return { ok: true, revoked };
  }
  async accessToken(id, force = false) {
    await this.init();
    const account = this.data.accounts.find((a) => a.id === (id || this.data.activeId));
    if (!account?.accessToken)
      throw new Error('Please sign in with ChatGPT in Model & connection settings');
    if (!publicAccount(account).planEnabled)
      throw new Error('ChatGPT plan usage is not enabled; authorize it in settings');
    if (!force && account.expiresAt > Date.now() + 60000) return account.accessToken;
    const earliest =
      typeof account.earliestRefreshAt === 'number'
        ? account.earliestRefreshAt * (account.earliestRefreshAt > 1e12 ? 1 : 1000)
        : Date.parse(account.earliestRefreshAt);
    if (Number.isFinite(earliest) && earliest > Date.now()) {
      if (!force && account.expiresAt > Date.now()) return account.accessToken;
      throw new Error('ChatGPT credential renewal is not available yet; try again later');
    }
    if (this.refreshes.has(account.id)) return this.refreshes.get(account.id);
    const old = account.refreshToken;
    if (!old) throw new Error('ChatGPT sign-in expired; sign in again');
    const refresh = (async () => {
      try {
        const d = await this.discovery();
        const tokens = await (
          await this.request(d.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: account.clientId,
              refresh_token: old,
              resource: RESOURCE,
            }),
          })
        ).json();
        if (tokens.id_token)
          await this.identity(tokens.id_token, {
            clientId: account.clientId,
            subject: account.subject,
          });
        if (
          !tokens.access_token ||
          !tokens.refresh_token ||
          !Number.isFinite(tokens.expires_in) ||
          tokens.expires_in <= 0 ||
          (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')
        )
          throw new Error('Invalid renewed ChatGPT credentials');
        await this.mutate(() => {
          if (account.refreshToken !== old) throw new Error('ChatGPT session changed');
          Object.assign(account, {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + tokens.expires_in * 1000,
            earliestRefreshAt: tokens.earliest_refresh_at,
            ...(tokens.scope ? { scope: scopes(tokens.scope) } : {}),
            ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
          });
        });
        if (!publicAccount(account).planEnabled)
          throw new Error('ChatGPT plan permission was revoked');
        return account.accessToken;
      } catch (error) {
        if (error.oauthCode === 'invalid_grant' || error.status === 401)
          await this.mutate(() => {
            if (account.refreshToken !== old) return;
            this.stopRequests(account.id);
            delete account.accessToken;
            delete account.refreshToken;
            delete account.idToken;
            account.scope = [];
          });
        throw error;
      } finally {
        this.refreshes.delete(account.id);
      }
    })();
    this.refreshes.set(account.id, refresh);
    return refresh;
  }
  async lease(force = false, expectedId) {
    await this.init();
    const id = this.data.activeId;
    if (expectedId && expectedId !== id) throw new Error('ChatGPT account changed');
    const token = await this.accessToken(id, force);
    if (id !== this.data.activeId) throw new Error('ChatGPT account changed');
    const controller = new AbortController();
    this.controllers.set(controller, id);
    return {
      id,
      token,
      signal: controller.signal,
      release: () => this.controllers.delete(controller),
    };
  }
  async models() {
    const lease = await this.lease();
    try {
      const data = await (
        await this.request(RESOURCE + '/models', {
          headers: { Authorization: 'Bearer ' + lease.token },
          signal: AbortSignal.any([lease.signal, AbortSignal.timeout(15000)]),
        })
      ).json();
      if (!Array.isArray(data.models))
        throw new Error('OpenAI returned an unsupported account model catalog');
      const list = data.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string');
      return {
        ok: true,
        models: list.map((m) => ({
          id: m.slug,
          name: m.display_name || m.slug,
          contextLength: m.context_window || m.context_length || null,
          vision: m.supports_image_input === true,
        })),
      };
    } finally {
      lease.release();
    }
  }
  async limits(force = false) {
    await this.init();
    if (this.limitPending?.id === this.data.activeId) return this.limitPending.promise;
    const promise = this.readLimits(force);
    this.limitPending = { id: this.data.activeId, promise };
    try {
      return await promise;
    } finally {
      if (this.limitPending?.promise === promise) this.limitPending = null;
    }
  }
  async readLimits(force = false) {
    await this.init();
    const id = this.data.activeId;
    if (!force && this.limitCache?.id === id && Date.now() - this.limitCache.at < 60000)
      return this.limitCache.value;
    const lease = await this.lease();
    try {
      const account = this.data.accounts.find((a) => a.id === id);
      const result = await this.quotaReader({
        token: lease.token,
        accountId: account.codexAccountId,
        planType: account.planType,
        signal: lease.signal,
      });
      if (lease.signal.aborted || this.data.activeId !== id)
        throw new Error('ChatGPT account changed');
      this.limitCache = { id, at: Date.now(), value: result };
      return result;
    } finally {
      lease.release();
    }
  }
  async consumeReset({ accountId, creditId } = {}, confirm) {
    await this.init();
    if (!accountId || accountId !== this.data.activeId) throw new Error('ChatGPT account changed');
    if (typeof confirm !== 'function') throw new Error('Manual confirmation is required');
    if (this.resetBusy) throw new Error('A reset request is already pending');
    this.resetBusy = true;
    try {
      const result = await this.limits(true);
      if (!result.ok) throw new Error(result.error);
      const credits = result.rateLimitResetCredits;
      if (!(credits?.availableCount > 0))
        throw new Error('No usage-limit reset credits are available');
      const card = creditId
        ? credits.credits?.find((card) => card.id === creditId && card.status === 'available')
        : null;
      if (creditId && (!card || (card.expiresAt && card.expiresAt * 1000 <= Date.now())))
        throw new Error('This reset credit is unavailable or expired');
      const account = this.data.accounts.find((a) => a.id === accountId);
      if (!account || this.data.activeId !== accountId) throw new Error('ChatGPT account changed');
      if (
        !(await confirm({
          account: publicAccount(account),
          card,
          availableCount: credits.availableCount,
        }))
      )
        return { ok: true, cancelled: true };
      const lease = await this.lease(false, accountId);
      try {
        // Retain the same key after an ambiguous failure, so an explicit retry cannot spend another card.
        this.resetKeys ||= new Map();
        const key = accountId + ':' + (creditId || 'next');
        const idempotencyKey = this.resetKeys.get(key) || crypto.randomUUID();
        this.resetKeys.set(key, idempotencyKey);
        const response = await this.quotaReader({
          token: lease.token,
          accountId: account.codexAccountId,
          planType: account.planType,
          signal: lease.signal,
          consume: { idempotencyKey, creditId },
        });
        this.limitCache = null;
        if (response.ok && response.redemption) this.resetKeys.delete(key);
        if (lease.signal.aborted || this.data.activeId !== accountId)
          throw new Error('ChatGPT account changed');
        if (response.limits)
          this.limitCache = { id: accountId, at: Date.now(), value: response.limits };
        return response;
      } finally {
        lease.release();
      }
    } finally {
      this.resetBusy = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.cancelLogin();
    this.stopRequests();
  }
}
module.exports = { ChatGPTAccounts, validateIdToken };
