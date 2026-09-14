const $ = id => document.getElementById(id);
const WAD = 10n ** 18n;
const BPS = 10_000n;
const MAX_UINT = (1n << 256n) - 1n;
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
  account: null,
  chainId: null,
  nativeBalance: 0n,
  borrower: null,
  borrowerRisk: null,
  collateralPosition: null,
  debtPosition: null,
  shocked: false,
  price: 0n,
  liquidatorUsdc: 0n,
  inFlight: false
};
const selectorCache = new Map();
let rpcId = 1;

function text(id, value) { const el = $(id); if (el) el.textContent = value; }
function shortAddress(a) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : '—'; }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function encodeAddress(a) { if (!isAddress(a)) throw new Error('Invalid address'); return a.slice(2).toLowerCase().padStart(64, '0'); }
function encodeUint(v) { const n = BigInt(v); if (n < 0n) throw new Error('Negative uint'); return n.toString(16).padStart(64, '0'); }
function encodeBool(v) { return encodeUint(v ? 1n : 0n); }
function decodeWords(data) {
  const body = String(data || '0x').slice(2);
  if (!body.length || body.length % 64 !== 0) throw new Error('Malformed contract response');
  const out = [];
  for (let i = 0; i < body.length; i += 64) out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return out;
}
function formatUnits(value, decimals = 18, precision = 4) {
  if (value === null || value === undefined) return '—';
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const remainder = value % base;
  const frac = remainder.toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}
function formatHealth(v) { return v === null || v === undefined ? '—' : v === MAX_UINT ? '∞' : formatUnits(v, 18, 4); }
function explorerTx(hash) { return `${KUB.explorer}/tx/${hash}`; }
function setBanner(message = '', { error = false, txHash = null } = {}) {
  const el = $('labTxBanner');
  if (!el) return;
  if (!message) { el.classList.add('hidden'); el.replaceChildren(); return; }
  el.classList.remove('hidden');
  el.classList.toggle('error', error);
  el.replaceChildren(document.createTextNode(message));
  if (txHash) {
    const a = document.createElement('a');
    a.href = explorerTx(txHash);
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
  const result = hash.slice(0, 10);
  selectorCache.set(signature, result);
  return result;
}
async function ethCall(to, data) { return rpc('eth_call', [{ to, data }, 'latest']); }
async function callWords(to, signature, args = '') { return decodeWords(await ethCall(to, `${await selector(signature)}${args}`)); }
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
  const start = Date.now();
  while (Date.now() - start < 150000) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) {
      if (r.status === '0x0') throw new Error(`Transaction reverted: ${hash}`);
      return r;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}
async function sendTx(to, data, label) {
  if (!state.account) throw new Error('Connect a wallet first');
  if (state.chainId !== KUB.chainId) throw new Error('Switch to KUB Testnet first');
  const tx = { from: state.account, to, data };
  setBanner(`${label}: estimating gas…`);
  await window.ethereum.request({ method: 'eth_estimateGas', params: [tx] });
  setBanner(`${label}: waiting for wallet confirmation…`);
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
  setBanner(`${label}: submitted. Waiting for confirmation…`, { txHash: hash });
  await waitReceipt(hash);
  setBanner(`${label}: confirmed.`, { txHash: hash });
  return hash;
}
async function locked(fn) {
  if (state.inFlight) return;
  state.inFlight = true;
  updateButtons();
  try {
    await fn();
    await refresh();
  } catch (e) {
    setBanner(`Transaction stopped: ${e?.message || 'unknown error'}`, { error: true });
  } finally {
    state.inFlight = false;
    updateButtons();
  }
}

async function loadRegistry() {
  const response = await fetch('/config/kub-liquidation-lab.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Liquidation lab registry unavailable');
  state.registry = await response.json();
  const deployed = state.registry.deploymentStatus === 'deployed' && Object.values(state.registry.contracts || {}).every(isAddress);
  text('labStatus', deployed ? 'DEPLOYED' : 'DEPLOYMENT PENDING');
  text('labContracts', deployed ? `Pool ${shortAddress(state.registry.contracts.pool)} · Oracle ${shortAddress(state.registry.contracts.oracle)}` : 'Liquidation lab deployment is not registered.');
  text('labFooter', deployed ? 'Lab contracts configured on KUB Testnet. Canonical Maddeth contracts remain untouched.' : 'The isolated lab is not ready.');
  return deployed;
}
async function readRisk(address) {
  const w = await callWords(state.registry.contracts.lens, 'accountRisk(address)', encodeAddress(address));
  return { collateralUsd: w[0], borrowLimitUsd: w[1], liquidationLimitUsd: w[2], debtUsd: w[3], healthFactor: w[4], availableBorrowUsd: w[5] };
}
async function readPosition(address, asset) {
  const w = await callWords(state.registry.contracts.lens, 'positionView(address,address)', `${encodeAddress(address)}${encodeAddress(asset)}`);
  return { walletBalance: w[0], supplied: w[1], borrowed: w[2], collateralEnabled: w[3] !== 0n };
}
async function readLabState() {
  const c = state.registry.contracts;
  const [shockWord, priceWords] = await Promise.all([
    callWords(c.oracle, 'shocked()'),
    callWords(c.oracle, 'getPrice(address)', encodeAddress(c.labKUB))
  ]);
  state.shocked = shockWord[0] !== 0n;
  state.price = priceWords[0];
  if (state.account) state.liquidatorUsdc = await tokenBalance(c.labUSDC, state.account);
}
async function inspectBorrower(address) {
  if (!isAddress(address)) {
    state.borrowerRisk = null;
    state.collateralPosition = null;
    state.debtPosition = null;
    return;
  }
  const c = state.registry.contracts;
  const [risk, col, debt] = await Promise.all([
    readRisk(address),
    readPosition(address, c.labKUB),
    readPosition(address, c.labUSDC)
  ]);
  state.borrower = address;
  state.borrowerRisk = risk;
  state.collateralPosition = col;
  state.debtPosition = debt;
  localStorage.setItem('maddeth-lab-borrower', address);
  if ($('labBorrowerInput')) $('labBorrowerInput').value = address;
}
async function refresh() {
  if (!state.registry) return;
  if (state.account && window.ethereum) {
    const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
    state.chainId = Number.parseInt(chainHex, 16);
    state.nativeBalance = BigInt(await window.ethereum.request({ method: 'eth_getBalance', params: [state.account, 'latest'] }));
  }
  await readLabState();
  const candidate = $('labBorrowerInput')?.value || localStorage.getItem('maddeth-lab-borrower') || state.borrower;
  if (isAddress(candidate)) await inspectBorrower(candidate);
  render();
}
function maxClose() { if (!state.debtPosition?.borrowed) return 0n; return state.debtPosition.borrowed * 5_000n / BPS; }
function expectedSeize() {
  const repay = maxClose();
  if (!repay || !state.price) return 0n;
  const repayUsd = repay * WAD / (10n ** 6n);
  let seize = repayUsd * (10n ** 18n) / state.price;
  seize = seize * 10_500n / BPS;
  const supplied = state.collateralPosition?.supplied || 0n;
  return seize > supplied ? supplied : seize;
}
function render() {
  const deployed = state.registry?.deploymentStatus === 'deployed';
  text('labConnectedWallet', state.account ? shortAddress(state.account) : 'Not connected');
  text('labGasBalance', state.account ? `${formatUnits(state.nativeBalance, 18, 4)} tKUB` : '— tKUB');
  text('labNetworkPill', state.account ? (state.chainId === KUB.chainId ? 'KUB Testnet' : `Wrong network · ${state.chainId}`) : 'Not connected');
  text('labConnectWallet', state.account ? shortAddress(state.account) : 'Connect Wallet A/B');
  text('labOraclePrice', state.price ? `$${formatUnits(state.price, 18, 2)}` : '—');
  text('labShockState', state.shocked ? 'SHOCKED' : 'NORMAL');
  text('labShockPriceLarge', state.price ? `$${formatUnits(state.price, 18, 2)}` : '—');
  text('labBorrowerAddressDisplay', state.borrower ? shortAddress(state.borrower) : 'Not set');
  text('labBorrowerHealth', `Health ${state.borrowerRisk ? formatHealth(state.borrowerRisk.healthFactor) : '—'}`);
  text('labBorrowerDebt', state.debtPosition ? `${formatUnits(state.debtPosition.borrowed, 6, 6)} labUSDC` : '—');
  text('labBorrowerCollateral', state.collateralPosition ? `Collateral ${formatUnits(state.collateralPosition.supplied, 18, 4)} labKUB` : 'Collateral —');
  text('labMaxClose', state.debtPosition ? `${formatUnits(maxClose(), 6, 6)} labUSDC` : '—');
  text('labExpectedSeize', state.collateralPosition ? `${formatUnits(expectedSeize(), 18, 6)} labKUB` : '—');
  text('labLiquidatorUsdc', state.account ? `${formatUnits(state.liquidatorUsdc, 6, 2)} labUSDC` : '—');
  $('labShockState')?.classList.toggle('danger', state.shocked);
  $('labBorrowerHealth')?.classList.toggle('danger', Boolean(state.borrowerRisk && state.borrowerRisk.healthFactor < WAD && state.borrowerRisk.debtUsd > 0n));
  updateButtons(deployed);
}
function updateButtons(deployed = state.registry?.deploymentStatus === 'deployed') {
  const ready = Boolean(deployed && state.account && state.chainId === KUB.chainId && !state.inFlight);
  for (const id of ['labMintCollateral', 'labOpenPosition', 'labShockPrice', 'labResetPrice', 'labMintDebt']) if ($(id)) $(id).disabled = !ready;
  if ($('labShockPrice')) $('labShockPrice').disabled = !ready || state.shocked;
  if ($('labResetPrice')) $('labResetPrice').disabled = !ready || !state.shocked;
  const liquidatable = Boolean(state.borrowerRisk && state.borrowerRisk.debtUsd > 0n && state.borrowerRisk.healthFactor < WAD && state.account && state.borrower && state.account.toLowerCase() !== state.borrower.toLowerCase());
  if ($('labLiquidate')) $('labLiquidate').disabled = !ready || !liquidatable || maxClose() === 0n;
}

async function mintCollateral() {
  const c = state.registry.contracts;
  const amount = 100n * 10n ** 18n;
  await locked(async () => sendTx(c.labKUB, `${await selector('mint(address,uint256)')}${encodeAddress(state.account)}${encodeUint(amount)}`, 'Mint 100 labKUB'));
}
async function openPosition() {
  const c = state.registry.contracts;
  await locked(async () => {
    if (state.shocked) throw new Error('Reset the lab oracle to $10 before opening the standard borrower position');
    const current = await readRisk(state.account);
    if (current.debtUsd > 0n) throw new Error('This wallet already has lab debt; use a fresh Wallet A or clear the position first');
    const balance = await tokenBalance(c.labKUB, state.account);
    const collateral = 100n * 10n ** 18n;
    if (balance < collateral) throw new Error('Mint 100 labKUB first');
    await sendTx(c.labKUB, `${await selector('approve(address,uint256)')}${encodeAddress(c.pool)}${encodeUint(collateral)}`, 'Approve labKUB');
    await sendTx(c.pool, `${await selector('supply(address,uint256)')}${encodeAddress(c.labKUB)}${encodeUint(collateral)}`, 'Supply 100 labKUB');
    await sendTx(c.pool, `${await selector('setCollateral(address,bool)')}${encodeAddress(c.labKUB)}${encodeBool(true)}`, 'Enable labKUB collateral');
    await sendTx(c.pool, `${await selector('borrow(address,uint256)')}${encodeAddress(c.labUSDC)}${encodeUint(700n * 10n ** 6n)}`, 'Borrow 700 labUSDC');
    state.borrower = state.account;
    localStorage.setItem('maddeth-lab-borrower', state.account);
    if ($('labBorrowerInput')) $('labBorrowerInput').value = state.account;
    setBanner('Wallet A position opened. Health should be above 1. Now trigger the bounded price shock.');
  });
}
async function setShock(enabled) {
  const c = state.registry.contracts;
  await locked(async () => sendTx(c.oracle, `${await selector('setShock(bool)')}${encodeBool(enabled)}`, enabled ? 'Shock labKUB to $8' : 'Reset labKUB to $10'));
}
async function mintDebt() {
  const c = state.registry.contracts;
  const amount = 10_000n * 10n ** 6n;
  await locked(async () => sendTx(c.labUSDC, `${await selector('mint(address,uint256)')}${encodeAddress(state.account)}${encodeUint(amount)}`, 'Mint 10,000 labUSDC'));
}
async function inspectFromInput() {
  try {
    const value = $('labBorrowerInput')?.value.trim();
    if (!isAddress(value)) throw new Error('Enter Wallet A borrower address');
    await inspectBorrower(value);
    render();
  } catch (e) {
    setBanner(e?.message || 'Could not inspect borrower', { error: true });
  }
}
async function liquidate() {
  const c = state.registry.contracts;
  await locked(async () => {
    const borrower = $('labBorrowerInput').value.trim();
    if (!isAddress(borrower)) throw new Error('Enter Wallet A borrower address');
    await inspectBorrower(borrower);
    if (state.account.toLowerCase() === borrower.toLowerCase()) throw new Error('Switch MetaMask to Wallet B before liquidation');
    if (!state.borrowerRisk || state.borrowerRisk.healthFactor >= WAD || state.borrowerRisk.debtUsd === 0n) throw new Error('Borrower is not currently liquidatable');
    const repay = maxClose();
    if (state.liquidatorUsdc < repay) throw new Error('Wallet B needs more labUSDC; mint test debt tokens first');
    await sendTx(c.labUSDC, `${await selector('approve(address,uint256)')}${encodeAddress(c.pool)}${encodeUint(repay)}`, 'Approve labUSDC');
    await sendTx(c.pool, `${await selector('liquidate(address,address,address,uint256)')}${encodeAddress(borrower)}${encodeAddress(c.labUSDC)}${encodeAddress(c.labKUB)}${encodeUint(repay)}`, 'Liquidate Wallet A');
    setBanner('Liquidation confirmed. Wallet A debt and collateral have been refreshed.');
  });
}

async function init() {
  if (!$('liquidation-lab')) return;
  try {
    const deployed = await loadRegistry();
    if (window.ethereum) {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts?.[0]) state.account = accounts[0];
      window.ethereum.on?.('accountsChanged', async accounts => { state.account = accounts?.[0] || null; await refresh(); });
      window.ethereum.on?.('chainChanged', async () => refresh());
    }
    if (deployed) await refresh(); else render();
  } catch (e) {
    text('labStatus', 'REGISTRY ERROR');
    setBanner(e?.message || 'Could not load lab', { error: true });
  }
  $('labConnectWallet')?.addEventListener('click', connect);
  $('labNetworkPill')?.addEventListener('click', async () => { try { await ensureKub(); await refresh(); } catch (e) { setBanner(e?.message || 'Network switch failed', { error: true }); } });
  $('labMintCollateral')?.addEventListener('click', mintCollateral);
  $('labOpenPosition')?.addEventListener('click', openPosition);
  $('labShockPrice')?.addEventListener('click', () => setShock(true));
  $('labResetPrice')?.addEventListener('click', () => setShock(false));
  $('labMintDebt')?.addEventListener('click', mintDebt);
  $('labInspectBorrower')?.addEventListener('click', inspectFromInput);
  $('labBorrowerInput')?.addEventListener('change', inspectFromInput);
  $('labLiquidate')?.addEventListener('click', liquidate);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
