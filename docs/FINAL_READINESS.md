# Maddeth Final Testnet Readiness

Maddeth's internal readiness target is a hardened KUB Testnet release, not a claim of production safety.

## Internal testnet evidence

The repository must retain deterministic coverage for:

- supply, withdraw, collateral enable/disable
- borrow, repay and interest accrual
- supply-cap and borrow-cap enforcement
- near-100% utilization accounting
- insufficient-liquidity failure
- healthy-account liquidation rejection
- close-factor liquidation and liquidation bonus math
- two independent liquidators and repeated liquidation
- collateral exhaustion and residual bad debt
- reserve-first bad-debt absorption and supplier-loss socialization
- zero, stale and future oracle failure
- oracle recovery
- risk-admin pause-only permissions
- owner-only unpause and two-step ownership
- pause behavior during active debt
- reserve-withdrawal boundaries
- RWA lender allowlists and revocation
- RWA maturity, repayment and redemption
- RWA default declaration and cure
- RWA debt cap and term locking
- RWA issuer approval/revocation and factory emergency stop
- fuzz and invariant accounting coverage

`test/Phase4StressReadiness.t.sol`, `test/RwaHardening.t.sol`, the earlier Phase 1–3 suites and Slither security workflow collectively provide this evidence.

## Live testnet gates

The `/app/readiness/` page should report:

- canonical deployment registry marked deployed
- bytecode at every canonical contract address
- exactly three canonical lending markets
- non-zero oracle prices no older than the Pool maximum age
- no unexpected market pause
- live KUB block heartbeat
- isolated RWA sample readable

If any live gate fails, the release verdict should be ATTENTION rather than TESTNET READY.

## One-pass manual smoke test after frontend deployment

Run once after the Vercel quota clears and the final `main` build is deployed:

1. Dashboard loads live KUB snapshot.
2. Markets show three canonical assets.
3. Fresh wallet supplies WtKUB, enables collateral, borrows test stablecoin, repays and withdraws.
4. Liquidation Lab opens a healthy Wallet A position, shocks labKUB to $8, and Wallet B liquidates it.
5. Protocol Risk Console reads owner, risk admin, oracle and three markets.
6. Pause one test market, verify the state changes, then owner-unpause it.
7. RWA page loads the isolated sample vault and its legal/testnet disclaimer.
8. Readiness page refreshes to TESTNET READY with production gates still pending.

Do not use a global protocol pause during a routine smoke test unless an actual emergency-control test is explicitly planned.

## External gates that remain blocking

The following cannot be satisfied by repository code alone:

1. Independent smart-contract audit and remediation of findings.
2. Production oracle/feed policy and provider review.
3. Production governance, multisig and/or timelock design with actual signers.
4. Conservative production asset allowlist and caps.
5. RWA legal, servicing, recovery and issuer framework.

No Maddeth UI or document should represent these as complete until they are completed outside this repository and independently verified.

## Definition of done for the codebase

The code-side readiness phase is complete when:

- Build/Test is green on the final merged commit.
- Security Analysis is green on the final merged commit.
- `scripts/check-frontend.mjs` passes.
- `scripts/check-release-readiness.mjs` passes.
- Phase 4 stress and RWA hardening tests pass.
- the readiness page is part of the production frontend bundle.
- operations and audit-scope documents are present.

After that point, remaining launch work is external assurance/governance rather than major protocol feature development.
