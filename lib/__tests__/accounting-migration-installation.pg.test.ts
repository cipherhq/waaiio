import { beforeAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// Mandatory local proof: absent/non-local database fails, never silently skips.
const names = [
  "existing refund behavior is preserved before preparation",
  "preparation preserves existing public finalizer and inert hold state",
  "installer is owner-only and cannot be called by any application role",
  "installation retains exact recurring precursor variant",
  "unbound actor/approval aborts without partial enrollment",
  "new unresolved business outside reviewed domain fails completeness",
  "missing environment and stale catalog bindings fail closed",
  "unknown recurring body fails and rolls back enrollment",
  "post-enrollment failure restores all functions, guards, index and enrollment atomically",
  "full composition passes catalog source ACL and enrollment checks",
  "service role reads holds and denied ordinary roles cannot call financial RPCs",
  "flutterwave recurring finalizer and replay work under the complete active guard set",
  "stripe recurring finalizer and replay work under the complete active guard set",
  "paystack recurring finalizer and replay work under the complete active guard set",
  "clean manual confirmation and strict linked refund remain compatible",
  "connected direct fee refund creates no platform-held adjustment",
  "final rejection guard preserves approved manual authority and allows pending cancellation",
  "enrolled refund creates one deferred journal with idempotent replay",
  "held new outgoing authority remains denied",
  "actual prior claim can record provider truth after a simulated audited release and refund rehold",
  "repeat cutover fails closed without ledger fiction"
] as const;
for (const variant of ['legacy', 'canonical']) describe(`accounting installation: ${variant}`, () => {
 let report: { results: {name: string; status: string; error?: string}[] };
 beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'accounting-proof-'));
  try {
   const file=join(dir,'report.json');
   try { execFileSync(process.execPath,[resolve('lib/__tests__/fixtures/accounting-install-harness.cjs')], {env:{...process.env,ACCOUNTING_TEST_VARIANT:variant,ACCOUNTING_TEST_REPORT:file},timeout:120000,stdio:'pipe'}); }
   catch(error) { if (!readFileSync(file,'utf8')) throw error; }
   report=JSON.parse(readFileSync(file,'utf8'));
  } finally { rmSync(dir,{recursive:true,force:true}); }
 }, 130000);
 for(const name of names) it(name, () => { const result=report.results.find(x=>x.name===name); expect(result, name).toBeDefined(); expect(result?.status, result?.error).toBe('passed'); });
});
