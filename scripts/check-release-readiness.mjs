import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'config/kub-testnet.json',
  'config/readiness.json',
  'test/Phase4StressReadiness.t.sol',
  'test/RwaHardening.t.sol',
  'test/Phase3RiskResilience.t.sol',
  'test/LiquidationEngine.t.sol',
  'test/MaddethPoolInvariant.t.sol',
  'docs/OPERATIONS_RUNBOOK.md',
  'docs/FINAL_READINESS.md',
  'docs/AUDIT_SCOPE.md',
  'app/readiness/index.html',
  'src/readiness.js'
];
for (const file of requiredFiles) if (!existsSync(file)) throw new Error(`Release readiness file missing: ${file}`);

const kub = JSON.parse(readFileSync('config/kub-testnet.json', 'utf8'));
if (kub.chainId !== 25925) throw new Error(`Unexpected KUB Testnet chainId: ${kub.chainId}`);
if (kub.deploymentStatus !== 'deployed') throw new Error('KUB Testnet deployment registry is not marked deployed');
if (!Number.isInteger(kub.deploymentBlock) || kub.deploymentBlock <= 0) throw new Error('Deployment block missing');
if (!/^0x[0-9a-fA-F]{40}$/.test(String(kub.deployer || ''))) throw new Error('Validated deployer address missing');
const contractKeys = ['maddethPool','maddethLens','oracle','interestRateModel','rwaVaultFactory','sampleRwaVault','wrappedKUB','testUSDT','testUSDC'];
for (const key of contractKeys) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(kub.contracts?.[key] || ''))) throw new Error(`Invalid canonical contract address: ${key}`);
}

const matrix = JSON.parse(readFileSync('config/readiness.json', 'utf8'));
if (matrix.chainId !== 25925 || matrix.releaseStage !== 'testnet-readiness') throw new Error('Readiness matrix must remain scoped to KUB Testnet');
const codeIds = new Set((matrix.codeEvidence || []).map(item => item.id));
for (const id of ['supply','borrow','repay','withdraw','collateral','liquidation','bad-debt','oracle','admin','rwa','stress','ci','slither']) {
  if (!codeIds.has(id)) throw new Error(`Readiness evidence missing: ${id}`);
}
const gates = matrix.externalGates || [];
for (const id of ['audit','production-oracles','governance','mainnet-assets','legal-rwa']) {
  const gate = gates.find(item => item.id === id);
  if (!gate || gate.status !== 'pending' || gate.blockingMainnet !== true) throw new Error(`External gate must remain pending/blocking until independently completed: ${id}`);
}
if (!matrix.policy?.neverTreatTestnetEvidenceAsIndependentAudit) throw new Error('Audit safety boundary missing from readiness policy');

const stress = readFileSync('test/Phase4StressReadiness.t.sol', 'utf8');
for (const marker of ['testManyBorrowersCanDriveUtilisationNearOneWithoutBreakingAccounting','testTwoIndependentLiquidatorsCanSequentiallyRestoreHealth','testCollateralExhaustionThenBadDebtSocialisationPreservesAccounting','testProtocolPauseDuringActiveDebtBlocksRiskIncreaseButAllowsRepair','testReserveWithdrawalCannotExceedAccruedReserves']) {
  if (!stress.includes(marker)) throw new Error(`Phase 4 stress coverage missing: ${marker}`);
}
const rwa = readFileSync('test/RwaHardening.t.sol', 'utf8');
for (const marker of ['testRevokedLenderCannotAddCapitalButKeepsExistingClaim','testMaturityStopsNewCapitalAndNewBorrowButAllowsRepaymentAndExit','testDefaultLifecycleRequiresMaturityAndOwnerRecoveryAfterCure','testFactoryIssuerRevocationAndEmergencyStop']) {
  if (!rwa.includes(marker)) throw new Error(`RWA hardening coverage missing: ${marker}`);
}

const readinessJs = readFileSync('src/readiness.js', 'utf8');
if (!/eth_getCode/.test(readinessJs)) throw new Error('Readiness dashboard must verify deployed bytecode');
if (!/priceUpdatedAt/.test(readinessJs)) throw new Error('Readiness dashboard must check oracle freshness');
if (!/externalGates/.test(readinessJs)) throw new Error('Readiness dashboard must display external gates');

console.log(`Release readiness integrity PASS · ${contractKeys.length} canonical contracts · ${matrix.codeEvidence.length} evidence checks · ${gates.length} external gates`);
