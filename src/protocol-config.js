export const KUB_TESTNET = Object.freeze({
  chainId: 25925,
  chainIdHex: '0x6545',
  chainName: 'KUB Testnet',
  nativeCurrency: Object.freeze({ name: 'Test KUB', symbol: 'tKUB', decimals: 18 }),
  rpcUrls: Object.freeze(['https://rpc-testnet.bitkubchain.io']),
  blockExplorerUrls: Object.freeze(['https://testnet.kubscan.com']),
  faucetUrl: 'https://faucet.kubchain.com/'
});

// Canonical deployment registry consumed by the static frontend.
// Addresses MUST stay null until a real chain-25925 broadcast succeeds and is checked on KUBScan.
export const MADDETH_DEPLOYMENT = Object.freeze({
  network: 'KUB Testnet',
  chainId: 25925,
  contracts: Object.freeze({
    maddethPool: '0xe381d4d97fA0206D447d1E965F1c1dB96cC5fDc6',
    maddethLens: '0x55F4a27C67916A47E8421576c07cB2Ffe7B7022d',
    oracle: '0x4D468eb9b0b7AD964a87Cb79E5D329D9a22a9D36',
    interestRateModel: '0x127f127281f8Be23D9789a44fFFC7a2A980BE6d6',
    rwaVaultFactory: '0x76Dd7E8A3f77f7cD2C3d84C025cBBD01670991A4',
    sampleRwaVault: '0x0958Cc85232D8393B92D1463D2DFeB4FEFb8B801',
    wrappedKUB: '0x9f99A8573F7A330eA01E04117e29d98e0164f88E',
    testUSDT: '0x5609661078c717b996Ab0185d5a555925Da27bE5',
    testUSDC: '0x2d6f6A9b93dE56E4169fbc7C5a2F1dE0B55bC1F8'
  }),
  oracleFeeds: Object.freeze({
    kubUsdt: '0x6Cc1316A9695E435875A5CDA6e60066114f8A395',
    usdcUsdt: '0x6f1373EC8d0562be98a98FE46844f057284B7A61'
  }),
  assets: Object.freeze([
    Object.freeze({
      key: 'wrappedKUB',
      symbol: 'WtKUB',
      name: 'Wrapped Test KUB',
      decimals: 18,
      testOnly: true,
      canWrapNative: true,
      collateral: true
    }),
    Object.freeze({
      key: 'testUSDC',
      symbol: 'mUSDC',
      name: 'Maddeth Test USDC',
      decimals: 6,
      testOnly: true,
      canWrapNative: false,
      collateral: true
    }),
    Object.freeze({
      key: 'testUSDT',
      symbol: 'mUSDT',
      name: 'Maddeth Test USDT',
      decimals: 6,
      testOnly: true,
      canWrapNative: false,
      collateral: true
    })
  ])
});

export function configuredContract(name) {
  const value = MADDETH_DEPLOYMENT.contracts[name];
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

export function deploymentReady() {
  return Boolean(
    configuredContract('maddethPool') &&
    configuredContract('maddethLens') &&
    configuredContract('oracle') &&
    configuredContract('wrappedKUB') &&
    configuredContract('testUSDC') &&
    configuredContract('testUSDT')
  );
}
