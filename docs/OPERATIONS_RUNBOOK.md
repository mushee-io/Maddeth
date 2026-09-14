# Maddeth KUB Testnet Operations Runbook

This runbook is for the current KUB Testnet deployment only. It does not authorize production deployment or production-fund custody.

## Canonical deployment

- Network: KUB Testnet
- Chain ID: 25925
- Registry: `config/kub-testnet.json`
- Explorer: KUBScan Testnet
- Canonical Pool: read from the registry; never paste an unverified replacement address into an admin transaction.

Before any emergency action, verify the connected wallet, chain ID, canonical Pool address, current owner, current risk admin, oracle address and current market status in the Protocol → Risk & Resilience Console.

## Severity model

### SEV-1 — immediate loss / solvency risk

Examples: confirmed oracle corruption, unexpected reserve deficit, unauthorized ownership/admin change, active exploit, repeated transaction behavior inconsistent with tested accounting.

Actions:

1. Pause the protocol immediately using the owner or risk-admin wallet.
2. Do not alter oracle, LTV, caps, reserves or ownership while the incident cause is unknown.
3. Record the latest block, transaction hashes, affected markets, wallet addresses and KUBScan links.
4. Reproduce the condition in an isolated Foundry test or test lab before proposing recovery.
5. Only the owner may unpause after the root cause is understood and the recovery change has passed Build/Test and Security Analysis.

### SEV-2 — one-market risk

Examples: one market oracle stale, abnormal utilization, liquidity exhaustion, suspicious asset behavior.

Actions:

1. Pause the affected market.
2. Keep healthy withdrawals and repayments available.
3. Inspect oracle freshness, cash, total supplied, total borrowed, reserves and utilization.
4. Do not reopen the market until the owner validates the recovery state.

### SEV-3 — frontend / RPC / observability issue

Examples: Vercel outage, RPC read failure, stale UI, KUBScan delay.

Actions:

1. Do not change onchain state just to fix a frontend symptom.
2. Verify canonical state directly from the registry and KUB RPC.
3. Keep deployment and admin actions blocked until the UI and RPC agree on chain ID and contract addresses.

## Emergency pause boundaries

The risk admin is intentionally pause-only. It may pause the full protocol or a listed market, but it cannot unpause. Recovery is owner-only. Market configuration, oracle replacement, reserve withdrawal and bad-debt absorption are not exposed through the browser risk console.

Pause should block new risk creation while preserving repair paths such as repayment and safe withdrawals where the contract permits them.

## Oracle incident checklist

A canonical price must be non-zero, not from the future and no older than the Pool's maximum oracle age. If any market violates these rules, borrowing/withdrawal/liquidation paths that depend on the invalid price must fail closed.

For a suspected oracle issue:

1. Pause the affected market or full protocol.
2. Record the oracle adapter and feed addresses from the canonical registry.
3. Compare the onchain timestamp and value to the expected feed policy.
4. Never use the Liquidation Lab oracle as a canonical replacement.
5. Reproduce zero, stale and future timestamp behavior in the deterministic oracle test suite.

## Insolvency / bad debt checklist

Bad debt may only be absorbed after enabled collateral is exhausted. The Pool consumes accrued reserves first, then socializes any remaining loss to suppliers through the supply index. `absorbBadDebt` is owner-only and must not be used as a convenience cleanup tool.

Before absorption:

1. Confirm the account is unhealthy.
2. Confirm enabled collateral value is zero.
3. Record residual debt, market cash, accrued reserves and supplier value.
4. Confirm the expected post-write-off supplier loss in an isolated test.
5. After absorption, verify borrower debt is zero and `cash + borrow receivables >= supplier claims`.

## Ownership / key incident

Maddeth uses two-step ownership. A transfer is not complete until the pending owner explicitly accepts. If a transfer is initiated to the wrong address, the current owner should cancel it before acceptance.

Do not use a personal deployer wallet as the intended long-term production owner. Production governance remains an external launch gate.

## Release procedure

For a testnet release candidate:

1. Merge only after Build/Test and Security Analysis are green.
2. Run `node scripts/check-frontend.mjs`.
3. Run `node scripts/check-release-readiness.mjs`.
4. Confirm `config/kub-testnet.json` contains the validated canonical deployment.
5. Deploy the frontend once.
6. Open `/app/readiness/` and refresh live checks.
7. Verify `/app/protocol/#risk-admin` reads the same canonical state.
8. Verify `/app/liquidations/#liquidation-lab` remains isolated from the canonical pool.

## Production boundary

A green testnet dashboard is not a production approval. Independent smart-contract audit, production oracle review, governance/multisig controls, conservative asset caps and the RWA legal/servicing framework remain blocking external gates.
