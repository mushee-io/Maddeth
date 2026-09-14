import {
  KUB_TESTNET,
  MADDETH_DEPLOYMENT,
  configuredContract,
  deploymentReady,
  connectWallet as connectProtocolWallet,
  walletSnapshot,
  liveProtocolSnapshot,
  accountRisk,
  positionSnapshot,
  assetConfig,
  parseUnits,
  formatUnits,
  approveToken,
  mintTestAsset,
  waitForReceipt,
  transactionExplorerUrl
} from './protocol.js';

const WAD = 10n ** 18n;
const BPS = 10_000n;
const CLOSE_FACTOR_BPS = 5_000n;
const FALLBACK_DEPLOYMENT_BLOCK = 33_520_111;
const MAX_SCAN_BORROWERS = 1_000;
const LOG_CHUNK_SIZE = 2_000;
const $ = id => document.getElementById(id);
let rpcId = 1;

const state = {
  account: null,
  chainId: null,
  nativeBalance: null,
  markets: [],
  candidates: [],
  inspected: null,
  preview: null,
  inFlight: false,
  scanning: false,
  deploymentBlock: FALLBACK_DEPLOYMENT_BLOCK
};

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—';
}
function text(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}
function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}
function encodeAddress(address) {
  if (!isAddress(address)) throw new Error('Invalid address');
  return address.slice(2).toLowerCase().padStart(64, '0');
}
function encodeUint(value) {
  const n = BigInt(value);
  if (n < 0n) throw new Error('Negative uint');
  return n.toString(16).padStart(64, '0');
}
function utf8ToHex(value) {
  return `0x${Array.from(new TextEncoder().encode(value)).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function topicAddress(topic) {
  const raw = String(topic || '').replace(/^0x/, '');
  if (raw.length !== 64) throw new Error('Malformed indexed address');
  return `0x${raw.slice(24)}`;
}
function blockHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}
function formatToken(value, asset, precision = 6) {
  return `${formatUnits(value, asset.decimals, precision)} ${asset.symbol}`;
}
function formatUsd(value, precision = 4) {
  return `$${formatUnits(value, 18, precision)}`;
}
function formatHealth(value) {
  if (value === null || value === undefined) return '—';
  return value >= ((1n << 256n) - 1n) ? '∞' : formatUnits(value, 18, 4);
}
function setBanner(message = '', { txHash = null, error = false } = {}) {
  const banner = $('txBanner');
  if (!banner) return;
  if (!message) {
    banner.classList.add('hidden');
    banner.replaceChildren();
    return;
  }
  banner.classList.remove('hidden');
  banner.classList.toggle('error', error);
  banner.replaceChildren(document.createTextNode(message));
  if (txHash) {
    const a = document.createElement('a');
    a.href = transactionExplorerUrl(txHash);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = ' View on KUBScan ↗';
    banner.appendChild(a);
  }
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
async function selector(signature) {
  const hash = await rpcRequest('web3_sha3', [utf8ToHex(signature)]);
  return hash.slice(0, 10);
}
async function sendTransaction({ from, to, data }) {
  if (!from) throw new Error('Connect the liquidator wallet first');
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  if (Number.parseInt(chainHex, 16) !== KUB_TESTNET.chainId) throw new Error('Switch to KUB Testnet first');
  const tx = { from, to, data };
  await window.ethereum.request({ method: 'eth_estimateGas', params: [tx] });
  return window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
}

async function loadDeploymentBlock() {
  try {
    const response = await fetch('/config/kub-testnet.json', { cache: 'no-store' });
    if (!response.ok) return;
    const registry = await response.json();
    if (Number.isInteger(registry.deploymentBlock) && registry.deploymentBlock > 0) {
      state.deploymentBlock = registry.deploymentBlock;
    }
  } catch {
    state.deploymentBlock = FALLBACK_DEPLOYMENT_BLOCK;
  }
  text('scanFromBlock', String(state.deploymentBlock));
}

async function configuredAssets() {
  if (state.markets.length) return state.markets;
  const snapshot = await liveProtocolSnapshot(null);
  if (!snapshot.deployed) throw new Error('Canonical Maddeth contracts are not configured');
  state.markets = snapshot.assets;
  return state.markets;
}

async function inspectBorrower(address) {
  if (!isAddress(address)) throw new Error('Enter a valid borrower address');
  const assets = await configuredAssets();
  const [risk, ...positions] = await Promise.all([
    accountRisk(address),
    ...assets.map(asset => positionSnapshot(address, asset))
  ]);
  const inspected = {
    address,
    risk,
    positions,
    liquidatable: Boolean(risk && risk.debtUsd > 0n && risk.healthFactor < WAD)
  };
  state.inspected = inspected;
  state.preview = null;
  renderBorrower();
  return inspected;
}

async function borrowerAddressesFromLogs() {
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');
  const topic0 = await rpcRequest('web3_sha3', [utf8ToHex('Borrowed(address,address,uint256,uint256)')]);
  const latestHex = await rpcRequest('eth_blockNumber');
  const latest = Number(BigInt(latestHex));
  const borrowers = new Set();
  let scanned = 0;

  for (let start = state.deploymentBlock; start <= latest; start += LOG_CHUNK_SIZE) {
    const end = Math.min(start + LOG_CHUNK_SIZE - 1, latest);
    text('scanProgress', `Scanning blocks ${start.toLocaleString()}–${end.toLocaleString()}…`);
    const logs = await rpcRequest('eth_getLogs', [{
      address: pool,
      fromBlock: blockHex(start),
      toBlock: blockHex(end),
      topics: [topic0]
    }]);
    scanned += logs.length;
    for (const log of logs) {
      if (!log.topics?.[1]) continue;
      borrowers.add(topicAddress(log.topics[1]).toLowerCase());
      if (borrowers.size >= MAX_SCAN_BORROWERS) return { borrowers: [...borrowers], scanned, truncated: true };
    }
  }
  return { borrowers: [...borrowers], scanned, truncated: false };
}

async function scanCandidates() {
  if (state.scanning) return;
  state.scanning = true;
  $('scanButton').disabled = true;
  setBanner('Scanning canonical Borrowed events and checking current health factors…');
  try {
    const { borrowers, scanned, truncated } = await borrowerAddressesFromLogs();
    const rows = [];
    for (let i = 0; i < borrowers.length; i++) {
      text('scanProgress', `Checking borrower ${i + 1}/${borrowers.length}…`);
      try {
        const risk = await accountRisk(borrowers[i]);
        if (risk?.debtUsd > 0n) rows.push({ address: borrowers[i], risk });
      } catch (error) {
        console.warn('Borrower health read failed', borrowers[i], error);
      }
    }
    rows.sort((a, b) => {
      const ah = a.risk.healthFactor;
      const bh = b.risk.healthFactor;
      return ah < bh ? -1 : ah > bh ? 1 : 0;
    });
    state.candidates = rows;
    renderCandidates();
    text('scanProgress', `${borrowers.length} borrower(s) · ${scanned} borrow event(s)${truncated ? ' · scan capped at 1,000 borrowers' : ''}`);
    setBanner(`Scan complete. ${rows.filter(row => row.risk.healthFactor < WAD).length} liquidatable account(s) found.`);
  } catch (error) {
    setBanner(`Liquidation scan failed: ${error?.message || 'unknown error'}`, { error: true });
  } finally {
    state.scanning = false;
    $('scanButton').disabled = false;
  }
}

function renderCandidates() {
  const body = $('candidateRows');
  if (!body) return;
  body.replaceChildren();
  if (!state.candidates.length) {
    const row = document.createElement('div');
    row.className = 'liquidation-row empty-row';
    row.textContent = 'No active borrower positions found in the scanned range.';
    body.appendChild(row);
    return;
  }
  for (const candidate of state.candidates) {
    const row = document.createElement('div');
    row.className = `liquidation-row ${candidate.risk.healthFactor < WAD ? 'danger-row' : ''}`;
    const account = document.createElement('span');
    account.className = 'mono';
    account.textContent = shortAddress(candidate.address);
    account.title = candidate.address;
    const health = document.createElement('strong');
    health.textContent = formatHealth(candidate.risk.healthFactor);
    const debt = document.createElement('span');
    debt.textContent = formatUsd(candidate.risk.debtUsd);
    const status = document.createElement('span');
    status.className = candidate.risk.healthFactor < WAD ? 'danger-text' : 'positive';
    status.textContent = candidate.risk.healthFactor < WAD ? 'LIQUIDATABLE' : 'HEALTHY';
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'secondary-btn compact-btn';
    inspect.textContent = 'Inspect';
    inspect.addEventListener('click', async () => {
      $('borrowerAddress').value = candidate.address;
      try { await inspectBorrower(candidate.address); }
      catch (error) { setBanner(error?.message || 'Could not inspect borrower', { error: true }); }
    });
    row.append(account, health, debt, status, inspect);
    body.appendChild(row);
  }
}

function eligibleDebtPositions() {
  return state.inspected?.positions?.filter(position => position.borrowedAmount > 0n) || [];
}
function eligibleCollateralPositions() {
  return state.inspected?.positions?.filter(position => position.collateralEnabled && position.suppliedAmount > 0n) || [];
}
function populateAssetSelect(id, positions, kind) {
  const select = $(id);
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  for (const position of positions) {
    const option = document.createElement('option');
    option.value = position.key;
    option.textContent = `${position.symbol} · ${kind === 'debt' ? formatToken(position.borrowedAmount, position, 6) : formatToken(position.suppliedAmount, position, 6)}`;
    select.appendChild(option);
  }
  if (positions.some(position => position.key === previous)) select.value = previous;
}

function renderBorrower() {
  const inspected = state.inspected;
  if (!inspected) {
    text('borrowerHealth', '—');
    text('borrowerDebt', '—');
    text('borrowerCollateral', '—');
    text('borrowerStatus', 'Not inspected');
    return;
  }
  text('borrowerHealth', formatHealth(inspected.risk.healthFactor));
  text('borrowerDebt', formatUsd(inspected.risk.debtUsd));
  text('borrowerCollateral', formatUsd(inspected.risk.collateralUsd));
  text('borrowerStatus', inspected.liquidatable ? 'LIQUIDATABLE' : 'HEALTHY / NOT LIQUIDATABLE');
  $('borrowerStatus')?.classList.toggle('danger-text', inspected.liquidatable);
  $('borrowerStatus')?.classList.toggle('positive', !inspected.liquidatable);
  populateAssetSelect('debtAsset', eligibleDebtPositions(), 'debt');
  populateAssetSelect('collateralAsset', eligibleCollateralPositions(), 'collateral');
  updateMaxCloseHint();
  renderPreview();
}

function positionByKey(key) {
  return state.inspected?.positions?.find(position => position.key === key) || null;
}
function marketByKey(key) {
  return state.markets.find(asset => asset.key === key) || assetConfig(key);
}
function updateMaxCloseHint() {
  const debtPosition = positionByKey($('debtAsset')?.value);
  if (!debtPosition) {
    text('maxCloseHint', '—');
    return;
  }
  let maxClose = debtPosition.borrowedAmount * CLOSE_FACTOR_BPS / BPS;
  if (maxClose === 0n) maxClose = debtPosition.borrowedAmount;
  text('maxCloseHint', formatToken(maxClose, debtPosition, 6));
}

function calculateLiquidationPreview() {
  if (!state.inspected) throw new Error('Inspect a borrower first');
  if (!state.inspected.liquidatable) throw new Error('ACCOUNT_HEALTHY: this account cannot be liquidated');
  const debtPosition = positionByKey($('debtAsset').value);
  const collateralPosition = positionByKey($('collateralAsset').value);
  const debtMarket = marketByKey($('debtAsset').value);
  const collateralMarket = marketByKey($('collateralAsset').value);
  if (!debtPosition || !collateralPosition || !debtMarket || !collateralMarket) throw new Error('Choose valid debt and collateral markets');
  if (!collateralPosition.collateralEnabled) throw new Error('Selected asset is not enabled collateral');

  const requested = parseUnits($('repayAmount').value, debtPosition.decimals);
  const debt = debtPosition.borrowedAmount;
  let maxClose = debt * CLOSE_FACTOR_BPS / BPS;
  if (maxClose === 0n) maxClose = debt;
  let paid = requested > maxClose ? maxClose : requested;

  const collateralUsd = collateralPosition.suppliedAmount * collateralMarket.price / (10n ** BigInt(collateralPosition.decimals));
  const maxRepayUsd = collateralUsd * BPS / (BPS + collateralMarket.liquidationBonusBps);
  const maxRepayByCollateral = maxRepayUsd * (10n ** BigInt(debtPosition.decimals)) / debtMarket.price;
  let collateralLimited = false;
  if (paid > maxRepayByCollateral) {
    paid = maxRepayByCollateral;
    collateralLimited = true;
  }
  if (paid <= 0n) throw new Error('COLLATERAL_DUST: no economically liquidatable amount');

  let seize;
  if (collateralLimited) {
    seize = collateralPosition.suppliedAmount;
  } else {
    const debtUsd = paid * debtMarket.price / (10n ** BigInt(debtPosition.decimals));
    const seizeUsd = debtUsd * (BPS + collateralMarket.liquidationBonusBps) / BPS;
    seize = seizeUsd * (10n ** BigInt(collateralPosition.decimals)) / collateralMarket.price;
    if (seize > collateralPosition.suppliedAmount) seize = collateralPosition.suppliedAmount;
  }

  return {
    borrower: state.inspected.address,
    debtPosition,
    collateralPosition,
    debtMarket,
    collateralMarket,
    requested,
    maxClose,
    paid,
    seize,
    collateralLimited,
    bonusBps: collateralMarket.liquidationBonusBps
  };
}

function renderPreview() {
  const preview = state.preview;
  text('previewRepay', preview ? formatToken(preview.paid, preview.debtPosition, 6) : '—');
  text('previewSeize', preview ? formatToken(preview.seize, preview.collateralPosition, 6) : '—');
  text('previewBonus', preview ? `${(Number(preview.bonusBps) / 100).toFixed(2)}%` : '—');
  text('previewCap', preview ? formatToken(preview.maxClose, preview.debtPosition, 6) : '—');
  text('previewMode', preview ? (preview.collateralLimited ? 'Collateral limited' : 'Close-factor limited') : '—');
  const execute = $('executeLiquidation');
  if (execute) execute.disabled = !preview || !state.account || state.chainId !== KUB_TESTNET.chainId || state.inFlight;
}

async function previewLiquidation() {
  state.preview = calculateLiquidationPreview();
  renderPreview();
  setBanner(`Preview ready. Liquidator will repay ${formatToken(state.preview.paid, state.preview.debtPosition, 6)} and receive about ${formatToken(state.preview.seize, state.preview.collateralPosition, 6)}.`);
}

async function executeLiquidation() {
  if (!state.preview) throw new Error('Preview liquidation first');
  if (!state.account) throw new Error('Connect the liquidator wallet first');
  if (state.account.toLowerCase() === state.preview.borrower.toLowerCase()) throw new Error('Use a second wallet as the liquidator for this test');
  if (state.chainId !== KUB_TESTNET.chainId) throw new Error('Switch to KUB Testnet first');
  const pool = configuredContract('maddethPool');
  if (!pool) throw new Error('MaddethPool is not configured');

  state.inFlight = true;
  renderPreview();
  try {
    setBanner('Approve debt asset: waiting for liquidator wallet confirmation…');
    const approval = await approveToken(state.account, state.preview.debtPosition.address, pool, state.preview.paid);
    setBanner('Debt asset approval submitted. Waiting for KUB confirmation…', { txHash: approval });
    await waitForReceipt(approval);

    const method = await selector('liquidate(address,address,address,uint256)');
    const data = `${method}${encodeAddress(state.preview.borrower)}${encodeAddress(state.preview.debtPosition.address)}${encodeAddress(state.preview.collateralPosition.address)}${encodeUint(state.preview.paid)}`;
    setBanner('Execute liquidation: waiting for liquidator wallet confirmation…');
    const hash = await sendTransaction({ from: state.account, to: pool, data });
    setBanner('Liquidation submitted. Waiting for KUB confirmation…', { txHash: hash });
    await waitForReceipt(hash);
    setBanner('Liquidation confirmed on KUB Testnet.', { txHash: hash });
    await inspectBorrower(state.preview.borrower);
  } finally {
    state.inFlight = false;
    renderPreview();
  }
}

async function connectWallet() {
  if (!window.ethereum) throw new Error('No EVM wallet found');
  state.account = await connectProtocolWallet();
  await refreshWallet();
}
async function refreshWallet() {
  if (!state.account) return;
  const snapshot = await walletSnapshot(state.account);
  state.chainId = snapshot.chainId;
  state.nativeBalance = snapshot.nativeBalance;
  text('networkPill', snapshot.chainId === KUB_TESTNET.chainId ? 'KUB Testnet' : `Wrong network · ${snapshot.chainId}`);
  text('connectWallet', shortAddress(state.account));
  text('liquidatorAddress', state.account);
  text('liquidatorTKUB', snapshot.nativeBalance === null ? '—' : `${formatUnits(snapshot.nativeBalance, 18, 4)} tKUB`);
  renderPreview();
}

async function mintSelectedDebtAsset() {
  if (!state.account) throw new Error('Connect the liquidator wallet first');
  const key = $('debtAsset').value;
  if (key !== 'testUSDC' && key !== 'testUSDT') throw new Error('Only Maddeth test stablecoins can be minted from this helper');
  const asset = marketByKey(key) || assetConfig(key);
  const amount = 10_000n * (10n ** BigInt(asset.decimals));
  setBanner(`Mint ${asset.symbol}: waiting for wallet confirmation…`);
  const hash = await mintTestAsset(state.account, key, amount);
  setBanner(`${asset.symbol} mint submitted. Waiting for KUB confirmation…`, { txHash: hash });
  await waitForReceipt(hash);
  setBanner(`10,000 ${asset.symbol} minted to the liquidator wallet.`, { txHash: hash });
}

function useMaxClose() {
  const debtPosition = positionByKey($('debtAsset').value);
  if (!debtPosition) return;
  let maxClose = debtPosition.borrowedAmount * CLOSE_FACTOR_BPS / BPS;
  if (maxClose === 0n) maxClose = debtPosition.borrowedAmount;
  $('repayAmount').value = formatUnits(maxClose, debtPosition.decimals, debtPosition.decimals);
  state.preview = null;
  renderPreview();
}

function wire() {
  $('connectWallet')?.addEventListener('click', () => connectWallet().catch(error => setBanner(error?.message || 'Wallet connection failed', { error: true })));
  $('networkPill')?.addEventListener('click', () => import('./protocol.js').then(({ ensureKubTestnet }) => ensureKubTestnet()).then(refreshWallet).catch(error => setBanner(error?.message || 'Network switch failed', { error: true })));
  $('scanButton')?.addEventListener('click', scanCandidates);
  $('inspectButton')?.addEventListener('click', () => inspectBorrower($('borrowerAddress').value.trim()).catch(error => setBanner(error?.message || 'Borrower inspection failed', { error: true })));
  $('previewLiquidation')?.addEventListener('click', () => previewLiquidation().catch(error => setBanner(error?.message || 'Preview failed', { error: true })));
  $('executeLiquidation')?.addEventListener('click', () => executeLiquidation().catch(error => setBanner(`Liquidation stopped: ${error?.message || 'unknown error'}`, { error: true })));
  $('useMaxClose')?.addEventListener('click', useMaxClose);
  $('mintDebtAsset')?.addEventListener('click', () => mintSelectedDebtAsset().catch(error => setBanner(error?.message || 'Mint failed', { error: true })));
  $('debtAsset')?.addEventListener('change', () => { state.preview = null; updateMaxCloseHint(); renderPreview(); });
  $('collateralAsset')?.addEventListener('change', () => { state.preview = null; renderPreview(); });
  $('repayAmount')?.addEventListener('input', () => { state.preview = null; renderPreview(); });

  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', accounts => {
      state.account = accounts[0] || null;
      if (state.account) refreshWallet().catch(() => {});
      else { state.chainId = null; text('connectWallet', 'Connect liquidator'); renderPreview(); }
    });
    window.ethereum.on?.('chainChanged', () => state.account && refreshWallet().catch(() => {}));
    window.ethereum.request({ method: 'eth_accounts' }).then(accounts => {
      if (accounts[0]) {
        state.account = accounts[0];
        refreshWallet().catch(() => {});
      }
    }).catch(() => {});
  }
}

async function init() {
  if (!deploymentReady()) {
    setBanner('Maddeth canonical deployment is not configured.', { error: true });
    return;
  }
  await loadDeploymentBlock();
  await configuredAssets();
  wire();
  text('poolAddress', configuredContract('maddethPool'));
  text('candidateRowsStatus', `${MADDETH_DEPLOYMENT.assets.length} configured markets`);
}

init().catch(error => setBanner(`Liquidation console failed to initialize: ${error?.message || 'unknown error'}`, { error: true }));
