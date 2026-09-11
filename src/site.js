const byId = id => document.getElementById(id);
const all = selector => Array.from(document.querySelectorAll(selector));

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
  if (theme) theme.content = resolved === 'dark' ? '#111116' : '#f5f1eb';
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
function init() {
  applyTheme(storageGet('maddeth-theme') || 'system');
  wireSettings();
  hardenExternalLinks();
  setActiveNav();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
else init();
