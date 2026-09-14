import { readFileSync, existsSync } from 'node:fs';

const pages = [
  'index.html',
  'app/index.html',
  'app/markets/index.html',
  'app/markets/wtkub/index.html',
  'app/markets/musdc/index.html',
  'app/markets/musdt/index.html',
  'app/borrow/index.html',
  'app/liquidations/index.html',
  'app/rwa/index.html',
  'app/portfolio/index.html',
  'app/protocol/index.html',
  'docs/index.html'
];

for (const file of pages) {
  if (!existsSync(file)) throw new Error(`Missing route file: ${file}`);
  const html = readFileSync(file, 'utf8');
  if (!/Content-Security-Policy/.test(html)) throw new Error(`Missing CSP: ${file}`);
  if (/spark\.finance/i.test(html) || /\bSpark\b/.test(html)) throw new Error(`Spark branding/reference found: ${file}`);
  if (/javascript\s*:/i.test(html)) throw new Error(`javascript: URL found: ${file}`);
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const dupes = [...counts].filter(([,n]) => n > 1);
  if (dupes.length) throw new Error(`Duplicate IDs in ${file}: ${dupes.map(([id,n]) => `${id}(${n})`).join(', ')}`);
  for (const match of html.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>/gi)) {
    const tag = match[0];
    if (!/rel=["'][^"']*noopener[^"']*["']/i.test(tag) || !/rel=["'][^"']*noreferrer[^"']*["']/i.test(tag)) throw new Error(`Unsafe target=_blank link in ${file}: ${tag}`);
  }
}

const home = readFileSync('index.html','utf8');
if (/id=["']appSection["']/.test(home) || /data-view=/.test(home)) throw new Error('Homepage still contains legacy one-page application navigation');
if (!/href=["']\/app\/["']/.test(home)) throw new Error('Homepage must link to dedicated app dashboard');

const requiredRoutes = {
  'app/index.html': ['dashSupplied','dashBorrowed','dashLiquidity','dashMarkets','connectWallet','networkPill','liveMode','sandboxMode'],
  'app/markets/index.html': ['metricSupplied','metricBorrowed','metricLiquidity','metricMarkets','marketRows','refreshMarkets','mintUsdc','mintUsdt'],
  'app/borrow/index.html': ['supplyAsset','supplyAmount','borrowAsset','borrowAmount','borrowLiquidity','ltvValue','healthFactor','previewBorrow','submitBorrow','repayButton','withdrawButton'],
  'app/liquidations/index.html': [
    'scanButton','candidateRows','borrowerAddress','inspectButton','borrowerHealth','debtAsset','collateralAsset','repayAmount','useMaxClose','previewLiquidation','executeLiquidation','mintDebtAsset',
    'liquidation-lab','labStatus','labConnectWallet','labMintCollateral','labOpenPosition','labShockPrice','labResetPrice','labBorrowerInput','labInspectBorrower','labMintDebt','labLiquidate','labBorrowerHealth','labMaxClose','labExpectedSeize'
  ],
  'app/rwa/index.html': ['rwaStatus','rwaCap','rwaDeposits','rwaDebt','rwaMaturity','rwaAccess','rwaDepositButton','rwaWithdrawButton'],
  'app/portfolio/index.html': ['portfolioDisconnected','portfolioLive','portfolioTitle','portfolioConnect','portfolioRows','portfolioHealth'],
  'app/protocol/index.html': [
    'deploymentLabel','contractStatus','riskConsoleTitle','riskActionBanner','riskConnectedWallet','riskRole','riskNetwork','riskOwner','riskPendingOwner','riskAdminAddress','riskOracle','riskProtocolPause','riskMarketCount','riskAlertCount','riskEmergencyStatus','riskMarketsBody','riskMarketSelect','riskConnect','riskNetworkButton','riskRefresh','riskPauseProtocol','riskUnpauseProtocol','riskPauseMarket','riskUnpauseMarket'
  ]
};
for (const [file, required] of Object.entries(requiredRoutes)) {
  const html = readFileSync(file,'utf8');
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
  const missing = required.filter(id => !ids.has(id));
  if (missing.length) throw new Error(`Missing required IDs in ${file}: ${missing.join(', ')}`);
}
for (const file of ['app/markets/wtkub/index.html','app/markets/musdc/index.html','app/markets/musdt/index.html']) {
  const html = readFileSync(file,'utf8');
  for (const id of ['marketDetailSymbol','marketDetailSupply','marketDetailBorrow','marketDetailUtilisation','marketDetailLiquidity']) if (!html.includes(`id="${id}"`)) throw new Error(`Missing ${id} in ${file}`);
}
const rwa = readFileSync('app/rwa/index.html','utf8');
if (!/does not represent a legally enforceable real-world asset/i.test(rwa)) throw new Error('RWA legal/testnet disclaimer missing');
const appCss = readFileSync('src/app-pages.css','utf8');
if (!/prefers-reduced-motion/.test(appCss)) throw new Error('Reduced-motion support missing');
const appJs = readFileSync('src/app-pages.js','utf8');
if (!/deploymentReady/.test(appJs) || !/liveProtocolSnapshot/.test(appJs)) throw new Error('Live protocol integration missing from app-pages.js');
if (!/state\.sandbox/.test(appJs)) throw new Error('Sandbox isolation missing from app-pages.js');
if (!/noopener noreferrer/.test(appJs)) throw new Error('Dynamic external link hardening missing');
const liquidationJs = readFileSync('src/liquidations.js','utf8');
if (!/Borrowed\(address,address,uint256,uint256\)/.test(liquidationJs)) throw new Error('Liquidation borrower event scanner missing');
if (!/liquidate\(address,address,address,uint256\)/.test(liquidationJs)) throw new Error('Liquidation execution path missing');
if (!/eth_estimateGas/.test(liquidationJs)) throw new Error('Liquidation execution must fail closed through gas estimation');
if (!/CLOSE_FACTOR_BPS\s*=\s*5_000n/.test(liquidationJs)) throw new Error('Liquidation close factor preview is not pinned to protocol value');
const labInlineJs = readFileSync('src/liquidation-lab-inline.js','utf8');
if (!/kub-liquidation-lab\.json/.test(labInlineJs)) throw new Error('Embedded lab registry integration missing');
if (!/setShock\(bool\)/.test(labInlineJs)) throw new Error('Embedded lab bounded oracle shock missing');
if (!/liquidate\(address,address,address,uint256\)/.test(labInlineJs)) throw new Error('Embedded lab liquidation execution missing');
if (!/eth_estimateGas/.test(labInlineJs)) throw new Error('Embedded lab must fail closed through gas estimation');
if (!/account\.toLowerCase\(\) === borrower\.toLowerCase\(\)/.test(labInlineJs)) throw new Error('Embedded lab two-wallet guard missing');
const siteJs = readFileSync('src/site.js','utf8');
if (!/\/app\/liquidations\/#liquidation-lab/.test(siteJs)) throw new Error('Lab navigation must remain inside the Liquidations page');
const riskJs = readFileSync('src/risk-admin.js','utf8');
if (!/setProtocolPaused\(bool\)/.test(riskJs)) throw new Error('Risk console protocol pause path missing');
if (!/setPaused\(address,bool\)/.test(riskJs)) throw new Error('Risk console market pause path missing');
if (!/MAX_ORACLE_AGE\(\)/.test(riskJs)) throw new Error('Risk console oracle freshness boundary missing');
if (!/marketTotals\(address\)/.test(riskJs) || !/markets\(address\)/.test(riskJs)) throw new Error('Risk console live market telemetry missing');
if (!/eth_estimateGas/.test(riskJs)) throw new Error('Risk console actions must fail closed through gas estimation');
if (/configureMarket\(address/.test(riskJs) || /withdrawReserves\(/.test(riskJs) || /absorbBadDebt\(/.test(riskJs) || /setOracle\(/.test(riskJs)) throw new Error('Risk browser console exposes destructive owner configuration');
console.log(`Frontend integrity PASS · ${pages.length} routes · Phase 3 risk console enforced`);
