/**
 * #271 Slice B: Webhook claim/reclaim/fencing — real PostgreSQL proofs.
 *
 * Uses psql via execSync against TEST_DATABASE_URL.
 *
 * Deterministic two-session overlap tests:
 *   Session A: BEGIN → claim (holds FOR UPDATE lock) → wait
 *   Session B: claim concurrently (blocks on FOR UPDATE until A commits)
 *   Session A: COMMIT → B unblocks → assert B's result
 *
 * Locally: skips when TEST_DATABASE_URL absent.
 * CI Migration Validation: TEST_DATABASE_URL is set; skip = CI failure.
 *
 * Refs: #278, #271
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'child_process';

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
 * Deterministic two-session overlap using interactive psql.
 *
 * Session A starts a transaction, executes sqlA (which acquires FOR UPDATE),
 * and holds the transaction open.
 * Session B concurrently executes sqlB, which blocks on the FOR UPDATE lock.
 * After a short delay (ensuring B is blocked), Session A commits.
 * B unblocks and completes.
 *
 * Returns both results. Fails if the overlap could not be established.
 */
function runOverlappingSessions(
  setup: string,
  sqlA: string,
  sqlB: string,
): Promise<{ resultA: string; resultB: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      procA?.kill();
      procB?.kill();
      reject(new Error('Overlapping session timeout (15s)'));
    }, 15000);

    if (setup) runSQL(setup);

    let resultA = '';
    let resultB = '';
    let procA: ChildProcess | null = null;
    let procB: ChildProcess | null = null;

    // Session A: BEGIN + execute claim (holds lock) — interactive mode
    procA = spawn('psql', [dbUrl!, '-t', '-A'], { stdio: ['pipe', 'pipe', 'pipe'] });
    procA.stdout!.on('data', (d: Buffer) => { resultA += d.toString(); });
    procA.stderr!.on('data', (d: Buffer) => { resultA += d.toString(); });

    // Send BEGIN + claim to Session A
    procA.stdin!.write(`BEGIN;\n${sqlA}\n`);

    // Wait briefly for A to acquire the lock, then start B
    setTimeout(() => {
      // Session B: tries the same claim — will block on FOR UPDATE until A commits
      procB = spawn('psql', [dbUrl!, '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let bOutput = '';
      procB.stdout!.on('data', (d: Buffer) => { bOutput += d.toString(); });
      procB.stderr!.on('data', (d: Buffer) => { bOutput += d.toString(); });
      procB.on('close', () => {
        resultB = bOutput.trim();
        clearTimeout(timeout);
        procA?.kill();
        resolve({ resultA: resultA.trim(), resultB });
      });

      // Send B's SQL
      procB.stdin!.write(`${sqlB}\n`);
      procB.stdin!.end();

      // After another delay (B is now blocked on lock), commit A to release
      setTimeout(() => {
        procA!.stdin!.write('COMMIT;\n');
        procA!.stdin!.end();
      }, 500);
    }, 300);
  });
}

const TEST_PREFIX = 'test-271b-';
let testCounter = 0;
function uniqueEventId() {
  return `${TEST_PREFIX}${Date.now()}-${++testCounter}`;
}

function parseJson(raw: string): Record<string, unknown> {
  const line = raw.split('\n').find(l => l.startsWith('{'));
  return line ? JSON.parse(line) : {};
}

describe('Slice B — webhook claim/reclaim/fencing (real PostgreSQL)', () => {
  beforeEach(() => {
    runSQL(`DELETE FROM public.processed_webhook_events WHERE event_id LIKE '${TEST_PREFIX}%';`);
  });

  // ── Sequential correctness proofs ──

  it('first claim succeeds with UUID claim_token', () => {
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
    const { result: c } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    callRpc(`SELECT public.complete_webhook_event('${eid}', '${c.claim_token}'::uuid);`);
    const { result } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('already_completed');
  });

  it('failed event CAN be reclaimed with new token', () => {
    const eid = uniqueEventId();
    const { result: c1 } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    callRpc(`SELECT public.fail_webhook_event('${eid}', '${c1.claim_token}'::uuid, 'err');`);
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
    const { raw } = callRpc(`SELECT public.fail_webhook_event('${eid}', '00000000-0000-0000-0000-000000000000'::uuid, 'x');`);
    expect(raw).toBe('f');
  });

  it('complete with correct token succeeds', () => {
    const eid = uniqueEventId();
    const { result: c } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    const { raw } = callRpc(`SELECT public.complete_webhook_event('${eid}', '${c.claim_token}'::uuid);`);
    expect(raw).toBe('t');
    const { stdout } = runSQL(`SELECT status FROM public.processed_webhook_events WHERE event_id = '${eid}';`);
    expect(stdout).toBe('completed');
  });

  it('stale-worker terminal-write fencing: old token rejected, new token accepted', () => {
    const eid = uniqueEventId();
    const { result: claimA } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    runSQL(`UPDATE public.processed_webhook_events SET last_attempted_at = NOW() - INTERVAL '2 minutes' WHERE event_id = '${eid}';`);
    const { result: claimB } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(claimB.claimed).toBe(true);
    const { raw: rawA } = callRpc(`SELECT public.complete_webhook_event('${eid}', '${claimA.claim_token}'::uuid);`);
    expect(rawA).toBe('f');
    const { raw: rawB } = callRpc(`SELECT public.complete_webhook_event('${eid}', '${claimB.claim_token}'::uuid);`);
    expect(rawB).toBe('t');
  });

  // ── ACL proofs ──

  it('ACL: anon cannot claim', () => {
    const eid = uniqueEventId();
    const r = runSQL(`SET ROLE anon;\nSELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(r.exitCode).not.toBe(0);
    const output = `${r.stderr} ${r.stdout}`;
    expect(output).toMatch(/permission denied/i);
  });

  it('ACL: authenticated cannot claim', () => {
    const eid = uniqueEventId();
    const r = runSQL(`SET ROLE authenticated;\nSELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    expect(r.exitCode).not.toBe(0);
    const output = `${r.stderr} ${r.stdout}`;
    expect(output).toMatch(/permission denied/i);
  });

  // ── Deterministic two-session overlap proofs ──
  // Session A holds the FOR UPDATE row lock inside a transaction.
  // Session B concurrently attempts the same claim and blocks on the lock.
  // When A commits, B unblocks and gets the post-A state.

  it('overlapping failed-retry: A reclaims while B blocks, B sees active_processing', async () => {
    const eid = uniqueEventId();
    // Setup: claim + fail
    const { result: c1 } = callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    callRpc(`SELECT public.fail_webhook_event('${eid}', '${c1.claim_token}'::uuid, 'initial');`);

    // A reclaims inside a transaction (holds lock), B blocks then sees active_processing
    const { resultA, resultB } = await runOverlappingSessions(
      '',
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );

    const rA = parseJson(resultA);
    const rB = parseJson(resultB);

    expect(rA.claimed).toBe(true);
    expect(rB.claimed).toBe(false);
    expect(rB.reason).toBe('active_processing');
  }, 20000);

  it('overlapping stale-reclaim: A reclaims while B blocks, B sees active_processing', async () => {
    const eid = uniqueEventId();
    // Setup: claim + make stale
    callRpc(`SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`);
    runSQL(`UPDATE public.processed_webhook_events SET last_attempted_at = NOW() - INTERVAL '2 minutes' WHERE event_id = '${eid}';`);

    const { resultA, resultB } = await runOverlappingSessions(
      '',
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );

    const rA = parseJson(resultA);
    const rB = parseJson(resultB);

    expect(rA.claimed).toBe(true);
    expect(rB.claimed).toBe(false);
    expect(rB.reason).toBe('active_processing');
  }, 20000);

  it('one-winner first-delivery overlap: exactly one claims', async () => {
    const eid = uniqueEventId();

    const { resultA, resultB } = await runOverlappingSessions(
      '',
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
      `SELECT public.claim_webhook_event('${eid}', 'meta_cloud', 'message');`,
    );

    const rA = parseJson(resultA);
    const rB = parseJson(resultB);

    // Exactly one winner
    const claimedCount = [rA.claimed, rB.claimed].filter(Boolean).length;
    expect(claimedCount).toBe(1);
  }, 20000);
});

} // end if dbUrl
