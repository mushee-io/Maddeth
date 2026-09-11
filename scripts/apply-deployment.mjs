import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = process.argv[2] || path.join(root, 'deployment-kub-testnet.json');
if (!fs.existsSync(manifestPath)) throw new Error(`Deployment manifest not found: ${manifestPath}`);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (Number(manifest.chainId) !== 25925) throw new Error(`Refusing non-KUB-Testnet manifest: chain ${manifest.chainId}`);

const contractKeys = [
  'maddethPool',
  'maddethLens',
  'oracle',
  'interestRateModel',
  'rwaVaultFactory',
  'sampleRwaVault',
  'wrappedKUB',
  'testUSDT',
  'testUSDC'
];

for (const key of contractKeys) {
  const value = manifest[key];
  if (!/^0x[0-9a-fA-F]{40}$/.test(value || '')) throw new Error(`Missing/invalid ${key} in deployment manifest`);
}

const jsPath = path.join(root, 'src', 'protocol-config.js');
let source = fs.readFileSync(jsPath, 'utf8');
for (const key of contractKeys) {
  const pattern = new RegExp(`(${key}\\s*:\\s*)(?:null|'0x[0-9a-fA-F]{40}')`);
  if (!pattern.test(source)) throw new Error(`Could not locate ${key} in protocol-config.js`);
  source = source.replace(pattern, `$1'${manifest[key]}'`);
}
fs.writeFileSync(jsPath, source);

const configPath = path.join(root, 'config', 'kub-testnet.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.deploymentStatus = 'deployed';
config.deploymentBlock = Number(manifest.blockNumber || 0);
config.deployer = manifest.deployer || null;
config.deployedAt = Number(manifest.generatedAt || 0);
for (const key of contractKeys) config.contracts[key] = manifest[key];
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Applied KUB Testnet deployment at block ${config.deploymentBlock || 'unknown'}.`);
for (const key of contractKeys) console.log(`${key}=${manifest[key]}`);
