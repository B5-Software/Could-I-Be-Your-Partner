/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// Exercise the same GitHub identity / npm exchange used by npm publish. A dry run
// or an already-published version does not validate the trusted publisher.
async function verifyTrustedPublisher({ env = process.env, fetchRequest = fetch } = {}) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error('Run this check in GitHub Actions with id-token: write permission.');
  if (env.NPM_TOKEN || (env.NODE_AUTH_TOKEN && env.NODE_AUTH_TOKEN !== 'XXXXX-XXXXX-XXXXX-XXXXX'))
    throw new Error('Remove long-lived npm token injection before verifying trusted publishing.');

  const requestUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (requestUrl.protocol !== 'https:' || requestUrl.username || requestUrl.password)
    throw new Error('GitHub OIDC requires an HTTPS identity endpoint.');
  requestUrl.searchParams.set('audience', 'npm:registry.npmjs.org');
  async function request(url, options, description) {
    let response;
    try {
      response = await fetchRequest(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      // Never include a request URL, token or response body in an error/log.
      throw new Error(description + ' failed; check connectivity and retry the workflow.');
    }
    if (!response.ok)
      throw new Error(
        description +
          ' failed (HTTP ' +
          response.status +
          '). Check cibyp Trusted Publisher: B5-Software / Could-I-Be-Your-Partner / npm.yml, ' +
          'Environment name empty, Allow npm publish enabled.',
      );
    try {
      return await response.json();
    } catch {
      throw new Error(description + ' returned invalid JSON.');
    }
  }

  const identity = await request(
    requestUrl,
    {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      },
    },
    'GitHub OIDC identity request',
  );
  if (typeof identity?.value !== 'string' || !identity.value)
    throw new Error('GitHub did not return an OIDC identity token.');
  const exchange = await request(
    'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/cibyp',
    { method: 'POST', headers: { Authorization: 'Bearer ' + identity.value } },
    'npm trusted publisher exchange',
  );
  // npm CLI only requires the exchanged token. Production responses do not
  // necessarily include the token_type / expires fields shown in API examples.
  if (typeof exchange?.token !== 'string' || !exchange.token)
    throw new Error('npm did not return a valid temporary OIDC credential.');
  // Discard both credentials without logging or saving them. npm publish obtains
  // its own fresh credentials; this check changes no package versions/dist-tags.
}

if (require.main === module)
  verifyTrustedPublisher()
    .then(() =>
      console.log(
        '[npm] Trusted publisher identity verified for cibyp; no versions or dist-tags changed.',
      ),
    )
    .catch((error) => {
      console.error('[npm]', error.message);
      process.exitCode = 1;
    });

module.exports = { verifyTrustedPublisher };
