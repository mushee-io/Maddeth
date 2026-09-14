import { readFileSync, writeFileSync } from 'node:fs';

const sourcePath = process.argv[2] || 'deployment-kub-liquidation-lab.json';
const targetPath = process.argv[3] || 'config/kub-liquidation-lab.json';
const deployment = JSON.parse(readFileSync(sourcePath, 'utf8'));
const registry = JSON.parse(readFileSync(targetPath, 'utf8'));

const addressKeys = ['pool', 'lens', 'oracle', 'rateModel', 'labKUB', 'labUSDC'];
const isAddress = value => /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));

if (Number(deployment.chainId) !== 25925) throw new Error(`Unexpected chainId ${deployment.chainId}`);
for (const key of addressKeys) {
  if (!isAddress(deployment[key])) throw new Error(`Invalid ${key} address: ${deployment[key]}`);
}
if (!isAddress(deployment.deployer)) throw new Error(`Invalid deployer: ${deployment.deployer}`);
if (!Number.isInteger(Number(deployment.deploymentBlock)) || Number(deployment.deploymentBlock) <= 0) {
  throw new Error('Invalid deploymentBlock');
}

registry.deploymentStatus = 'deployed';
registry.contracts = Object.fromEntries(addressKeys.map(key => [key, deployment[key]]));
registry.deploymentBlock = Number(deployment.deploymentBlock);
registry.deployer = deployment.deployer;
registry.deployedAt = Number(deployment.deployedAt);

writeFileSync(targetPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Applied liquidation lab deployment from ${sourcePath} -> ${targetPath}`);
