import fs from 'node:fs';
import path from 'node:path';

const manifestPath = process.argv[2] || 'deployment-kub-testnet.json';
const envPath = process.argv[3] || process.env.GITHUB_ENV;

if (!envPath) throw new Error('Missing GITHUB_ENV/output path');
if (!fs.existsSync(manifestPath)) throw new Error(`Deployment manifest not found: ${manifestPath}`);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (Number(manifest.chainId) !== 25925) {
  throw new Error(`Refusing non-KUB-Testnet manifest: chain ${manifest.chainId}`);
}

const mapping = {
  DEPLOYMENT_DEPLOYER: 'deployer',
  MADDETH_POOL: 'maddethPool',
  MADDETH_LENS: 'maddethLens',
  ORACLE: 'oracle',
  INTEREST_RATE_MODEL: 'interestRateModel',
  RWA_FACTORY: 'rwaVaultFactory',
  SAMPLE_RWA: 'sampleRwaVault',
  WRAPPED_KUB: 'wrappedKUB',
  TEST_USDC: 'testUSDC',
  TEST_USDT: 'testUSDT'
};

const lines = [];
for (const [envKey, manifestKey] of Object.entries(mapping)) {
  const value = manifest[manifestKey];
  if (!/^0x[0-9a-fA-F]{40}$/.test(value || '')) {
    throw new Error(`Missing/invalid ${manifestKey} in ${path.basename(manifestPath)}`);
  }
  lines.push(`${envKey}=${value}`);
}

fs.appendFileSync(envPath, `${lines.join('\n')}\n`);
console.log(`Loaded ${lines.length} KUB Testnet deployment addresses from ${manifestPath}.`);
