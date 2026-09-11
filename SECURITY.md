# Maddeth Security

Maddeth is currently testnet software. It has not completed an independent production audit and must not be represented as production-ready or used with real-value assets until audit, economic review, governance hardening and mainnet readiness work are complete.

## Current security controls

- Two-step ownership transfers across privileged contracts.
- Risk admin is pause-only in the lending pool; only the owner can reopen protocol or markets.
- Irreversible bad-debt socialization is owner-only.
- New markets require contract code, bounded decimals, a deployed rate model and conservative parameter ceilings.
- Maximum listed-market count limits account-health loop growth.
- Supply and borrow caps are enforced on-chain.
- Withdrawals and repayments remain available during emergency pauses when account-health and liquidity rules permit.
- Liquidations remain available during pauses.
- Exact token balance-delta checks reject fee-on-transfer and unexpected rebasing behavior that could desynchronize accounting.
- Oracle prices fail closed on invalid, future or stale timestamps.
- Bitkub oracle feeds support optional normalized price circuit-breaker bounds.
- Isolated RWA vaults use separate accounting, lender allowlists, immutable maturity/debt caps and locked economic terms after funding begins.
- RWA vault creation can be paused globally at the factory.
- Reentrancy guards cover state-changing asset movement paths.
- Fuzz tests, invariant tests and security regression tests run in CI.
- Slither high-severity static analysis runs separately in CI.

## Emergency model

The pool owner controls market configuration, oracle replacement, reserve withdrawals, bad-debt absorption and unpausing. The risk admin can pause the whole protocol or individual markets but cannot reopen them. This is intentional so a compromised operational key can stop new risk without restoring activity or changing economic parameters.

During a pause, new supply and borrow activity is blocked. Repayment, liquidation and safe withdrawal paths are kept available so users and keepers can reduce risk.

## KUB Testnet deployment rules

The deployment workflow:

1. Requires explicit manual confirmation.
2. Refuses any RPC whose chain ID is not 25925.
3. Requires a dedicated signer with at least 0.1 tKUB before broadcast.
4. Builds and runs the complete Foundry suite before deployment.
5. Validates bytecode at every critical deployed address.
6. Executes an on-chain wrap/supply/borrow/repay/withdraw/unwrap smoke cycle.
7. Writes deployment addresses into the canonical frontend registry only after the smoke cycle passes.
8. Preserves Foundry broadcast receipts as workflow artifacts.

Never commit or paste a funded private key into source code, issues, chats or logs. Use a dedicated KUB Testnet wallet and the `KUB_TESTNET_PRIVATE_KEY` GitHub environment secret.

## Explicit testnet-only components

`mUSDC`, `mUSDT`, WtKUB and the sample RWA vault are testnet development components. Mock stablecoins are mintable and do not represent real USDC/USDT claims. The sample RWA vault does not represent a legally enforceable real-world asset.

## Before mainnet

At minimum: independent smart-contract audit, economic-model review, oracle/depeg policy, multisig plus timelock ownership, incident-response runbook, deployment reproducibility checks, formalized upgrade policy, monitoring/alerting, keeper/liquidator reliability testing and legal review for any RWA product.
