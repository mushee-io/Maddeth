import { KUB_TESTNET, MADDETH_DEPLOYMENT, configuredContract, deploymentReady } from './protocol-config.js';

const selectorCache = new Map();

function provider() {
  if (!window.ethereum) throw new Error('No EVM wallet detected');
  return window.ethereum;
}

function utf8ToHex(value) {
  return `0x${Array.from(new TextEncoder().encode(value)).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function selector(signature) {
  if (selectorCache.has(signature)) return selectorCache.get(signature);
  const hash = await provider().request({ method: 'web3_sha3', params: [utf8ToHex(signature)] });
  const result = hash.slice(0, 10);
  selectorCache.set(signature, result);
  return result;
}

function encodeAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('Invalid address');
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function encodeUint(value) {
  const n = BigInt(value);
  if (n < 0n) throw new Error('Negative uint');
  return n.toString(16).padStart(64, '0');
}

function encodeBool(value) {
  return value ? encodeUint(1n) : encodeUint(0n);
}

function decodeWords(data) {
  const body = String(data || '0x').slice(2);
  if (!body.length || body.length % 64 !== 0) throw new Error('Malformed contract response');
  const words = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return words;
}

async function ethCall(to, data) {
  return provider().request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
}

async function readNoArgUint(to, signature) {
  const data = await selector(signature);
  const result = await ethCall(to, data);
  return decodeWords(result)[0];
}

async function readAddressArgWords(to, signature, address) {
  const method = await selector(signature);
  return decodeWords(await ethCall(to, `${method}${encodeAddress(address)}`));
}

async function sendTransaction({ from, to, data, value = null }) {
  if (!from) throw new Error('Connect a wallet first');
  const chainHex = await provider().request({ method: 'eth_chainId' });
  if (Number.parseInt(chainHex, 16) !== KUB_TESTNET.chainId) throw new Error('Switch to KUB Testnet first');
  const tx = { from, to, data };
  if (value !== null) tx.value = `0x${BigInt(value).toString(16)}`;

  // Fail before opening a wallet confirmation if the transaction cannot execute against current state.
  await provider().request({ method: 'eth_estimateGas', params: [tx] });
  return provider().request({ method: 'eth_sendTransaction', params: [tx] });
}

export async function waitForReceipt(txHash, { timeoutMs = 120000, intervalMs = 1200 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await provider().request({ method: 'eth_getTransactionReceipt', params: [txHash] });
    if (receipt) {
      if (receipt.status === '0x0') throw new Error(`Transaction reverted: ${txHash}`);
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for transaction: ${txHash}`);
}

export async function ensureKubTestnet() {
  const wallet = provider();
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: KUB_TESTNET.chainIdHex }] });
  } catch (err) {
    if (err && err.code === 4902) {
      await wallet.request({ method: 'wallet_addEthereumChain', params: [KUB_TESTNET] });
      return;
    }
    throw err;
  }
}

export async function connectWallet() {
  const accounts = await provider().request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('Wallet did not return an account');
  await ensureKubTestnet();
  return accounts[0];
}

export async function walletSnapshot(account) {
  if (!account) throw new Error('Account required');
  const wallet = provider();
  const chainHex = await wallet.request({ method: 'eth_chainId' });
  const chainId = Number.parseInt(chainHex, 16);
  let nativeBalance = null;
  if (chainId === KUB_TESTNET.chainId) {
    nativeBalance = BigInt(await wallet.request({ method: 'eth_getBalance', params: [account, 'latest'] }));
  }
  return { account, chainId, nativeBalance };
}

export async function liveProtocolSnapshot(account = null) {
  if (!deploymentReady()) {
    return {
      deployed: false,
      activeMarkets: 0,
      accountHealthFactor: null,
      assets: [],
      reason: 'Protocol addresses are not configured yet.'
    };
  }

  const pool = configuredContract('maddethPool');
  const oracle = configuredContract('oracle');
  const activeMarkets = Number(await readNoArgUint(pool, 'marketCount()'));
  let accountHealthFactor = null;

  if (account) {
    const healthWords = await readAddressArgWords(pool, 'healthFactor(address)', account);
    accountHealthFactor = healthWords[0] ?? null;
  }

  const assets = [];
  for (const asset of MADDETH_DEPLOYMENT.assets) {
    const address = configuredContract(asset.key);
    if (!address) continue;

    const [totalSupplied, totalBorrowed, utilisation, reserves] = await readAddressArgWords(
      pool,
      'marketTotals(address)',
      address
    );
    const [price] = await readAddressArgWords(oracle, 'getPrice(address)', address);
    assets.push({ ...asset, address, totalSupplied, totalBorrowed, utilisation, reserves, price });
  }

  return { deployed: true, activeMarkets, accountHealthFactor, assets };
}

export function parseUnits(value, decimals = 18) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Enter a valid positive amount');
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error(`Too many decimal places; maximum is ${decimals}`);
  const base = 10n ** BigInt(decimals);
  const amount = BigInt(whole) * base + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  return amount;
}

export async function wrapTKUB(account, amount) {
  const wrapped = configuredContract('wrappedKUB');
  if (!wrapped) throw new Error('WtKUB is not configured');
  const data = await selector('deposit()');
  return sendTransaction({ from: account, to: wrapped, data, value: amount });
}

export async function approvePool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const method = await selector('approve(address,uint256)');
  return sendTransaction({
    from: account,
    to: asset,
    data: `${method}${encodeAddress(pool)}${encodeUint(amount)}`
  });
}

export async function supplyToPool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const method = await selector('supply(address,uint256)');
  return sendTransaction({
    from: account,
    to: pool,
    data: `${method}${encodeAddress(asset)}${encodeUint(amount)}`
  });
}

export async function setCollateral(account, asset, enabled = true) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const method = await selector('setCollateral(address,bool)');
  return sendTransaction({
    from: account,
    to: pool,
    data: `${method}${encodeAddress(asset)}${encodeBool(enabled)}`
  });
}

export async function borrowFromPool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const method = await selector('borrow(address,uint256)');
  return sendTransaction({
    from: account,
    to: pool,
    data: `${method}${encodeAddress(asset)}${encodeUint(amount)}`
  });
}

export async function repayPool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const approvalHash = await approvePool(account, asset, amount);
  await waitForReceipt(approvalHash);
  const method = await selector('repay(address,uint256)');
  return sendTransaction({
    from: account,
    to: pool,
    data: `${method}${encodeAddress(asset)}${encodeUint(amount)}`
  });
}

export function assetConfig(key) {
  const metadata = MADDETH_DEPLOYMENT.assets.find(asset => asset.key === key);
  const address = configuredContract(key);
  return metadata && address ? { ...metadata, address } : null;
}

export function formatUnits(value, decimals = 18, precision = 4) {
  if (value === null || value === undefined) return '—';
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const remainder = value % base;
  const fractional = remainder.toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return `${whole}${fractional ? `.${fractional}` : ''}`;
}

export function deploymentExplorerUrl(address) {
  if (!address) return null;
  return `${KUB_TESTNET.blockExplorerUrls[0]}/address/${address}`;
}

export function transactionExplorerUrl(hash) {
  if (!hash) return null;
  return `${KUB_TESTNET.blockExplorerUrls[0]}/tx/${hash}`;
}

export { KUB_TESTNET, MADDETH_DEPLOYMENT, configuredContract, deploymentReady };
