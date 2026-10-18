const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ChatGPTAccounts, validateIdToken } = require('../../src/main/services/chatgpt-accounts');
const { AccountVault } = require('../../src/main/services/account-vault');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};

test('direct ChatGPT plan grants remain usable without a legacy Codex account identifier', async (t) => {
  const f = fixture({
    service: {
      quotaReader: async () => {
        throw new Error('Must not invoke legacy quota RPC');
      },
    },
  });
  t.after(() => f.service.dispose());
  await f.service.login();
  await f.complete();
  const limits = await f.service.limits();
  assert.equal(limits.ok, true);
  assert.equal(limits.unavailable, true);
  assert.equal(limits.manageUrl, 'https://chatgpt.com/settings/usage');
  assert.doesNotMatch(limits.message, /account identifier/);
  assert.equal((await f.service.models()).models[0].id, 'visible-model');
  const lease = await f.service.lease();
  try {
    assert.equal(lease.token, 'fixture-access');
  } finally {
    lease.release();
  }
});
const claims = {
  iss: 'https://auth.openai.com',
  aud: 'oaiapp_fixture',
  sub: 'fixture-person',
  nonce: 'fixture-nonce',
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: 'fixture@example.invalid',
};
function jwt(payload) {
  const data = [{ alg: 'RS256', kid: jwk.kid }, payload]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  return (
    data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')
  );
}
function fixture(overrides = {}) {
  let stored = null;
  let opened;
  const changes = [];
  const service = new ChatGPTAccounts({
    vault: {
      load: async () => stored,
      save: async (value) => {
        stored = structuredClone(value);
      },
    },
    openExternal: async (url) => {
      opened = new URL(url);
    },
    onChange: (state) => changes.push(state),
    fetchImpl: async (url, options = {}) => {
      const json = (value) =>
        new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('openid-configuration'))
        return json({
          issuer: claims.iss,
          authorization_endpoint: claims.iss + '/api/accounts/authorize',
          token_endpoint: claims.iss + '/api/accounts/oauth/token',
          jwks_uri: claims.iss + '/jwks',
          revocation_endpoint: claims.iss + '/revoke',
        });
      if (url.endsWith('/jwks')) return json({ keys: [jwk] });
      if (url.endsWith('/revoke')) return json({});
      if (url.endsWith('/oauth/token')) {
        if (overrides.token) return overrides.token(options);
        assert.equal(options.body.get('client_id'), claims.aud);
        assert.equal(options.body.get('redirect_uri'), opened.searchParams.get('redirect_uri'));
        assert.equal(
          crypto.createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),
          opened.searchParams.get('code_challenge'),
        );
        return json({
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          id_token: jwt({ ...claims, nonce: opened.searchParams.get('nonce') }),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        });
      }
      if (url.endsWith('/models'))
        return json({
          models: [
            {
              slug: 'visible-model',
              display_name: 'Visible',
              visibility: 'list',
              context_window: 200000,
            },
            { slug: 'internal', visibility: 'hidden' },
          ],
        });
      throw new Error('Unmocked account network request');
    },
    ...overrides.service,
  });
  return {
    service,
    changes,
    get stored() {
      return stored;
    },
    get opened() {
      return opened;
    },
    async complete(params = {}) {
      const url = new URL(opened.searchParams.get('redirect_uri'));
      url.search = new URLSearchParams({
        state: opened.searchParams.get('state'),
        code: 'fixture-code',
        client_id:
          opened.pathname === '/oauth/authorize' ? 'app_EMoamEEZ73f0CkXaXp7hrann' : claims.aud,
        ...params,
      });
      return fetch(url);
    },
  };
}
test('identity validation rejects wrong nonce, audience, subject, expiry and signature', async () => {
  const expected = { clientId: claims.aud, nonce: claims.nonce, subject: claims.sub, keys: [jwk] };
  assert.equal((await validateIdToken(jwt(claims), expected)).sub, claims.sub);
  for (const bad of [
    { nonce: 'wrong' },
    { aud: 'wrong' },
    { sub: 'wrong' },
    { exp: 1 },
    { iss: 'https://example.invalid' },
  ])
    await assert.rejects(validateIdToken(jwt({ ...claims, ...bad }), expected));
  const token = jwt(claims);
  await assert.rejects(validateIdToken(token.slice(0, -20) + 'x'.repeat(20), expected));
});

test('explicit Codex quota connection verifies the same identity and never replaces direct-plan inference credentials', async (t) => {
  let seen;
  const f = fixture({
    service: {
      quotaHttpReader: async (options) => {
        seen = options;
        return {
          ok: true,
          rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, windowDurationMins: 300 } } },
        };
      },
    },
  });
  t.after(() => f.service.dispose());
  await f.service.login();
  await f.complete();
  const signed = jwt({
    ...claims,
    aud: 'app_EMoamEEZ73f0CkXaXp7hrann',
    'https://api.openai.com/auth': { chatgpt_account_id: 'selected-account' },
  });
  const input = {
    tokens: {
      id_token: signed,
      access_token: signed,
      refresh_token: 'quota-refresh',
      account_id: 'selected-account',
    },
  };
  await f.service.importCodexQuota(input);
  assert.equal(f.stored.accounts[0].codexQuota.refreshToken, undefined);
  assert.equal(f.stored.accounts[0].codexQuota.ownedGrant, false);
  const result = await f.service.limits(true);
  assert.equal(result.rateLimitsByLimitId.codex.primary.usedPercent, 20);
  assert.equal(seen.accountId, 'selected-account');
  assert.equal(seen.token, signed);
  const lease = await f.service.lease();
  assert.equal(lease.token, 'fixture-access');
  lease.release();
  assert.ok(!JSON.stringify(await f.service.status()).includes('quota-refresh'));
  await assert.rejects(
    f.service.importCodexQuota({
      tokens: {
        ...input.tokens,
        id_token: jwt({ ...claims, aud: 'app_EMoamEEZ73f0CkXaXp7hrann', sub: 'other-person' }),
      },
    }),
    /identity validation/,
  );
  f.service.data.accounts[0].codexQuota.expiresAt = 0;
  await assert.rejects(f.service.limits(true), /reconnect/);
  // The read-only import must never rotate the original client's refresh token.
  assert.equal(f.stored.accounts[0].refreshToken, 'fixture-refresh');
  await f.service.logout();
  assert.ok(!f.stored.accounts[0].codexQuota);
});
test('independent quota OAuth owns its refresh grant, preserves inference login and rejects a different identity', async (t) => {
  const codexId = 'app_EMoamEEZ73f0CkXaXp7hrann';
  let otherIdentity = false;
  let refreshed = 0;
  let seen;
  const f = fixture({
    token: async (options) => {
      const client = options.body.get('client_id');
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.equal(client, codexId);
        assert.equal(options.body.get('refresh_token'), 'owned-quota-refresh');
        ++refreshed;
        return Response.json({
          access_token: 'quota-rotated',
          refresh_token: 'owned-quota-rotated',
          expires_in: 3600,
        });
      }
      assert.equal(
        crypto.createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),
        f.opened.searchParams.get('code_challenge'),
      );
      const quota = client === codexId;
      assert.equal(options.body.has('resource'), !quota);
      return Response.json({
        access_token: quota ? 'quota-access' : 'fixture-access',
        refresh_token: quota ? 'owned-quota-refresh' : 'fixture-refresh',
        id_token: jwt({
          ...claims,
          aud: client,
          sub: otherIdentity ? 'other-person' : claims.sub,
          nonce: f.opened.searchParams.get('nonce'),
          ...(quota
            ? { 'https://api.openai.com/auth': { chatgpt_account_id: 'quota-account' } }
            : {}),
        }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'chatgpt.tokens.use.direct',
      });
    },
    service: {
      quotaHttpReader: async (options) => {
        seen = options;
        return { ok: true, windows: [] };
      },
    },
  });
  t.after(() => f.service.dispose());
  await f.service.login();
  await f.complete();
  const accountId = f.service.data.activeId;
  await f.service.login(accountId, { quota: true });
  assert.equal(f.opened.origin + f.opened.pathname, claims.iss + '/oauth/authorize');
  assert.equal(f.opened.searchParams.get('originator'), 'cibyp');
  assert.equal(f.opened.searchParams.get('client_id'), codexId);
  assert.equal(f.opened.searchParams.has('id_token_hint'), false);
  assert.equal(f.opened.searchParams.has('resource'), false);
  assert.ok([1455, 1457].includes(Number(new URL(f.opened.searchParams.get('redirect_uri')).port)));
  assert.equal((await f.complete()).status, 200);
  assert.equal(f.stored.accounts[0].codexQuota.ownedGrant, true);
  assert.equal(f.stored.accounts[0].accessToken, 'fixture-access');
  f.service.data.accounts[0].codexQuota.expiresAt = 0;
  await f.service.limits(true);
  assert.equal(refreshed, 1);
  assert.equal(seen.token, 'quota-rotated');
  assert.equal(seen.accountId, 'quota-account');
  assert.equal(f.stored.accounts[0].codexQuota.refreshToken, 'owned-quota-rotated');
  assert.doesNotMatch(
    JSON.stringify(await f.service.status()),
    /owned-quota|quota-access|fixture-access/,
  );
  otherIdentity = true;
  await f.service.login(accountId, { quota: true });
  assert.equal((await f.complete()).status, 400);
  assert.equal(f.stored.accounts[0].codexQuota.refreshToken, 'owned-quota-rotated');
});
test('loopback sign-in validates PKCE and state, keeps credentials out of public state, filters models', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.login();
  assert.equal(f.opened.origin, claims.iss);
  assert.equal(f.opened.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(f.opened.searchParams.get('agent_name_hint'), 'Could I Be Your Partner');
  assert.equal((await f.complete({ state: 'wrong' })).status, 400);
  assert.equal(f.service.snapshot().accounts.length, 0);
  assert.equal((await f.complete()).status, 200);
  const state = await f.service.status();
  assert.equal(state.accounts[0].planEnabled, true);
  assert.equal(f.stored.accounts[0].clientId, claims.aud);
  assert.equal((await f.service.models()).models[0].id, 'visible-model');
  assert.equal((await f.service.models()).models.length, 1);
  assert.doesNotMatch(JSON.stringify(f.changes), /fixture-access|fixture-refresh|idToken|clientId/);
  const owner = state.activeId;
  await f.service.logout(owner);
  assert.equal(f.service.snapshot().activeId, null);
  assert.equal(f.stored.accounts[0].accessToken, undefined);
  await f.service.login(owner);
  assert.equal(f.opened.searchParams.get('client_id'), claims.aud);
  assert.equal(f.opened.searchParams.has('id_token_hint'), false);
});
test('refreshes serialize, rotate credentials and logout aborts leases', async (t) => {
  let count = 0;
  const f = fixture({
    token: async (options) => {
      if (options.body.get('grant_type') === 'authorization_code')
        return new Response(
          JSON.stringify({
            access_token: 'a1',
            refresh_token: 'r1',
            id_token: jwt({ ...claims, nonce: f.opened.searchParams.get('nonce') }),
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'chatgpt.tokens.use.direct',
          }),
        );
      ++count;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(options.body.get('refresh_token'), 'r1');
      return new Response(
        JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }),
      );
    },
  });
  t.after(() => f.service.dispose());
  await f.service.login();
  await f.complete();
  f.service.data.accounts[0].expiresAt = 0;
  assert.deepEqual(await Promise.all([f.service.accessToken(), f.service.accessToken()]), [
    'a2',
    'a2',
  ]);
  assert.equal(count, 1);
  assert.equal(f.stored.accounts[0].refreshToken, 'r2');
  const lease = await f.service.lease();
  await f.service.logout();
  assert.equal(lease.signal.aborted, true);
  lease.release();
  await assert.rejects(f.service.lease(), /sign in/);
});
test('a refresh completing after logout cannot restore credentials', async (t) => {
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = fixture({
    token: async (options) => {
      if (options.body.get('grant_type') === 'authorization_code')
        return new Response(
          JSON.stringify({
            access_token: 'a1',
            refresh_token: 'r1',
            id_token: jwt({ ...claims, nonce: f.opened.searchParams.get('nonce') }),
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'chatgpt.tokens.use.direct',
          }),
        );
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return new Response(
        JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }),
      );
    },
  });
  t.after(() => f.service.dispose());
  await f.service.login();
  await f.complete();
  f.service.data.accounts[0].expiresAt = 0;
  const refresh = f.service.accessToken();
  const rejected = assert.rejects(refresh, /session changed/);
  await ready;
  await f.service.logout();
  release();
  await rejected;
  assert.equal(f.service.data.accounts[0].accessToken, undefined);
  assert.equal(f.stored.accounts[0].refreshToken, undefined);
});
test('failed vault writes roll back identity changes and login startup can be cancelled', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.init();
  f.service.vault.save = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(
    f.service.mutate(() => {
      f.service.data.activeId = 'bad';
      f.service.data.accounts.push({ id: 'bad' });
    }),
    /disk full/,
  );
  assert.equal(f.service.snapshot().activeId, null);
  assert.equal(f.service.snapshot().accounts.length, 0);
  const g = fixture();
  t.after(() => g.service.dispose());
  let release;
  g.service.discovery = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = g.service.login();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(g.service.login(), /already starting/);
  g.service.cancelLogin();
  release({});
  await assert.rejects(pending, /cancelled/);
  assert.equal(g.opened, undefined);
});
test('real platform vault round trips and Windows never stores plaintext tokens', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-vault-test-'));
  try {
    const file = path.join(directory, 'accounts.vault');
    const vault = new AccountVault(file);
    assert.equal(await vault.load(), null);
    const value = { version: 1, accounts: [{ accessToken: 'test-secret-value' }] };
    if (process.platform !== 'win32' && !process.versions.electron) {
      await assert.rejects(vault.save(value), /OS credential encryption is unavailable/);
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
      return;
    }
    await vault.save(value);
    assert.deepEqual(await vault.load(), value);
    if (process.platform === 'win32')
      assert.doesNotMatch(await fs.readFile(file, 'utf8'), /test-secret-value/);
    else assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    if (
      path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith('cibyp-vault-test-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  }
});
