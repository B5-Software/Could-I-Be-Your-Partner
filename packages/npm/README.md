# Could I Be Your Partner

Complete GUI and terminal AI Agent with shared settings, history, todos and VM workspaces.

```sh
npm install -g cibyp
cibyp          # GUI; automatically uses TUI when no desktop is available
cibyp-tui      # TUI
cibyp-code     # Code TUI, using the current terminal directory as the host workspace
```

Or use npx:

```sh
npx cibyp
npx cibyp --tui
npx --package=cibyp cibyp-code
```

Installation includes Electron, Code-OSS, Node.js and the compiled native tools for your
OS/architecture. npm selects one platform package; large payloads are split into dependencies
and verified against a pinned SHA-256 before local extraction. No GitHub download is needed
on first start. A VM image is managed separately by the App's VM settings.

The GUI is registered for the current user: Windows Start menu, macOS `~/Applications/CIBYP.app`,
or the Linux application menu (`cibyp.desktop`). Reinstalling or updating replaces the same
launcher with the new runtime; settings, history and workspaces are preserved. Existing
processes continue using their version until restarted. Old runtime caches are retained to
avoid deleting running binaries; the App's data is stored separately.

Update with `npm install -g cibyp@latest`. npx installations also register the GUI; its target
lives in the CIBYP cache independently of npm's temporary npx directory.

Node.js 22.14+ is required for the small launcher; the actual App uses its bundled Node.js.
Supported targets: Windows 10/11, macOS and glibc Linux, on x64 or arm64. Linux GUI needs
Electron's system desktop libraries. Alpine/musl is unsupported. On Linux, prefer a
user-owned npm prefix; sudo installations place the launcher/cache in the invoking user's
profile. GUI and TUI share the App's single-instance lock.

`--help` and `--version` work without starting the App. If installation scripts were disabled,
`cibyp --install-only` repairs the runtime from the already-installed npm payloads and registers
the GUI. Normal starts can unpack those local payloads too. Do not omit optional dependencies.
`CIBYP_CACHE_DIR` selects the writable runtime cache; keep it consistent across installs and starts.

The `latest` npm tag follows the current CIBYP release, including alpha versions.
Pin a release with `npm install -g cibyp@VERSION`.

[Source and documentation](https://github.com/B5-Software/Could-I-Be-Your-Partner)

GPL-3.0-or-later
