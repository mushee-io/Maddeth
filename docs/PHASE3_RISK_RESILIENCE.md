# Maddeth Phase 3 — Risk & Resilience

Phase 3 hardens three areas: explicit bad-debt handling, fail-closed oracle behavior and live emergency administration on the canonical KUB Testnet deployment.

## Safety boundary

The canonical Maddeth pool and Bitkub oracle are never fault-injected from the browser. Zero, stale, future and distressed-price scenarios run only in Foundry against TEST-ONLY mocks. The browser Risk & Resilience Console reads canonical state and exposes only emergency pause/unpause paths that already exist in `MaddethPool`.

The browser console deliberately does **not** expose `configureMarket`, `setOracle`, `absorbBadDebt` or `withdrawReserves`.

## Bad debt model

`absorbBadDebt(user, debtAsset)` is owner-only. It can only execute after the account is unhealthy and all enabled collateral value has been exhausted. Accrued protocol reserves cover the debt first. Any remaining amount is socialized through the market supply index, making supplier loss explicit in accounting instead of hiding it.

Phase 3 tests assert:

- bad debt cannot be absorbed while collateral remains;
- non-owner callers cannot absorb bad debt;
- collateral-limited liquidation can leave real residual debt;
- absorption clears the borrower debt shares and reduces market borrow accounting;
- accrued reserves are consumed before supplier loss;
- supplier balances reflect residual loss rather than leaving an insolvent accounting hole.

## Oracle fail-closed matrix

`MaddethPool` requires a strictly positive price, rejects timestamps in the future and rejects prices older than `MAX_ORACLE_AGE` (30 minutes).

The Phase 3 suite checks:

| Fault | Expected result |
| --- | --- |
| Price = 0 | `INVALID_PRICE` |
| Price older than max age | `STALE_PRICE` |
| Price timestamp in the future | `FUTURE_PRICE` |
| Stale price during liquidation | liquidation reverts and debt is unchanged |
| Feed restored with valid current price | borrow path works again |

`FaultyPriceOracle.sol` exists exclusively for deterministic tests and must never replace the canonical KUB oracle.

## Risk & Resilience Console

Open `/app/protocol/#risk-admin`.

The console reads directly from the canonical KUB Testnet Pool and Oracle and displays:

- connected wallet role;
- owner, pending owner and risk admin;
- protocol pause state;
- canonical oracle address;
- market count;
- per-market supplied, borrowed, utilisation, cash and reserves;
- LTV and liquidation threshold;
- oracle freshness status and age;
- per-market pause state;
- emergency warning count.

### Emergency permissions

- **Owner**: pause/unpause protocol, pause/unpause markets.
- **Risk admin**: pause protocol and markets only.
- **Everyone else**: read-only observer.

Every browser mutation performs `eth_estimateGas` before asking the wallet to submit the transaction. A reverting emergency action therefore fails closed before broadcast.

## Manual Phase 3 checklist

1. Open the Protocol page and scroll to **Risk & resilience console**.
2. Confirm owner, risk admin, oracle and three canonical markets populate.
3. Confirm each oracle reports `FRESH` under normal KUB Testnet state.
4. Confirm a normal non-admin wallet receives read-only controls.
5. With the risk-admin wallet, verify **Pause** is available but **Unpause** is disabled.
6. With the owner wallet, verify both pause and recovery actions are role-appropriate.
7. Do not pause the canonical pool unless intentionally performing an emergency-control test.
8. Run `forge test -vvv`; all Phase 3 bad-debt/oracle/admin tests must pass.

## PASS criteria

Phase 3 is complete when:

- Foundry Build/Test is green;
- security analysis remains green;
- all deterministic bad-debt tests pass;
- zero/stale/future oracle tests pass;
- recovery from a valid oracle price is demonstrated;
- canonical risk telemetry loads from KUB Testnet;
- risk admin is pause-only and owner-only recovery is enforced;
- browser integrity checks prevent destructive owner configuration from being added to the console accidentally.

Independent smart-contract audit and production governance/oracle policy remain prerequisites for mainnet use.
