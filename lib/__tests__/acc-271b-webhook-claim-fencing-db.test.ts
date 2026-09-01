/**
 * #271 Slice B: Webhook claim/reclaim/fencing — real PostgreSQL proofs.
 *
 * Uses psql via execSync against TEST_DATABASE_URL.
 * Skips gracefully in normal CI (no TEST_DATABASE_URL set).
 *
 * Refs: #278, #271
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('Slice B — webhook claim/reclaim/fencing (real PostgreSQL) — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  const fullSql = role ? `SET ROLE ${role};\n${sql}` : sql;
  try {
    let stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    stdout = stdout.trim();
    if (role && stdout.startsWith('SET\n')) stdout = stdout.slice(4).trim();
    else if (role && stdout === 'SET') stdout = '';
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || '', exitCode: err.status || 1 };
  }
}

function callRpc(sql: string, role?: string) {
  const r = runSQL(sql, role);
  if (r.exitCode !== 0) return { result: {} as Record<string, unknown>, raw: r.stderr || r.stdout, exitCode: r.exitCode };
  try {
    const lines = r.stdout.split('\n');
    const jsonLine = lines.find(l => l.startsWith('{')) || r.stdout;
    return { result: JSON.parse(jsonLine) as Record<string, unknown>, raw: r.stdout, exitCode: 0 };
  } catch {
    return { result: {} as Record<string, unknown>, raw: r.stdout, exitCode: 0 };
  }
}

const TEST_PREFIX = 'test-271b-';
let testCounter = 0;
function uniqueEventId() {
  return `${TEST_PREFIX}${Date.now()}-${++testCounter}`;
}

describe('Slice B — webhook claim/reclaim/fencing (real PostgreSQL)', () => {
  beforeEach(() => {
    // Clean up test rows from previous runs
    runSQL(`DELETE FROM public.processed_webhook_events WHERE event_id LIKE '${TEST_PREFIX}%';`);
  });

  it('a) first claim succeeds — returns claimed=true with UUID claim_token', () => {
    const eid = uniqueEventId();
    const { result } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    expect(result.claimed).toBe(true);
    expect(result.claim_token).toBeDefined();
    expect(typeof result.claim_token).toBe('string');
    // UUID format: 8-4-4-4-12 hex
    expect(result.claim_token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('b) duplicate claim returns active_processing', () => {
    const eid = uniqueEventId();
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    const { result } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('active_processing');
  });

  it('c) completed event cannot be reclaimed — already_completed', () => {
    const eid = uniqueEventId();
    const { result: claim } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    // Complete it
    callRpc(`SELECT public.complete_webhook_event('${eid}', '${claim.claim_token}'::uuid);`);
    // Try to reclaim
    const { result } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('already_completed');
  });

  it('d) failed event CAN be reclaimed — claimed=true with new token', () => {
    const eid = uniqueEventId();
    const { result: claim1 } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    // Fail it
    callRpc(`SELECT public.fail_webhook_event('${eid}', '${claim1.claim_token}'::uuid, 'test error');`);
    // Reclaim
    const { result: claim2 } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    expect(claim2.claimed).toBe(true);
    expect(claim2.claim_token).toBeDefined();
    expect(claim2.claim_token).not.toBe(claim1.claim_token);
  });

  it('e) complete with wrong token fails — returns false', () => {
    const eid = uniqueEventId();
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    const wrongToken = '00000000-0000-0000-0000-000000000000';
    const { result, raw } = callRpc(
      `SELECT public.complete_webhook_event('${eid}', '${wrongToken}'::uuid);`,
    );
    // Result is a bare boolean 'f' from psql
    const completed = raw === 't' || result === true;
    expect(completed).toBe(false);
  });

  it('f) fail with wrong token fails — returns false', () => {
    const eid = uniqueEventId();
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    const wrongToken = '00000000-0000-0000-0000-000000000000';
    const { result, raw } = callRpc(
      `SELECT public.fail_webhook_event('${eid}', '${wrongToken}'::uuid, 'nope');`,
    );
    const failed = raw === 't' || result === true;
    expect(failed).toBe(false);
  });

  it('g) complete with correct token succeeds — returns true, status=completed', () => {
    const eid = uniqueEventId();
    const { result: claim } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    const { raw } = callRpc(
      `SELECT public.complete_webhook_event('${eid}', '${claim.claim_token}'::uuid);`,
    );
    expect(raw).toBe('t');
    // Verify status in DB
    const { stdout } = runSQL(
      `SELECT status FROM public.processed_webhook_events WHERE event_id = '${eid}';`,
    );
    expect(stdout).toBe('completed');
  });

  it('h) old worker cannot complete after reclaim — stale token rejected', () => {
    const eid = uniqueEventId();
    // Worker A claims
    const { result: claimA } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    const tokenA = claimA.claim_token;

    // Simulate stale: backdate last_attempted_at by 2 minutes
    runSQL(`UPDATE public.processed_webhook_events SET last_attempted_at = NOW() - INTERVAL '2 minutes' WHERE event_id = '${eid}';`);

    // Worker B reclaims (stale processing)
    const { result: claimB } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );
    expect(claimB.claimed).toBe(true);
    expect(claimB.claim_token).not.toBe(tokenA);

    // Worker A tries to complete with old token — should fail
    const { raw } = callRpc(
      `SELECT public.complete_webhook_event('${eid}', '${tokenA}'::uuid);`,
    );
    expect(raw).toBe('f');

    // Worker B can still complete with new token
    const { raw: rawB } = callRpc(
      `SELECT public.complete_webhook_event('${eid}', '${claimB.claim_token}'::uuid);`,
    );
    expect(rawB).toBe('t');
  });

  it('i) ACL: anon cannot claim — permission denied', () => {
    const eid = uniqueEventId();
    const { exitCode, stderr } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      'anon',
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/permission denied/i);
  });

  it('j) ACL: authenticated cannot claim — permission denied', () => {
    const eid = uniqueEventId();
    const { exitCode, stderr } = callRpc(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      'authenticated',
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/permission denied/i);
  });
});

} // end if dbUrl
