# Upstream fallback notices

The runtime collector reads actual dependency license files. For Cargo archives that omit their license, exact upstream copies are retained here and included in the source/resource fingerprint. Standard CC0/Apache choices use the existing full texts. MIT copies preserve their upstream copyright notice.

- `ruint-MIT.txt`: https://github.com/alloy-rs/ruint/blob/5bd4cff6ae3960591d750cdd7356e24aa086b67a/LICENSE
- `ruint-macro-MIT.txt`: https://github.com/alloy-rs/ruint/blob/89d58efbd4c6de4994e5e404ed6450b8bb927202/LICENSE
- `sha3-asm-BSD.txt`: https://github.com/danipopes/keccak-asm/blob/ce6d06afb38e47234f42ccc66c254be9ebf0ad6e/LICENSE
- `valuable-MIT.txt`: https://github.com/tokio-rs/valuable/blob/9efc29b6e58cef28f6566a47aa7e142a55fead77/LICENSE

Versions and dependency checksums are fixed in `Cargo.lock`. Notices follow the resolved target dependency graph, including build dependencies, rather than every unrelated optional package in the lockfile. The application uses the Apache option for explicitly dual-licensed dependencies; the deprecated `Apache-2.0/MIT` spelling is handled explicitly. Missing or unsupported license data still fails packaging.
