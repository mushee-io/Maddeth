import {
  KUB_TESTNET,
  connectWallet as connectProtocolWallet,
  ensureKubTestnet,
  walletSnapshot,
  liveProtocolSnapshot,
  deploymentReady,
  configuredContract,
  assetConfig,
  formatUnits,
  parseUnits,
  wrapTKUB,
  approvePool,
  supplyToPool,
  setCollateral,
  borrowFromPool,
  waitForReceipt,
  transactionExplorerUrl
} from './protocol.js';

const state = { account: null, chainId: null, sandbox: false, protocol: null, inFlight: false };
const views = ['markets','borrow','rwa','portfolio','protocol'];
const titleMap = {markets:'Markets',borrow:'Borrow',rwa:'RWA Credit',portfolio:'Portfolio',protocol:'Protocol'};

const $ = (id) => document.getElementById(id);

function setView(view){
  if(!views.includes(view)) return;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`${view}View`).classList.add('active');
  $('viewTitle').textContent = titleMap[view];
  $('appSection').scrollIntoView({behavior:'smooth',block:'start'});
}

document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', e => {
  const view = e.currentTarget.dataset.view;
  if(view) setView(view);
}));

function shortAddress(a){ return `${a.slice(0,6)}…${a.slice(-4)}`; }

function ensureTxStatusElement(){
  let el = $('txStatus');
  if(el) return el;
  el = document.createElement('p');
  el.id = 'txStatus';
  el.setAttribute('aria-live','polite');
  el.style.margin = '12px 0 0';
  el.style.fontSize = '12px';
  el.style.lineHeight = '1.5';
  const row = document.querySelector('#borrowView .action-row');
  row?.insertAdjacentElement('afterend', el);
  return el;
}

function setTxStatus(message, txHash = null){
  const el = ensureTxStatusElement();
  if(!el) return;
  el.replaceChildren(document.createTextNode(message));
  if(txHash){
    const link = document.createElement('a');
    link.href = transactionExplorerUrl(txHash);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ' View on KUBScan ↗';
    el.appendChild(link);
  }
}

function setSubmitState(){
  const button = $('submitBorrow');
  if(state.inFlight){
    button.disabled = true;
    button.textContent = 'Transaction in progress…';
    return;
  }
  if(!deploymentReady()){
    button.disabled = true;
    button.textContent = 'Contracts not deployed';
    return;
  }
  if(!state.account){
    button.disabled = true;
    button.textContent = 'Connect wallet to transact';
    return;
  }
  if(state.chainId !== KUB_TESTNET.chainId){
    button.disabled = true;
    button.textContent = 'Switch to KUB Testnet';
    return;
  }
  if(state.sandbox){
    button.disabled = true;
    button.textContent = 'Switch to Live mode to transact';
    return;
  }
  button.disabled = false;
  button.textContent = 'Supply collateral & borrow';
}

async function syncProtocolStatus(){
  if(!deploymentReady()){
    state.protocol = { deployed:false, activeMarkets:0 };
    $('contractStatus').textContent = 'Contracts not deployed/configured on KUB Testnet yet';
    const activeMarkets = document.querySelector('.metrics-row .metric:nth-child(4) strong');
    if(activeMarkets && !state.sandbox) activeMarkets.textContent = '0';
    setSubmitState();
    return;
  }

  try{
    state.protocol = await liveProtocolSnapshot(state.account);
    $('contractStatus').textContent = `Live contracts connected · ${state.protocol.activeMarkets} markets`;
    const activeMarkets = document.querySelector('.metrics-row .metric:nth-child(4) strong');
    if(activeMarkets && !state.sandbox) activeMarkets.textContent = String(state.protocol.activeMarkets);

    if(state.account && state.protocol.accountHealthFactor !== null){
      const hf = state.protocol.accountHealthFactor;
      const maxUint = (1n << 256n) - 1n;
      $('healthFactor').textContent = hf === maxUint ? '∞' : formatUnits(hf, 18, 2);
    }
  }catch(err){
    console.error('Live protocol read failed', err);
    $('contractStatus').textContent = 'Contract addresses configured, but live reads failed closed';
  }
  setSubmitState();
}

async function refreshWallet(){
  if(!window.ethereum || !state.account) return;
  try{
    const snapshot = await walletSnapshot(state.account);
    state.chainId = snapshot.chainId;
    $('networkPill').textContent = state.chainId === KUB_TESTNET.chainId ? 'KUB Testnet' : `Wrong network · ${state.chainId}`;
    $('networkPill').style.borderColor = state.chainId === KUB_TESTNET.chainId ? '#36b89f' : '#ff8a76';
    $('connectWallet').textContent = shortAddress(state.account);
    $('portfolioTitle').textContent = `Portfolio · ${shortAddress(state.account)}`;
    $('portfolioConnect').textContent = 'Wallet connected';
    $('portfolioConnect').disabled = true;

    if(state.chainId === KUB_TESTNET.chainId && snapshot.nativeBalance !== null){
      $('walletBalance').textContent = `${formatUnits(snapshot.nativeBalance, 18, 4)} tKUB`;
      await syncProtocolStatus();
    }else{
      $('walletBalance').textContent = 'Switch to KUB Testnet';
      setSubmitState();
    }
  }catch(err){
    console.error('Wallet refresh failed', err);
  }
}

async function connectWallet(){
  if(!window.ethereum){
    alert('No EVM wallet found. Install a MetaMask-compatible wallet to connect to KUB Testnet.');
    return;
  }
  try{
    state.account = await connectProtocolWallet();
    await refreshWallet();
  }catch(err){
    console.error(err);
    alert(err?.message || 'Wallet connection failed');
  }
}

$('connectWallet').addEventListener('click', connectWallet);
$('portfolioConnect').addEventListener('click', connectWallet);
$('networkPill').addEventListener('click', async () => {
  if(!window.ethereum) return;
  try{
    await ensureKubTestnet();
    await refreshWallet();
  }catch(err){
    console.error(err);
  }
});

if(window.ethereum){
  window.ethereum.on?.('accountsChanged', accounts => {
    state.account = accounts[0] || null;
    if(state.account) refreshWallet();
    else window.location.reload();
  });
  window.ethereum.on?.('chainChanged', () => { if(state.account) refreshWallet(); });
  window.ethereum.request({method:'eth_accounts'}).then(accounts => {
    if(accounts[0]){state.account=accounts[0];refreshWallet();}
  });
}

function setMode(sandbox){
  state.sandbox = sandbox;
  $('sandboxMode').classList.toggle('active',sandbox);
  $('liveMode').classList.toggle('active',!sandbox);
  $('sandboxNotice').classList.toggle('hidden',!sandbox);
  $('liveNotice').classList.toggle('hidden',sandbox);
  document.querySelectorAll('[data-live]').forEach(el => {
    el.textContent = sandbox ? el.dataset.sandbox : el.dataset.live;
  });
  if(!sandbox && state.protocol?.deployed){
    const activeMarkets = document.querySelector('.metrics-row .metric:nth-child(4) strong');
    if(activeMarkets) activeMarkets.textContent = String(state.protocol.activeMarkets);
  }
  updateRisk();
  setSubmitState();
}
$('sandboxMode').addEventListener('click',()=>setMode(true));
$('liveMode').addEventListener('click',async()=>{
  setMode(false);
  await syncProtocolStatus();
});

function numberFromInput(id){
  const v = Number($(id).value.replace(/,/g,''));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function updateRisk(){
  const supply = numberFromInput('supplyAmount');
  const borrow = numberFromInput('borrowAmount');
  if(!state.sandbox || !supply || !borrow){
    $('ltvValue').textContent = '0.00%';
    if(!state.account || !state.protocol?.deployed) $('healthFactor').textContent = '∞';
    $('riskFill').style.width = '0%';
    return;
  }
  // Sandbox-only simplification: inputs are treated as equal USD value to explain mechanics.
  const ltv = Math.min((borrow/supply)*100,150);
  const threshold = 82.5;
  const health = borrow === 0 ? Infinity : (supply*(threshold/100))/borrow;
  $('ltvValue').textContent = `${ltv.toFixed(2)}%`;
  $('healthFactor').textContent = Number.isFinite(health) ? health.toFixed(2) : '∞';
  $('riskFill').style.width = `${Math.min(ltv,100)}%`;
}
$('previewBorrow').addEventListener('click',updateRisk);
$('supplyAmount').addEventListener('input',updateRisk);
$('borrowAmount').addEventListener('input',updateRisk);

const supplySelection = {
  'tKUB': { key:'wrappedKUB', decimals:18, wrapNative:true },
  'Mock USDT': { key:'testUSDT', decimals:6, wrapNative:false }
};
const borrowSelection = {
  'Mock USDT': { key:'testUSDT', decimals:6 },
  'Mock USDC': { key:'testUSDC', decimals:6 }
};

async function confirmStep(label, txPromise){
  setTxStatus(`${label}: waiting for wallet confirmation…`);
  const hash = await txPromise;
  setTxStatus(`${label}: submitted. Waiting for confirmation…`, hash);
  await waitForReceipt(hash);
  setTxStatus(`${label}: confirmed.`, hash);
  return hash;
}

async function executeSupplyBorrowFlow(){
  if(state.inFlight) return;
  if(!deploymentReady()) throw new Error('Maddeth contracts are not configured on KUB Testnet yet');
  if(!state.account) throw new Error('Connect a wallet first');
  if(state.chainId !== KUB_TESTNET.chainId) throw new Error('Switch to KUB Testnet first');
  if(state.sandbox) throw new Error('Transactions are disabled in Sandbox mode');

  const supplyChoice = supplySelection[$('supplyAsset').value];
  const borrowChoice = borrowSelection[$('borrowAsset').value];
  if(!supplyChoice || !borrowChoice) throw new Error('Unsupported asset selection');

  const collateral = assetConfig(supplyChoice.key);
  const debtAsset = assetConfig(borrowChoice.key);
  if(!collateral || !debtAsset) throw new Error('Selected assets are not configured on KUB Testnet');

  const supplyAmount = parseUnits($('supplyAmount').value, supplyChoice.decimals);
  const borrowAmount = parseUnits($('borrowAmount').value, borrowChoice.decimals);
  const pool = configuredContract('maddethPool');
  if(!pool) throw new Error('MaddethPool is not configured');

  state.inFlight = true;
  setSubmitState();
  try{
    if(supplyChoice.wrapNative){
      await confirmStep('Wrap tKUB', wrapTKUB(state.account, supplyAmount));
    }
    await confirmStep('Approve collateral', approvePool(state.account, collateral.address, supplyAmount));
    await confirmStep('Supply collateral', supplyToPool(state.account, collateral.address, supplyAmount));
    await confirmStep('Enable collateral', setCollateral(state.account, collateral.address, true));
    await confirmStep('Borrow asset', borrowFromPool(state.account, debtAsset.address, borrowAmount));
    setTxStatus('Position opened successfully on KUB Testnet. Refreshing live protocol state…');
    await refreshWallet();
    setTxStatus('Position opened successfully on KUB Testnet.');
  }catch(err){
    console.error('Supply/borrow flow failed', err);
    setTxStatus(`Transaction flow stopped: ${err?.message || 'unknown error'}`);
    throw err;
  }finally{
    state.inFlight = false;
    setSubmitState();
  }
}

$('submitBorrow').addEventListener('click', async () => {
  try{
    await executeSupplyBorrowFlow();
  }catch(err){
    if(!String(err?.message || '').includes('rejected')) alert(err?.message || 'Transaction failed');
  }
});

setMode(false);
syncProtocolStatus();
