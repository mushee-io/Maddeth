# Maddeth Independent Audit Scope

This document defines the intended scope for a future independent security review. It is not an audit report and must never be presented as one.

## In-scope smart contracts

- `contracts/MaddethPool.sol`
- `contracts/MaddethLens.sol`
- `contracts/InterestRateModel.sol`
- `contracts/BitkubOracleAdapter.sol`
- `contracts/IsolatedRwaVault.sol`
- `contracts/RwaVaultFactory.sol`
- `contracts/WrappedTKUB.sol`
- `contracts/utils/Ownable2Step.sol`
- contract interfaces and production-path libraries used by the above

Test-only mocks, the Liquidation Lab oracle and test stablecoins should be reviewed for test isolation but are not production dependencies.

## Primary audit questions

### Pooled lending accounting

- supply/borrow share and index math
- rounding direction and zero-share edge cases
- interest accrual and reserve accounting
- cash plus receivables versus supplier claims
- market-cap enforcement
- behavior at very high utilization
- reentrancy and token-transfer assumptions
- unsupported fee/rebasing token behavior

### Collateral and solvency

- LTV and liquidation-threshold calculations
- oracle decimals and asset decimals
- close factor and liquidation bonus
- collateral-limited liquidation
- repeated liquidations
- health-factor transitions
- bad-debt absorption
- reserve-first loss coverage
- supplier-loss socialization
- market-insolvent fail-closed boundaries

### Oracle safety

- zero/future/stale data
- price bounds
- feed authorization/configuration
- decimal normalization
- stale recovery
- failure propagation through borrow/withdraw/liquidation paths

### Administration and governance

- owner/risk-admin separation
- pause/unpause authority
- two-step ownership
- market reconfiguration risk
- oracle replacement authority
- reserve-withdrawal authority
- bad-debt absorption authority
- deployment/configuration assumptions

### RWA isolation

- lender allowlists and revocation
- fixed-term APR accounting
- debt cap
- maturity behavior
- default declaration/cure
- withdrawal/redemption rules
- issuer approval and factory pause
- metadata/maturity constraints
- legal/off-chain assumptions that cannot be enforced by the contracts

## Frontend / operational review

The independent review should also sample the transaction-producing frontend paths for:

- chain-ID enforcement
- canonical-address pinning
- gas-estimation fail-closed behavior
- approval amounts
- two-wallet liquidation guard
- separation of canonical and test-lab contracts
- emergency pause UX
- misleading readiness or audit claims

## Evidence supplied to auditors

- all Foundry tests
- fuzz/invariant configuration
- Phase 2 liquidation lab documentation
- Phase 3 risk/resilience documentation
- Phase 4 stress/readiness documentation
- canonical KUB Testnet registry
- deployment/resume workflows
- security-analysis workflow
- operations runbook
- known assumptions and external gates

## Explicit exclusions / external dependencies

An independent code audit does not itself establish:

- legal enforceability of RWA credit
- solvency or identity of real-world issuers
- correctness of third-party oracle providers beyond integration behavior
- security of external wallets/signers
- regulatory approval
- insurance
- economic safety of any future production cap selection

Those require separate operational, legal, economic and governance review.
