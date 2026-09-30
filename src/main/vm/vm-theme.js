// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const { shellQuote } = require('./vm-paths');

function desktopAppearance(theme = {}, systemDark = false) {
  const dark = theme.mode === 'dark' || (theme.mode !== 'light' && systemDark);
  const hex = (value, fallback) =>
    /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback;
  return {
    theme: dark ? 'dark' : 'light',
    accent_color: hex(theme.accentColor, '#4f8cff'),
    background_color: hex(theme.backgroundColor, dark ? '#1a2232' : '#f5f7fa'),
    appearance_source: 'app',
  };
}

// Only public appearance fields cross the bridge. The same lock used by the
// desktop preserves wallpaper, pinned applications and other guest preferences.
const GUEST_APPEARANCE_SCRIPT = `import base64, fcntl, json, os, pathlib, sys, tempfile
directory = pathlib.Path(os.environ.get('XDG_CONFIG_HOME') or str(pathlib.Path.home() / '.config')) / 'cibyp'
directory.mkdir(parents=True, exist_ok=True)
target = directory / 'desktop.json'
changes = json.loads(base64.b64decode(sys.argv[1]))
with (directory / '.settings.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        state = json.loads(target.read_text(encoding='utf-8'))
        if not isinstance(state, dict): state = {}
    except (OSError, ValueError):
        state = {}
    state.update(changes)
    fd, temporary = tempfile.mkstemp(prefix='.desktop.json.', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
`;

class VmAppearanceSync {
  constructor({ getInstance, getTheme, getSystemDark }) {
    this.getInstance = getInstance;
    this.getTheme = getTheme;
    this.getSystemDark = getSystemDark;
    this.pending = null;
    this.worker = null;
    this.applied = null;
    this.generation = 0;
  }

  sync({ force = false } = {}) {
    this.pending = desktopAppearance(this.getTheme(), this.getSystemDark());
    if (force) this.generation++;
    if (!this.worker)
      this.worker = this._drain().finally(() => {
        this.worker = null;
      });
    return this.worker;
  }

  async _drain() {
    while (this.pending) {
      const instance = this.getInstance();
      if (!instance || instance.state !== 'ready') return { ok: true, pending: true };
      const appearance = this.pending;
      this.pending = null;
      const signature = JSON.stringify(appearance);
      const generation = this.generation;
      if (
        this.applied?.instance === instance &&
        this.applied.signature === signature &&
        this.applied.generation === generation
      )
        continue;
      try {
        const data = Buffer.from(signature).toString('base64');
        const result = await instance.exec(
          `python3 -c ${shellQuote(GUEST_APPEARANCE_SCRIPT)} ${shellQuote(data)}`,
          { timeoutMs: 15000 },
        );
        if (!result.ok) throw new Error(result.stderr || 'VM 个性化设置同步失败');
        this.applied = { instance, signature, generation };
      } catch (error) {
        this.pending ||= appearance;
        throw error;
      }
    }
    return { ok: true, pending: false };
  }
}

module.exports = { desktopAppearance, GUEST_APPEARANCE_SCRIPT, VmAppearanceSync };
