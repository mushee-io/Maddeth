import {
  KUB_TESTNET,
  liveProtocolSnapshot,
  sampleRwaSnapshot,
  deploymentReady,
  configuredContract,
  formatUnits,
  formatWadPercent
} from './protocol.js';

const byId = id => document.getElementById(id);
const RPC_TIMEOUT_MS = 12_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
let rpcId = 7000;
const selectorCache = new Map();

async function rpc(method, params = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(KUB_TESTNET.rpcUrls[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`KUB RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || 'KUB RPC request failed');
    if (payload.result === undefined || payload.result === null) throw new Error(`${method} returned no result`);
    return payload.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${method} timed out`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function utf8ToHex(value) {
  return `0x${Array.from(new TextEncoder().encode(value)).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function selector(signature) {
  if (selectorCache.has(signature)) return selectorCache.get(signature);
  const hash = await rpc('web3_sha3', [utf8ToHex(signature)]);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`Invalid selector hash for ${signature}`);
  const value = hash.slice(0, 10);
  selectorCache.set(signature, value);
  return value;
}

async function noArgCall(address, signature) {
  return rpc('eth_call', [{ to: address, data: await selector(signature) }, 'latest']);
}

function decodeAddressWord(hex) {
  const body = String(hex || '0x').replace(/^0x/, '').padStart(64, '0');
  return `0x${body.slice(-40)}`;
}

function validAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(address || '')) && String(address).toLowerCase() !== ZERO_ADDRESS;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load ${path}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function renderEvidence(items) {
  const root = byId('readinessEvidence');
  if (!root) return;
  root.replaceChildren();
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'readiness-evidence-card';
    const eyebrow = document.createElement('small');
    eyebrow.textContent = String(item.id || '').toUpperCase();
    const title = document.createElement('strong');
    title.textContent = item.label || 'Unnamed evidence';
    const detail = document.createElement('p');
    detail.textContent = item.evidence || 'No evidence description';
    const status = document.createElement('span');
    status.className = `readiness-status ${item.status || 'unknown'}`;
    status.textContent = String(item.status || 'unknown').toUpperCase();
    card.append(eyebrow, title, detail, status);
    root.appendChild(card);
  }
}

function renderExternal(items) {
  const root = byId('readinessExternal');
  if (!root) return;
  root.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'readiness-gate';
    const dot = document.createElement('i');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.label || item.id || 'External gate';
    const detail = document.createElement('span');
    const gateStatus = String(item.status || 'unknown').toUpperCase();
    detail.textContent = `${gateStatus} · ${item.blockingMainnet ? 'Required before production use' : 'Release follow-up'}`;
    copy.append(title, detail);
    row.append(dot, copy);
    root.appendChild(row);
  }
}

function marketMetric(label, value) {
  const wrapper = document.createElement('div');
  const small = document.createElement('small');
  small.textContent = label;
  const strong = document.createElement('b');
  strong.textContent = value;
  wrapper.append(small, strong);
  return wrapper;
}

function renderMarkets(assets) {
  const root = byId('readinessMarkets');
  if (!root) return;
  root.replaceChildren();
  const now = Math.floor(Date.now() / 1000);
  for (const asset of assets) {
    const age = Math.max(0, now - Number(asset.priceUpdatedAt));
    const row = document.createElement('article');
    row.className = 'readiness-market';
    row.append(
      marketMetric('MARKET', String(asset.symbol || 'UNKNOWN')),
      marketMetric('SUPPLIED', marketAmount(asset, asset.totalSupplied)),
      marketMetric('BORROWED', marketAmount(asset, asset.totalBorrowed)),
      marketMetric('UTILISATION', formatWadPercent(asset.utilisation)),
      marketMetric('ORACLE AGE', formatAge(age)),
      marketMetric('STATUS', asset.paused ? 'PAUSED' : 'OPEN')
    );
    root.appendChild(row);
  }
}

async function bytecodeReady(addresses) {
  if (!addresses.length || addresses.some(address => !validAddress(address))) return false;
  const codes = await Promise.all(addresses.map(address => rpc('eth_getCode', [address, 'latest'])));
  return codes.every(code => code && code !== '0x' && code !== '0x0');
}

async function coreBytecodeReady(registry) {
  const keys = ['maddethPool', 'maddethLens', 'oracle', 'interestRateModel', 'rwaVaultFactory', 'sampleRwaVault', 'wrappedKUB', 'testUSDC', 'testUSDT'];
  const addresses = keys.map(key => registry.contracts?.[key]);
  if (!(await bytecodeReady(addresses))) return false;
  const feeds = Object.values(registry.oracleFeeds || {});
  return feeds.length >= 2 && bytecodeReady(feeds);
}

async function liveBindings(registry) {
  const pool = registry.contracts?.maddethPool;
  const lens = registry.contracts?.maddethLens;
  const oracle = registry.contracts?.oracle;
  if (![pool, lens, oracle].every(validAddress)) throw new Error('Canonical bindings are not configured');
  const [poolOracleRaw, lensPoolRaw, protocolPausedRaw] = await Promise.all([
    noArgCall(pool, 'oracle()'),
    noArgCall(lens, 'pool()'),
    noArgCall(pool, 'protocolPaused()')
  ]);
  const poolOracle = decodeAddressWord(poolOracleRaw);
  const lensPool = decodeAddressWord(lensPoolRaw);
  const protocolPaused = BigInt(protocolPausedRaw || '0x0') !== 0n;
  return {
    protocolPaused,
    oracleBound: poolOracle.toLowerCase() === oracle.toLowerCase(),
    lensBound: lensPool.toLowerCase() === pool.toLowerCase()
  };
}

async function refreshReadiness() {
  banner('Refreshing live KUB Testnet readiness…', 'info');
  const verdict = document.querySelector('.readiness-verdict');
  verdict?.classList.remove('ready', 'warn', 'fail');

  try {
    const [policy, registry, snapshot, rwa, blockHex, chainHex] = await Promise.all([
      loadJson('/config/readiness.json'),
      loadJson('/config/kub-testnet.json'),
      liveProtocolSnapshot(),
      sampleRwaSnapshot(),
      rpc('eth_blockNumber'),
      rpc('eth_chainId')
    ]);

    const chainId = Number(BigInt(chainHex));
    const currentBlock = Number(BigInt(blockHex));
    if (chainId !== 25925 || registry.chainId !== 25925) throw new Error(`Wrong KUB chain: ${chainId}`);
    if (!Number.isInteger(registry.deploymentBlock) || currentBlock < registry.deploymentBlock) throw new Error('RPC head predates the canonical deployment');

    renderEvidence(policy.codeEvidence || []);
    renderExternal(policy.externalGates || []);
    renderMarkets(snapshot.assets || []);

    const [codeReady, bindings] = await Promise.all([coreBytecodeReady(registry), liveBindings(registry)]);
    const bytecodeOk = deploymentReady() && registry.deploymentStatus === 'deployed' && codeReady;
    const marketsOk = snapshot.deployed && snapshot.activeMarkets === 3 && snapshot.assets.length === 3;
    const now = Math.floor(Date.now() / 1000);
    const staleMarkets = snapshot.assets.filter(asset => asset.price <= 0n || Number(asset.priceUpdatedAt) <= 0 || now - Number(asset.priceUpdatedAt) > 1800);
    const pausedMarkets = snapshot.assets.filter(asset => asset.paused);
    const oracleOk = snapshot.assets.length === 3 && staleMarkets.length === 0 && bindings.oracleBound;
    const postureOk = pausedMarkets.length === 0 && !bindings.protocolPaused && bindings.lensBound;
    const rwaOk = Boolean(rwa && rwa.address && !rwa.defaulted && !rwa.paused && rwa.status !== 'MATURED_OUTSTANDING');
    const evidenceOk = (policy.codeEvidence || []).length > 0 && (policy.codeEvidence || []).every(item => ['verified', 'enforced'].includes(item.status));
    const blockingExternal = (policy.externalGates || []).filter(item => item.blockingMainnet && item.status !== 'complete');

    setText('readyDeployment', bytecodeOk ? 'LIVE' : 'CHECK');
    setText('readyDeploymentDetail', bytecodeOk ? `${shortAddress(configuredContract('maddethPool'))} · contracts + feeds verified` : 'Registry, bytecode or feed check failed');
    setText('readyMarkets', String(snapshot.activeMarkets));
    setText('readyOracle', oracleOk ? 'FRESH' : 'ATTENTION');
    setText('readyOracleDetail', oracleOk ? 'All configured prices ≤ 30m old · oracle binding verified' : `${staleMarkets.length} stale/invalid market(s)`);
    setText('readyProtocol', postureOk ? 'OPEN' : 'ATTENTION');
    setText('readyProtocolDetail', postureOk ? 'Global + market pause state clear · Lens binding verified' : `${pausedMarkets.length} market pause(s) or binding/global pause issue`);
    setText('readyRwa', rwaOk ? rwa.status : 'ATTENTION');
    setText('readyRwaDetail', rwa ? `${shortAddress(rwa.address)} · isolated test vault` : 'Sample vault unavailable');
    setText('readyBlock', String(currentBlock));

    const testnetReady = bytecodeOk && marketsOk && oracleOk && postureOk && rwaOk && evidenceOk;
    if (testnetReady) {
      setText('readinessVerdict', 'TESTNET READY');
      setText('readinessVerdictDetail', blockingExternal.length
        ? `Internal testnet gates pass. Mainnet remains blocked by ${blockingExternal.length} external gate(s).`
        : 'Internal testnet gates pass. Re-run independent production sign-off before any mainnet release.');
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
