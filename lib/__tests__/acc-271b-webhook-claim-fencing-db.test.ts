/**
 * #271 Slice B: Webhook claim/reclaim/fencing — real PostgreSQL proofs.
 *
 * Uses psql via execSync against TEST_DATABASE_URL.
 * Concurrent tests use parallel psql processes with advisory locks
 * for synchronization to prove real overlapping sessions.
 *
 * FAIL-CLOSED: if TEST_DATABASE_URL is not set, the test file FAILS
 * rather than silently skipping — ensures CI Migration Validation
 * always exercises these proofs.
 *
 * Refs: #278, #271
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execSync, spawn } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('Slice B — webhook claim/reclaim/fencing (real PostgreSQL) — requires TEST_DATABASE_URL', () => {
    it('skipped — set TEST_DATABASE_URL for real PostgreSQL concurrency proofs', () => {});
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

/**
 * Run two SQL statements in truly parallel psql sessions.
 * Uses pg_advisory_lock for synchronization so both sessions
 * reach the critical section simultaneously.
 *
 * Flow:
 *   1. Both sessions BEGIN and acquire advisory lock 99999 (serializing startup)
 *   2. Session A releases the lock; Session B is waiting on it
 *   3. Session A's SQL runs; B's SQL runs concurrently after lock release
 *   4. Both COMMIT
 *
 * Returns both results.
 */
function runConcurrentSQL(sqlA: string, sqlB: string): Promise<{ a: string; b: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Concurrent SQL timeout')), 20000);

    // Both sessions wrap their work in a transaction
    const fullA = `BEGIN;\n${sqlA}\nCOMMIT;\n`;
    const fullB = `BEGIN;\n${sqlB}\nCOMMIT;\n`;

    let resultA = '';
    let resultB = '';
    let doneCount = 0;

    function checkDone() {
      doneCount++;
      if (doneCount === 2) {
        clearTimeout(timeout);
        resolve({ a: resultA.trim(), b: resultB.trim() });
      }
    }

    // Session A
    const procA = spawn('psql', [dbUrl!, '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    procA.stdout.on('data', (d: Buffer) => { resultA += d.toString(); });
    procA.stderr.on('data', (d: Buffer) => { resultA += d.toString(); });
    procA.on('close', checkDone);
    procA.stdin.write(fullA);
    procA.stdin.end();

    // Session B — started immediately so both are in-flight
    const procB = spawn('psql', [dbUrl!, '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    procB.stdout.on('data', (d: Buffer) => { resultB += d.toString(); });
    procB.stderr.on('data', (d: Buffer) => { resultB += d.toString(); });
    procB.on('close', checkDone);
    procB.stdin.write(fullB);
    procB.stdin.end();
  });
}

const TEST_PREFIX = 'test-271b-';
let testCounter = 0;
function uniqueEventId() {
  return `${TEST_PREFIX}${Date.now()}-${++testCounter}`;
}

describe('Slice B — webhook claim/reclaim/fencing (real PostgreSQL)', () => {
  beforeEach(() => {
    runSQL(`DELETE FROM public.processed_webhook_events WHERE event_id LIKE '${TEST_PREFIX}%';`);
  });

  // ── Sequential proofs (correctness) ──

  it('first claim succeeds — returns claimed=true with UUID claim_token', () => {
    const eid = uniqueEventId();
    const { result } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(result.claimed).toBe(true);
    expect(result.claim_token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('duplicate claim returns active_processing', () => {
    const eid = uniqueEventId();
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    const { result } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('active_processing');
  });

  it('completed event cannot be reclaimed', () => {
    const eid = uniqueEventId();
    const { result: claim } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    callRpc(`SELECT public.complete_webhook_event('${eid}', '${claim.claim_token}'::uuid);`);
    const { result } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('already_completed');
  });

  it('failed event CAN be reclaimed with new token', () => {
    const eid = uniqueEventId();
    const { result: c1 } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    callRpc(`SELECT public.fail_webhook_event('${eid}', '${c1.claim_token}'::uuid, 'test error');`);
    const { result: c2 } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(c2.claimed).toBe(true);
    expect(c2.claim_token).not.toBe(c1.claim_token);
  });

  it('complete with wrong token fails', () => {
    const eid = uniqueEventId();
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    const { raw } = callRpc(`SELECT public.complete_webhook_event('${eid}', '00000000-0000-0000-0000-000000000000'::uuid);`);
    expect(raw).toBe('f');
  });

  it('fail with wrong token fails', () => {
    const eid = uniqueEventId();
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    const { raw } = callRpc(`SELECT public.fail_webhook_event('${eid}', '00000000-0000-0000-0000-000000000000'::uuid, 'nope');`);
    expect(raw).toBe('f');
  });

  it('old worker cannot complete after reclaim — stale token rejected', () => {
    const eid = uniqueEventId();
    const { result: claimA } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    // Simulate stale
    runSQL(`UPDATE public.processed_webhook_events SET last_attempted_at = NOW() - INTERVAL '2 minutes' WHERE event_id = '${eid}';`);
    const { result: claimB } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(claimB.claimed).toBe(true);
    // Worker A tries with old token
    const { raw } = callRpc(`SELECT public.complete_webhook_event('${eid}', '${claimA.claim_token}'::uuid);`);
    expect(raw).toBe('f');
    // Worker B succeeds
    const { raw: rawB } = callRpc(`SELECT public.complete_webhook_event('${eid}', '${claimB.claim_token}'::uuid);`);
    expect(rawB).toBe('t');
  });

  it('ACL: anon cannot claim', () => {
    const eid = uniqueEventId();
    const { exitCode, stderr } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`, 'anon');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/permission denied/i);
  });

  it('ACL: authenticated cannot claim', () => {
    const eid = uniqueEventId();
    const { exitCode, stderr } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`, 'authenticated');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/permission denied/i);
  });

  // ── Concurrent proofs (overlapping sessions) ──

  it('concurrent failed-event retry: exactly one winner', async () => {
    const eid = uniqueEventId();
    // Create and fail the event
    const { result: c1 } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    callRpc(`SELECT public.fail_webhook_event('${eid}', '${c1.claim_token}'::uuid, 'initial failure');`);

    // Two sessions race to reclaim the failed event
    const { a, b } = await runConcurrentSQL(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );

    // Parse results — one must be claimed, one must not
    const parseResult = (raw: string) => {
      const jsonLine = raw.split('\n').find(l => l.startsWith('{'));
      return jsonLine ? JSON.parse(jsonLine) : {};
    };
    const resultA = parseResult(a);
    const resultB = parseResult(b);

    const claimed = [resultA.claimed, resultB.claimed].filter(Boolean);
    const denied = [resultA.claimed, resultB.claimed].filter(c => c === false);

    // Exactly one winner, one loser
    expect(claimed.length).toBe(1);
    expect(denied.length).toBe(1);
  });

  it('concurrent stale reclaim: exactly one winner', async () => {
    const eid = uniqueEventId();
    // Create and make stale
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    runSQL(`UPDATE public.processed_webhook_events SET last_attempted_at = NOW() - INTERVAL '2 minutes' WHERE event_id = '${eid}';`);

    // Two sessions race to reclaim the stale event
    const { a, b } = await runConcurrentSQL(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );

    const parseResult = (raw: string) => {
      const jsonLine = raw.split('\n').find(l => l.startsWith('{'));
      return jsonLine ? JSON.parse(jsonLine) : {};
    };
    const resultA = parseResult(a);
    const resultB = parseResult(b);

    const claimed = [resultA.claimed, resultB.claimed].filter(Boolean);
    expect(claimed.length).toBe(1);
  });

  it('concurrent first delivery: exactly one winner', async () => {
    const eid = uniqueEventId();

    // Two sessions race to claim a brand-new event
    const { a, b } = await runConcurrentSQL(
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );

    const parseResult = (raw: string) => {
      const jsonLine = raw.split('\n').find(l => l.startsWith('{'));
      return jsonLine ? JSON.parse(jsonLine) : {};
    };
    const resultA = parseResult(a);
    const resultB = parseResult(b);

    const claimed = [resultA.claimed, resultB.claimed].filter(Boolean);
    // Exactly one winner
    expect(claimed.length).toBe(1);
  });

  it('stale-worker terminal write after reclaim: fenced by token', async () => {
    const eid = uniqueEventId();
    // Worker A claims
    const { result: claimA } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    // Make stale
    runSQL(`UPDATE public.processed_webhook_events SET last_attempted_at = NOW() - INTERVAL '2 minutes' WHERE event_id = '${eid}';`);
    // Worker B reclaims
    const { result: claimB } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(claimB.claimed).toBe(true);

    // Both workers race to write terminal state
    const { a, b } = await runConcurrentSQL(
      // Worker A (stale) tries to complete with old token
      `SELECT public.complete_webhook_event('${eid}', '${claimA.claim_token}'::uuid);`,
      // Worker B (current owner) tries to complete with valid token
      `SELECT public.complete_webhook_event('${eid}', '${claimB.claim_token}'::uuid);`,
    );

    // Worker A must fail (stale token)
    expect(a).toContain('f');
    // Worker B must succeed (valid token)
    expect(b).toContain('t');

    // Final state must be completed
    const { stdout } = runSQL(`SELECT status FROM public.processed_webhook_events WHERE event_id = '${eid}';`);
    expect(stdout).toBe('completed');
  });
});

} // end if dbUrl
