# Local EVM execution fixture

The integration test installs ExecutionFixture.sol's source-hashed runtime only in a fresh local Anvil chain. The fixture uses a synthetic default price and freely mintable balances to test allowances, transfers, wallet signatures and receipts. The test can change the router price in local storage to verify a pending swap's minimum output.

After the live execution checks, the test replaces those local contracts with a stateful constant-product pool and verifies that successive simulated swaps update reserves and balances inside the simulation while preserving the canonical pool state.

The artifact uses pinned solc 0.8.30, the Paris EVM target and disabled optimization. See the [official compiler release](https://www.soliditylang.org/blog/2025/05/07/solidity-0.8.30-release-announcement/). Reproduce with npm install --prefix .cache/quant-solc --ignore-scripts --no-audit --no-fund --save-exact solc@0.8.30, then node scripts/compile-quant-fixture.cjs. The cache has its own lockfile; these compiler dependencies are not application runtime dependencies.

Tests validate the source SHA-256 and every runtime bytecode SHA-256 before installation. CI consumes the artifact without downloading or running a Solidity compiler. The checks do not prove compatibility with every real Uniswap deployment, mempool conditions, adversarial tokens or public-chain execution latency.
