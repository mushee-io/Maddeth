# Maddeth

**Credit infrastructure for KUB.**

Maddeth is a KUB-native lending and RWA credit protocol being built testnet-first.

## What is implemented in this build

- Original responsive institutional DeFi UI
- KUB Testnet network configuration
- MetaMask-compatible EIP-1193 wallet connection
- automatic KUB Testnet add/switch flow
- live native tKUB wallet balance
- Live vs Sandbox data separation
- lending market dashboard
- supply/borrow risk preview UI
- RWA isolated vault UI
- portfolio and protocol risk views
- testnet contract address configuration
- early Solidity pooled lending core
- isolated RWA vault contract
- kinked interest-rate model
- fail-closed price oracle interface + test-only mock oracle

## Important

The protocol contracts are **early testnet architecture and not production-ready**. The UI intentionally shows unavailable values in Live mode until real deployed contract addresses are configured. Sandbox figures are clearly labelled demonstration values.

## Run locally

Any static file server can serve this directory. Example with Python:

`python -m http.server 8080`

Then open `http://localhost:8080`.

## KUB Testnet

- Chain ID: 25925
- RPC: https://rpc-testnet.bitkubchain.io
- Currency: tKUB
- Explorer: https://testnet.kubscan.com
