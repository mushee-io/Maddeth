import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('config/kub-testnet.json', 'utf8'));
const rpcUrl = registry.rpcUrl;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const RPC_TIMEOUT_MS = 12_000;
if (!rpcUrl || !/^https:\/\//i.test(rpcUrl)) throw new Error('KUB RPC missing or not HTTPS in canonical registry');
let id = 1;

async function rpc(method, params = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || `${method} failed`);
    if (payload.result === undefined || payload.result === null) throw new Error(`${method} returned no result`);
    return payload.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function selector(signature) {
  const hex = `0x${Buffer.from(signature, 'utf8').toString('hex')}`;
  const hash = await rpc('web3_sha3', [hex]);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`Invalid selector hash for ${signature}`);
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

function validAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(address || ''));
}

function isZeroAddress(address) {
  return String(address || '').toLowerCase() === ZERO_ADDRESS;
}

function short(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

if (registry.chainId !== 25925 || registry.deploymentStatus !== 'deployed') throw new Error('Registry is not the validated KUB Testnet deployment');
if (!Number.isInteger(registry.deploymentBlock) || registry.deploymentBlock <= 0) throw new Error('Canonical deployment block is invalid');
if (!validAddress(registry.deployer) || isZeroAddress(registry.deployer)) throw new Error('Canonical deployer is invalid');

const blockHex = await rpc('eth_blockNumber');
const chainHex = await rpc('eth_chainId');
const currentBlock = Number(BigInt(blockHex));
if (!Number.isSafeInteger(currentBlock)) throw new Error('RPC returned an unsafe block number');
if (Number(BigInt(chainHex)) !== 25925) throw new Error(`RPC chain mismatch: ${Number(BigInt(chainHex))}`);
if (currentBlock < registry.deploymentBlock) throw new Error(`RPC head ${currentBlock} predates deployment block ${registry.deploymentBlock}`);

const contractEntries = Object.entries(registry.contracts || {});
if (contractEntries.length !== 9) throw new Error(`Unexpected canonical contract registry size: ${contractEntries.length}`);
const missingCode = [];
for (const [name, address] of contractEntries) {
  if (!validAddress(address) || isZeroAddress(address)) throw new Error(`Invalid address in registry: ${name}`);
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (!code || code === '0x' || code === '0x0') missingCode.push(name);
}
if (missingCode.length) throw new Error(`Missing bytecode: ${missingCode.join(', ')}`);

const feedEntries = Object.entries(registry.oracleFeeds || {});
if (feedEntries.length < 2) throw new Error('Canonical oracle feed registry is incomplete');
const missingFeedCode = [];
for (const [name, address] of feedEntries) {
  if (!validAddress(address) || isZeroAddress(address)) throw new Error(`Invalid oracle feed address: ${name}`);
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (!code || code === '0x' || code === '0x0') missingFeedCode.push(name);
}
if (missingFeedCode.length) throw new Error(`Missing oracle feed bytecode: ${missingFeedCode.join(', ')}`);

const pool = registry.contracts.maddethPool;
const lens = registry.contracts.maddethLens;
const [ownerHex, riskAdminHex, oracleHex, marketCountHex, pausedHex, lensPoolHex] = await Promise.all([
  call(pool, 'owner()'),
  call(pool, 'riskAdmin()'),
  call(pool, 'oracle()'),
  call(pool, 'marketCount()'),
  call(pool, 'protocolPaused()'),
  call(lens, 'pool()')
]);
const owner = addressWord(ownerHex);
const riskAdmin = addressWord(riskAdminHex);
const oracle = addressWord(oracleHex);
const lensPool = addressWord(lensPoolHex);
const marketCount = Number(uintWord(marketCountHex));
const protocolPaused = uintWord(pausedHex) !== 0n;

if (!validAddress(owner) || isZeroAddress(owner)) throw new Error('Pool owner is zero or invalid');
if (!validAddress(riskAdmin) || isZeroAddress(riskAdmin)) throw new Error('Pool risk admin is zero or invalid');
if (oracle.toLowerCase() !== registry.contracts.oracle.toLowerCase()) throw new Error(`Pool oracle mismatch: ${oracle}`);
if (lensPool.toLowerCase() !== pool.toLowerCase()) throw new Error(`Lens pool mismatch: ${lensPool}`);
if (marketCount !== 3) throw new Error(`Unexpected canonical market count: ${marketCount}`);
if (protocolPaused) throw new Error('Canonical protocol is paused; final readiness must fail closed');

const report = {
  ok: true,
  network: registry.name,
  chainId: 25925,
  block: currentBlock,
  deploymentBlock: registry.deploymentBlock,
  confirmationsSinceDeployment: currentBlock - registry.deploymentBlock,
  contractsWithCode: contractEntries.length,
  oracleFeedsWithCode: feedEntries.length,
  marketCount,
  protocolPaused,
  owner,
  riskAdmin,
  oracle,
  pool,
  lens,
  explorer: registry.explorer,
  summary: `${contractEntries.length} contracts · ${feedEntries.length} feeds · ${marketCount} markets · owner ${short(owner)} · risk admin ${short(riskAdmin)} · OPEN`
};
console.log(JSON.stringify(report, null, 2));
