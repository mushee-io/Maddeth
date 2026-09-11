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
    maddethPool: null,
    maddethLens: null,
    oracle: null,
    interestRateModel: null,
    rwaVaultFactory: null,
    sampleRwaVault: null,
    wrappedKUB: null,
    testUSDT: null,
    testUSDC: null
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
