# Maddeth

**Credit infrastructure for KUB.**

Maddeth is a KUB-native pooled lending protocol plus isolated RWA credit vault infrastructure, built testnet-first for KUB Chain.

## Application structure

Maddeth now uses a real multi-page protocol architecture instead of embedding every product view into one marketing page.

- `/` — marketing homepage
- `/app/` — application dashboard
- `/app/markets/` — market directory
- `/app/markets/wtkub/` — WtKUB market
- `/app/markets/musdc/` — mUSDC market
- `/app/markets/musdt/` — mUSDT market
- `/app/borrow/` — supply / collateral / borrow / repay / withdraw terminal
- `/app/rwa/` — isolated RWA credit vaults
- `/app/portfolio/` — connected-wallet portfolio and health
- `/app/protocol/` — protocol architecture and security model
- `/docs/` — documentation

Wallet connection is part of the application shell, not a requirement for browsing the marketing homepage or public market data.

## Current build

### Lending core

- indexed supplier and borrower accounting
- utilisation-driven kinked interest-rate model
- reserve factor and protocol reserve accounting
- supply / withdraw / collateral enable / borrow / repay / repay-for
- LTV and liquidation-threshold enforcement
- partial liquidations with close factor and liquidation bonus
- collateral-limited liquidation handling
- bad-debt absorption with reserves-first loss handling
- supply caps and borrow caps
- per-market pause plus protocol-wide emergency pause
- fail-closed price validation

### RWA credit

- isolated vault factory
- approved issuer registry
- issuer-owned vaults
- lender allowlists
- independent debt caps and maturity
- pause controls
- explicit default declaration and cure lifecycle
- debt-gated withdrawals
- metadata URI registry

### KUB integration

- KUB Testnet chain ID `25925`
- RPC `https://rpc-testnet.bitkubchain.io`
- explorer `https://testnet.kubscan.com`
- MetaMask-compatible EIP-1193 wallet connection
- automatic KUB Testnet add/switch flow
- native tKUB wallet balance
- Wrapped tKUB test contract
- Bitkub/BKC Oracle adapter with heartbeat, completed-round and timestamp checks
- KUB Testnet Foundry deployment script
- canonical deployment registry that stays empty until a real broadcast succeeds

### Frontend integrity

The frontend is static and route-based. `scripts/check-frontend.mjs` enforces the required routes, CSP, dedicated market/borrow/RWA/portfolio/protocol pages, critical DOM bindings, RWA testnet disclosure and external-link hardening.

GitHub Actions runs the frontend integrity check before `forge build` and `forge test -vvv`. The KUB Testnet deployment workflow runs the same frontend gate before any broadcast.

## Important

The smart contracts are **testnet software and are not production-ready**. They have not received an independent external audit.

The UI intentionally refuses to invent live TVL, rates, balances or deployment state while canonical KUB Testnet contract addresses are unset. Sandbox values are clearly labelled simulated values and cannot submit transactions.

Mintable `mUSDC` and `mUSDT` are test assets only and must never be represented as real stablecoins.

The RWA demonstration vault does not represent a legally enforceable real-world asset.

## Run locally

```bash
python -m http.server 8080
```

Open `http://localhost:8080/` for the homepage or `http://localhost:8080/app/` for the application.

## Build and test

```bash
node scripts/check-frontend.mjs
forge build
forge test -vvv
```

## KUB Testnet deployment

Use a dedicated testnet-only key. Never commit or paste a private key.

```bash
export KUB_TESTNET_RPC_URL="https://rpc-testnet.bitkubchain.io"
export PRIVATE_KEY="<local testnet key>"

forge script script/DeployKubTestnet.s.sol:DeployKubTestnet \
  --rpc-url "$KUB_TESTNET_RPC_URL" \
  -vvvv
```

After the dry run succeeds, add `--broadcast` to perform the real testnet deployment.

See `docs/KUB_TESTNET_DEPLOYMENT.md` for the deployment and post-deployment checklist.

## Repository layout

- `contracts/` — lending, RWA, oracle and test helper contracts
- `test/` — unit, fuzz and invariant tests
- `script/` — KUB Testnet deployment and smoke test
- `config/` — canonical network/deployment registry
- `src/` — shared design system, app client and protocol client
- `app/` — multi-page Maddeth application
- `docs/` — public documentation and deployment documentation
- `scripts/` — deployment registry and frontend integrity tooling
