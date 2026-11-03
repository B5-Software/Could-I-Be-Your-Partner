# Local EVM execution fixture

ExecutionFixture.sol and its source-hashed artifact are testing fixtures, not Uniswap deployments or production smart contracts. They deliberately use a synthetic fixed price and freely mintable balances. The integration test installs their runtime only in a fresh local Anvil chain and checks real allowances, transfers, wallet signatures and receipts.

The artifact uses pinned solc 0.8.30, the Paris EVM target and disabled optimization. See the [official compiler release](https://www.soliditylang.org/blog/2025/05/07/solidity-0.8.30-release-announcement/). Reproduce with npm install --prefix .cache/quant-solc --ignore-scripts --no-audit --no-fund --save-exact solc@0.8.30, then node scripts/compile-quant-fixture.cjs. The cache has its own lockfile; these compiler dependencies are not application runtime dependencies.

Tests validate the source SHA-256 and every runtime bytecode SHA-256 before installation. CI consumes the artifact without downloading or running a Solidity compiler. The checks do not prove compatibility with every real Uniswap deployment, mempool conditions, adversarial tokens or public-chain execution latency.
