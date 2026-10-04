/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const repo = 'B5-Software/Could-I-Be-Your-Partner';
const api = 'https://api.github.com/repos/' + repo;
async function json(url, { fetchJSON = fetch, signal, limit = 1024 * 1024 } = {}) {
  const response = await fetchJSON(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cibyp-launcher' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)].filter(Boolean)),
  });
  if (!response.ok) throw new Error('GitHub release lookup failed: HTTP ' + response.status);
  const chunks = [];
  let length = 0;
  for await (const bytes of response.body) {
    length += bytes.length;
    if (length > limit) throw new Error('Release metadata is too large');
    chunks.push(Buffer.from(bytes));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function discoverRelease({ channel = 'preview', version, signal, fetchJSON = fetch } = {}) {
  if (!['stable', 'preview'].includes(channel))
    throw new Error('Channel must be stable or preview');
  if (version && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error('Invalid runtime version');
  const releases = version
    ? [await json(api + '/releases/tags/v' + encodeURIComponent(version), { fetchJSON, signal })]
    : await json(api + '/releases?per_page=100', { fetchJSON, signal, limit: 4 * 1024 * 1024 });
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list');
  const release = releases
    .filter((x) => !x.draft && (channel !== 'stable' || !x.prerelease))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .find((x) => x.assets?.some((a) => a.name === 'cibyp-runtime.json'));
  if (!release)
    throw new Error('No complete runtime is available on the selected GitHub release channel');
  const asset = release.assets.find((a) => a.name === 'cibyp-runtime.json');
  const url = new URL(asset.browser_download_url);
  if (url.hostname !== 'github.com' || !url.pathname.startsWith('/' + repo + '/releases/download/'))
    throw new Error('Unexpected release manifest origin');
  // Mirrors never supply the trusted checksum manifest.
  const manifest = await json(url.href, { fetchJSON, signal });
  if (manifest.schema !== 1 || release.tag_name !== 'v' + manifest.version)
    throw new Error('Release tag and runtime manifest disagree');
  const targets = [
    'win32-x64',
    'win32-arm64',
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
  ];
  if (Object.keys(manifest.targets || {}).length !== targets.length)
    throw new Error('Incomplete release manifest');
  for (const key of targets) {
    const [platform, arch] = key.split('-');
    const item = require('./runtime.cjs').selectTarget(manifest, platform, arch);
    const binary = release.assets.find((a) => a.name === item.file);
    if (
      !binary ||
      binary.size !== item.size ||
      (binary.digest && binary.digest !== 'sha256:' + item.sha256)
    )
      throw new Error('Runtime checksum does not match the official release asset');
    item.url = binary.browser_download_url;
  }
  return manifest;
}
module.exports = { discoverRelease, json, repo };
