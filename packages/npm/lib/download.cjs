/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');

const defaultMirrors = ['https://gh-proxy.com/', 'https://ghfast.top/'];
function sources(url, mirrors = defaultMirrors) {
  const origin = new URL(url);
  if (
    origin.protocol !== 'https:' ||
    origin.hostname !== 'github.com' ||
    origin.username ||
    origin.password ||
    !origin.pathname.startsWith('/B5-Software/Could-I-Be-Your-Partner/releases/download/')
  )
    throw new Error('Unexpected runtime download origin');
  return [
    ...new Set([
      url,
      ...mirrors.map((prefix) => {
        const target = prefix.includes('{url}')
          ? prefix.replace('{url}', url)
          : prefix.replace(/\/?$/, '/') + url;
        const mirror = new URL(target);
        if (mirror.protocol !== 'https:' || mirror.username || mirror.password)
          throw new Error('Download mirrors must use HTTPS without embedded credentials');
        return target;
      }),
    ]),
  ];
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function write(file, bytes, offset) {
  for (let position = 0; position < bytes.length;) {
    const result = await file.write(bytes, position, bytes.length - position, offset + position);
    if (!result.bytesWritten) throw new Error('Unable to write downloaded bytes');
    position += result.bytesWritten;
  }
}
async function stream(response, file, start, length, progress) {
  let count = 0;
  for await (const bytes of response.body) {
    count += bytes.length;
    if (count > length) throw new Error('Download exceeded the expected range');
    await write(file, bytes, start + count - bytes.length);
    progress(bytes.length);
  }
  if (count !== length) throw new Error('Download ended before the expected range');
}
async function probe(url, size, { fetchFile, signal }) {
  const begin = performance.now();
  const response = await fetchFile(url, {
    headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)].filter(Boolean)),
  });
  try {
    if (response.status === 206 && response.headers.get('content-range') === `bytes 0-0/${size}`)
      return { url, ranges: true, latency: performance.now() - begin };
    if (response.status === 200) return { url, ranges: false, latency: performance.now() - begin };
    throw new Error('HTTP ' + response.status);
  } finally {
    await response.body?.cancel();
  }
}

async function downloadVerified(
  { url, size, sha256: expected },
  destination,
  {
    mirrors = defaultMirrors,
    concurrency = 4,
    fetchFile = fetch,
    signal,
    onProgress = () => {},
    candidates,
  } = {},
) {
  if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{64}$/.test(expected || ''))
    throw new Error('A trusted SHA-256 and size are required before downloading');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Download concurrency must be between 1 and 8');
  const checked = await Promise.allSettled(
    (candidates || sources(url, mirrors)).map((candidate) =>
      probe(candidate, size, { fetchFile, signal }),
    ),
  );
  signal?.throwIfAborted();
  const available = checked
    .filter((x) => x.status === 'fulfilled')
    .map((x) => x.value)
    .sort((a, b) => a.latency - b.latency);
  if (!available.length) throw new Error('GitHub and configured download mirrors are unavailable');
  const partial = destination + '.part';
  const failures = [];
  for (let sourceIndex = 0; sourceIndex < available.length; sourceIndex++) {
    const source = available[sourceIndex];
    signal?.throwIfAborted();
    const controller = new AbortController();
    const downloadSignal = AbortSignal.any(
      [controller.signal, signal, AbortSignal.timeout(60 * 60 * 1000)].filter(Boolean),
    );
    const file = await fs.open(partial, 'w');
    let completed = 0;
    let lastProgress = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgress >= 60000)
        controller.abort(new Error('Download stalled for 60 seconds'));
    }, 10000);
    const progress = (count) => {
      lastProgress = Date.now();
      completed += count;
      onProgress({ downloaded: completed, total: size, source: source.url });
    };
    try {
      if (source.ranges && concurrency > 1 && size > 1024 * 1024) {
        const segmentSize = Math.max(1024 * 1024, Math.ceil(size / 64));
        let cursor = 0;
        const tasks = Array.from({ length: concurrency }, async () => {
          while (cursor < size) {
            const start = cursor,
              end = Math.min(size - 1, start + segmentSize - 1);
            cursor = end + 1;
            let error;
            for (let attempt = 0; attempt < 3; attempt++) {
              let counted = 0;
              try {
                const response = await fetchFile(source.url, {
                  headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
                  signal: AbortSignal.any([downloadSignal, AbortSignal.timeout(90000)]),
                });
                if (
                  response.status !== 206 ||
                  response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`
                ) {
                  await response.body?.cancel();
                  const failure = new Error('Download source did not honor the requested range');
                  failure.code = response.status === 200 ? 'RANGE_UNSUPPORTED' : 'RANGE_FAILED';
                  throw failure;
                }
                await stream(response, file, start, end - start + 1, (count) => {
                  counted += count;
                  progress(count);
                });
                error = null;
                break;
              } catch (failure) {
                completed -= counted;
                error = failure;
                if (downloadSignal.aborted || failure.code === 'RANGE_UNSUPPORTED') throw failure;
                if (attempt < 2)
                  await require('node:timers/promises').setTimeout(250 * 2 ** attempt, null, {
                    signal: downloadSignal,
                  });
              }
            }
            if (error) throw error;
          }
        });
        const settled = await Promise.allSettled(
          tasks.map((task) =>
            task.catch((error) => {
              controller.abort(error);
              throw error;
            }),
          ),
        );
        const failed = settled.find((x) => x.status === 'rejected');
        if (failed) throw failed.reason;
      } else {
        const response = await fetchFile(source.url, {
          headers: { 'Accept-Encoding': 'identity' },
          signal: downloadSignal,
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error('HTTP ' + response.status);
        }
        await stream(response, file, 0, size, progress);
      }
      await file.close();
      if ((await sha256(partial)) !== expected) throw new Error('SHA-256 verification failed');
      signal?.throwIfAborted();
      await fs.rename(partial, destination);
      onProgress({ downloaded: size, total: size, verified: true, source: source.url });
      return destination;
    } catch (error) {
      controller.abort(error);
      await file.close().catch(() => {});
      await fs.rm(partial, { force: true });
      signal?.throwIfAborted();
      failures.push(new URL(source.url).host + ': ' + error.message);
      if (error.code === 'RANGE_UNSUPPORTED')
        available.splice(sourceIndex + 1, 0, { ...source, ranges: false });
    } finally {
      clearInterval(watchdog);
    }
  }
  throw new Error('All downloads failed: ' + failures.join('; '));
}
module.exports = { sources, sha256, downloadVerified, defaultMirrors };
