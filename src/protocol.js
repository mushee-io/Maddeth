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
    assets.push({
      ...asset,
      address,
      totalSupplied,
      totalBorrowed,
      utilisation,
      reserves,
      price
    });
  }

  return { deployed: true, activeMarkets, accountHealthFactor, assets };
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

export { KUB_TESTNET, MADDETH_DEPLOYMENT, configuredContract, deploymentReady };
