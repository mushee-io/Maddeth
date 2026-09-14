# Maddeth Phase 2 — Liquidation & Risk Engine

Maddeth has two liquidation test surfaces. They are intentionally separated.

## 1. Canonical KUB Testnet liquidation console

Open `/app/liquidations/`.

The console reads the already validated Maddeth KUB Testnet deployment. It does **not** change oracle prices, LTV, liquidation thresholds or any canonical market configuration.

It performs four steps:

1. Scans `Borrowed(address,address,uint256,uint256)` logs from the recorded deployment block.
2. Deduplicates borrower addresses and reads their current account risk through `MaddethLens`.
3. For an unhealthy account, previews the same close-factor and collateral-limited liquidation arithmetic used by `MaddethPool`.
4. From a second wallet, approves the exact debt-token amount and calls `MaddethPool.liquidate(...)`.

The browser transaction path performs `eth_estimateGas` before opening the wallet confirmation, so healthy accounts and other reverting liquidations fail closed.

### Two-wallet rule

Use two different wallets:

- **Wallet A** — borrower / unhealthy account.
- **Wallet B** — liquidator.

The liquidation console refuses to execute when the connected liquidator is the inspected borrower address.

For test stablecoin debt, the console includes a helper to mint 10,000 `mUSDC` or `mUSDT` to Wallet B. These tokens are test-only and have no production value.

## 2. Deterministic price-shock suite

A deterministic liquidation cannot safely be manufactured against the canonical pool because its WtKUB price comes from the configured KUB oracle adapter.

The Foundry suite `test/LiquidationEngine.t.sol` therefore uses a separate `MockPriceOracle`, `labKUB`, and `labUSDC`. This does not modify the canonical KUB deployment.

The suite proves:

- a healthy account cannot be liquidated;
- an oracle price shock can make the borrower unhealthy;
- one liquidation is capped by the protocol's 50% close factor;
- the configured liquidation bonus is reflected in seized collateral;
- a successful liquidation improves borrower health;
- repeated close-factor liquidations can restore health;
- collateral-limited liquidation does not overcharge the liquidator;
- a liquidator without the debt asset / approval cannot change borrower debt.

Run locally or in CI:

```bash
forge test --match-contract LiquidationEngineTest -vvv
```

## Canonical protocol constants currently exercised

- Close factor: `50%` (`5000` bps)
- Liquidation eligibility: account health factor `< 1.0`
- Liquidation collateral must be enabled collateral
- Liquidation repay is capped by both the close factor and the economic value of available collateral
- Collateral seizure includes the configured collateral-market liquidation bonus

## Manual canonical test

A real canonical liquidation should only be attempted when the live scanner reports an account as `LIQUIDATABLE`.

1. Connect Wallet B on KUB Testnet.
2. Run **Scan borrowers**.
3. Inspect a red `LIQUIDATABLE` account.
4. Select a debt market and enabled collateral market.
5. Click **Use max close**.
6. Click **Preview liquidation**.
7. Ensure Wallet B owns enough debt tokens; mint test stablecoins when applicable.
8. Click **Execute liquidation**.
9. Approve the debt token transaction.
10. Approve the pool liquidation transaction.
11. Re-inspect Wallet A and confirm debt fell, collateral was seized, and health improved or collateral was exhausted.

## Safety boundary

The canonical liquidation UI is an execution and monitoring surface, not a price manipulation tool. Forced price shocks belong only in the deterministic test suite or a separately deployed, clearly labelled liquidation lab.
