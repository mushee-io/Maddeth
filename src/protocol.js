import { KUB_TESTNET, MADDETH_DEPLOYMENT, configuredContract, deploymentReady } from './protocol-config.js';

const selectorCache = new Map();
let rpcId = 1;

function walletProvider() {
  if (!window.ethereum) throw new Error('No EVM wallet detected');
  return window.ethereum;
}

async function rpcRequest(method, params = []) {
  const response = await fetch(KUB_TESTNET.rpcUrls[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
  });
  if (!response.ok) throw new Error(`KUB RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'KUB RPC request failed');
  return payload.result;
}

function utf8ToHex(value) {
  return `0x${Array.from(new TextEncoder().encode(value)).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function selector(signature) {
  if (selectorCache.has(signature)) return selectorCache.get(signature);
  const hash = await rpcRequest('web3_sha3', [utf8ToHex(signature)]);
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

function wordToAddress(word) {
  return `0x${BigInt(word).toString(16).padStart(40, '0').slice(-40)}`;
}

function decodeWords(data) {
  const body = String(data || '0x').slice(2);
  if (!body.length || body.length % 64 !== 0) throw new Error('Malformed contract response');
  const words = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return words;
}

async function ethCall(to, data) {
  return rpcRequest('eth_call', [{ to, data }, 'latest']);
}

async function readNoArgWords(to, signature) {
  return decodeWords(await ethCall(to, await selector(signature)));
}

async function readNoArgUint(to, signature) {
  return (await readNoArgWords(to, signature))[0];
}

async function readNoArgAddress(to, signature) {
  return wordToAddress((await readNoArgWords(to, signature))[0]);
}

async function readAddressArgWords(to, signature, address) {
  const method = await selector(signature);
  return decodeWords(await ethCall(to, `${method}${encodeAddress(address)}`));
}

async function sendTransaction({ from, to, data, value = null }) {
  if (!from) throw new Error('Connect a wallet first');
  const wallet = walletProvider();
  const chainHex = await wallet.request({ method: 'eth_chainId' });
  if (Number.parseInt(chainHex, 16) !== KUB_TESTNET.chainId) throw new Error('Switch to KUB Testnet first');
  const tx = { from, to, data };
  if (value !== null) tx.value = `0x${BigInt(value).toString(16)}`;

  // Fail closed before opening a wallet confirmation when the current state would revert.
  await wallet.request({ method: 'eth_estimateGas', params: [tx] });
  return wallet.request({ method: 'eth_sendTransaction', params: [tx] });
}

export async function waitForReceipt(txHash, { timeoutMs = 120000, intervalMs = 1200 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await rpcRequest('eth_getTransactionReceipt', [txHash]);
    if (receipt) {
      if (receipt.status === '0x0') throw new Error(`Transaction reverted: ${txHash}`);
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for transaction: ${txHash}`);
}

export async function ensureKubTestnet() {
  const wallet = walletProvider();
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
  const accounts = await walletProvider().request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('Wallet did not return an account');
  await ensureKubTestnet();
  return accounts[0];
}

export async function walletSnapshot(account) {
  if (!account) throw new Error('Account required');
  const wallet = walletProvider();
  const chainHex = await wallet.request({ method: 'eth_chainId' });
  const chainId = Number.parseInt(chainHex, 16);
  let nativeBalance = null;
  if (chainId === KUB_TESTNET.chainId) {
    nativeBalance = BigInt(await wallet.request({ method: 'eth_getBalance', params: [account, 'latest'] }));
  }
  return { account, chainId, nativeBalance };
}

async function readMarketViaLens(asset) {
  const lens = configuredContract('maddethLens');
  if (!lens) throw new Error('MaddethLens is not configured');
  const words = await readAddressArgWords(lens, 'marketView(address)', asset.address);
  if (words.length < 17) throw new Error('Unexpected MaddethLens market response');
  return {
    ...asset,
    listed: words[0] !== 0n,
    paused: words[1] !== 0n,
    ltvBps: words[2],
    liquidationThresholdBps: words[3],
    liquidationBonusBps: words[4],
    reserveFactorBps: words[5],
    supplyCap: words[6],
    borrowCap: words[7],
    totalSupplied: words[8],
    totalBorrowed: words[9],
    availableLiquidity: words[10],
    utilisation: words[11],
    reserves: words[12],
    supplyApr: words[13],
    borrowApr: words[14],
    price: words[15],
    priceUpdatedAt: words[16]
  };
}

export async function accountRisk(account) {
  if (!account || !deploymentReady()) return null;
  const lens = configuredContract('maddethLens');
  const words = await readAddressArgWords(lens, 'accountRisk(address)', account);
  if (words.length < 6) throw new Error('Unexpected MaddethLens account response');
  return {
    collateralUsd: words[0],
    borrowLimitUsd: words[1],
    liquidationLimitUsd: words[2],
    debtUsd: words[3],
    healthFactor: words[4],
    availableBorrowUsd: words[5]
  };
}

export async function positionSnapshot(account, asset) {
  if (!account) return null;
  const lens = configuredContract('maddethLens');
  if (!lens || !asset?.address) return null;
  const words = await readAddressArgWords(lens, 'positionView(address,address)', account)
    .catch(async () => {
      const method = await selector('positionView(address,address)');
      return decodeWords(await ethCall(lens, `${method}${encodeAddress(account)}${encodeAddress(asset.address)}`));
    });
  if (words.length < 4) throw new Error('Unexpected MaddethLens position response');
  return {
    ...asset,
    walletBalance: words[0],
    suppliedAmount: words[1],
    borrowedAmount: words[2],
    collateralEnabled: words[3] !== 0n
  };
}

async function readPosition(account, asset) {
  const lens = configuredContract('maddethLens');
  const method = await selector('positionView(address,address)');
  const words = decodeWords(await ethCall(lens, `${method}${encodeAddress(account)}${encodeAddress(asset.address)}`));
  return {
    ...asset,
    walletBalance: words[0],
    suppliedAmount: words[1],
    borrowedAmount: words[2],
    collateralEnabled: words[3] !== 0n
  };
}

export async function liveProtocolSnapshot(account = null) {
  if (!deploymentReady()) {
    return {
      deployed: false,
      activeMarkets: 0,
      accountRisk: null,
      positions: [],
      assets: [],
      reason: 'Protocol addresses are not configured yet.'
    };
  }

  const pool = configuredContract('maddethPool');
  const activeMarkets = Number(await readNoArgUint(pool, 'marketCount()'));
  const configuredAssets = MADDETH_DEPLOYMENT.assets
    .map(asset => ({ ...asset, address: configuredContract(asset.key) }))
    .filter(asset => asset.address);

  const assets = [];
  for (const asset of configuredAssets) assets.push(await readMarketViaLens(asset));

  let risk = null;
  const positions = [];
  if (account) {
    risk = await accountRisk(account);
    for (const asset of configuredAssets) positions.push(await readPosition(account, asset));
  }

  return { deployed: true, activeMarkets, accountRisk: risk, positions, assets };
}

export async function previewBorrow(account, asset, amount) {
  if (!deploymentReady()) throw new Error('Maddeth is not deployed');
  const lens = configuredContract('maddethLens');
  const method = await selector('previewBorrow(address,address,uint256)');
  const words = decodeWords(await ethCall(
    lens,
    `${method}${encodeAddress(account)}${encodeAddress(asset)}${encodeUint(amount)}`
  ));
  return {
    allowed: words[0] !== 0n,
    newDebtUsd: words[1],
    newHealthFactor: words[2],
    availableBorrowUsd: words[3]
  };
}

export async function sampleRwaSnapshot(account = null) {
  const vault = configuredContract('sampleRwaVault');
  if (!vault) return null;
  const [borrower, liquidityAsset, maturity, debtCap, totalDeposits, totalDebt, paused, defaulted] = await Promise.all([
    readNoArgAddress(vault, 'borrower()'),
    readNoArgAddress(vault, 'liquidityAsset()'),
    readNoArgUint(vault, 'maturity()'),
    readNoArgUint(vault, 'debtCap()'),
    readNoArgUint(vault, 'totalDeposits()'),
    readNoArgUint(vault, 'totalDebt()'),
    readNoArgUint(vault, 'paused()'),
    readNoArgUint(vault, 'defaulted()')
  ]);
  let lenderDeposit = 0n;
  let allowlisted = false;
  if (account) {
    lenderDeposit = (await readAddressArgWords(vault, 'deposits(address)', account))[0];
    allowlisted = (await readAddressArgWords(vault, 'allowlistedLender(address)', account))[0] !== 0n;
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  let status = 'ACTIVE';
  if (defaulted !== 0n) status = 'DEFAULTED';
  else if (paused !== 0n) status = 'PAUSED';
  else if (now >= maturity && totalDebt > 0n) status = 'MATURED_OUTSTANDING';
  else if (now >= maturity) status = 'MATURED_REPAID';
  return {
    address: vault,
    borrower,
    liquidityAsset,
    maturity,
    debtCap,
    totalDeposits,
    totalDebt,
    paused: paused !== 0n,
    defaulted: defaulted !== 0n,
    lenderDeposit,
    allowlisted,
    status
  };
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
  return sendTransaction({ from: account, to: wrapped, data: await selector('deposit()'), value: amount });
}

export async function unwrapTKUB(account, amount) {
  const wrapped = configuredContract('wrappedKUB');
  if (!wrapped) throw new Error('WtKUB is not configured');
  const method = await selector('withdraw(uint256)');
  return sendTransaction({ from: account, to: wrapped, data: `${method}${encodeUint(amount)}` });
}

export async function approveToken(account, token, spender, amount) {
  const method = await selector('approve(address,uint256)');
  return sendTransaction({
    from: account,
    to: token,
    data: `${method}${encodeAddress(spender)}${encodeUint(amount)}`
  });
}

export async function approvePool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  return approveToken(account, asset, pool, amount);
}

export async function supplyToPool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const method = await selector('supply(address,uint256)');
  return sendTransaction({ from: account, to: pool, data: `${method}${encodeAddress(asset)}${encodeUint(amount)}` });
}

export async function withdrawFromPool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const method = await selector('withdraw(address,uint256)');
  return sendTransaction({ from: account, to: pool, data: `${method}${encodeAddress(asset)}${encodeUint(amount)}` });
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
  return sendTransaction({ from: account, to: pool, data: `${method}${encodeAddress(asset)}${encodeUint(amount)}` });
}

export async function repayPool(account, asset, amount) {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const approvalHash = await approvePool(account, asset, amount);
  await waitForReceipt(approvalHash);
  const method = await selector('repay(address,uint256)');
  return sendTransaction({ from: account, to: pool, data: `${method}${encodeAddress(asset)}${encodeUint(amount)}` });
}

export async function mintTestAsset(account, key, amount) {
  if (key !== 'testUSDC' && key !== 'testUSDT') throw new Error('Only Maddeth test stablecoins can be minted');
  const token = configuredContract(key);
  if (!token) throw new Error('Test token is not configured');
  const method = await selector('mint(address,uint256)');
  return sendTransaction({ from: account, to: token, data: `${method}${encodeAddress(account)}${encodeUint(amount)}` });
}

export async function depositRwa(account, amount) {
  const vault = configuredContract('sampleRwaVault');
  const stable = configuredContract('testUSDC');
  if (!vault || !stable) throw new Error('RWA testnet vault is not configured');
  const approvalHash = await approveToken(account, stable, vault, amount);
  await waitForReceipt(approvalHash);
  const method = await selector('deposit(uint256)');
  return sendTransaction({ from: account, to: vault, data: `${method}${encodeUint(amount)}` });
}

export async function withdrawRwa(account, amount) {
  const vault = configuredContract('sampleRwaVault');
  if (!vault) throw new Error('RWA testnet vault is not configured');
  const method = await selector('withdraw(uint256)');
  return sendTransaction({ from: account, to: vault, data: `${method}${encodeUint(amount)}` });
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

export function formatWadPercent(value, precision = 2) {
  if (value === null || value === undefined) return '—';
  const basisPoints = value * 10_000n / 10n ** 18n;
  const whole = basisPoints / 100n;
  const fraction = (basisPoints % 100n).toString().padStart(2, '0').slice(0, precision);
  return `${whole}.${fraction}%`;
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
