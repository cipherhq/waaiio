/**
 * Email OTP Concurrent Consumption — Real Database Integration Tests
 *
 * The email OTP system stores codes in `platform_settings` table with key `otp:<email>`.
 * On verify, it deletes the row (consume-once). This tests concurrency and expiry.
 *
 * Run: eval "$(supabase status -o env 2>/dev/null)" && \
 *   SUPABASE_INTEGRATION=true NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" npx vitest run lib/__tests__/otp-concurrency.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;

/**
 * Insert an OTP code into platform_settings, mimicking handleSend().
 */
async function insertOtp(email: string, code: string, expiresAt: Date) {
  await db
    .from('platform_settings')
    .upsert(
      {
        key: `otp:${email}`,
        value: { code, expires_at: expiresAt.toISOString() },
        description: 'Email OTP',
      },
      { onConflict: 'key' },
    );
}

/**
 * Simulate the verify logic from handleVerify():
 * - Fetch the OTP row
 * - Check expiry
 * - Compare code
 * - Delete on success (consume)
 * Returns { success, error? }
 */
async function verifyOtp(
  email: string,
  code: string,
): Promise<{ success: boolean; error?: string }> {
  const { data } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', `otp:${email}`)
    .maybeSingle();

  if (!data?.value) {
    return { success: false, error: 'no_code' };
  }

  const stored = data.value as { code: string; expires_at: string };

  if (new Date() > new Date(stored.expires_at)) {
    await db.from('platform_settings').delete().eq('key', `otp:${email}`);
    return { success: false, error: 'expired' };
  }

  if (String(code).trim() !== stored.code) {
    return { success: false, error: 'wrong_code' };
  }

  // Consume: delete the row. Use a conditional delete to prevent double-consume.
  const { data: deleted } = await db
    .from('platform_settings')
    .delete()
    .eq('key', `otp:${email}`)
    .select('key');

  if (!deleted || deleted.length === 0) {
    // Another concurrent request already consumed it
    return { success: false, error: 'already_consumed' };
  }

  return { success: true };
}

describeIntegration('Email OTP concurrency — real database', () => {
  const testEmail = `otp-test-${Date.now()}@test.local`;

  beforeAll(async () => {
    const url =
      process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', {
        encoding: 'utf-8',
      });
      const keyLine = env
        .split('\n')
        .find((l) => l.startsWith('SERVICE_ROLE_KEY='));
      key = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }
    db = createClient(url, key);
  }, 15000);

  afterAll(async () => {
    if (!db) return;
    // Clean up any leftover test OTPs
    await db
      .from('platform_settings')
      .delete()
      .like('key', `otp:otp-test-%@test.local`);
  });

  it('a) OTP can be consumed once — second verify fails', async () => {
    const code = '123456';
    await insertOtp(testEmail, code, new Date(Date.now() + 5 * 60 * 1000));

    const r1 = await verifyOtp(testEmail, code);
    expect(r1.success).toBe(true);

    const r2 = await verifyOtp(testEmail, code);
    expect(r2.success).toBe(false);
    expect(r2.error).toBe('no_code');
  });

  it('b) two simultaneous verification requests — exactly one succeeds', async () => {
    const email2 = `otp-conc-${Date.now()}@test.local`;
    const code = '654321';
    await insertOtp(email2, code, new Date(Date.now() + 5 * 60 * 1000));

    const [r1, r2] = await Promise.all([
      verifyOtp(email2, code),
      verifyOtp(email2, code),
    ]);

    const successes = [r1, r2].filter((r) => r.success).length;
    expect(successes).toBe(1);

    // Cleanup
    await db.from('platform_settings').delete().eq('key', `otp:${email2}`);
  });

  it('c) expired OTP fails verification', async () => {
    const email3 = `otp-expired-${Date.now()}@test.local`;
    const code = '111111';
    // Set expiry 1 second in the past
    await insertOtp(email3, code, new Date(Date.now() - 1000));

    const r = await verifyOtp(email3, code);
    expect(r.success).toBe(false);
    expect(r.error).toBe('expired');
  });

  it('d) previously used OTP fails on retry', async () => {
    const email4 = `otp-used-${Date.now()}@test.local`;
    const code = '222222';
    await insertOtp(email4, code, new Date(Date.now() + 5 * 60 * 1000));

    // First consume
    const r1 = await verifyOtp(email4, code);
    expect(r1.success).toBe(true);

    // Retry after consumption — code no longer exists
    const r2 = await verifyOtp(email4, code);
    expect(r2.success).toBe(false);
    expect(r2.error).toBe('no_code');

    // Even inserting a new code and consuming it, old code doesn't work
    const newCode = '333333';
    await insertOtp(email4, newCode, new Date(Date.now() + 5 * 60 * 1000));
    const r3 = await verifyOtp(email4, code); // old code
    expect(r3.success).toBe(false);
    expect(r3.error).toBe('wrong_code');

    // Cleanup
    await db.from('platform_settings').delete().eq('key', `otp:${email4}`);
  });
});

describe('Email OTP concurrency DB status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
