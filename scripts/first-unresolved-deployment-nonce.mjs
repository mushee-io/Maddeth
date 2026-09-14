import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [journalPath, rpcUrl] = process.argv.slice(2);
if (!journalPath || !rpcUrl) {
  throw new Error('Usage: node scripts/first-unresolved-deployment-nonce.mjs <journal> <rpc-url>');
}

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const txs = [...(journal.transactions || [])].sort(
  (a, b) => Number.parseInt(a.transaction.nonce, 16) - Number.parseInt(b.transaction.nonce, 16)
);

if (txs.length === 0) {
  throw new Error('Deployment journal contains no transactions');
}

for (const tx of txs) {
  const nonce = Number.parseInt(tx.transaction.nonce, 16);
  const hash = tx.hash;

  if (!hash) {
    console.log(nonce);
    process.exit(0);
  }

  const result = spawnSync(
    'cast',
    ['rpc', '--rpc-url', rpcUrl, 'eth_getTransactionReceipt', hash],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to inspect receipt for nonce ${nonce}: ${result.stderr || result.stdout}`);
  }

  const raw = result.stdout.trim();
  if (!raw || raw === 'null') {
    console.log(nonce);
    process.exit(0);
  }

  const receipt = JSON.parse(raw);
  if (receipt.status !== '0x1') {
    throw new Error(`Deployment transaction failed at nonce ${nonce}: ${hash} (status ${receipt.status})`);
  }
}
