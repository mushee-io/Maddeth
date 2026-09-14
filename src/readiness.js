import {
  KUB_TESTNET,
  liveProtocolSnapshot,
  sampleRwaSnapshot,
  deploymentReady,
  configuredContract,
  deploymentExplorerUrl,
  formatUnits,
  formatWadPercent
} from './protocol.js';

const byId = id => document.getElementById(id);
let rpcId = 7000;

async function rpc(method, params = []) {
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

function setText(id, value) {
  const node = byId(id);
  if (node) node.textContent = value;
}

function shortAddress(address) {
  if (!address) return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function marketAmount(asset, value) {
  return `${formatUnits(value, Number(asset.decimals), 2)} ${asset.symbol}`;
}

function banner(message, kind = 'info') {
  const node = byId('readinessBanner');
  if (!node) return;
  node.textContent = message;
  node.className = `tx-banner ${kind}`;
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.json();
}

function renderEvidence(items) {
  const root = byId('readinessEvidence');
  root.replaceChildren();
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'readiness-evidence-card';
    const eyebrow = document.createElement('small');
    eyebrow.textContent = item.id.toUpperCase();
    const title = document.createElement('strong');
    title.textContent = item.label;
    const detail = document.createElement('p');
    detail.textContent = item.evidence;
    const status = document.createElement('span');
    status.className = `readiness-status ${item.status}`;
    status.textContent = item.status.toUpperCase();
    card.append(eyebrow, title, detail, status);
    root.appendChild(card);
  }
}

function renderExternal(items) {
  const root = byId('readinessExternal');
  root.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'readiness-gate';
    const dot = document.createElement('i');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.label;
    const detail = document.createElement('span');
    detail.textContent = item.blockingMainnet ? 'Required before production use' : 'Release follow-up';
    copy.append(title, detail);
    row.append(dot, copy);
    root.appendChild(row);
  }
}

function renderMarkets(assets) {
  const root = byId('readinessMarkets');
  root.replaceChildren();
  const now = Math.floor(Date.now() / 1000);
  for (const asset of assets) {
    const age = Math.max(0, now - Number(asset.priceUpdatedAt));
    const row = document.createElement('article');
    row.className = 'readiness-market';
    row.innerHTML = `
      <div><small>MARKET</small><b>${asset.symbol}</b></div>
      <div><small>SUPPLIED</small><b>${marketAmount(asset, asset.totalSupplied)}</b></div>
      <div><small>BORROWED</small><b>${marketAmount(asset, asset.totalBorrowed)}</b></div>
      <div><small>UTILISATION</small><b>${formatWadPercent(asset.utilisation)}</b></div>
      <div><small>ORACLE AGE</small><b>${formatAge(age)}</b></div>
      <div><small>STATUS</small><b>${asset.paused ? 'PAUSED' : 'OPEN'}</b></div>`;
    root.appendChild(row);
  }
}

async function coreBytecodeReady(registry) {
  const keys = ['maddethPool', 'maddethLens', 'oracle', 'interestRateModel', 'rwaVaultFactory', 'sampleRwaVault', 'wrappedKUB', 'testUSDC', 'testUSDT'];
  const addresses = keys.map(key => registry.contracts?.[key]).filter(Boolean);
  if (addresses.length !== keys.length) return false;
  const codes = await Promise.all(addresses.map(address => rpc('eth_getCode', [address, 'latest'])));
  return codes.every(code => code && code !== '0x' && code !== '0x0');
}

async function refreshReadiness() {
  banner('Refreshing live KUB Testnet readiness…', 'info');
  const verdict = document.querySelector('.readiness-verdict');
  verdict?.classList.remove('ready', 'warn', 'fail');

  try {
    const [policy, registry, snapshot, rwa, blockHex] = await Promise.all([
      loadJson('/config/readiness.json'),
      loadJson('/config/kub-testnet.json'),
      liveProtocolSnapshot(),
      sampleRwaSnapshot(),
      rpc('eth_blockNumber')
    ]);

    renderEvidence(policy.codeEvidence || []);
    renderExternal(policy.externalGates || []);
    renderMarkets(snapshot.assets || []);

    const bytecodeOk = deploymentReady() && registry.deploymentStatus === 'deployed' && await coreBytecodeReady(registry);
    const marketsOk = snapshot.deployed && snapshot.activeMarkets === 3 && snapshot.assets.length === 3;
    const now = Math.floor(Date.now() / 1000);
    const staleMarkets = snapshot.assets.filter(asset => asset.price <= 0n || now - Number(asset.priceUpdatedAt) > 1800);
    const pausedMarkets = snapshot.assets.filter(asset => asset.paused);
    const oracleOk = snapshot.assets.length === 3 && staleMarkets.length === 0;
    const postureOk = pausedMarkets.length === 0;
    const rwaOk = Boolean(rwa && rwa.address && !rwa.defaulted);
    const evidenceOk = (policy.codeEvidence || []).every(item => ['verified', 'enforced'].includes(item.status));
    const externalPending = (policy.externalGates || []).some(item => item.status !== 'complete');

    setText('readyDeployment', bytecodeOk ? 'LIVE' : 'CHECK');
    setText('readyDeploymentDetail', bytecodeOk ? `${shortAddress(configuredContract('maddethPool'))} · bytecode verified` : 'Registry or bytecode check failed');
    setText('readyMarkets', String(snapshot.activeMarkets));
    setText('readyOracle', oracleOk ? 'FRESH' : 'ATTENTION');
    setText('readyOracleDetail', oracleOk ? 'All configured prices ≤ 30m old' : `${staleMarkets.length} stale/invalid market(s)`);
    setText('readyProtocol', postureOk ? 'OPEN' : 'PAUSED');
    setText('readyProtocolDetail', postureOk ? 'No canonical market pause detected' : `${pausedMarkets.length} market(s) paused`);
    setText('readyRwa', rwaOk ? rwa.status : 'ATTENTION');
    setText('readyRwaDetail', rwa ? `${shortAddress(rwa.address)} · isolated test vault` : 'Sample vault unavailable');
    setText('readyBlock', BigInt(blockHex).toString());

    const testnetReady = bytecodeOk && marketsOk && oracleOk && postureOk && rwaOk && evidenceOk;
    if (testnetReady) {
      setText('readinessVerdict', externalPending ? 'TESTNET READY' : 'READY');
      setText('readinessVerdictDetail', externalPending ? 'Internal testnet gates pass. Production remains blocked by external gates.' : 'All configured gates pass.');
      verdict?.classList.add('ready');
      banner('Readiness refresh complete · internal KUB Testnet gates pass.', 'success');
    } else {
      setText('readinessVerdict', 'ATTENTION');
      setText('readinessVerdictDetail', 'One or more live/internal testnet gates need attention before release sign-off.');
      verdict?.classList.add('warn');
      banner('Readiness refresh complete · review the highlighted live checks.', 'warning');
    }
  } catch (error) {
    setText('readinessVerdict', 'CHECK FAILED');
    setText('readinessVerdictDetail', error.message || 'Could not complete readiness checks.');
    verdict?.classList.add('fail');
    banner(error.message || 'Readiness check failed.', 'error');
  }
}

byId('readinessRefreshTop')?.addEventListener('click', refreshReadiness);
refreshReadiness();
