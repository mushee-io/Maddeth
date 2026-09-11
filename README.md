# Maddeth

**Credit infrastructure for KUB.**

Maddeth is a KUB-native pooled lending protocol plus isolated RWA credit vault infrastructure. The project is being built testnet-first for KUB Chain.

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
- MetaMask-compatible EIP-1193 wallet connection
- automatic KUB Testnet add/switch flow
- native tKUB wallet balance
- Wrapped tKUB test contract
- Bitkub/BKC Oracle adapter with heartbeat, completed-round and timestamp checks
- KUB Testnet Foundry deployment script
- canonical deployment registry that stays empty until a real broadcast succeeds

### Testing and CI

Foundry tests cover the pooled lending lifecycle, interest accrual, liquidations, stale prices, emergency controls, RWA lifecycle, factory ownership, wrapped tKUB and Bitkub Oracle adapter behavior. Fuzz tests and accounting invariants are also included.

GitHub Actions runs `forge build` and `forge test -vvv` on pushes and pull requests.

## Important

The smart contracts are **testnet software and are not production-ready**. They have not received an independent external audit. The UI intentionally refuses to invent live TVL, rates or balances while canonical KUB Testnet contract addresses are unset.

Mintable `mUSDC` and `mUSDT` are test assets only and must never be represented as real stablecoins.

## Run the frontend locally

Any static file server can serve this repository:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

The browser client reads `src/protocol-config.js`. Before deployment it shows the protocol as not configured. After verified addresses are inserted, Live mode can read market totals, utilisation, reserves, oracle prices and connected-account health factor directly from KUB Testnet.

## Build and test contracts

Install Foundry, then run:

```bash
forge build
forge test -vvv
```

## KUB Testnet deployment

Use a testnet-only key locally. Never commit a private key.

```bash
export KUB_TESTNET_RPC_URL="https://rpc-testnet.bitkubchain.io"
export PRIVATE_KEY="<local testnet key>"

forge script script/DeployKubTestnet.s.sol:DeployKubTestnet \
  --rpc-url "$KUB_TESTNET_RPC_URL" \
  -vvvv
```

After the dry run succeeds, add `--broadcast` to perform the real testnet deployment.

See [`docs/KUB_TESTNET_DEPLOYMENT.md`](docs/KUB_TESTNET_DEPLOYMENT.md) for the full deployment and post-deployment checklist.

## KUB Testnet

- RPC: `https://rpc-testnet.bitkubchain.io`
- Chain ID: `25925`
- Native currency: `tKUB`
- Explorer: `https://testnet.kubscan.com`

## Repository layout

- `contracts/` — lending, RWA, oracle and test helper contracts
- `test/` — unit, fuzz and invariant tests
- `script/` — KUB Testnet deployment
- `config/` — canonical network/deployment registry
- `src/` — static frontend, wallet and live protocol client
- `docs/` — architecture and deployment documentation
