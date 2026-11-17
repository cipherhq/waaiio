/**
 * #1075 — merchants are charged only for paid messages (real PostgreSQL).
 *
 * Owner decision 2026-11-16: service replies (bot replies, and plain-text
 * non-template messages, which WhatsApp does not bill) must not use messaging
 * credit; marketing/campaign and template messages stay charged as today.
 * The mechanism is the existing per-country `service` rate (no migration):
 * with `service: 0` the final-state authorize_message_send reserves nothing,
 * so a service reply also goes out when the balance is zero.
 *
 * Runs against a database with every migration applied
 * (scripts/ci-bootstrap-test-db.sh), through check_or_authorize_send — the
 * RPC MessageSender calls — and settle_message_cost.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/messaging-paid-only-1075-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
if (process.env.REQUIRE_PG_TESTS === 'true' && !dbUrl) throw new Error('Disposable PostgreSQL is required for the #1075 proof');
const suite = dbUrl ? describe : describe.skip;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 30000 }).trim();
}

const OWNER = '00000000-0000-0000-0000-000000107501';
const BIZ_EMPTY = 'b0000000-0000-0000-0000-000000107501'; // NG, no messaging credit at all
const BIZ_FUNDED = 'b0000000-0000-0000-0000-000000107502'; // NG, purchased credit
const BIZ_GH = 'b0000000-0000-0000-0000-000000107503'; // GH, no service rate configured
const FUNDED_START = 100000;

suite('#1075 paid-only messaging charges (real PostgreSQL)', () => {
  beforeAll(() => {
    psql(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${OWNER}', 'owner-1075@test.example', '{}') ON CONFLICT (id) DO NOTHING;`);
    for (const [id, slug, country] of [[BIZ_EMPTY, 'paid-only-empty', 'NG'], [BIZ_FUNDED, 'paid-only-funded', 'NG'], [BIZ_GH, 'paid-only-gh', 'GH']]) {
      psql(`INSERT INTO businesses (id, name, slug, owner_id, country_code, address, city, neighborhood, phone)
            VALUES ('${id}', '${slug}', '${slug}', '${OWNER}', '${country}', '1 Test', 'T', 'T', '+1')
            ON CONFLICT (id) DO UPDATE SET country_code = '${country}';`);
    }
    psql(`INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
          VALUES ('${JSON.stringify({
            messaging_financial_gate: true,
            messaging_pricing: {
              NGN: { default_cost_minor: 500, default_spend_cap_minor: 5000000,
                rates: { NG: { service: 0, marketing: 800, utility: 300, authentication: 200, '*': 500 } } },
              GHS: { default_cost_minor: 50, default_spend_cap_minor: 500000,
                rates: { GH: { marketing: 80, utility: 30, '*': 50 } } },
            },
          })}'::JSONB, NOW(), '${OWNER}');`);
    psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
          VALUES ('${BIZ_FUNDED}', 'purchased', ${FUNDED_START}, 'NGN', ${FUNDED_START}, 'paid-only-1075-${Date.now()}');`);
  });

  const attempt = (biz: string, category: string) => psql(
    `INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category)
     VALUES ('${biz}', '+2348000000000', 'business', 'NG', '${category}') RETURNING id;`);
  const authorize = (id: string) => JSON.parse(psql(`SELECT public.check_or_authorize_send('${id}');`));
  const settle = (id: string, outcome: 'charged' | 'released') => JSON.parse(psql(`SELECT public.settle_message_cost('${id}', '${outcome}');`));
  const balance = (biz: string) => Number(psql(`SELECT COALESCE(SUM(remaining_minor), 0) FROM messaging_allowances WHERE business_id = '${biz}';`));
  const debits = (id: string) => Number(psql(`SELECT COUNT(*) FROM messaging_allowance_events WHERE attempt_id = '${id}' AND event_type = 'reserve';`));
  const disposition = (id: string) => psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${id}';`);

  it('a service reply at rate 0 is authorized with zero balance and debits nothing', () => {
    expect(balance(BIZ_EMPTY)).toBe(0);
    const id = attempt(BIZ_EMPTY, 'service');
    const auth = authorize(id);
    expect(auth).toMatchObject({ authorized: true, cost_minor: 0, currency_code: 'NGN' });
    expect(settle(id, 'charged')).toMatchObject({ settled: true });
    expect(disposition(id)).toBe('charged');
    expect(balance(BIZ_EMPTY)).toBe(0);
    expect(debits(id)).toBe(0);
  });

  it('a marketing (campaign) message is still refused when there is no credit', () => {
    const id = attempt(BIZ_EMPTY, 'marketing');
    expect(authorize(id)).toMatchObject({ authorized: false, reason: 'insufficient_allowance_balance' });
    expect(balance(BIZ_EMPTY)).toBe(0);
  });

  it('a funded business: service is free, marketing and utility templates are charged at today\'s rates', () => {
    const before = balance(BIZ_FUNDED);
    const svc = attempt(BIZ_FUNDED, 'service');
    expect(authorize(svc)).toMatchObject({ authorized: true, cost_minor: 0 });
    settle(svc, 'charged');
    expect(balance(BIZ_FUNDED)).toBe(before);

    const mkt = attempt(BIZ_FUNDED, 'marketing');
    expect(authorize(mkt)).toMatchObject({ authorized: true, cost_minor: 800 });
    expect(balance(BIZ_FUNDED)).toBe(before - 800);
    expect(settle(mkt, 'charged')).toMatchObject({ settled: true });

    const utl = attempt(BIZ_FUNDED, 'utility');
    expect(authorize(utl)).toMatchObject({ authorized: true, cost_minor: 300 });
    settle(utl, 'charged');
    expect(balance(BIZ_FUNDED)).toBe(before - 800 - 300);
  });

  it('no double charge: replayed authorization and settlement do not debit again', () => {
    const before = balance(BIZ_FUNDED);
    const id = attempt(BIZ_FUNDED, 'marketing');
    authorize(id);
    expect(authorize(id)).toMatchObject({ authorized: true, idempotent: true });
    expect(settle(id, 'charged')).toMatchObject({ settled: true });
    expect(settle(id, 'charged')).toMatchObject({ settled: true, idempotent: true });
    expect(balance(BIZ_FUNDED)).toBe(before - 800);
    expect(debits(id)).toBe(1);
  });

  it('a failed paid send is released in full', () => {
    const before = balance(BIZ_FUNDED);
    const id = attempt(BIZ_FUNDED, 'marketing');
    authorize(id);
    expect(balance(BIZ_FUNDED)).toBe(before - 800);
    expect(settle(id, 'released')).toMatchObject({ settled: true });
    expect(balance(BIZ_FUNDED)).toBe(before);
  });

  it('without a configured service rate, service still falls back to the "all other" rate (config step required)', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category)
                     VALUES ('${BIZ_GH}', '+233200000000', 'business', 'GH', 'service') RETURNING id;`);
    // No GHS credit: the 50 fallback cost cannot be reserved.
    expect(authorize(id)).toMatchObject({ authorized: false, reason: 'insufficient_allowance_balance' });
  });
});
