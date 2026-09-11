import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const css = readFileSync('src/styles.css', 'utf8');
const ui = readFileSync('src/ui.js', 'utf8');

const requiredIds = [
  'appSection','viewTitle','liveMode','sandboxMode','liveNotice','sandboxNotice','txBanner',
  'marketsView','borrowView','rwaView','portfolioView','protocolView','metricSupplied','metricLiquidity','metricMarkets','marketRows',
  'refreshMarkets','mintUsdc','mintUsdt','supplyAsset','supplyAmount','walletBalance','borrowAsset','borrowAmount','borrowLiquidity',
  'ltvValue','healthFactor','riskFill','riskMessage','previewBorrow','submitBorrow','accountCollateral','accountDebt','accountBorrowLimit',
  'accountAvailable','accountHealth','repayAsset','repayAmount','repayMax','repayButton','withdrawAsset','withdrawAmount','withdrawMax','withdrawButton',
  'rwaStatus','rwaAsset','rwaCap','rwaDeposits','rwaDebt','rwaMaturity','rwaAccess','rwaExplorer','rwaDepositAmount','rwaDepositButton','rwaWithdrawButton',
  'portfolioDisconnected','portfolioLive','portfolioTitle','portfolioConnect','portfolioCollateral','portfolioDebt','portfolioAvailable','portfolioHealth',
  'portfolioAddress','portfolioRows','refreshPortfolio','networkPill','connectWallet','deploymentLabel','contractStatus'
];

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
const idCounts = new Map();
for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);

const missing = requiredIds.filter(id => !idCounts.has(id));
const duplicates = [...idCounts.entries()].filter(([, count]) => count > 1);

if (missing.length) throw new Error(`Missing frontend IDs: ${missing.join(', ')}`);
if (duplicates.length) throw new Error(`Duplicate frontend IDs: ${duplicates.map(([id, count]) => `${id}(${count})`).join(', ')}`);

if (/spark\.finance/i.test(html) || /\bSpark\b/.test(html)) throw new Error('Spark branding/reference found in Maddeth frontend');
if (/javascript\s*:/i.test(html)) throw new Error('javascript: URL found');
if (!/Content-Security-Policy/.test(html)) throw new Error('Missing CSP meta policy');
if (!/rpc-testnet\.bitkubchain\.io/.test(html)) throw new Error('KUB Testnet RPC missing');
if (!/TESTNET HARDENED/.test(html) || !/audit pending/i.test(html)) throw new Error('Required testnet/audit disclosure missing');
if (!/SANDBOX[\s\S]*simulated/i.test(html)) throw new Error('Sandbox disclosure missing');
if (!/does not represent a legally enforceable real-world asset/i.test(html)) throw new Error('RWA demo disclaimer missing');
if (!/prefers-reduced-motion/.test(css)) throw new Error('Reduced-motion support missing');
if (!/noopener/.test(ui) || !/noreferrer/.test(ui)) throw new Error('External-link hardening missing');

for (const match of html.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>/gi)) {
  if (!/rel=["'][^"']*noopener[^"']*noreferrer[^"']*["']/i.test(match[0]) && !/rel=["'][^"']*noreferrer[^"']*noopener[^"']*["']/i.test(match[0])) {
    throw new Error(`Unsafe target=_blank link: ${match[0]}`);
  }
}

console.log(`Frontend integrity PASS · ${ids.length} unique IDs · Maddeth design system enforced`);
