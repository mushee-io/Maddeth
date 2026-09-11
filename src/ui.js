const byId = id => document.getElementById(id);
const all = selector => Array.from(document.querySelectorAll(selector));

const keyToSymbol = Object.freeze({
  wrappedKUB: 'WtKUB',
  testUSDC: 'mUSDC',
  testUSDT: 'mUSDT'
});

function safeLocalStorageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function safeLocalStorageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* storage may be blocked */ }
}

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(preference) {
  const normalized = ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
  const resolved = normalized === 'system' ? systemTheme() : normalized;
  document.body.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  safeLocalStorageSet('maddeth-theme', normalized);

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = resolved === 'dark' ? '#111116' : '#f5f1eb';

  ['themeLight', 'themeDark', 'themeSystem'].forEach(id => byId(id)?.classList.remove('active-setting'));
  const activeId = normalized === 'light' ? 'themeLight' : normalized === 'dark' ? 'themeDark' : 'themeSystem';
  byId(activeId)?.classList.add('active-setting');
}

function wireThemeControls() {
  const saved = safeLocalStorageGet('maddeth-theme') || 'system';
  applyTheme(saved);
  byId('themeLight')?.addEventListener('click', () => applyTheme('light'));
  byId('themeDark')?.addEventListener('click', () => applyTheme('dark'));
  byId('themeSystem')?.addEventListener('click', () => applyTheme('system'));

  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', () => {
    if ((safeLocalStorageGet('maddeth-theme') || 'system') === 'system') applyTheme('system');
  });
}

function proxyClick(sourceSelector, targetId) {
  all(sourceSelector).forEach(source => source.addEventListener('click', event => {
    event.preventDefault();
    byId(targetId)?.click();
  }));
}

function closeSettings() {
  const details = document.querySelector('.settings-menu');
  if (details?.open) details.open = false;
}

function wireSettings() {
  byId('settingsLive')?.addEventListener('click', () => { byId('liveMode')?.click(); closeSettings(); });
  byId('settingsSandbox')?.addEventListener('click', () => { byId('sandboxMode')?.click(); closeSettings(); });

  document.addEventListener('pointerdown', event => {
    const details = document.querySelector('.settings-menu');
    if (details?.open && !details.contains(event.target)) details.open = false;
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSettings();
  });
}

function walletConnected() {
  const label = byId('connectWallet')?.textContent?.trim() || '';
  return /^0x[0-9a-f]{4,}…[0-9a-f]{4}$/i.test(label);
}

function sandboxActive() {
  return Boolean(byId('sandboxMode')?.classList.contains('active'));
}

function syncWalletGate() {
  const gate = byId('walletGate');
  if (!gate) return;
  gate.classList.toggle('hidden', walletConnected() || sandboxActive());
}

function marketRatesBySymbol(symbol) {
  const rows = all('#marketRows .market-row');
  for (const row of rows) {
    const cells = Array.from(row.children);
    if (cells.length < 3) continue;
    const rowSymbol = cells[0]?.querySelector('b')?.textContent?.trim() || cells[0]?.textContent?.trim().split(/\s+/)[0];
    if (rowSymbol === symbol) {
      return {
        supply: cells[1]?.textContent?.trim() || '—',
        borrow: cells[2]?.textContent?.trim() || '—'
      };
    }
  }
  return { supply: '—', borrow: '—' };
}

function syncSelectedRates() {
  const supplyKey = byId('supplyAsset')?.value;
  const borrowKey = byId('borrowAsset')?.value;
  const supplySymbol = keyToSymbol[supplyKey] || '—';
  const borrowSymbol = keyToSymbol[borrowKey] || '—';
  const supplyRates = marketRatesBySymbol(supplySymbol);
  const borrowRates = marketRatesBySymbol(borrowSymbol);

  if (byId('selectedSupplySymbol')) byId('selectedSupplySymbol').textContent = supplySymbol;
  if (byId('selectedBorrowSymbol')) byId('selectedBorrowSymbol').textContent = borrowSymbol;
  if (byId('selectedSupplyRate')) byId('selectedSupplyRate').textContent = supplyRates.supply;
  if (byId('selectedBorrowRate')) byId('selectedBorrowRate').textContent = borrowRates.borrow;
}

function syncActiveViewButton(view) {
  all('.app-tabs [data-view]').forEach(button => button.classList.toggle('active-view', button.dataset.view === view));
}

function wireViewState() {
  all('[data-view]').forEach(button => button.addEventListener('click', () => {
    const view = button.dataset.view;
    if (view) syncActiveViewButton(view);
    closeSettings();
  }));
  syncActiveViewButton('markets');
}

function parseDisplayedNumber(value) {
  const match = String(value || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : '';
}

function fillSupplyMax() {
  const input = byId('supplyAmount');
  const assetKey = byId('supplyAsset')?.value;
  if (!input || !assetKey) return;

  if (assetKey === 'wrappedKUB') {
    const native = parseDisplayedNumber(byId('walletBalance')?.textContent);
    if (native) {
      input.value = native;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  const symbol = keyToSymbol[assetKey];
  const rows = all('#portfolioRows .position-row');
  for (const row of rows) {
    const cells = Array.from(row.children);
    const rowSymbol = cells[0]?.querySelector('b')?.textContent?.trim();
    if (rowSymbol === symbol) {
      const wallet = parseDisplayedNumber(cells[1]?.textContent);
      if (wallet) {
        input.value = wallet;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
  }
}

function wireMaxButton() {
  byId('supplyMaxVisual')?.addEventListener('click', fillSupplyMax);
}

function observeDynamicUi() {
  const connect = byId('connectWallet');
  const marketRows = byId('marketRows');
  const live = byId('liveMode');
  const sandbox = byId('sandboxMode');

  const observers = [];
  if (connect) {
    const observer = new MutationObserver(syncWalletGate);
    observer.observe(connect, { childList: true, subtree: true, characterData: true });
    observers.push(observer);
  }
  if (marketRows) {
    const observer = new MutationObserver(syncSelectedRates);
    observer.observe(marketRows, { childList: true, subtree: true, characterData: true });
    observers.push(observer);
  }
  [live, sandbox].filter(Boolean).forEach(button => {
    const observer = new MutationObserver(() => { syncWalletGate(); syncSelectedRates(); });
    observer.observe(button, { attributes: true, attributeFilter: ['class'] });
    observers.push(observer);
  });

  window.addEventListener('pagehide', () => observers.forEach(observer => observer.disconnect()), { once: true });
}

function hardenExternalLinks() {
  all('a[target="_blank"]').forEach(link => {
    const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
    rel.add('noopener');
    rel.add('noreferrer');
    link.setAttribute('rel', Array.from(rel).join(' '));
  });
}

function init() {
  wireThemeControls();
  wireSettings();
  proxyClick('[data-connect-proxy]', 'connectWallet');
  proxyClick('[data-sandbox-proxy]', 'sandboxMode');
  wireViewState();
  wireMaxButton();
  hardenExternalLinks();

  byId('supplyAsset')?.addEventListener('change', syncSelectedRates);
  byId('borrowAsset')?.addEventListener('change', syncSelectedRates);

  syncWalletGate();
  syncSelectedRates();
  observeDynamicUi();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
