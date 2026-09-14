import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [manifestPath = 'deployment-kub-testnet.json', journalPath = 'broadcast/DeployKubTestnet.s.sol/25925/run-latest.json', rpcUrl = 'https://rpc-testnet.bitkubchain.io'] = process.argv.slice(2);

const addressRe = /^0x[0-9a-fA-F]{40}$/;
const lower = (v) => String(v).toLowerCase();

function runCast(args) {
  const result = spawnSync('cast', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`cast ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function firstToken(value) {
  return String(value).trim().split(/\s+/)[0] || '';
}

function outputValues(value) {
  return String(value)
    .trim()
    .split(/\r?\n/)
    .map((line) => firstToken(line))
    .filter(Boolean);
}

function call(address, signature, args = []) {
  return runCast(['call', address, signature, ...args, '--rpc-url', rpcUrl]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert(Number(manifest.chainId) === 25925, `Wrong manifest chain: ${manifest.chainId}`);
assert(addressRe.test(manifest.deployer || ''), 'Invalid deployer in manifest');

const keys = [
  'maddethPool',
  'maddethLens',
  'oracle',
  'interestRateModel',
  'rwaVaultFactory',
  'sampleRwaVault',
  'wrappedKUB',
  'testUSDC',
  'testUSDT'
];
for (const key of keys) assert(addressRe.test(manifest[key] || ''), `Invalid ${key} in manifest`);

const chainId = Number(firstToken(runCast(['chain-id', '--rpc-url', rpcUrl])));
assert(chainId === 25925, `RPC is chain ${chainId}, expected 25925`);

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const txs = [...(journal.transactions || [])].sort(
  (a, b) => Number.parseInt(a.transaction.nonce, 16) - Number.parseInt(b.transaction.nonce, 16)
);
assert(txs.length > 0, 'Deployment journal has no transactions');
for (const tx of txs) {
  const nonce = Number.parseInt(tx.transaction.nonce, 16);
  assert(tx.hash, `Missing deployment transaction hash at nonce ${nonce}`);
  const raw = runCast(['rpc', '--rpc-url', rpcUrl, 'eth_getTransactionReceipt', tx.hash]);
  assert(raw && raw !== 'null', `Missing receipt for deployment nonce ${nonce}`);
  const receipt = JSON.parse(raw);
  assert(receipt.status === '0x1', `Deployment transaction reverted at nonce ${nonce}: ${tx.hash}`);
}
console.log(`Receipts: ${txs.length}/${txs.length} successful`);

for (const key of keys) {
  const code = runCast(['code', manifest[key], '--rpc-url', rpcUrl]);
  assert(code && code !== '0x', `No bytecode at ${key}: ${manifest[key]}`);
}
console.log('Bytecode: all canonical contracts present');

const deployer = manifest.deployer;
const pool = manifest.maddethPool;
const lens = manifest.maddethLens;
const oracle = manifest.oracle;
const factory = manifest.rwaVaultFactory;
const rwa = manifest.sampleRwaVault;
const wtkub = manifest.wrappedKUB;
const usdc = manifest.testUSDC;
const usdt = manifest.testUSDT;
const rate = manifest.interestRateModel;

assert(lower(firstToken(call(pool, 'owner()(address)'))) === lower(deployer), 'MaddethPool owner mismatch');
assert(lower(firstToken(call(oracle, 'owner()(address)'))) === lower(deployer), 'Oracle owner mismatch');
assert(lower(firstToken(call(factory, 'owner()(address)'))) === lower(deployer), 'RWA factory owner mismatch');
assert(lower(firstToken(call(pool, 'oracle()(address)'))) === lower(oracle), 'Pool oracle wiring mismatch');
assert(lower(firstToken(call(lens, 'pool()(address)'))) === lower(pool), 'Lens pool wiring mismatch');
assert(firstToken(call(pool, 'protocolPaused()(bool)')) === 'false', 'Pool is unexpectedly paused');
assert(firstToken(call(pool, 'marketCount()(uint256)')) === '3', 'Expected exactly 3 Maddeth markets');

const expectedAssets = [wtkub, usdc, usdt];
for (let i = 0; i < expectedAssets.length; i += 1) {
  const listed = firstToken(call(pool, 'listedAssets(uint256)(address)', [String(i)]));
  assert(lower(listed) === lower(expectedAssets[i]), `listedAssets(${i}) mismatch`);
}

const wConfig = outputValues(call(pool, 'markets(address)(bool,bool,uint16,uint16,uint16,uint16,uint128,uint128,address)', [wtkub]));
const uConfig = outputValues(call(pool, 'markets(address)(bool,bool,uint16,uint16,uint16,uint16,uint128,uint128,address)', [usdc]));
const tConfig = outputValues(call(pool, 'markets(address)(bool,bool,uint16,uint16,uint16,uint16,uint128,uint128,address)', [usdt]));
for (const [name, cfg] of [['WtKUB', wConfig], ['mUSDC', uConfig], ['mUSDT', tConfig]]) {
  assert(cfg[0] === 'true', `${name} market is not listed`);
  assert(cfg[1] === 'false', `${name} market is paused`);
  assert(lower(cfg[cfg.length - 1]) === lower(rate), `${name} rate model mismatch`);
}

assert(firstToken(call(wtkub, 'decimals()(uint8)')) === '18', 'WtKUB decimals mismatch');
assert(firstToken(call(usdc, 'decimals()(uint8)')) === '6', 'mUSDC decimals mismatch');
assert(firstToken(call(usdt, 'decimals()(uint8)')) === '6', 'mUSDT decimals mismatch');

const seed = 1_000_000n * 1_000_000n;
for (const [name, asset] of [['mUSDC', usdc], ['mUSDT', usdt]]) {
  const cash = BigInt(firstToken(call(asset, 'balanceOf(address)(uint256)', [pool])));
  const totals = outputValues(call(pool, 'marketTotals(address)(uint256,uint256,uint256,uint256)', [asset]));
  const supplied = BigInt(totals[0]);
  const borrowed = BigInt(totals[1]);
  assert(supplied >= seed, `${name} seeded supply missing: ${supplied}`);
  assert(cash + borrowed >= seed, `${name} accounting liquidity below seed: cash=${cash} borrowed=${borrowed}`);
}
console.log('Markets and seeded stable liquidity: OK');

for (const asset of [wtkub, usdc, usdt]) {
  const output = call(oracle, 'getPrice(address)(uint256,uint256)', [asset]);
  const price = BigInt(firstToken(output));
  assert(price > 0n, `Oracle returned zero price for ${asset}`);
}
console.log('Oracle read path: OK');

assert(firstToken(call(factory, 'approvedIssuer(address)(bool)', [deployer])) === 'true', 'Deployer is not an approved RWA issuer');
assert(BigInt(firstToken(call(factory, 'vaultCount()(uint256)'))) >= 1n, 'RWA factory has no vaults');
assert(firstToken(call(factory, 'isVault(address)(bool)', [rwa])) === 'true', 'Sample RWA vault is not registered');
assert(lower(firstToken(call(rwa, 'borrower()(address)'))) === lower(deployer), 'Sample RWA borrower mismatch');
assert(lower(firstToken(call(rwa, 'liquidityAsset()(address)'))) === lower(usdc), 'Sample RWA liquidity asset mismatch');
assert(firstToken(call(rwa, 'fixedAprBps()(uint16)')) === '900', 'Sample RWA APR mismatch');
assert(firstToken(call(rwa, 'allowlistedLender(address)(bool)', [deployer])) === 'true', 'Deployer is not allowlisted on sample RWA vault');
console.log('RWA factory/vault wiring: OK');

console.log('KUB_TESTNET_DEPLOYMENT_VALIDATION=PASS');
