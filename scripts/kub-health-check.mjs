import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('config/kub-testnet.json', 'utf8'));
const rpcUrl = registry.rpcUrl;
if (!rpcUrl) throw new Error('KUB RPC missing from canonical registry');
let id = 1;

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params })
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `${method} failed`);
  return payload.result;
}

async function selector(signature) {
  const hex = `0x${Buffer.from(signature, 'utf8').toString('hex')}`;
  const hash = await rpc('web3_sha3', [hex]);
  return hash.slice(0, 10);
}

async function call(address, signature) {
  return rpc('eth_call', [{ to: address, data: await selector(signature) }, 'latest']);
}

function uintWord(hex) {
  return BigInt(hex || '0x0');
}

function addressWord(hex) {
  const body = String(hex || '0x').replace(/^0x/, '').padStart(64, '0');
  return `0x${body.slice(-40)}`;
}

function short(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

if (registry.chainId !== 25925 || registry.deploymentStatus !== 'deployed') throw new Error('Registry is not the validated KUB Testnet deployment');
const blockHex = await rpc('eth_blockNumber');
const chainHex = await rpc('eth_chainId');
if (Number(BigInt(chainHex)) !== 25925) throw new Error(`RPC chain mismatch: ${Number(BigInt(chainHex))}`);

const contractEntries = Object.entries(registry.contracts || {});
const missingCode = [];
for (const [name, address] of contractEntries) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) throw new Error(`Invalid address in registry: ${name}`);
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (!code || code === '0x' || code === '0x0') missingCode.push(name);
}
if (missingCode.length) throw new Error(`Missing bytecode: ${missingCode.join(', ')}`);

const pool = registry.contracts.maddethPool;
const [ownerHex, riskAdminHex, oracleHex, marketCountHex, pausedHex] = await Promise.all([
  call(pool, 'owner()'),
  call(pool, 'riskAdmin()'),
  call(pool, 'oracle()'),
  call(pool, 'marketCount()'),
  call(pool, 'protocolPaused()')
]);
const owner = addressWord(ownerHex);
const riskAdmin = addressWord(riskAdminHex);
const oracle = addressWord(oracleHex);
const marketCount = Number(uintWord(marketCountHex));
const protocolPaused = uintWord(pausedHex) !== 0n;

if (oracle.toLowerCase() !== registry.contracts.oracle.toLowerCase()) throw new Error(`Pool oracle mismatch: ${oracle}`);
if (marketCount !== 3) throw new Error(`Unexpected canonical market count: ${marketCount}`);

const report = {
  ok: true,
  network: registry.name,
  chainId: 25925,
  block: Number(BigInt(blockHex)),
  contractsWithCode: contractEntries.length,
  marketCount,
  protocolPaused,
  owner,
  riskAdmin,
  oracle,
  pool,
  explorer: registry.explorer,
  summary: `${contractEntries.length} contracts · ${marketCount} markets · owner ${short(owner)} · risk admin ${short(riskAdmin)} · ${protocolPaused ? 'PAUSED' : 'OPEN'}`
};
console.log(JSON.stringify(report, null, 2));
