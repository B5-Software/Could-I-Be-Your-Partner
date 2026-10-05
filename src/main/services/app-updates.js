/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { compareVersions } = require('../update-checker');
const releases = require('../../../packages/npm/lib/releases.cjs');
const { downloadVerified } = require('../../../packages/npm/lib/download.cjs');
const { checksum, cacheDirectory, inside } = require('../../../packages/npm/lib/runtime.cjs');

function selectInstaller(assets, platform, arch, appImage = false) {
  const suffix =
    platform === 'win32'
      ? '.exe'
      : platform === 'darwin'
        ? '.pkg'
        : appImage
          ? '.AppImage'
          : '.deb';
  const label = platform === 'linux' && !appImage && arch === 'x64' ? 'amd64' : arch;
  const matching = assets.filter(
    (asset) =>
      asset.name.endsWith(suffix) &&
      (platform === 'win32'
        ? new RegExp('(?:Setup[- ]|' + arch + ')[^/]*\\.exe$', 'i').test(asset.name)
        : asset.name.includes(label)),
  );
  // Windows uses separate architecture assets; never choose the other architecture.
  const explicit = matching.filter((asset) => asset.name.includes(label));
  const selected = explicit.length
    ? explicit
    : matching.filter((asset) => !/arm64|x64|ia32/.test(asset.name));
  if (selected.length !== 1)
    throw new Error('No unambiguous installer exists for ' + platform + '-' + arch);
  const asset = selected[0];
  if (
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  )
    throw new Error('The official release does not provide a verified installer digest');
  return { ...asset, sha256: asset.digest.slice(7), url: asset.browser_download_url };
}

class AppUpdates {
  constructor({
    app,
    settings,
    publish,
    busy = () => false,
    json = releases.json,
    download = downloadVerified,
    resolveRuntime,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    launch = spawn,
  }) {
    Object.assign(this, {
      app,
      settings,
      publish,
      busy,
      json,
      download,
      env,
      platform,
      arch,
      launch,
    });
    this.resolveRuntime =
      resolveRuntime || require('../../../packages/npm/lib/updates.cjs').resolveRuntime;
    this.directory = path.join(app.getPath('userData'), 'updates');
    this.state = { phase: 'idle' };
  }
  status() {
    const { file, runtime, ...publicState } = this.state;
    return publicState;
  }
  change(value) {
    this.state = { ...this.state, ...value };
    const state = this.status();
    this.publish('updates:state', state);
    return state;
  }
  async start() {
    if (this.operation) return this.status();
    if (['ready', 'installing'].includes(this.state.phase)) return this.change({});
    this.state = { phase: 'idle' };
    this.change({ phase: 'checking', error: '', downloaded: 0, total: 0 });
    this.operation = this.prepare()
      .catch((error) => this.change({ phase: 'error', error: error.message }))
      .finally(() => {
        this.operation = null;
      });
    // Downloads live in the shared owner, not in a long-running frontend RPC.
    return this.status();
  }
  async prepare() {
    await fs.mkdir(this.directory, { recursive: true });
    const channel = this.settings().updates?.channel === 'all' ? 'preview' : 'stable';
    const list = await this.json(
      'https://api.github.com/repos/' + releases.repo + '/releases?per_page=100',
      { limit: 4 * 1024 * 1024 },
    );
    if (!Array.isArray(list)) throw new Error('Invalid release list');
    const latest = list
      .filter(
        (r) =>
          !r.draft &&
          (channel === 'preview' || !r.prerelease) &&
          /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(r.tag_name),
      )
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    if (!latest) throw new Error('No published release exists on the selected channel');
    const version = latest.tag_name.slice(1);
    if (compareVersions(version, this.app.getVersion()) <= 0)
      return this.change({ phase: 'current', version });
    this.change({ phase: 'downloading', version });
    // A verified npm-managed runtime is staged in the launcher's existing cache.
    const base = cacheDirectory(this.env, this.platform);
    const relative = path.relative(base, this.app.getAppPath?.() || '');
    const managed = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (managed) {
      if (!latest.assets?.some((asset) => asset.name === 'cibyp-runtime.json'))
        throw new Error(
          'The new runtime is still being published; retry after the build completes',
        );
      const runtime = await this.resolveRuntime({
        force: true,
        channel,
        env: this.env,
        platform: this.platform,
        arch: this.arch,
        discover: (options) => releases.discoverRelease({ ...options, version }),
        log: (message) => this.change({ detail: message }),
      });
      const { readState } = require('../../../packages/npm/lib/updates.cjs');
      const installed = await readState({ env: this.env, platform: this.platform });
      if (installed.manifest?.version !== version)
        throw new Error('The downloaded runtime does not match the requested version');
      this.change({ phase: 'ready', kind: 'launcher', runtime });
    } else {
      const asset = selectInstaller(
        latest.assets || [],
        this.platform,
        this.arch,
        !!this.env.APPIMAGE,
      );
      const url = new URL(asset.url);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'github.com' ||
        !url.pathname.startsWith('/' + releases.repo + '/releases/download/') ||
        url.username ||
        url.password
      )
        throw new Error('Unexpected installer download origin');
      await fs.mkdir(this.directory, { recursive: true });
      const file = inside(this.directory, asset.name);
      await this.download(asset, file, {
        concurrency: 4,
        mirrors:
          this.env.CIBYP_MIRRORS === 'off'
            ? []
            : this.env.CIBYP_MIRRORS?.split(',')
                .map((value) => value.trim())
                .filter(Boolean),
        onProgress: (p) => {
          if (!p.verified && Date.now() - (this.progressAt || 0) < 250) return;
          this.progressAt = Date.now();
          this.change({ downloaded: p.downloaded, total: p.total });
        },
      });
      if ((await fs.stat(file)).size !== asset.size || (await checksum(file)) !== asset.sha256)
        throw new Error('Installer SHA-256 verification failed');
      if (this.platform === 'linux') await fs.chmod(file, 0o755);
      this.change({ phase: 'ready', kind: 'installer', file, sha256: asset.sha256, detail: '' });
    }
    const temporary = path.join(this.directory, 'pending.tmp.json');
    await fs.writeFile(temporary, JSON.stringify(this.state), {
      mode: 0o600,
    });
    await fs.rename(temporary, path.join(this.directory, 'pending.json'));
    return this.status();
  }
  async restore() {
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(this.directory, 'pending.json'), 'utf8'),
      );
      if (saved.phase !== 'ready' || compareVersions(saved.version, this.app.getVersion()) <= 0)
        return;
      if (saved.kind === 'installer') {
        if (
          path.dirname(path.resolve(saved.file)) !== path.resolve(this.directory) ||
          !/^[a-f0-9]{64}$/.test(saved.sha256) ||
          (await checksum(saved.file)) !== saved.sha256
        )
          return;
      } else if (saved.kind === 'launcher') {
        const { usable } = require('../../../packages/npm/lib/runtime.cjs');
        const relation = path.relative(
          cacheDirectory(this.env, this.platform),
          saved.runtime?.directory || '',
        );
        if (
          !relation ||
          relation.startsWith('..') ||
          path.isAbsolute(relation) ||
          !saved.runtime ||
          !(await usable(saved.runtime.directory, saved.runtime.asset))
        )
          return;
      } else return;
      this.state = saved;
    } catch {
      /* No verified pending update. */
    }
  }
  async install() {
    if (this.state.phase !== 'ready') return { ok: false, error: 'Download an update first' };
    if (this.busy()) return { ok: false, error: 'Stop running tasks before restarting to install' };
    // Reserve installation before asynchronous verification or process creation.
    // Two frontends cannot launch two installers for the same pending update.
    this.change({ phase: 'installing' });
    try {
      if (this.state.kind === 'installer') {
        if ((await checksum(this.state.file)) !== this.state.sha256) {
          this.change({ phase: 'error', error: 'Installer checksum has changed; download again' });
          await fs.rm(path.join(this.directory, 'pending.json'), { force: true });
          return { ok: false, error: this.state.error };
        }
        if (this.platform === 'linux' && this.env.APPIMAGE) {
          const target = path.resolve(this.env.APPIMAGE);
          await fs.access(path.dirname(target), require('node:fs').constants.W_OK);
          const helper = path.join(this.directory, 'install-appimage.cjs');
          await fs.writeFile(
            helper,
            'const fs=require("node:fs/promises"),cp=require("node:child_process");const [pid,source,target]=process.argv.slice(2);(async()=>{for(let n=0;n<240;n++){try{process.kill(Number(pid),0)}catch{await fs.copyFile(source,target+".cibyp-update");await fs.chmod(target+".cibyp-update",0o755);await fs.rename(target+".cibyp-update",target);cp.spawn(target,[],{detached:true,stdio:"ignore"}).unref();return}await new Promise(r=>setTimeout(r,500))}throw new Error("App did not exit")})().catch(e=>{console.error(e.message);process.exitCode=1});',
          );
          const child = this.launch(
            process.execPath,
            [helper, String(process.pid), this.state.file, target],
            { detached: true, stdio: 'ignore', env: { ...this.env, ELECTRON_RUN_AS_NODE: '1' } },
          );
          await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
          child.unref();
        } else {
          const command =
            this.platform === 'darwin'
              ? '/usr/bin/open'
              : this.platform === 'linux'
                ? 'xdg-open'
                : this.state.file;
          const args = this.platform === 'win32' ? [] : [this.state.file];
          const child = this.launch(command, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          await new Promise((resolve, reject) => {
            // Desktop openers can start successfully yet reject the file. Keep
            // the owner alive when the OS cannot open its package installer.
            if (this.platform === 'win32') child.once('spawn', resolve);
            else
              child.once('exit', (code) =>
                code === 0
                  ? resolve()
                  : reject(new Error('The system installer could not be opened (' + code + ')')),
              );
            child.once('error', reject);
          });
          child.unref();
        }
      } else {
        const { usable } = require('../../../packages/npm/lib/runtime.cjs');
        if (!(await usable(this.state.runtime.directory, this.state.runtime.asset)))
          throw new Error('The staged runtime is incomplete; download again');
      }
      // Give all frontends time to show the restart notice before owner shutdown.
      setTimeout(() => this.app.quit(), 500).unref();
      return { ok: true, kind: this.state.kind };
    } catch (error) {
      this.change({ phase: 'ready', error: error.message });
      return { ok: false, error: error.message };
    }
  }
}
module.exports = { AppUpdates, selectInstaller };
