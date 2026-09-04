/**
 * Admin production browser bootstrap verifier (#292)
 *
 * Headless Chromium smoke test that proves admin.waaiio.com (or a
 * supplied URL) can initialize the SPA without Supabase/runtime errors.
 *
 * Committed and testable — no /tmp ESM dependency-resolution assumptions.
 * Browser dependency is explicit via admin/package.json playwright dep.
 *
 * Usage:
 *   node admin/scripts/verify-production.mjs [url]
 *
 * Exit codes:
 *   0 = healthy (SPA mounted, no Supabase init errors)
 *   1 = unhealthy (crash, blank page, Supabase error, timeout)
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'https://admin.waaiio.com';
const TIMEOUT = 15_000;
const MOUNT_TIMEOUT = 10_000;

const SUPABASE_CRASH_PATTERNS = [
  'Invalid supabaseUrl',
  'supabaseUrl is required',
  'supabaseUrl: Must be a valid',
  'supabaseUrl: Provided URL is malformed',
];

async function verify() {
  console.log(`Verifying ${url} ...`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') errors.push(entry.text());
  });

  try {
    // 1. Load the page
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    if (!response) {
      console.error('FAIL: No response from server');
      process.exit(1);
    }
    if (response.status() !== 200) {
      console.error(`FAIL: HTTP ${response.status()}`);
      process.exit(1);
    }
    console.log('  HTTP 200');

    // 2. Wait for SPA mount
    await page.waitForSelector('#root > *', { timeout: MOUNT_TIMEOUT });
    console.log('  SPA mounted (#root has children)');

    // 3. Check for Supabase initialization crashes
    const supabaseErrors = errors.filter(e =>
      SUPABASE_CRASH_PATTERNS.some(p => e.includes(p))
    );
    if (supabaseErrors.length > 0) {
      console.error('FAIL: Supabase initialization error(s):');
      supabaseErrors.forEach(e => console.error('  ' + e));
      process.exit(1);
    }
    console.log('  No Supabase init errors');

    // 4. Verify meaningful content rendered
    const contentLength = await page.evaluate(() => {
      const root = document.getElementById('root');
      return root ? root.innerHTML.length : 0;
    });
    if (contentLength < 100) {
      console.error(`FAIL: SPA root has minimal content (${contentLength} chars)`);
      process.exit(1);
    }
    console.log(`  Content rendered (${contentLength} chars)`);

    // 5. Report non-critical console errors for visibility
    const nonCritical = errors.filter(e =>
      !SUPABASE_CRASH_PATTERNS.some(p => e.includes(p))
    );
    if (nonCritical.length > 0) {
      console.log(`  Note: ${nonCritical.length} non-critical console error(s)`);
    }

    console.log('PASS: Bootstrap smoke healthy');
  } finally {
    await browser.close();
  }
}

verify().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
