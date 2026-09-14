const $ = id => document.getElementById(id);
const WAD = 10n ** 18n;
const ZERO = '0x0000000000000000000000000000000000000000';
const KUB = {
  chainId: 25925,
  chainIdHex: '0x6545',
  rpcUrl: 'https://rpc-testnet.bitkubchain.io',
  explorer: 'https://testnet.kubscan.com',
  addChain: {
    chainId: '0x6545',
    chainName: 'KUB Testnet',
    nativeCurrency: { name: 'Test KUB', symbol: 'tKUB', decimals: 18 },
    rpcUrls: ['https://rpc-testnet.bitkubchain.io'],
    blockExplorerUrls: ['https://testnet.kubscan.com']
  }
};

const state = {
  registry: null,
  pool: null,
  account: null,
  chainId: null,
  owner: null,
  pendingOwner: null,
  riskAdmin: null,
  oracle: null,
  protocolPaused: false,
  maxOracleAge: 0n,
  blockTimestamp: 0n,
  markets: [],
  selectedMarket: null,
  inFlight: false
};

const selectorCache = new Map();
let rpcId = 1;

function text(id, value) { const el = $(id); if (el) el.textContent = value; }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function sameAddress(a, b) { return Boolean(a && b && a.toLowerCase() === b.toLowerCase()); }
function shortAddress(a) { return isAddress(a) ? `${a.slice(0,6)}…${a.slice(-4)}` : '—'; }
function encodeUint(v) { return BigInt(v).toString(16).padStart(64, '0'); }
function encodeAddress(v) { if (!isAddress(v)) throw new Error('Invalid address'); return v.slice(2).toLowerCase().padStart(64, '0'); }
function encodeBool(v) { return encodeUint(v ? 1n : 0n); }
function wordAddress(v) { return `0x${BigInt(v).toString(16).padStart(64, '0').slice(24)}`; }
function formatUnits(value, decimals = 18, precision = 4) {
  const n = BigInt(value ?? 0);
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = n / base;
  const frac = (n % base).toString().padStart(Number(d), '0').slice(0, precision).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}
function formatPctWad(v) { return `${(Number(v) / 1e16).toFixed(2)}%`; }
function formatBps(v) { return `${(Number(v) / 100).toFixed(2)}%`; }
function explorerAddress(address) { return `${KUB.explorer}/address/${address}`; }
function setBanner(message = '', { error = false, txHash = null } = {}) {
  const el = $('riskActionBanner');
  if (!el) return;
  if (!message) { el.classList.add('hidden'); el.replaceChildren(); return; }
  el.classList.remove('hidden');
  el.classList.toggle('error', error);
  el.replaceChildren(document.createTextNode(message));
  if (txHash) {
    const a = document.createElement('a');
    a.href = `${KUB.explorer}/tx/${txHash}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = ' View on KUBScan ↗';
    el.appendChild(a);
  }
}

async function rpc(method, params = []) {
  const response = await fetch(KUB.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
  });
  if (!response.ok) throw new Error(`KUB RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'KUB RPC failed');
  return payload.result;
}

async function selector(signature) {
  if (selectorCache.has(signature)) return selectorCache.get(signature);
  const bytes = `0x${Array.from(new TextEncoder().encode(signature)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const hash = await rpc('web3_sha3', [bytes]);
  const out = hash.slice(0, 10);
  selectorCache.set(signature, out);
  return out;
}

function decodeWords(data) {
  const body = String(data || '0x').slice(2);
  if (!body.length || body.length % 64 !== 0) throw new Error('Malformed contract response');
  const words = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return words;
}

async function ethCall(to, data) { return rpc('eth_call', [{ to, data }, 'latest']); }
async function callWords(to, signature, args = '') { return decodeWords(await ethCall(to, `${await selector(signature)}${args}`)); }
async function callAddress(to, signature, args = '') { return wordAddress((await callWords(to, signature, args))[0]); }
async function tokenBalance(token, account) { return (await callWords(token, 'balanceOf(address)', encodeAddress(account)))[0]; }

async function ensureKub() {
  if (!window.ethereum) throw new Error('Install a MetaMask-compatible wallet');
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: KUB.chainIdHex }] });
  } catch (e) {
    if (e?.code === 4902) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [KUB.addChain] });
    else throw e;
  }
}

async function connect() {
  if (!window.ethereum) { setBanner('No EVM wallet detected.', { error: true }); return; }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.[0]) throw new Error('Wallet returned no account');
    await ensureKub();
    state.account = accounts[0];
    await refresh();
  } catch (e) {
    setBanner(e?.message || 'Wallet connection failed', { error: true });
  }
}

async function waitReceipt(hash) {
  const started = Date.now();
  while (Date.now() - started < 150_000) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status === '0x0') throw new Error(`Transaction reverted: ${hash}`);
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

async function sendTx(data, label) {
  if (!state.account) throw new Error('Connect the admin wallet first');
  if (state.chainId !== KUB.chainId) throw new Error('Switch to KUB Testnet first');
  const tx = { from: state.account, to: state.pool, data };
  setBanner(`${label}: estimating gas…`);
  await window.ethereum.request({ method: 'eth_estimateGas', params: [tx] });
  setBanner(`${label}: waiting for wallet confirmation…`);
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
  setBanner(`${label}: submitted. Waiting for confirmation…`, { txHash: hash });
  await waitReceipt(hash);
  setBanner(`${label}: confirmed.`, { txHash: hash });
  return hash;
}

async function loadRegistry() {
  const response = await fetch('/config/kub-testnet.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Canonical KUB registry unavailable');
  const registry = await response.json();
  if (registry.deploymentStatus !== 'deployed') throw new Error('Canonical Maddeth deployment is not marked deployed');
  const pool = registry.contracts?.maddethPool;
  if (!isAddress(pool)) throw new Error('Canonical pool address missing');
  state.registry = registry;
  state.pool = pool;
}

function marketIdentity(asset) {
  const c = state.registry?.contracts || {};
  if (sameAddress(asset, c.wrappedKUB)) return { symbol: 'WtKUB', decimals: 18 };
  if (sameAddress(asset, c.testUSDC)) return { symbol: 'mUSDC', decimals: 6 };
  if (sameAddress(asset, c.testUSDT)) return { symbol: 'mUSDT', decimals: 6 };
  return { symbol: shortAddress(asset), decimals: 18 };
}

async function readMarket(asset) {
  const cfg = await callWords(state.pool, 'markets(address)', encodeAddress(asset));
  const totals = await callWords(state.pool, 'marketTotals(address)', encodeAddress(asset));
  const cash = await tokenBalance(asset, state.pool);
  let oraclePrice = 0n;
  let oracleUpdatedAt = 0n;
  let oracleError = null;
  try {
    const price = await callWords(state.oracle, 'getPrice(address)', encodeAddress(asset));
    oraclePrice = price[0];
    oracleUpdatedAt = price[1];
  } catch (e) {
    oracleError = e?.message || 'oracle read reverted';
  }
  const identity = marketIdentity(asset);
  const age = oracleUpdatedAt > 0n && state.blockTimestamp >= oracleUpdatedAt ? state.blockTimestamp - oracleUpdatedAt : null;
  let oracleState = 'FRESH';
  if (oracleError) oracleState = 'REVERT';
  else if (oraclePrice === 0n) oracleState = 'ZERO';
  else if (oracleUpdatedAt > state.blockTimestamp) oracleState = 'FUTURE';
  else if (age === null || age > state.maxOracleAge) oracleState = 'STALE';

  return {
    asset,
    ...identity,
    listed: cfg[0] !== 0n,
    paused: cfg[1] !== 0n,
    ltvBps: cfg[2],
    liquidationThresholdBps: cfg[3],
    liquidationBonusBps: cfg[4],
    reserveFactorBps: cfg[5],
    supplyCap: cfg[6],
    borrowCap: cfg[7],
    rateModel: wordAddress(cfg[8]),
    totalSupplied: totals[0],
    totalBorrowed: totals[1],
    utilisation: totals[2],
    reserves: totals[3],
    cash,
    oraclePrice,
    oracleUpdatedAt,
    oracleAge: age,
    oracleState,
    oracleError
  };
}

async function readCanonicalState() {
  const pool = state.pool;
  const [owner, pendingOwner, riskAdmin, oracle, paused, maxAge, count, block] = await Promise.all([
    callAddress(pool, 'owner()'),
    callAddress(pool, 'pendingOwner()'),
    callAddress(pool, 'riskAdmin()'),
    callAddress(pool, 'oracle()'),
    callWords(pool, 'protocolPaused()'),
    callWords(pool, 'MAX_ORACLE_AGE()'),
    callWords(pool, 'marketCount()'),
    rpc('eth_getBlockByNumber', ['latest', false])
  ]);
  state.owner = owner;
  state.pendingOwner = pendingOwner;
  state.riskAdmin = riskAdmin;
  state.oracle = oracle;
  state.protocolPaused = paused[0] !== 0n;
  state.maxOracleAge = maxAge[0];
  state.blockTimestamp = BigInt(block.timestamp);

  const markets = [];
  for (let i = 0n; i < count[0]; i++) {
    const asset = await callAddress(pool, 'listedAssets(uint256)', encodeUint(i));
    markets.push(await readMarket(asset));
  }
  state.markets = markets;
  if (!state.selectedMarket || !markets.some(m => sameAddress(m.asset, state.selectedMarket))) state.selectedMarket = markets[0]?.asset || null;
}

function roleLabel() {
  if (!state.account) return 'Observer';
  if (sameAddress(state.account, state.owner)) return 'Owner';
  if (sameAddress(state.account, state.riskAdmin)) return 'Risk admin';
  return 'Observer';
}

function riskAlerts() {
  const alerts = [];
  if (state.protocolPaused) alerts.push('Protocol paused');
  if (state.pendingOwner && !sameAddress(state.pendingOwner, ZERO)) alerts.push('Ownership transfer pending');
  for (const market of state.markets) {
    if (market.paused) alerts.push(`${market.symbol} paused`);
    if (market.oracleState !== 'FRESH') alerts.push(`${market.symbol} oracle ${market.oracleState.toLowerCase()}`);
    if (market.utilisation >= 9n * WAD / 10n) alerts.push(`${market.symbol} utilisation ≥ 90%`);
    if (market.totalBorrowed > 0n && market.cash === 0n) alerts.push(`${market.symbol} has zero cash`);
  }
  return alerts;
}

function renderMarkets() {
  const body = $('riskMarketsBody');
  if (!body) return;
  body.replaceChildren();
  for (const market of state.markets) {
    const row = document.createElement('div');
    row.className = `risk-market-row${market.paused ? ' paused' : ''}${market.oracleState !== 'FRESH' ? ' warning' : ''}`;
    const age = market.oracleAge === null ? '—' : `${market.oracleAge}s`;
    const cells = [
      market.symbol,
      formatUnits(market.totalSupplied, market.decimals, 2),
      formatUnits(market.totalBorrowed, market.decimals, 2),
      formatPctWad(market.utilisation),
      formatUnits(market.cash, market.decimals, 2),
      formatUnits(market.reserves, market.decimals, 4),
      formatBps(market.ltvBps),
      formatBps(market.liquidationThresholdBps),
      `${market.oracleState} · ${age}`,
      market.paused ? 'PAUSED' : 'OPEN'
    ];
    for (const value of cells) {
      const span = document.createElement('span');
      span.textContent = value;
      row.appendChild(span);
    }
    body.appendChild(row);
  }
}

function renderMarketSelect() {
  const select = $('riskMarketSelect');
  if (!select) return;
  const previous = state.selectedMarket;
  select.replaceChildren();
  for (const market of state.markets) {
    const option = document.createElement('option');
    option.value = market.asset;
    option.textContent = `${market.symbol} · ${shortAddress(market.asset)}${market.paused ? ' · PAUSED' : ''}`;
    select.appendChild(option);
  }
  if (previous && state.markets.some(m => sameAddress(m.asset, previous))) select.value = previous;
  state.selectedMarket = select.value || state.markets[0]?.asset || null;
}

function render() {
  text('riskConnectedWallet', state.account ? shortAddress(state.account) : 'Not connected');
  text('riskRole', roleLabel());
  text('riskNetwork', state.account ? (state.chainId === KUB.chainId ? 'KUB Testnet' : `Wrong network · ${state.chainId}`) : 'Not connected');
  text('riskOwner', shortAddress(state.owner));
  text('riskPendingOwner', state.pendingOwner && !sameAddress(state.pendingOwner, ZERO) ? shortAddress(state.pendingOwner) : 'None');
  text('riskAdminAddress', shortAddress(state.riskAdmin));
  text('riskOracle', shortAddress(state.oracle));
  text('riskProtocolPause', state.protocolPaused ? 'PAUSED' : 'OPEN');
  text('riskMarketCount', String(state.markets.length));
  const alerts = riskAlerts();
  text('riskAlertCount', String(alerts.length));
  text('riskEmergencyStatus', alerts.length ? alerts.join(' · ') : 'No active emergency flags');
  renderMarkets();
  renderMarketSelect();
  updateButtons();
}

function updateButtons() {
  const ready = Boolean(state.account && state.chainId === KUB.chainId && !state.inFlight);
  const isOwner = sameAddress(state.account, state.owner);
  const isRiskAdmin = sameAddress(state.account, state.riskAdmin);
  const selected = state.markets.find(m => sameAddress(m.asset, state.selectedMarket));
  if ($('riskPauseProtocol')) $('riskPauseProtocol').disabled = !ready || state.protocolPaused || (!isOwner && !isRiskAdmin);
  if ($('riskUnpauseProtocol')) $('riskUnpauseProtocol').disabled = !ready || !state.protocolPaused || !isOwner;
  if ($('riskPauseMarket')) $('riskPauseMarket').disabled = !ready || !selected || selected.paused || (!isOwner && !isRiskAdmin);
  if ($('riskUnpauseMarket')) $('riskUnpauseMarket').disabled = !ready || !selected || !selected.paused || !isOwner;
}

async function refresh() {
  if (!state.pool) return;
  if (window.ethereum) {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    state.account = accounts?.[0] || null;
    if (state.account) {
      const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
      state.chainId = Number.parseInt(chainHex, 16);
    } else state.chainId = null;
  }
  await readCanonicalState();
  render();
}

async function locked(fn) {
  if (state.inFlight) return;
  state.inFlight = true;
  updateButtons();
  try {
    await fn();
    await refresh();
  } catch (e) {
    setBanner(`Action stopped: ${e?.message || 'unknown error'}`, { error: true });
  } finally {
    state.inFlight = false;
    updateButtons();
  }
}

async function setProtocolPause(paused) {
  await locked(async () => {
    const role = roleLabel();
    if (paused && !['Owner', 'Risk admin'].includes(role)) throw new Error('Only owner or risk admin may pause the protocol');
    if (!paused && role !== 'Owner') throw new Error('Only owner may unpause the protocol');
    if (!window.confirm(`${paused ? 'PAUSE' : 'UNPAUSE'} the canonical Maddeth protocol on KUB Testnet?`)) return;
    const data = `${await selector('setProtocolPaused(bool)')}${encodeBool(paused)}`;
    await sendTx(data, paused ? 'Pause protocol' : 'Unpause protocol');
  });
}

async function setMarketPause(paused) {
  await locked(async () => {
    const asset = $('riskMarketSelect')?.value;
    if (!isAddress(asset)) throw new Error('Select a market first');
    state.selectedMarket = asset;
    const role = roleLabel();
    if (paused && !['Owner', 'Risk admin'].includes(role)) throw new Error('Only owner or risk admin may pause a market');
    if (!paused && role !== 'Owner') throw new Error('Only owner may unpause a market');
    const market = state.markets.find(m => sameAddress(m.asset, asset));
    if (!window.confirm(`${paused ? 'PAUSE' : 'UNPAUSE'} ${market?.symbol || shortAddress(asset)} on the canonical KUB pool?`)) return;
    const data = `${await selector('setPaused(address,bool)')}${encodeAddress(asset)}${encodeBool(paused)}`;
    await sendTx(data, `${paused ? 'Pause' : 'Unpause'} ${market?.symbol || 'market'}`);
  });
}

async function init() {
  try {
    await loadRegistry();
    await refresh();
    if (window.ethereum) {
      window.ethereum.on?.('accountsChanged', async accounts => { state.account = accounts?.[0] || null; await refresh(); });
      window.ethereum.on?.('chainChanged', async () => refresh());
    }
  } catch (e) {
    setBanner(e?.message || 'Risk console failed to initialize', { error: true });
    text('riskEmergencyStatus', 'Console unavailable');
  }

  $('riskConnect')?.addEventListener('click', connect);
  $('riskNetworkButton')?.addEventListener('click', async () => { try { await ensureKub(); await refresh(); } catch (e) { setBanner(e?.message || 'Could not switch network', { error: true }); } });
  $('riskRefresh')?.addEventListener('click', async () => { try { await refresh(); setBanner('Canonical risk state refreshed.'); } catch (e) { setBanner(e?.message || 'Refresh failed', { error: true }); } });
  $('riskMarketSelect')?.addEventListener('change', e => { state.selectedMarket = e.target.value; updateButtons(); });
  $('riskPauseProtocol')?.addEventListener('click', () => setProtocolPause(true));
  $('riskUnpauseProtocol')?.addEventListener('click', () => setProtocolPause(false));
  $('riskPauseMarket')?.addEventListener('click', () => setMarketPause(true));
  $('riskUnpauseMarket')?.addEventListener('click', () => setMarketPause(false));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
