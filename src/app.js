const KUB_TESTNET = {
  chainIdHex: '0x6545',
  chainId: 25925,
  chainName: 'KUB Testnet',
  nativeCurrency: { name: 'Test KUB', symbol: 'tKUB', decimals: 18 },
  rpcUrls: ['https://rpc-testnet.bitkubchain.io'],
  blockExplorerUrls: ['https://testnet.kubscan.com']
};

const state = { account: null, chainId: null, sandbox: false };
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
function hexToDecimal(hex){ return parseInt(hex,16); }
function formatEth(hex){
  const n = BigInt(hex || '0x0');
  const whole = n / 10n**18n;
  const frac = (n % 10n**18n).toString().padStart(18,'0').slice(0,4).replace(/0+$/,'');
  return `${whole}${frac ? '.'+frac : ''}`;
}

async function ensureKubTestnet(){
  if(!window.ethereum) throw new Error('No EVM wallet detected');
  try{
    await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:KUB_TESTNET.chainIdHex}]});
  }catch(err){
    if(err && err.code === 4902){
      await window.ethereum.request({method:'wallet_addEthereumChain',params:[KUB_TESTNET]});
    } else { throw err; }
  }
}

async function refreshWallet(){
  if(!window.ethereum || !state.account) return;
  const chainHex = await window.ethereum.request({method:'eth_chainId'});
  state.chainId = hexToDecimal(chainHex);
  $('networkPill').textContent = state.chainId === KUB_TESTNET.chainId ? 'KUB Testnet' : `Wrong network · ${state.chainId}`;
  $('networkPill').style.borderColor = state.chainId === KUB_TESTNET.chainId ? '#36b89f' : '#ff8a76';
  $('connectWallet').textContent = shortAddress(state.account);
  $('portfolioTitle').textContent = `Portfolio · ${shortAddress(state.account)}`;
  $('portfolioConnect').textContent = 'Wallet connected';
  $('portfolioConnect').disabled = true;
  if(state.chainId === KUB_TESTNET.chainId){
    const balance = await window.ethereum.request({method:'eth_getBalance',params:[state.account,'latest']});
    $('walletBalance').textContent = `${formatEth(balance)} tKUB`;
  }else{
    $('walletBalance').textContent = 'Switch to KUB Testnet';
  }
}

async function connectWallet(){
  if(!window.ethereum){
    alert('No EVM wallet found. Install a MetaMask-compatible wallet to connect to KUB Testnet.');
    return;
  }
  try{
    const accounts = await window.ethereum.request({method:'eth_requestAccounts'});
    state.account = accounts[0];
    await ensureKubTestnet();
    await refreshWallet();
  }catch(err){
    console.error(err);
    alert(err?.message || 'Wallet connection failed');
  }
}

$('connectWallet').addEventListener('click', connectWallet);
$('portfolioConnect').addEventListener('click', connectWallet);

if(window.ethereum){
  window.ethereum.on?.('accountsChanged', accounts => { state.account = accounts[0] || null; if(state.account) refreshWallet(); });
  window.ethereum.on?.('chainChanged', () => { if(state.account) refreshWallet(); });
  window.ethereum.request({method:'eth_accounts'}).then(accounts => { if(accounts[0]){state.account=accounts[0];refreshWallet();} });
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
  updateRisk();
}
$('sandboxMode').addEventListener('click',()=>setMode(true));
$('liveMode').addEventListener('click',()=>setMode(false));

function numberFromInput(id){
  const v = Number($(id).value.replace(/,/g,''));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function updateRisk(){
  const supply = numberFromInput('supplyAmount');
  const borrow = numberFromInput('borrowAmount');
  if(!state.sandbox || !supply || !borrow){
    $('ltvValue').textContent = '0.00%';
    $('healthFactor').textContent = '∞';
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
setMode(false);
