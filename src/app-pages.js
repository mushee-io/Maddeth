import {
  KUB_TESTNET,
  connectWallet as connectProtocolWallet,
  ensureKubTestnet,
  walletSnapshot,
  liveProtocolSnapshot,
  sampleRwaSnapshot,
  deploymentReady,
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
const $ = id => document.getElementById(id);

const state = {
  account: null,
  chainId: null,
  nativeBalance: null,
  sandbox: false,
  protocol: null,
  rwa: null,
  inFlight: false
};

function text(id, value) { const el = $(id); if (el) el.textContent = value; }
function html(id, value) { const el = $(id); if (el) el.innerHTML = value; }
function toggle(id, cls, value) { const el = $(id); if (el) el.classList.toggle(cls, value); }
function shortAddress(address) { return address ? `${address.slice(0,6)}…${address.slice(-4)}` : '—'; }
function formatUsd(value, precision = 2) { return value === null || value === undefined ? '—' : `$${formatUnits(value, 18, precision)}`; }
function formatToken(value, decimals, symbol, precision = 4) { return value === null || value === undefined ? '—' : `${formatUnits(value, decimals, precision)} ${symbol}`; }
function percentFromBps(value) { return value === null || value === undefined ? '—' : `${(Number(value)/100).toFixed(2)}%`; }
function assetByKey(key) { return state.protocol?.assets?.find(a => a.key === key) || assetConfig(key); }
function positionByKey(key) { return state.protocol?.positions?.find(p => p.key === key) || null; }
function liveEnabled() { return deploymentReady() && Boolean(state.account) && state.chainId === KUB_TESTNET.chainId && !state.sandbox && !state.inFlight; }

function setBanner(message = '', { txHash = null, error = false } = {}) {
  const banner = $('txBanner');
  if (!banner) return;
  if (!message) { banner.classList.add('hidden'); banner.replaceChildren(); return; }
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

function setMode(sandbox) {
  state.sandbox = sandbox;
  $('sandboxMode')?.classList.toggle('active', sandbox);
  $('liveMode')?.classList.toggle('active', !sandbox);
  toggle('sandboxNotice','hidden',!sandbox);
  toggle('liveNotice','hidden',sandbox);
  render();
  setActionStates();
}

function setActionStates() {
  const canTx = liveEnabled();
  const reason = !deploymentReady() ? 'Contracts not deployed'
    : !state.account ? 'Connect wallet'
    : state.chainId !== KUB_TESTNET.chainId ? 'Switch to KUB Testnet'
    : state.sandbox ? 'Live mode required'
    : state.inFlight ? 'Transaction in progress…'
    : 'Supply collateral & borrow';
  const submit = $('submitBorrow');
  if (submit) { submit.disabled = !canTx; submit.textContent = reason; }
  ['repayButton','withdrawButton','mintUsdc','mintUsdt'].forEach(id => { if ($(id)) $(id).disabled = !canTx; });
  if ($('rwaDepositButton')) {
    const canDeposit = canTx && state.rwa?.allowlisted && state.rwa?.status === 'ACTIVE';
    $('rwaDepositButton').disabled = !canDeposit;
    $('rwaDepositButton').textContent = state.rwa && !state.rwa.allowlisted ? 'Wallet not allowlisted' : 'Deposit to vault';
  }
  if ($('rwaWithdrawButton')) $('rwaWithdrawButton').disabled = !(canTx && state.rwa?.lenderDeposit > 0n && state.rwa?.totalDebt === 0n);
}

function aggregate() {
  const assets = state.protocol?.assets || [];
  let supplied = 0n, borrowed = 0n, liquid = 0n;
  for (const a of assets) {
    const scale = 10n ** BigInt(a.decimals);
    supplied += a.totalSupplied * a.price / scale;
    borrowed += a.totalBorrowed * a.price / scale;
    liquid += a.availableLiquidity * a.price / scale;
  }
  return { supplied, borrowed, liquid, markets: state.protocol?.activeMarkets || 0 };
}
function marketHref(key) { return key === 'wrappedKUB' ? '/app/markets/wtkub/' : key === 'testUSDC' ? '/app/markets/musdc/' : '/app/markets/musdt/'; }
function marketRow(a) {
  return `<a class="market-row market-link-row" href="${marketHref(a.key)}"><span class="asset"><b>${a.symbol}</b><small>${a.testOnly ? 'KUB testnet asset' : 'Listed asset'} · LTV ${percentFromBps(a.ltvBps)}</small></span><span>${formatWadPercent(a.supplyApr)}</span><span>${formatWadPercent(a.borrowApr)}</span><span>${formatWadPercent(a.utilisation)}</span><span>${formatToken(a.availableLiquidity,a.decimals,a.symbol,2)}</span></a>`;
}

function renderMarkets() {
  const agg = aggregate();
  text('metricSupplied', state.sandbox ? '$2.84M demo' : state.protocol?.deployed ? formatUsd(agg.supplied) : '—');
  text('metricBorrowed', state.sandbox ? '$1.17M demo' : state.protocol?.deployed ? formatUsd(agg.borrowed) : '—');
  text('metricLiquidity', state.sandbox ? '$1.67M demo' : state.protocol?.deployed ? formatUsd(agg.liquid) : '—');
  text('metricMarkets', state.sandbox ? '3 demo' : String(agg.markets || 0));
  if (!$('marketRows')) return;
  if (state.sandbox) {
    html('marketRows', [['WtKUB','4.18%','6.42%','61.00%','620K demo','/app/markets/wtkub/'],['mUSDC','5.04%','7.20%','67.00%','840K demo','/app/markets/musdc/'],['mUSDT','4.72%','6.95%','64.00%','210K demo','/app/markets/musdt/']].map(r => `<a class="market-row market-link-row" href="${r[5]}"><span class="asset"><b>${r[0]}</b><small>Sandbox only</small></span><span>${r[1]}</span><span>${r[2]}</span><span>${r[3]}</span><span>${r[4]}</span></a>`).join(''));
    return;
  }
  if (!state.protocol?.deployed) {
    html('marketRows','<div class="market-row placeholder-row"><span>Contracts not deployed/configured yet</span><span>—</span><span>—</span><span>—</span><span>—</span></div>');
    return;
  }
  html('marketRows', state.protocol.assets.map(marketRow).join('') || '<div class="market-row placeholder-row"><span>No configured markets</span><span>—</span><span>—</span><span>—</span><span>—</span></div>');
}

function renderAccountSummary(prefix = 'account') {
  const risk = state.sandbox ? null : state.protocol?.accountRisk;
  if (prefix === 'dash') {
    text('dashCollateral', risk ? formatUsd(risk.collateralUsd) : '—'); text('dashDebt', risk ? formatUsd(risk.debtUsd) : '—'); text('dashAvailable', risk ? formatUsd(risk.availableBorrowUsd) : '—'); text('dashHealth', risk ? (risk.healthFactor === MAX_UINT ? '∞' : formatUnits(risk.healthFactor,18,2)) : '—'); return;
  }
  text('accountCollateral', risk ? formatUsd(risk.collateralUsd) : '—'); text('accountDebt', risk ? formatUsd(risk.debtUsd) : '—'); text('accountBorrowLimit', risk ? formatUsd(risk.borrowLimitUsd) : '—'); text('accountAvailable', risk ? formatUsd(risk.availableBorrowUsd) : '—'); text('accountHealth', risk ? (risk.healthFactor === MAX_UINT ? '∞' : formatUnits(risk.healthFactor,18,2)) : '—');
}

function renderDashboard() {
  const agg = aggregate();
  text('dashSupplied', state.sandbox ? '$2.84M demo' : state.protocol?.deployed ? formatUsd(agg.supplied) : '—'); text('dashBorrowed', state.sandbox ? '$1.17M demo' : state.protocol?.deployed ? formatUsd(agg.borrowed) : '—'); text('dashLiquidity', state.sandbox ? '$1.67M demo' : state.protocol?.deployed ? formatUsd(agg.liquid) : '—'); text('dashMarkets', state.sandbox ? '3 demo' : String(agg.markets || 0));
  if ($('dashboardMarketRows')) {
    if (state.sandbox) html('dashboardMarketRows','<a class="dashboard-market" href="/app/markets/wtkub/"><span>WtKUB</span><b>4.18% demo</b><small>Supply APY</small></a><a class="dashboard-market" href="/app/markets/musdc/"><span>mUSDC</span><b>5.04% demo</b><small>Supply APY</small></a><a class="dashboard-market" href="/app/markets/musdt/"><span>mUSDT</span><b>4.72% demo</b><small>Supply APY</small></a>');
    else if (state.protocol?.deployed) html('dashboardMarketRows',state.protocol.assets.map(a => `<a class="dashboard-market" href="${marketHref(a.key)}"><span>${a.symbol}</span><b>${formatWadPercent(a.supplyApr)}</b><small>${formatWadPercent(a.utilisation)} utilised</small></a>`).join(''));
    else html('dashboardMarketRows','<div class="dashboard-market muted-card"><span>Markets</span><b>—</b><small>Awaiting KUB Testnet deployment</small></div>');
  }
  renderAccountSummary('dash');
}

function renderPortfolio() {
  if (!$('portfolioDisconnected')) return;
  const connected = Boolean(state.account);
  toggle('portfolioDisconnected','hidden',connected); toggle('portfolioLive','hidden',!connected);
  if (!connected) return;
  text('portfolioTitle',`Portfolio · ${shortAddress(state.account)}`); text('portfolioAddress',state.account);
  const risk = state.protocol?.accountRisk;
  text('portfolioCollateral',risk ? formatUsd(risk.collateralUsd) : '—'); text('portfolioDebt',risk ? formatUsd(risk.debtUsd) : '—'); text('portfolioAvailable',risk ? formatUsd(risk.availableBorrowUsd) : '—'); text('portfolioHealth',risk ? (risk.healthFactor === MAX_UINT ? '∞' : formatUnits(risk.healthFactor,18,2)) : '—');
  const positions = state.protocol?.positions || [];
  html('portfolioRows',positions.length ? positions.map(p => `<div class="position-row"><span class="asset"><b>${p.symbol}</b><small>${p.testOnly ? 'KUB Testnet' : 'Listed asset'}</small></span><span>${formatUnits(p.walletBalance,p.decimals,4)}</span><span>${formatUnits(p.suppliedAmount,p.decimals,4)}</span><span>${formatUnits(p.borrowedAmount,p.decimals,4)}</span><span>${p.collateralEnabled ? '<b class="positive">Enabled</b>' : 'Off'}</span></div>`).join('') : '<div class="position-row placeholder-row"><span>No positions yet</span><span>—</span><span>—</span><span>—</span><span>—</span></div>');
}

function renderRwa() {
  if (!$('rwaStatus')) return;
  const rwa = state.rwa;
  if (state.sandbox) { text('rwaStatus','SANDBOX'); $('rwaStatus').className='status pending'; text('rwaCap','500,000 mUSDC demo'); text('rwaDeposits','120,000 mUSDC demo'); text('rwaDebt','72,000 mUSDC demo'); text('rwaMaturity','90 days demo'); text('rwaAccess','Simulated'); $('rwaExplorer')?.classList.add('disabled-link'); return; }
  if (!rwa) { text('rwaStatus','NOT DEPLOYED'); $('rwaStatus').className='status pending'; ['rwaCap','rwaDeposits','rwaDebt','rwaMaturity'].forEach(id => text(id,'—')); text('rwaAccess',state.account ? 'Vault unavailable' : 'Connect wallet'); $('rwaExplorer')?.classList.add('disabled-link'); return; }
  text('rwaStatus',rwa.status); $('rwaStatus').className=`status ${rwa.status === 'ACTIVE' ? 'live' : 'pending'}`; text('rwaCap',formatToken(rwa.debtCap,6,'mUSDC',0)); text('rwaDeposits',formatToken(rwa.totalDeposits,6,'mUSDC',2)); text('rwaDebt',formatToken(rwa.totalDebt,6,'mUSDC',2)); text('rwaMaturity',new Date(Number(rwa.maturity)*1000).toLocaleDateString()); text('rwaAccess',!state.account ? 'Connect wallet' : rwa.allowlisted ? 'Allowlisted' : 'Permission required');
  const ex=$('rwaExplorer'); if(ex){ ex.href=deploymentExplorerUrl(rwa.address); ex.target='_blank'; ex.rel='noopener noreferrer'; ex.classList.remove('disabled-link'); }
}

function renderMarketDetail() {
  const key=document.body.dataset.marketKey; if(!key || !$('marketDetailSymbol')) return;
  if(state.sandbox){ const d=key==='wrappedKUB'?{symbol:'WtKUB',supply:'4.18%',borrow:'6.42%',util:'61.00%',supplied:'1.59M demo',borrowed:'970K demo',liquid:'620K demo',ltv:'70.00%',threshold:'82.50%'}:key==='testUSDC'?{symbol:'mUSDC',supply:'5.04%',borrow:'7.20%',util:'67.00%',supplied:'1.28M demo',borrowed:'440K demo',liquid:'840K demo',ltv:'75.00%',threshold:'85.00%'}:{symbol:'mUSDT',supply:'4.72%',borrow:'6.95%',util:'64.00%',supplied:'420K demo',borrowed:'210K demo',liquid:'210K demo',ltv:'75.00%',threshold:'85.00%'}; [['marketDetailSymbol',d.symbol],['marketDetailSupply',d.supply],['marketDetailBorrow',d.borrow],['marketDetailUtilisation',d.util],['marketDetailSupplied',d.supplied],['marketDetailBorrowed',d.borrowed],['marketDetailLiquidity',d.liquid],['marketDetailLtv',d.ltv],['marketDetailThreshold',d.threshold]].forEach(([id,v])=>text(id,v)); return; }
  const a=assetByKey(key); if(!state.protocol?.deployed || !a) return;
  text('marketDetailSymbol',a.symbol); text('marketDetailSupply',formatWadPercent(a.supplyApr)); text('marketDetailBorrow',formatWadPercent(a.borrowApr)); text('marketDetailUtilisation',formatWadPercent(a.utilisation)); text('marketDetailSupplied',formatToken(a.totalSupplied,a.decimals,a.symbol,2)); text('marketDetailBorrowed',formatToken(a.totalBorrowed,a.decimals,a.symbol,2)); text('marketDetailLiquidity',formatToken(a.availableLiquidity,a.decimals,a.symbol,2)); text('marketDetailLtv',percentFromBps(a.ltvBps)); text('marketDetailThreshold',percentFromBps(a.liquidationThresholdBps));
  const link=$('marketContractLink'); if(link && a.address){ link.href=deploymentExplorerUrl(a.address); link.target='_blank'; link.rel='noopener noreferrer'; link.classList.remove('disabled-link'); }
}

function renderBorrowPage() {
  renderAccountSummary('account');
  const borrowAsset=assetByKey($('borrowAsset')?.value), supplyAsset=assetByKey($('supplyAsset')?.value);
  text('borrowLiquidity',borrowAsset?.availableLiquidity !== undefined ? formatToken(borrowAsset.availableLiquidity,borrowAsset.decimals,borrowAsset.symbol,4) : '—');
  text('selectedBorrowSymbol',borrowAsset?.symbol || '—'); text('selectedSupplySymbol',supplyAsset?.symbol || '—');
  text('selectedBorrowRate',state.sandbox ? '7.20% demo' : borrowAsset?.borrowApr !== undefined ? formatWadPercent(borrowAsset.borrowApr) : '—');
  text('selectedSupplyRate',state.sandbox ? '4.18% demo' : supplyAsset?.supplyApr !== undefined ? formatWadPercent(supplyAsset.supplyApr) : '—');
}
function render(){ renderDashboard(); renderMarkets(); renderBorrowPage(); renderRwa(); renderPortfolio(); renderMarketDetail(); setActionStates(); }

async function syncProtocolStatus(){
  if(!deploymentReady()){ state.protocol={deployed:false,activeMarkets:0,assets:[],positions:[],accountRisk:null}; state.rwa=null; text('deploymentLabel','DEPLOYMENT PENDING'); text('contractStatus','Contracts prepared; KUB Testnet addresses not configured yet'); render(); return; }
  try{ state.protocol=await liveProtocolSnapshot(state.account); state.rwa=await sampleRwaSnapshot(state.account); text('deploymentLabel','LIVE ON KUB TESTNET'); text('contractStatus',`Live contracts · ${state.protocol.activeMarkets} lending markets`); setBanner(''); }
  catch(error){ console.error('KUB read failed',error); state.protocol={deployed:false,activeMarkets:0,assets:[],positions:[],accountRisk:null}; state.rwa=null; text('deploymentLabel','KUB READ FAILED'); text('contractStatus','Configured addresses failed closed'); setBanner(`Live read failed: ${error?.message || 'unknown KUB RPC error'}`,{error:true}); }
  render();
}
async function refreshWallet(){ if(!window.ethereum || !state.account) return; try{ const snap=await walletSnapshot(state.account); state.chainId=snap.chainId; state.nativeBalance=snap.nativeBalance; text('networkPill',state.chainId===KUB_TESTNET.chainId?'KUB Testnet':`Wrong network · ${state.chainId}`); text('connectWallet',shortAddress(state.account)); text('walletBalance',snap.nativeBalance!==null?`${formatUnits(snap.nativeBalance,18,4)} tKUB`:'—'); const pc=$('portfolioConnect'); if(pc){pc.textContent='Wallet connected';pc.disabled=true;} await syncProtocolStatus(); }catch(error){ setBanner(`Wallet refresh failed: ${error?.message || 'unknown error'}`,{error:true}); } }
async function connectWallet(){ if(!window.ethereum){setBanner('No EVM wallet found. Install a MetaMask-compatible wallet to connect to KUB Testnet.',{error:true});return;} try{state.account=await connectProtocolWallet();await refreshWallet();}catch(error){if(!String(error?.message||'').toLowerCase().includes('reject'))setBanner(error?.message||'Wallet connection failed',{error:true});} }
async function confirmStep(label,promise){ setBanner(`${label}: waiting for wallet confirmation…`); const hash=await promise; setBanner(`${label}: submitted. Waiting for KUB confirmation…`,{txHash:hash}); await waitForReceipt(hash); setBanner(`${label}: confirmed.`,{txHash:hash}); return hash; }
async function withLock(action){ if(state.inFlight)return; state.inFlight=true; setActionStates(); try{await action();await refreshWallet();}catch(error){setBanner(`Transaction stopped: ${error?.message||'unknown error'}`,{error:true});throw error;}finally{state.inFlight=false;setActionStates();} }

function calculateLivePreview(){ if(!state.account||!state.protocol?.deployed)throw new Error('Connect a wallet to a deployed Maddeth testnet instance first'); const collateral=assetByKey($('supplyAsset')?.value),debtAsset=assetByKey($('borrowAsset')?.value); if(!collateral||!debtAsset)throw new Error('Selected market is unavailable'); const supplyAmount=parseUnits($('supplyAmount').value,collateral.decimals),borrowAmount=parseUnits($('borrowAmount').value,debtAsset.decimals); const current=state.protocol.accountRisk||{borrowLimitUsd:0n,liquidationLimitUsd:0n,debtUsd:0n}; const supplyUsd=supplyAmount*collateral.price/(10n**BigInt(collateral.decimals)),borrowUsd=borrowAmount*debtAsset.price/(10n**BigInt(debtAsset.decimals)); const newBorrowLimit=current.borrowLimitUsd+supplyUsd*collateral.ltvBps/BPS,newLiquidationLimit=current.liquidationLimitUsd+supplyUsd*collateral.liquidationThresholdBps/BPS,newDebt=current.debtUsd+borrowUsd; const allowed=newDebt<=newBorrowLimit,health=newDebt===0n?MAX_UINT:newLiquidationLimit*WAD/newDebt,used=newBorrowLimit===0n?0n:newDebt*10_000n/newBorrowLimit; return{collateral,debtAsset,supplyAmount,borrowAmount,newBorrowLimit,newDebt,health,used,allowed}; }
function previewRisk(){ if(state.sandbox){const supply=Number($('supplyAmount')?.value||0),borrow=Number($('borrowAmount')?.value||0),used=supply>0?Math.min((borrow/(supply*.7))*100,150):0;text('ltvValue',`${used.toFixed(2)}%`);text('healthFactor',borrow>0?((supply*.825)/borrow).toFixed(2):'∞');if($('riskFill'))$('riskFill').style.width=`${Math.min(used,100)}%`;text('riskMessage','SANDBOX · simulated risk preview only.');return null;} const p=calculateLivePreview(),used=Number(p.used)/100;text('ltvValue',`${used.toFixed(2)}%`);text('healthFactor',p.health===MAX_UINT?'∞':formatUnits(p.health,18,2));if($('riskFill'))$('riskFill').style.width=`${Math.min(used,100)}%`;text('riskMessage',p.allowed?`Inside borrow limit. Post-transaction debt ${formatUsd(p.newDebt)} against ${formatUsd(p.newBorrowLimit)} capacity.`:`Blocked: requested debt ${formatUsd(p.newDebt)} exceeds ${formatUsd(p.newBorrowLimit)} capacity.`);$('riskMessage')?.classList.toggle('danger',!p.allowed);return p; }
async function executeSupplyBorrow(){ if(!liveEnabled())throw new Error('Live KUB Testnet transaction mode is not available'); const p=previewRisk();if(!p?.allowed)throw new Error('Borrow request exceeds the account borrow limit');await withLock(async()=>{if(p.collateral.key==='wrappedKUB')await confirmStep('Wrap tKUB',wrapTKUB(state.account,p.supplyAmount));await confirmStep('Approve collateral',approvePool(state.account,p.collateral.address,p.supplyAmount));await confirmStep('Supply collateral',supplyToPool(state.account,p.collateral.address,p.supplyAmount));await confirmStep('Enable collateral',setCollateral(state.account,p.collateral.address,true));await confirmStep('Borrow asset',borrowFromPool(state.account,p.debtAsset.address,p.borrowAmount));setBanner('Position opened successfully on KUB Testnet.');}); }
function setInputFromPosition(inputId,key,field){const p=positionByKey(key),a=assetByKey(key);if(p&&a&&$(inputId))$(inputId).value=formatUnits(p[field],a.decimals,a.decimals);}

function wireCommon(){ $('connectWallet')?.addEventListener('click',connectWallet); $('portfolioConnect')?.addEventListener('click',connectWallet); $('networkPill')?.addEventListener('click',async()=>{try{await ensureKubTestnet();if(state.account)await refreshWallet();}catch(e){setBanner(e?.message||'Could not switch network',{error:true});}}); $('liveMode')?.addEventListener('click',()=>setMode(false)); $('sandboxMode')?.addEventListener('click',()=>setMode(true)); $('refreshMarkets')?.addEventListener('click',syncProtocolStatus); $('refreshPortfolio')?.addEventListener('click',refreshWallet); }
function wireBorrow(){ $('previewBorrow')?.addEventListener('click',()=>{try{previewRisk();}catch(e){setBanner(e?.message||'Could not preview',{error:true});}}); $('borrowAsset')?.addEventListener('change',renderBorrowPage); $('supplyAsset')?.addEventListener('change',renderBorrowPage); $('submitBorrow')?.addEventListener('click',async()=>{try{await executeSupplyBorrow();}catch{}}); $('repayMax')?.addEventListener('click',()=>setInputFromPosition('repayAmount',$('repayAsset').value,'borrowedAmount')); $('withdrawMax')?.addEventListener('click',()=>setInputFromPosition('withdrawAmount',$('withdrawAsset').value,'suppliedAmount')); $('repayButton')?.addEventListener('click',async()=>{try{const a=assetByKey($('repayAsset').value),amount=parseUnits($('repayAmount').value,a.decimals);await withLock(async()=>{await confirmStep('Repay debt',repayPool(state.account,a.address,amount));setBanner('Repayment confirmed on KUB Testnet.');});}catch(e){setBanner(e?.message||'Repay failed',{error:true});}}); $('withdrawButton')?.addEventListener('click',async()=>{try{const a=assetByKey($('withdrawAsset').value),amount=parseUnits($('withdrawAmount').value,a.decimals);await withLock(async()=>{await confirmStep('Withdraw supply',withdrawFromPool(state.account,a.address,amount));setBanner('Withdrawal confirmed on KUB Testnet.');});}catch(e){setBanner(e?.message||'Withdraw failed',{error:true});}}); }
function wireTestAssets(){ for(const [id,key,label] of [['mintUsdc','testUSDC','mUSDC'],['mintUsdt','testUSDT','mUSDT']]) $(id)?.addEventListener('click',async()=>{try{const a=assetByKey(key)||assetConfig(key),amount=10_000n*(10n**BigInt(a.decimals));await withLock(async()=>{await confirmStep(`Mint ${label}`,mintTestAsset(state.account,key,amount));setBanner(`10,000 ${label} minted to your KUB Testnet wallet.`);});}catch(e){setBanner(e?.message||'Mint failed',{error:true});}}); }
function wireRwa(){ $('rwaDepositButton')?.addEventListener('click',async()=>{try{if(!state.rwa?.allowlisted)throw new Error('This wallet is not allowlisted for the testnet RWA vault');const amount=parseUnits($('rwaDepositAmount').value,6);await withLock(async()=>{await confirmStep('Deposit to RWA vault',depositRwa(state.account,amount));setBanner('RWA deposit confirmed on KUB Testnet.');});}catch(e){setBanner(e?.message||'RWA deposit failed',{error:true});}}); $('rwaWithdrawButton')?.addEventListener('click',async()=>{try{if(!state.rwa?.lenderDeposit)throw new Error('No RWA deposit to withdraw');await withLock(async()=>{await confirmStep('Withdraw RWA deposit',withdrawRwa(state.account,state.rwa.lenderDeposit));setBanner('RWA withdrawal confirmed on KUB Testnet.');});}catch(e){setBanner(e?.message||'RWA withdrawal failed',{error:true});}}); }
function wireWalletEvents(){ if(!window.ethereum)return; window.ethereum.on?.('accountsChanged',accounts=>{state.account=accounts[0]||null;if(state.account)refreshWallet();else{state.chainId=null;syncProtocolStatus();}}); window.ethereum.on?.('chainChanged',()=>{if(state.account)refreshWallet();}); window.ethereum.request({method:'eth_accounts'}).then(accounts=>{if(accounts[0]){state.account=accounts[0];refreshWallet();}}).catch(()=>{}); }
function init(){wireCommon();wireBorrow();wireTestAssets();wireRwa();wireWalletEvents();setMode(false);syncProtocolStatus();}
init();