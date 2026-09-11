# Maddeth architecture — KUB Testnet

Maddeth is split into two risk domains.

## 1. Permissionless crypto lending

`MaddethPool.sol` is the shared liquidity layer for approved ERC-20 assets. The intended production design includes:

- supply / withdraw
- collateral enable / disable
- overcollateralised borrow / repay
- supply and borrow caps
- market pause controls
- per-asset LTV and liquidation thresholds
- fail-closed oracle validation
- liquidations
- utilisation-based interest rates
- protocol reserve factor
- canonical market registry for complete account-wide risk checks

The checked-in contract is an early testnet core, **not production-ready**. Its account-wide health iteration is intentionally marked incomplete rather than faking safety.

## 2. Isolated RWA vaults

Each `IsolatedRwaVault` is a separate credit domain. RWA debt does not share collateral or liquidity accounting with permissionless lending markets. Each vault can have independent:

- borrower / issuer
- lender allowlist
- debt cap
- maturity
- legal agreement / off-chain servicing reference
- oracle / NAV process
- risk tier
- pause state

## KUB network

- Network: KUB Testnet
- Chain ID: 25925
- Native currency: tKUB
- RPC: https://rpc-testnet.bitkubchain.io
- Explorer: https://testnet.kubscan.com

No KUB token or stablecoin contract address is invented in this repository. Addresses remain null until verified testnet deployments are available.

## Next hardening milestones

1. Add debt and supply indexes for accrued interest.
2. Add reserve factor and treasury accounting.
3. Add bad-debt socialisation / insolvency handling.
4. Integrate a verified KUB-compatible oracle path.
5. Add wrapped KUB adapter after verifying the canonical wrapped KUB contract.
6. Add RWA attestation / NAV and permission provider interfaces.
7. Add invariant, fuzz and liquidation edge-case tests.
8. Add timelock / multisig governance for risk changes.
9. External security review before any mainnet funds.
