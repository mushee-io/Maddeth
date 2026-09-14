import { liveProtocolSnapshot, deploymentReady, formatWadPercent } from './protocol.js';

const byId = id => document.getElementById(id);
const all = selector => Array.from(document.querySelectorAll(selector));
const WAD = 10n ** 18n;

function ensureTerminalDesign() {
  const styles = [
    { href: '/src/maddeth-terminal.css', marker: 'maddethTerminal' },
    { href: '/src/maddeth-reference-corrections.css', marker: 'maddethReferenceCorrections' }
  ];
  for (const style of styles) {
    if (document.querySelector(`link[data-${style.marker.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}]`)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = style.href;
    link.dataset[style.marker] = 'true';
    document.head.appendChild(link);
  }
}
ensureTerminalDesign();

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function resolvedTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(pref = 'system') {
  const safe = ['light','dark','system'].includes(pref) ? pref : 'system';
  const resolved = resolvedTheme(safe);
  document.body.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.content = resolved === 'dark' ? '#0d0f14' : '#ffffff';
  storageSet('maddeth-theme', safe);
  ['themeLight','themeDark','themeSystem'].forEach(id => byId(id)?.classList.remove('active-setting'));
  byId(safe === 'light' ? 'themeLight' : safe === 'dark' ? 'themeDark' : 'themeSystem')?.classList.add('active-setting');
}
function hardenExternalLinks() {
  all('a[target="_blank"]').forEach(link => {
    const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
    rel.add('noopener'); rel.add('noreferrer');
    link.setAttribute('rel', [...rel].join(' '));
  });
}
function ensureLiquidationNav() {
  const nav = document.querySelector('.app-nav');
  if (!nav || nav.querySelector('[data-app-nav="liquidations"]')) return;
  const link = document.createElement('a');
  link.href = '/app/liquidations/';
  link.dataset.appNav = 'liquidations';
  link.textContent = 'Liquidations';
  const rwa = nav.querySelector('[data-app-nav="rwa"]');
  if (rwa) nav.insertBefore(link, rwa);
  else nav.appendChild(link);
}
function ensureLiquidationLabNav() {
  const nav = document.querySelector('.app-nav');
  if (!nav || nav.querySelector('[data-app-nav="liquidation-lab"]')) return;
  const link = document.createElement('a');
  link.href = '/app/liquidations/#liquidation-lab';
  link.dataset.appNav = 'liquidation-lab';
  link.textContent = 'Lab';
  const liquidation = nav.querySelector('[data-app-nav="liquidations"]');
  if (liquidation?.nextSibling) nav.insertBefore(link, liquidation.nextSibling);
  else if (liquidation) nav.appendChild(link);
  else {
    const rwa = nav.querySelector('[data-app-nav="rwa"]');
    if (rwa) nav.insertBefore(link, rwa);
    else nav.appendChild(link);
  }
}
function ensureReadinessNav() {
  const nav = document.querySelector('.app-nav');
  if (!nav || nav.querySelector('[data-app-nav="readiness"]')) return;
  const link = document.createElement('a');
  link.href = '/app/readiness/';
  link.dataset.appNav = 'readiness';
  link.textContent = 'Readiness';
  const docs = nav.querySelector('[data-app-nav="docs"]');
  if (docs) nav.insertBefore(link, docs);
  else nav.appendChild(link);
}
function setActiveNav() {
  const page = document.body.dataset.appPage;
  if (!page) return;
  all('[data-app-nav]').forEach(link => link.classList.toggle('active', link.dataset.appNav === page));
}
function wireSettings() {
  byId('themeLight')?.addEventListener('click', () => applyTheme('light'));
  byId('themeDark')?.addEventListener('click', () => applyTheme('dark'));
  byId('themeSystem')?.addEventListener('click', () => applyTheme('system'));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const details = document.querySelector('.settings-menu');
      if (details) details.open = false;
    }
  });
}

function assetUsdWad(asset, amount) {
  const decimals = Number(asset?.decimals ?? 18);
  const price = BigInt(asset?.price ?? 0n);
  const quantity = BigInt(amount ?? 0n);
  if (price <= 0n || quantity < 0n) return 0n;
  return quantity * price / (10n ** BigInt(decimals));
}
function scaledString(value, unit) {
  const scaled100 = value * 100n / (unit * WAD);
  const whole = scaled100 / 100n;
  const fraction = (scaled100 % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}
function formatUsd(value) {
  if (value >= 1_000_000_000n * WAD) return `$${scaledString(value, 1_000_000_000n)}B`;
  if (value >= 1_000_000n * WAD) return `$${scaledString(value, 1_000_000n)}M`;
  if (value >= 1_000n * WAD) return `$${scaledString(value, 1_000n)}K`;
  const whole = value / WAD;
  const cents = ((value % WAD) * 100n / WAD).toString().padStart(2, '0');
  return `$${whole}.${cents}`;
}
function formatUtilisation(borrowed, supplied) {
  if (supplied <= 0n) return '0.00%';
  const bps = borrowed * 10_000n / supplied;
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, '0')}%`;
}
function createTicker() {
  if (document.querySelector('.maddeth-market-ticker')) return document.querySelector('.maddeth-market-ticker');
  const ticker = document.createElement('div');
  ticker.className = 'maddeth-market-ticker';
  ticker.setAttribute('role', 'status');
  ticker.setAttribute('aria-live', 'polite');
  ticker.innerHTML = '<span>SUPPLIED <b>DATA UNAVAILABLE</b></span><span>BORROWED <b>DATA UNAVAILABLE</b></span><span>UTIL <b>—</b></span><span>mUSDC APY <b>—</b></span><span>mUSDT APY <b>—</b></span><span class="ticker-unavailable">● RPC CHECKING</span>';
  document.body.appendChild(ticker);
  return ticker;
}
function setAnnouncement(text) {
  all('.announcement, .app-announcement').forEach(node => { node.textContent = text; });
}
async function refreshTerminalMarketState() {
  const ticker = createTicker();
  if (!deploymentReady()) {
    setAnnouncement('MADDETH KUB TESTNET // DEPLOYMENT DATA UNAVAILABLE');
    ticker.innerHTML = '<span>SUPPLIED <b>DATA UNAVAILABLE</b></span><span>BORROWED <b>DATA UNAVAILABLE</b></span><span>UTIL <b>—</b></span><span>mUSDC APY <b>—</b></span><span>mUSDT APY <b>—</b></span><span class="ticker-unavailable">● DEPLOYMENT UNAVAILABLE</span>';
    return;
  }
  try {
    const snapshot = await liveProtocolSnapshot();
    let supplied = 0n;
    let borrowed = 0n;
    for (const asset of snapshot.assets || []) {
      supplied += assetUsdWad(asset, asset.totalSupplied);
      borrowed += assetUsdWad(asset, asset.totalBorrowed);
    }
    const util = formatUtilisation(borrowed, supplied);
    const usdc = snapshot.assets?.find(asset => String(asset.symbol).toUpperCase().includes('USDC'));
    const usdt = snapshot.assets?.find(asset => String(asset.symbol).toUpperCase().includes('USDT'));
    const usdcApy = usdc ? formatWadPercent(usdc.supplyApr) : 'DATA UNAVAILABLE';
    const usdtApy = usdt ? formatWadPercent(usdt.supplyApr) : 'DATA UNAVAILABLE';
    setAnnouncement(`MADDETH MARKETS ARE LIVE — ${formatUsd(supplied)} supplied // ${formatUsd(borrowed)} borrowed // ${util} utilization // KUB TESTNET`);
    ticker.innerHTML = `<span>SUPPLIED <b>${formatUsd(supplied)}</b></span><span>BORROWED <b>${formatUsd(borrowed)}</b></span><span>UTIL <b>${util}</b></span><span>mUSDC APY <b>${usdcApy}</b></span><span>mUSDT APY <b>${usdtApy}</b></span><span class="ticker-status">● MARKETS OPERATIONAL</span>`;
  } catch (error) {
    console.warn('Maddeth terminal market state unavailable', error);
    setAnnouncement('MADDETH KUB TESTNET // RPC UNAVAILABLE // LIVE VALUES HIDDEN');
    ticker.innerHTML = '<span>SUPPLIED <b>RPC UNAVAILABLE</b></span><span>BORROWED <b>RPC UNAVAILABLE</b></span><span>UTIL <b>—</b></span><span>mUSDC APY <b>—</b></span><span>mUSDT APY <b>—</b></span><span class="ticker-unavailable">● RPC UNAVAILABLE</span>';
  }
}

function init() {
  applyTheme(storageGet('maddeth-theme') || 'system');
  ensureLiquidationNav();
  ensureLiquidationLabNav();
  ensureReadinessNav();
  wireSettings();
  hardenExternalLinks();
  setActiveNav();
  refreshTerminalMarketState();
  window.setInterval(refreshTerminalMarketState, 60_000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
else init();
