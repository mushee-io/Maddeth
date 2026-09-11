import {
  KUB_TESTNET,
  connectWallet as connectProtocolWallet,
  ensureKubTestnet,
  walletSnapshot,
  liveProtocolSnapshot,
  sampleRwaSnapshot,
  deploymentReady,
  configuredContract,
  assetConfig,
  formatUnits,
  formatWadPercent,
  parseUnits,
  wrapTKUB,
  approvePool,
  supplyToPool,
  setCollateral,
  borrowFromPool,
  repayPool,
  withdrawFromPool,
  mintTestAsset,
  depositRwa,
  withdrawRwa,
  waitForReceipt,
  transactionExplorerUrl,
  deploymentExplorerUrl
} from './protocol.js';

const WAD = 10n ** 18n;
const BPS = 10_000n;
const MAX_UINT = (1n << 256n) - 1n;

const state = {
  account: null,
  chainId: null,
  nativeBalance: null,
  sandbox: false,
  protocol: null,
  rwa: null,
  inFlight: false
};

const views = ['markets', 'borrow', 'rwa', 'portfolio', 'protocol'];
const titleMap = { markets: 'Markets', borrow: 'Borrow', rwa: 'RWA Credit', portfolio: 'Portfolio', protocol: 'Protocol' };
const $ = id => document.getElementById(id);

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—';
}

function setView(view) {
  if (!views.includes(view)) return;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  $(`${view}View`)?.classList.add('active');
  $('viewTitle').textContent = titleMap[view];
  $('appSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', event => {
  const view = event.currentTarget.dataset.view;
  if (view) setView(view);
}));

function setBanner(message = '', { txHash = null, error = false } = {}) {
  const banner = $('txBanner');
  if (!message) {
    banner.classList.add('hidden');
    banner.replaceChildren();
    return;
  }
  banner.classList.remove('hidden');
  banner.classList.toggle('error', error);
  banner.replaceChildren(document.createTextNode(message));
  if (txHash) {
    const link = document.createElement('a');
    link.href = transactionExplorerUrl(txHash);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ' View on KUBScan ↗';
    banner.appendChild(link);
  }
}

function formatUsd(value, precision = 2) {
  if (value === null || value === undefined) return '—';
  return `$${formatUnits(value, 18, precision)}`;
}

function formatToken(value, decimals, symbol, precision = 4) {
  return `${formatUnits(value, decimals, precision)} ${symbol}`;
}

function percentFromBps(value) {
  if (value === null || value === undefined) return '—';
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function assetByKey(key) {
  return state.protocol?.assets?.find(asset => asset.key === key) || assetConfig(key);
}

function positionByKey(key) {
  return state.protocol?.positions?.find(position => position.key === key) || null;
}

function liveEnabled() {
  return deploymentReady() && Boolean(state.account) && state.chainId === KUB_TESTNET.chainId && !state.sandbox && !state.inFlight;
}

function setActionStates() {
  const canTx = liveEnabled();
  const deployReady = deploymentReady();
  const reason = !deployReady
    ? 'Contracts not deployed'
    : !state.account
      ? 'Connect wallet to transact'
      : state.chainId !== KUB_TESTNET.chainId
        ? 'Switch to KUB Testnet'
        : state.sandbox
          ? 'Live mode required'
          : state.inFlight
            ? 'Transaction in progress…'
            : 'Supply collateral & borrow';

  $('submitBorrow').disabled = !canTx;
  $('submitBorrow').textContent = reason;
  $('repayButton').disabled = !canTx;
  $('withdrawButton').disabled = !canTx;
  $('mintUsdc').disabled = !canTx;
  $('mintUsdt').disabled = !canTx;

  const rwaCanDeposit = canTx && state.rwa?.allowlisted && state.rwa?.status === 'ACTIVE';
  $('rwaDepositButton').disabled = !rwaCanDeposit;
  $('rwaDepositButton').textContent = state.rwa && !state.rwa.allowlisted ? 'Wallet not allowlisted' : 'Deposit to vault';
  $('rwaWithdrawButton').disabled = !(canTx && state.rwa?.lenderDeposit > 0n && state.rwa?.totalDebt === 0n);
}

function setMode(sandbox) {
  state.sandbox = sandbox;
  $('sandboxMode').classList.toggle('active', sandbox);
  $('liveMode').classList.toggle('active', !sandbox);
  $('sandboxNotice').classList.toggle('hidden', !sandbox);
  $('liveNotice').classList.toggle('hidden', sandbox);
  if (sandbox) renderSandbox();
  else renderLive();
  setActionStates();
}

$('sandboxMode').addEventListener('click', () => setMode(true));
$('liveMode').addEventListener('click', () => setMode(false));

function renderSandbox() {
  $('metricSupplied').textContent = '$2.84M demo';
  $('metricLiquidity').textContent = '$1.67M demo';
  $('metricMarkets').textContent = '3 demo';
  $('marketRows').innerHTML = `
    <div class="market-row"><span class="asset"><b>WtKUB</b><small>Sandbox only</small></span><span>4.18%</span><span>6.42%</span><span>61.00%</span><span>620K demo</span></div>
    <div class="market-row"><span class="asset"><b>mUSDC</b><small>Sandbox only</small></span><span>5.04%</span><span>7.20%</span><span>67.00%</span><span>840K demo</span></div>
    <div class="market-row"><span class="asset"><b>mUSDT</b><small>Sandbox only</small></span><span>4.72%</span><span>6.95%</span><span>64.00%</span><span>210K demo</span></div>`;
  updateSandboxRisk();
}

function renderLive() {
  renderMarkets();
  renderAccountRisk();
  renderPortfolio();
  renderRwa();
  updateBorrowLiquidity();
}

function renderMarkets() {
  if (!state.protocol?.deployed) {
    $('metricSupplied').textContent = '—';
    $('metricLiquidity').textContent = '—';
    $('metricMarkets').textContent = '0';
    $('marketRows').innerHTML = '<div class="market-row placeholder-row"><span>Contracts not deployed/configured yet</span><span>—</span><span>—</span><span>—</span><span>—</span></div>';
    return;
  }

  let suppliedUsd = 0n;
  let liquidUsd = 0n;
  const rows = state.protocol.assets.map(asset => {
    const scale = 10n ** BigInt(asset.decimals);
    suppliedUsd += asset.totalSupplied * asset.price / scale;
    liquidUsd += asset.availableLiquidity * asset.price / scale;
    return `<div class="market-row">
      <span class="asset"><b>${asset.symbol}</b><small>${asset.testOnly ? 'KUB testnet asset' : 'Listed asset'} · LTV ${percentFromBps(asset.ltvBps)}</small></span>
      <span>${formatWadPercent(asset.supplyApr)}</span>
      <span>${formatWadPercent(asset.borrowApr)}</span>
      <span>${formatWadPercent(asset.utilisation)}</span>
      <span>${formatToken(asset.availableLiquidity, asset.decimals, asset.symbol, 2)}</span>
    </div>`;
  });

  $('metricSupplied').textContent = formatUsd(suppliedUsd, 2);
  $('metricLiquidity').textContent = formatUsd(liquidUsd, 2);
  $('metricMarkets').textContent = String(state.protocol.activeMarkets);
  $('marketRows').innerHTML = rows.join('') || '<div class="market-row placeholder-row"><span>No configured markets</span><span>—</span><span>—</span><span>—</span><span>—</span></div>';
}

function renderAccountRisk() {
  const risk = state.protocol?.accountRisk;
  if (!risk || state.sandbox) {
    ['accountCollateral', 'accountDebt', 'accountBorrowLimit', 'accountAvailable', 'accountHealth'].forEach(id => $(id).textContent = '—');
    return;
  }
  $('accountCollateral').textContent = formatUsd(risk.collateralUsd);
  $('accountDebt').textContent = formatUsd(risk.debtUsd);
  $('accountBorrowLimit').textContent = formatUsd(risk.borrowLimitUsd);
  $('accountAvailable').textContent = formatUsd(risk.availableBorrowUsd);
  $('accountHealth').textContent = risk.healthFactor === MAX_UINT ? '∞' : formatUnits(risk.healthFactor, 18, 2);
}

function renderPortfolio() {
  const connected = Boolean(state.account);
  $('portfolioDisconnected').classList.toggle('hidden', connected);
  $('portfolioLive').classList.toggle('hidden', !connected);
  if (!connected) return;

  $('portfolioTitle').textContent = `Portfolio · ${shortAddress(state.account)}`;
  $('portfolioAddress').textContent = state.account;
  const risk = state.protocol?.accountRisk;
  $('portfolioCollateral').textContent = risk ? formatUsd(risk.collateralUsd) : '—';
  $('portfolioDebt').textContent = risk ? formatUsd(risk.debtUsd) : '—';
  $('portfolioAvailable').textContent = risk ? formatUsd(risk.availableBorrowUsd) : '—';
  $('portfolioHealth').textContent = risk ? (risk.healthFactor === MAX_UINT ? '∞' : formatUnits(risk.healthFactor, 18, 2)) : '—';

  const positions = state.protocol?.positions || [];
  $('portfolioRows').innerHTML = positions.length ? positions.map(position => `
    <div class="position-row">
      <span class="asset"><b>${position.symbol}</b><small>${position.testOnly ? 'Testnet' : 'Live'}</small></span>
      <span>${formatUnits(position.walletBalance, position.decimals, 4)}</span>
      <span>${formatUnits(position.suppliedAmount, position.decimals, 4)}</span>
      <span>${formatUnits(position.borrowedAmount, position.decimals, 4)}</span>
      <span>${position.collateralEnabled ? '<b class="positive">Enabled</b>' : 'Off'}</span>
    </div>`).join('') : '<div class="position-row placeholder-row"><span>No positions yet</span><span>—</span><span>—</span><span>—</span><span>—</span></div>';
}

function renderRwa() {
  const rwa = state.rwa;
  if (!rwa) {
    $('rwaStatus').textContent = 'NOT DEPLOYED';
    $('rwaStatus').className = 'status pending';
    $('rwaCap').textContent = '—';
    $('rwaDeposits').textContent = '—';
    $('rwaDebt').textContent = '—';
    $('rwaMaturity').textContent = '—';
    $('rwaAccess').textContent = state.account ? 'Vault unavailable' : 'Connect wallet';
    $('rwaExplorer').classList.add('disabled-link');
    $('rwaExplorer').removeAttribute('target');
    return;
  }
  $('rwaStatus').textContent = rwa.status;
  $('rwaStatus').className = `status ${rwa.status === 'ACTIVE' ? 'live' : 'pending'}`;
  $('rwaCap').textContent = formatToken(rwa.debtCap, 6, 'mUSDC', 0);
  $('rwaDeposits').textContent = formatToken(rwa.totalDeposits, 6, 'mUSDC', 2);
  $('rwaDebt').textContent = formatToken(rwa.totalDebt, 6, 'mUSDC', 2);
  $('rwaMaturity').textContent = new Date(Number(rwa.maturity) * 1000).toLocaleDateString();
  $('rwaAccess').textContent = !state.account ? 'Connect wallet' : rwa.allowlisted ? 'Allowlisted' : 'Permission required';
  $('rwaExplorer').href = deploymentExplorerUrl(rwa.address);
  $('rwaExplorer').target = '_blank';
  $('rwaExplorer').rel = 'noopener noreferrer';
  $('rwaExplorer').classList.remove('disabled-link');
}

function updateBorrowLiquidity() {
  const asset = assetByKey($('borrowAsset').value);
  $('borrowLiquidity').textContent = asset?.availableLiquidity !== undefined
    ? formatToken(asset.availableLiquidity, asset.decimals, asset.symbol, 4)
    : '—';
}

async function syncProtocolStatus() {
  if (!deploymentReady()) {
    state.protocol = { deployed: false, activeMarkets: 0, assets: [], positions: [], accountRisk: null };
    state.rwa = null;
    $('contractStatus').textContent = 'Contracts prepared; real KUB Testnet addresses not configured yet';
    $('deploymentLabel').textContent = 'DEPLOYMENT PENDING';
    renderLive();
    setActionStates();
    return;
  }

  try {
    state.protocol = await liveProtocolSnapshot(state.account);
    state.rwa = await sampleRwaSnapshot(state.account);
    $('contractStatus').textContent = `Live contracts · ${state.protocol.activeMarkets} lending markets`;
    $('deploymentLabel').textContent = 'LIVE ON KUB TESTNET';
    if (!state.sandbox) renderLive();
  } catch (error) {
    console.error('Live KUB read failed', error);
    $('contractStatus').textContent = 'Addresses configured, but KUB RPC/contract reads failed closed';
    setBanner(`Live read failed: ${error?.message || 'unknown KUB RPC error'}`, { error: true });
  }
  setActionStates();
}

async function refreshWallet() {
  if (!window.ethereum || !state.account) return;
  try {
    const snapshot = await walletSnapshot(state.account);
    state.chainId = snapshot.chainId;
    state.nativeBalance = snapshot.nativeBalance;
    $('networkPill').textContent = state.chainId === KUB_TESTNET.chainId ? 'KUB Testnet' : `Wrong network · ${state.chainId}`;
    $('networkPill').style.borderColor = state.chainId === KUB_TESTNET.chainId ? '#36b89f' : '#ff8a76';
    $('connectWallet').textContent = shortAddress(state.account);
    $('portfolioConnect').textContent = 'Wallet connected';
    $('portfolioConnect').disabled = true;
    $('walletBalance').textContent = snapshot.nativeBalance !== null ? `${formatUnits(snapshot.nativeBalance, 18, 4)} tKUB` : 'Switch network';
    await syncProtocolStatus();
  } catch (error) {
    console.error('Wallet refresh failed', error);
    setBanner(`Wallet refresh failed: ${error?.message || 'unknown error'}`, { error: true });
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('No EVM wallet found. Install a MetaMask-compatible wallet to connect to KUB Testnet.');
    return;
  }
  try {
    state.account = await connectProtocolWallet();
    await refreshWallet();
  } catch (error) {
    console.error(error);
    if (!String(error?.message || '').toLowerCase().includes('user rejected')) alert(error?.message || 'Wallet connection failed');
  }
}

$('connectWallet').addEventListener('click', connectWallet);
$('portfolioConnect').addEventListener('click', connectWallet);
$('networkPill').addEventListener('click', async () => {
  if (!window.ethereum) return;
  try {
    await ensureKubTestnet();
    await refreshWallet();
  } catch (error) {
    setBanner(error?.message || 'Could not switch network', { error: true });
  }
});

if (window.ethereum) {
  window.ethereum.on?.('accountsChanged', accounts => {
    state.account = accounts[0] || null;
    if (state.account) refreshWallet();
    else window.location.reload();
  });
  window.ethereum.on?.('chainChanged', () => { if (state.account) refreshWallet(); });
  window.ethereum.request({ method: 'eth_accounts' }).then(accounts => {
    if (accounts[0]) {
      state.account = accounts[0];
      refreshWallet();
    }
  });
}

function inputNumber(id) {
  const value = Number($(id).value.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function updateSandboxRisk() {
  if (!state.sandbox) return;
  const supply = inputNumber('supplyAmount');
  const borrow = inputNumber('borrowAmount');
  if (!supply || !borrow) {
    $('ltvValue').textContent = '0.00%';
    $('healthFactor').textContent = '∞';
    $('riskFill').style.width = '0%';
    $('riskMessage').textContent = 'Sandbox preview uses equal-value demonstration inputs.';
    return;
  }
  const used = Math.min((borrow / (supply * 0.7)) * 100, 150);
  const health = (supply * 0.8) / borrow;
  $('ltvValue').textContent = `${used.toFixed(2)}%`;
  $('healthFactor').textContent = health.toFixed(2);
  $('riskFill').style.width = `${Math.min(used, 100)}%`;
  $('riskMessage').textContent = used <= 100 ? 'Sandbox position is inside the illustrative borrow limit.' : 'Sandbox position exceeds the illustrative borrow limit.';
}

function calculateLivePreview() {
  if (!state.account || !state.protocol?.deployed) throw new Error('Connect a wallet to a deployed Maddeth testnet instance first');
  const collateral = assetByKey($('supplyAsset').value);
  const debtAsset = assetByKey($('borrowAsset').value);
  if (!collateral || !debtAsset) throw new Error('Selected market is unavailable');

  const supplyAmount = parseUnits($('supplyAmount').value, collateral.decimals);
  const borrowAmount = parseUnits($('borrowAmount').value, debtAsset.decimals);
  const current = state.protocol.accountRisk || { borrowLimitUsd: 0n, liquidationLimitUsd: 0n, debtUsd: 0n };
  const supplyUsd = supplyAmount * collateral.price / (10n ** BigInt(collateral.decimals));
  const borrowUsd = borrowAmount * debtAsset.price / (10n ** BigInt(debtAsset.decimals));
  const newBorrowLimit = current.borrowLimitUsd + supplyUsd * collateral.ltvBps / BPS;
  const newLiquidationLimit = current.liquidationLimitUsd + supplyUsd * collateral.liquidationThresholdBps / BPS;
  const newDebt = current.debtUsd + borrowUsd;
  const allowed = newDebt <= newBorrowLimit;
  const health = newDebt === 0n ? MAX_UINT : newLiquidationLimit * WAD / newDebt;
  const used = newBorrowLimit === 0n ? 0n : newDebt * 10_000n / newBorrowLimit;
  return { collateral, debtAsset, supplyAmount, borrowAmount, newBorrowLimit, newDebt, health, used, allowed };
}

function previewRisk() {
  if (state.sandbox) {
    updateSandboxRisk();
    return null;
  }
  const preview = calculateLivePreview();
  const usedPercent = Number(preview.used) / 100;
  $('ltvValue').textContent = `${usedPercent.toFixed(2)}%`;
  $('healthFactor').textContent = preview.health === MAX_UINT ? '∞' : formatUnits(preview.health, 18, 2);
  $('riskFill').style.width = `${Math.min(usedPercent, 100)}%`;
  $('riskMessage').textContent = preview.allowed
    ? `Inside borrow limit. Post-transaction debt ${formatUsd(preview.newDebt)} against ${formatUsd(preview.newBorrowLimit)} borrow capacity.`
    : `Blocked: requested debt ${formatUsd(preview.newDebt)} exceeds ${formatUsd(preview.newBorrowLimit)} borrow capacity.`;
  $('riskMessage').classList.toggle('danger', !preview.allowed);
  return preview;
}

$('previewBorrow').addEventListener('click', () => {
  try { previewRisk(); } catch (error) { setBanner(error?.message || 'Could not preview position', { error: true }); }
});
$('supplyAmount').addEventListener('input', () => { if (state.sandbox) updateSandboxRisk(); });
$('borrowAmount').addEventListener('input', () => { if (state.sandbox) updateSandboxRisk(); });
$('borrowAsset').addEventListener('change', updateBorrowLiquidity);

async function confirmStep(label, promise) {
  setBanner(`${label}: waiting for wallet confirmation…`);
  const hash = await promise;
  setBanner(`${label}: submitted. Waiting for KUB confirmation…`, { txHash: hash });
  await waitForReceipt(hash);
  setBanner(`${label}: confirmed.`, { txHash: hash });
  return hash;
}

async function withTransactionLock(action) {
  if (state.inFlight) return;
  state.inFlight = true;
  setActionStates();
  try {
    await action();
    await refreshWallet();
  } catch (error) {
    console.error(error);
    setBanner(`Transaction stopped: ${error?.message || 'unknown error'}`, { error: true });
    throw error;
  } finally {
    state.inFlight = false;
    setActionStates();
  }
}

async function executeSupplyBorrowFlow() {
  if (!liveEnabled()) throw new Error('Maddeth is not ready for live KUB Testnet transactions');
  const preview = previewRisk();
  if (!preview?.allowed) throw new Error('Borrow request exceeds the account borrow limit');

  await withTransactionLock(async () => {
    if (preview.collateral.key === 'wrappedKUB') {
      await confirmStep('Wrap tKUB', wrapTKUB(state.account, preview.supplyAmount));
    }
    await confirmStep('Approve collateral', approvePool(state.account, preview.collateral.address, preview.supplyAmount));
    await confirmStep('Supply collateral', supplyToPool(state.account, preview.collateral.address, preview.supplyAmount));
    await confirmStep('Enable collateral', setCollateral(state.account, preview.collateral.address, true));
    await confirmStep('Borrow asset', borrowFromPool(state.account, preview.debtAsset.address, preview.borrowAmount));
    setBanner('Position opened successfully on KUB Testnet.');
  });
}

$('submitBorrow').addEventListener('click', async () => {
  try { await executeSupplyBorrowFlow(); } catch (error) {
    if (!String(error?.message || '').toLowerCase().includes('rejected')) alert(error?.message || 'Transaction failed');
  }
});

function setInputToPosition(inputId, key, field) {
  const position = positionByKey(key);
  const asset = assetByKey(key);
  if (!position || !asset) return;
  const value = position[field];
  $(inputId).value = formatUnits(value, asset.decimals, asset.decimals);
}

$('repayMax').addEventListener('click', () => setInputToPosition('repayAmount', $('repayAsset').value, 'borrowedAmount'));
$('withdrawMax').addEventListener('click', () => setInputToPosition('withdrawAmount', $('withdrawAsset').value, 'suppliedAmount'));

$('repayButton').addEventListener('click', async () => {
  try {
    const asset = assetByKey($('repayAsset').value);
    if (!asset) throw new Error('Debt market unavailable');
    const amount = parseUnits($('repayAmount').value, asset.decimals);
    await withTransactionLock(async () => {
      await confirmStep('Repay debt', repayPool(state.account, asset.address, amount));
      setBanner('Repayment confirmed on KUB Testnet.');
    });
  } catch (error) { if (!String(error?.message || '').toLowerCase().includes('rejected')) alert(error?.message || 'Repay failed'); }
});

$('withdrawButton').addEventListener('click', async () => {
  try {
    const asset = assetByKey($('withdrawAsset').value);
    if (!asset) throw new Error('Supply market unavailable');
    const amount = parseUnits($('withdrawAmount').value, asset.decimals);
    await withTransactionLock(async () => {
      await confirmStep('Withdraw supply', withdrawFromPool(state.account, asset.address, amount));
      setBanner('Withdrawal confirmed. WtKUB withdrawals remain wrapped test KUB.');
    });
  } catch (error) { if (!String(error?.message || '').toLowerCase().includes('rejected')) alert(error?.message || 'Withdraw failed'); }
});

async function mintStable(key, label) {
  const asset = assetByKey(key) || assetConfig(key);
  if (!asset) throw new Error(`${label} contract is not configured`);
  const amount = 10_000n * (10n ** BigInt(asset.decimals));
  await withTransactionLock(async () => {
    await confirmStep(`Mint ${label}`, mintTestAsset(state.account, key, amount));
    setBanner(`10,000 ${label} minted to your KUB Testnet wallet.`);
  });
}

$('mintUsdc').addEventListener('click', async () => { try { await mintStable('testUSDC', 'mUSDC'); } catch (error) { alert(error?.message || 'Mint failed'); } });
$('mintUsdt').addEventListener('click', async () => { try { await mintStable('testUSDT', 'mUSDT'); } catch (error) { alert(error?.message || 'Mint failed'); } });

$('rwaDepositButton').addEventListener('click', async () => {
  try {
    if (!state.rwa?.allowlisted) throw new Error('This wallet is not allowlisted for the demonstration RWA vault');
    const amount = parseUnits($('rwaDepositAmount').value, 6);
    await withTransactionLock(async () => {
      await confirmStep('Deposit to RWA vault', depositRwa(state.account, amount));
      setBanner('RWA vault deposit confirmed on KUB Testnet.');
    });
  } catch (error) { if (!String(error?.message || '').toLowerCase().includes('rejected')) alert(error?.message || 'RWA deposit failed'); }
});

$('rwaWithdrawButton').addEventListener('click', async () => {
  try {
    if (!state.rwa?.lenderDeposit) throw new Error('No RWA deposit to withdraw');
    await withTransactionLock(async () => {
      await confirmStep('Withdraw RWA deposit', withdrawRwa(state.account, state.rwa.lenderDeposit));
      setBanner('RWA withdrawal confirmed on KUB Testnet.');
    });
  } catch (error) { if (!String(error?.message || '').toLowerCase().includes('rejected')) alert(error?.message || 'RWA withdrawal failed'); }
});

$('refreshMarkets').addEventListener('click', syncProtocolStatus);
$('refreshPortfolio').addEventListener('click', refreshWallet);

setMode(false);
syncProtocolStatus();
