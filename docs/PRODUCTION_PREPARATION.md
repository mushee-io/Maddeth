# Maddeth Production Preparation Gates

This file is a checklist, not authorization to deploy or accept production funds.

## Governance

- replace the personal deployer as the intended long-term owner
- use an independently reviewed multisig and/or timelock design
- document signer quorum, signer replacement and recovery procedures
- keep risk admin pause-only unless a future audit explicitly recommends otherwise
- rehearse owner and risk-admin incident actions on testnet

## Oracle policy

- select production-grade feeds for every supported asset
- independently verify feed addresses and authorization model
- define maximum age and bounds per asset
- define behavior for feed outage, stale values and provider incident
- test decimal normalization and recovery in a production-like fork/test environment

## Asset admission

For every asset considered for production, document:

- token contract and decimals
- transfer behavior (no unsupported fee/rebase semantics)
- liquidity and market-risk assumptions
- initial supply cap
- initial borrow cap
- LTV
- liquidation threshold
- liquidation bonus
- reserve factor
- oracle source and freshness policy

Initial caps should be conservative and raised only after observed utilization, liquidity and liquidation behavior are understood.

## RWA requirements

Before any real-world credit vault is considered production-ready:

- identify the legal issuer/borrower entity
- document enforceable lender rights
- document servicing, repayment, default and recovery process
- define lender eligibility / access controls
- define reporting and disclosure obligations
- review metadata and issuer statements for accuracy

The onchain vault only enforces the coded accounting and access rules. Legal enforcement remains external.

## Security assurance

- complete independent smart-contract audit
- resolve critical/high findings and document accepted residual risks
- rerun full CI, fuzz, invariant and security analysis after remediation
- review deployment scripts and final constructor/configuration values
- perform a fresh testnet release candidate deployment and smoke test

## Operational readiness

- approve `docs/OPERATIONS_RUNBOOK.md`
- define monitoring and alert ownership
- define incident communication channels
- define pause authority and escalation
- define release/change-control policy
- archive canonical deployment manifests and verified source commit

## Final go/no-go

Production remains NO-GO while any blocking external gate in `config/readiness.json` is pending. The testnet dashboard must not override that rule.
