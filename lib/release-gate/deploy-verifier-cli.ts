/**
 * Release Gate V2 — Deploy Verifier CLI
 *
 * Post-deploy verification of runtime identity, health, and canary routes.
 *
 * Usage:
 *   npx tsx lib/release-gate/deploy-verifier-cli.ts \
 *     --target-url https://staging.waaiio.com \
 *     --expected-sha abc123... \
 *     --expected-project prj_xxx
 */

import { verifyDeployment } from './deploy-verifier';

function parseArgs(): { targetUrl: string; expectedSha: string; expectedProject: string } {
  const args = process.argv.slice(2);
  let targetUrl = '';
  let expectedSha = '';
  let expectedProject = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target-url' && args[i + 1]) targetUrl = args[++i];
    else if (args[i] === '--expected-sha' && args[i + 1]) expectedSha = args[++i];
    else if (args[i] === '--expected-project' && args[i + 1]) expectedProject = args[++i];
  }

  if (!targetUrl || !expectedSha || !expectedProject) {
    process.stderr.write(
      'Usage: deploy-verifier-cli.ts --target-url <url> --expected-sha <sha> --expected-project <id>\n',
    );
    process.exit(1);
  }

  return { targetUrl, expectedSha, expectedProject };
}

async function main() {
  const { targetUrl, expectedSha, expectedProject } = parseArgs();

  try {
    const result = await verifyDeployment({ targetUrl, expectedSha, expectedProject });

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Deploy Verification');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Target:    ${targetUrl}`);
    console.log(`  Expected:  SHA=${expectedSha.substring(0, 8)} Project=${expectedProject}`);
    console.log(`  Verdict:   ${result.verdict}`);
    console.log(`  Summary:   ${result.summary}`);
    console.log('');

    for (const check of result.checks) {
      const icon = check.status === 'pass' ? '  PASS' : check.status === 'warn' ? '  WARN' : '  FAIL';
      console.log(`  ${icon}  ${check.name}: ${check.detail}`);
    }

    console.log('═══════════════════════════════════════════════════════════');

    process.exit(result.verdict === 'FAIL' ? 1 : 0);
  } catch (err) {
    process.stderr.write(`Deploy verifier failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.includes('deploy-verifier-cli');
if (isDirectRun) {
  main();
}
