/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerEnvironmentIpc({
  fs,
  path,
  spawnSync,
  ipcMain,
  getSettings,
  vmService,
}) {
  // ---- 环境检测（Python / Node+npm / Bun / Git）----
  function normalizeEnvVersion(output) {
    const text = String(output || '').trim();
    const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) return m[1];
    return text.split(/\r?\n/)[0].slice(0, 80);
  }

  // macOS 打包后的 GUI 应用继承的是 launchd 的最小 PATH（/usr/bin:/bin:...），
  // 看不到用户 shell 里 Homebrew/nvm 等安装的工具（node/npm/git/python）。
  // 这里用用户的登录 shell 读回真实 PATH（zsh/bash/fish 通用），并附上常见安装位置兜底。
  let _cachedLoginPath = null;
  function getLoginPathEnv() {
    if (_cachedLoginPath) return _cachedLoginPath;
    const parts = [];
    try {
      const shellPath =
        process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
      const base = path.basename(shellPath).toLowerCase();
      const cmd = base === 'fish' ? 'string join : $PATH' : 'printf \'%s\' "$PATH"';
      const r = spawnSync(shellPath, ['-lic', cmd], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env },
      });
      if (!r.error && r.status === 0 && r.stdout) parts.push(String(r.stdout).trim());
    } catch {
      /* ignore */
    }
    // 兜底：Homebrew 两个前缀 + 系统默认路径 + nvm 通用目录
    parts.push('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    _cachedLoginPath = parts.join(':');
    return _cachedLoginPath;
  }

  function detectEnvTool(candidates, pathEnv) {
    for (const cmd of candidates) {
      const env = pathEnv ? { ...process.env, PATH: pathEnv } : process.env;
      let r;
      try {
        r = spawnSync(cmd, ['--version'], {
          encoding: 'utf8',
          timeout: 6000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
      } catch {
        continue;
      }
      if (r.error || r.status !== 0 || !r.stdout) continue;
      let exePath = null;
      try {
        const loc = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
          encoding: 'utf8',
          timeout: 6000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
        if (loc.status === 0 && loc.stdout) exePath = loc.stdout.trim().split(/\r?\n/)[0];
      } catch {
        /* ignore */
      }
      return {
        found: true,
        command: cmd,
        version: normalizeEnvVersion(r.stdout),
        path: exePath,
      };
    }
    return {
      found: false,
      command: candidates[0] || null,
      version: null,
      path: null,
    };
  }

  ipcMain.handle('env:detect', async () => {
    try {
      // VM 模式：探测虚拟机内的运行时（Agent 的 shell/python/node 脚本都在 guest 里执行）
      if ((getSettings().runtime || {}).location === 'vm' && !vmService.emergencyHost) {
        if (!vmService.instance || vmService.instance.state !== 'ready') await vmService.start();
        const probeOne = async (candidates) => {
          for (const c of candidates) {
            const r = await vmService.instance
              .exec(
                `command -v ${c} >/dev/null 2>&1 && { command -v ${c}; ${c} --version 2>&1 | head -2; } || true`,
                { timeoutMs: 15000 },
              )
              .catch(() => null);
            const out = (r && r.stdout ? r.stdout : '').trim();
            if (out) {
              const lines = out.split('\n');
              const exePath = (lines[0] || '').trim();
              return {
                found: true,
                command: c,
                version: normalizeEnvVersion(lines.slice(1).join(' ')),
                path: exePath || null,
              };
            }
          }
          return {
            found: false,
            command: candidates[0] || null,
            version: null,
            path: null,
          };
        };
        const results = {
          python: await probeOne(['python3', 'python']),
          node: await probeOne(['node']),
          npm: await probeOne(['npm']),
          bun: await probeOne(['bun']),
          git: await probeOne(['git']),
        };
        return { ok: true, results, platform: 'linux', location: 'vm' };
      }
      const pathEnv = process.platform === 'darwin' ? getLoginPathEnv() : process.env.PATH;
      const results = {
        python: detectEnvTool(
          process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'],
          pathEnv,
        ),
        node: detectEnvTool(['node'], pathEnv),
        npm: detectEnvTool(['npm'], pathEnv),
        bun: detectEnvTool(['bun'], pathEnv),
        git: detectEnvTool(['git'], pathEnv),
      };
      return {
        ok: true,
        results,
        platform: process.platform,
        location: 'host',
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
