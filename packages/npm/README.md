# CIBYP launcher

A small, dependency-free JavaScript launcher. npm contains no Electron, Code-OSS or platform payload packages. Complete application binaries come from the official GitHub Release.

```sh
npm install -g cibyp
cibyp              # GUI; TUI when no graphical desktop is available
cibyp-tui          # terminal Agent
cibyp-code         # Code TUI using the current terminal directory
npx cibyp          # no global installation
npx --package=cibyp cibyp-code
cibyp update       # explicitly update the App runtime
```

Requires Node.js >= 22.14 and tar (included in Windows 10+, macOS and Linux).
Windows/macOS/Linux x64 and arm64 are supported. Installation downloads the complete GUI/TUI runtime, verifies its SHA-256, and registers a user GUI launcher. VM images keep their separate download mechanism.

GitHub and HTTPS mirrors are probed automatically. Range-capable servers use four concurrent connections, retry failed segments and fall back to streaming when ranges are unavailable. Every completed download must match the size and SHA-256 obtained from official GitHub metadata before extraction or execution. Corrupt mirrors are discarded.

The runtime cache is independent of npm/npx. Starts check for App updates at most every six hours; verified cached versions remain usable if an automatic check fails. Explicit updates report failures. Updates replace the managed desktop entry and retain running versions, settings, history and workspaces. Windows Start Menu, macOS ~/Applications and Linux user applications launch through the cached JavaScript launcher, so they also check updates.

Desktop entries use the full name **Could I Be Your Partner**. On macOS the launcher migrates its own old `~/Applications/CIBYP.app` entry, preserving unrelated apps. After SHA-256 verification, macOS installs automatically verify the downloaded App's signature. An invalid or unsigned App is signed locally, including Electron helpers and native modules; valid existing signatures are preserved. Signing completes before the runtime becomes usable and failures are reported. Previous running runtime copies stay untouched.

Local ad-hoc signing requires no Apple account or paid certificate and does not grant Apple trust or notarization. macOS may still require **System Settings → Privacy & Security → Open Anyway** for an unnotarized App. The launcher never disables Gatekeeper or changes system-wide security settings. Direct DMG/PKG installations do not pass through this npm preparation step; official Developer ID signing and notarization remain the distribution solution for those installs. See [Apple's Developer ID guidance](https://developer.apple.com/developer-id/).

Launcher and App versions are independent. `cibyp --version` reports the launcher; `cibyp --runtime-version` reports the cached App. Update npm only when the launcher itself changes. The default App channel is preview (includes alpha); `cibyp --channel=stable` or `cibyp --channel=preview` persist the selected channel.

- `cibyp --no-update`: use the verified cache without a network check.
- `cibyp --install-only`: download/repair the runtime and register the GUI entry.
- `CIBYP_CACHE_DIR`: move the cache; use the same value for installation and starts.
- `CIBYP_MIRRORS=off`: use official GitHub only. Otherwise specify comma-separated HTTPS prefixes, optionally containing `{url}`.
- `CIBYP_DOWNLOAD_CONCURRENCY=1..8`: set connection count (default 4).
- `CIBYP_SKIP_INSTALL=1` or npm `--ignore-scripts`: defer the runtime download until first use.

Public installation needs no npm login. Use /help in TUI. cibyp-code maps its host working directory into the VM using the App's shared workspace synchronization.
