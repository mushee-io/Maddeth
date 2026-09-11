# Maddeth — KUB Testnet deployment

This document covers the canonical testnet deployment path for Maddeth. It is intentionally fail-closed: the frontend keeps contract addresses unset until a real deployment succeeds and the addresses are copied into both deployment registries.

## Network

- Network: KUB Testnet
- Chain ID: `25925`
- Chain ID hex: `0x6545`
- RPC: `https://rpc-testnet.bitkubchain.io`
- Explorer: `https://testnet.kubscan.com`
- Native asset: `tKUB`

## What the deployment script creates

`script/DeployKubTestnet.s.sol` deploys:

1. `WrappedTKUB`
2. mintable `mUSDC` test token
3. mintable `mUSDT` test token
4. `BitkubOracleAdapter`
5. `InterestRateModel`
6. `MaddethPool`
7. `RwaVaultFactory`

The script then configures WtKUB, mUSDC and mUSDT lending markets and approves the deployer as the first test RWA issuer.

The mintable stablecoins are **test assets only**. They must never be represented as real USDC/USDT.

## Oracle configuration

The testnet script currently points to the Bitkub/BKC Oracle proxy addresses used for KUB/USDT and USDC/USDT in the project configuration. The adapter validates positive values, completed rounds, timestamps and a configured heartbeat before returning a normalized 18-decimal price.

Some Bitkub Oracle deployments require consumer authorization/subscription. If the deployed `BitkubOracleAdapter` is not authorized to read a configured proxy, protocol reads will fail closed. Complete that authorization before enabling a market for a public demo.

## Environment

Copy `.env.example` locally and set a testnet-only deployment key. Never commit a private key.

```bash
export KUB_TESTNET_RPC_URL="https://rpc-testnet.bitkubchain.io"
export PRIVATE_KEY="<local testnet deployment key>"
```

The deployment key needs enough tKUB for testnet gas.

## Build and test first

```bash
forge build
forge test -vvv
```

Do not broadcast if either command fails.

## Dry run

```bash
forge script script/DeployKubTestnet.s.sol:DeployKubTestnet \
  --rpc-url "$KUB_TESTNET_RPC_URL" \
  -vvvv
```

The script hard-requires chain ID `25925`, so it will not silently deploy to another network.

## Broadcast

```bash
forge script script/DeployKubTestnet.s.sol:DeployKubTestnet \
  --rpc-url "$KUB_TESTNET_RPC_URL" \
  --broadcast \
  -vvvv
```

Record every returned deployment address and transaction hash.

## Post-deployment checklist

1. Confirm every deployment transaction on KUBScan.
2. Confirm the deployed pool references the intended oracle.
3. Confirm the oracle adapter can read each configured feed.
4. Confirm WtKUB wrapping/unwrapping on testnet.
5. Confirm mUSDC/mUSDT are clearly identified as test assets.
6. Run supply → collateral → borrow → repay → withdraw smoke tests with small amounts.
7. Force a test price move only in a controlled mock environment and confirm liquidation behavior.
8. Create one isolated RWA vault and confirm issuer ownership, lender allowlisting, maturity and repayment behavior.
9. Copy the canonical deployed addresses into `config/kub-testnet.json` and `src/protocol-config.js`.
10. Change `deploymentStatus` from `not-deployed` only after the deployment and smoke tests are verified.

## Frontend behavior

The frontend consumes `src/protocol-config.js`. While addresses are `null`, Live mode displays that contracts are not deployed/configured and refuses to invent protocol data.

Once canonical addresses are inserted, the browser client can read:

- active market count
- market supplied/borrowed totals
- utilisation
- reserves
- oracle prices
- connected account health factor

Transaction buttons remain disabled until the write path is deliberately enabled and tested against the deployed contracts.

## Mainnet warning

This repository is testnet software. Before any mainnet deployment, Maddeth still requires independent smart-contract review/audit, oracle/economic risk review, governance/multisig controls, production asset allowlisting, incident procedures and a legally reviewed RWA servicing/default process.
