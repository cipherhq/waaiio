/**
 * E1 Engage — Production-shaped DB schema contract tests (#557 B3)
 *
 * Verifies that all source adapter table/column contracts exist
 * against a real PostgreSQL database with all migrations applied.
 *
 * Requires TEST_DATABASE_URL environment variable (CI provides this).
 * Skipped when not set (same pattern as all other -db.test.ts files).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('E1 schema contract (TEST_DATABASE_URL not set)', () => {
    it('skipped — set TEST_DATABASE_URL to enable', () => {});
  });
} else {

function runSQL(sql: string): string {
  return execSync(
    `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
    { input: sql, encoding: 'utf-8', timeout: 15000 },
  ).trim();
}

function columnExists(table: string, column: string): boolean {
  const result = runSQL(`
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '${table}'
      AND column_name = '${column}';
  `);
  return parseInt(result, 10) > 0;
}

function tableExists(table: string): boolean {
  const result = runSQL(`
    SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '${table}';
  `);
  return parseInt(result, 10) > 0;
}

describe('E1 source adapter schema contracts', () => {
  // ── contact adapter → customer_profiles ──
  describe('contact adapter: customer_profiles', () => {
    it('table exists', () => expect(tableExists('customer_profiles')).toBe(true));
    it('has business_id', () => expect(columnExists('customer_profiles', 'business_id')).toBe(true));
    it('has phone', () => expect(columnExists('customer_profiles', 'phone')).toBe(true));
    it('has name', () => expect(columnExists('customer_profiles', 'name')).toBe(true));
    it('has email', () => expect(columnExists('customer_profiles', 'email')).toBe(true));
    it('has tags', () => expect(columnExists('customer_profiles', 'tags')).toBe(true));
    it('has created_at', () => expect(columnExists('customer_profiles', 'created_at')).toBe(true));
    it('has id (PK for pagination)', () => expect(columnExists('customer_profiles', 'id')).toBe(true));
  });

  // ── order adapter → orders ──
  describe('order adapter: orders', () => {
    it('table exists', () => expect(tableExists('orders')).toBe(true));
    it('has business_id', () => expect(columnExists('orders', 'business_id')).toBe(true));
    it('has user_id', () => expect(columnExists('orders', 'user_id')).toBe(true));
    it('has status', () => expect(columnExists('orders', 'status')).toBe(true));
    it('has total_amount', () => expect(columnExists('orders', 'total_amount')).toBe(true));
    it('has created_at', () => expect(columnExists('orders', 'created_at')).toBe(true));
    it('has id (PK)', () => expect(columnExists('orders', 'id')).toBe(true));
    it('does NOT have product_name (B3 removed)', () => {
      expect(columnExists('orders', 'product_name')).toBe(false);
    });
  });

  // ── booking adapter → bookings ──
  describe('booking adapter: bookings', () => {
    it('table exists', () => expect(tableExists('bookings')).toBe(true));
    it('has business_id', () => expect(columnExists('bookings', 'business_id')).toBe(true));
    it('has guest_phone', () => expect(columnExists('bookings', 'guest_phone')).toBe(true));
    it('has guest_name', () => expect(columnExists('bookings', 'guest_name')).toBe(true));
    it('has status', () => expect(columnExists('bookings', 'status')).toBe(true));
    it('has date (not booking_date)', () => expect(columnExists('bookings', 'date')).toBe(true));
    it('has created_at', () => expect(columnExists('bookings', 'created_at')).toBe(true));
    it('has id (PK)', () => expect(columnExists('bookings', 'id')).toBe(true));
    it('does NOT have service_name (B3 removed)', () => {
      expect(columnExists('bookings', 'service_name')).toBe(false);
    });
    it('does NOT have booking_date (B3 corrected to date)', () => {
      expect(columnExists('bookings', 'booking_date')).toBe(false);
    });
  });

  // ── event adapter → event_tickets (NOT event_registrations) ──
  describe('event adapter: event_tickets (B3 corrected)', () => {
    it('event_tickets table exists', () => expect(tableExists('event_tickets')).toBe(true));
    it('event_registrations does NOT exist', () => {
      expect(tableExists('event_registrations')).toBe(false);
    });
    it('has business_id', () => expect(columnExists('event_tickets', 'business_id')).toBe(true));
    it('has guest_phone', () => expect(columnExists('event_tickets', 'guest_phone')).toBe(true));
    it('has guest_name', () => expect(columnExists('event_tickets', 'guest_name')).toBe(true));
    it('has event_id', () => expect(columnExists('event_tickets', 'event_id')).toBe(true));
    it('has status', () => expect(columnExists('event_tickets', 'status')).toBe(true));
    it('has created_at', () => expect(columnExists('event_tickets', 'created_at')).toBe(true));
    it('has id (PK)', () => expect(columnExists('event_tickets', 'id')).toBe(true));
    it('does NOT have event_name (B3 removed)', () => {
      expect(columnExists('event_tickets', 'event_name')).toBe(false);
    });
  });

  // ── form adapter → form_responses ──
  describe('form adapter: form_responses', () => {
    it('table exists', () => expect(tableExists('form_responses')).toBe(true));
    it('has business_id', () => expect(columnExists('form_responses', 'business_id')).toBe(true));
    it('has customer_phone', () => expect(columnExists('form_responses', 'customer_phone')).toBe(true));
    it('has customer_name', () => expect(columnExists('form_responses', 'customer_name')).toBe(true));
    it('has customer_email', () => expect(columnExists('form_responses', 'customer_email')).toBe(true));
    it('has form_id', () => expect(columnExists('form_responses', 'form_id')).toBe(true));
    it('has submitted_at', () => expect(columnExists('form_responses', 'submitted_at')).toBe(true));
    it('has id (PK)', () => expect(columnExists('form_responses', 'id')).toBe(true));
  });

  // ── payment adapter → payments ──
  describe('payment adapter: payments', () => {
    it('table exists', () => expect(tableExists('payments')).toBe(true));
    it('has business_id', () => expect(columnExists('payments', 'business_id')).toBe(true));
    it('has user_id', () => expect(columnExists('payments', 'user_id')).toBe(true));
    it('has booking_id', () => expect(columnExists('payments', 'booking_id')).toBe(true));
    it('has order_id', () => expect(columnExists('payments', 'order_id')).toBe(true));
    it('has invoice_id', () => expect(columnExists('payments', 'invoice_id')).toBe(true));
    it('has reservation_id', () => expect(columnExists('payments', 'reservation_id')).toBe(true));
    it('has status', () => expect(columnExists('payments', 'status')).toBe(true));
    it('has amount', () => expect(columnExists('payments', 'amount')).toBe(true));
    it('has payment_method', () => expect(columnExists('payments', 'payment_method')).toBe(true));
    it('has created_at', () => expect(columnExists('payments', 'created_at')).toBe(true));
    it('has id (PK)', () => expect(columnExists('payments', 'id')).toBe(true));
  });

  // ── payment identity linked tables ──
  describe('payment identity linked tables', () => {
    it('profiles has phone', () => expect(columnExists('profiles', 'phone')).toBe(true));
    it('bookings has guest_phone', () => expect(columnExists('bookings', 'guest_phone')).toBe(true));
    it('invoices has customer_phone', () => expect(columnExists('invoices', 'customer_phone')).toBe(true));
    it('reservations has guest_phone', () => expect(columnExists('reservations', 'guest_phone')).toBe(true));
  });

  // ── consent/opt-out tables ──
  describe('consent and opt-out tables', () => {
    it('customer_consents exists', () => expect(tableExists('customer_consents')).toBe(true));
    it('customer_consents has phone', () => expect(columnExists('customer_consents', 'phone')).toBe(true));
    it('customer_consents has business_id', () => expect(columnExists('customer_consents', 'business_id')).toBe(true));
    it('customer_consents has channel', () => expect(columnExists('customer_consents', 'channel')).toBe(true));
    it('customer_consents has purpose', () => expect(columnExists('customer_consents', 'purpose')).toBe(true));
    it('customer_consents has status', () => expect(columnExists('customer_consents', 'status')).toBe(true));
    it('customer_consents has expires_at', () => expect(columnExists('customer_consents', 'expires_at')).toBe(true));
    it('messaging_opt_outs exists', () => expect(tableExists('messaging_opt_outs')).toBe(true));
    it('messaging_opt_outs has phone', () => expect(columnExists('messaging_opt_outs', 'phone')).toBe(true));
    it('messaging_opt_outs has opt_out_type', () => expect(columnExists('messaging_opt_outs', 'opt_out_type')).toBe(true));
  });

  // ── engage_segments migration 431 ──
  describe('engage_segments (migration 431 — file exists, NOT applied in unit test DB)', () => {
    it('migration file exists', () => {
      const fs = require('fs');
      expect(fs.existsSync('supabase/migrations/431_engage_segments.sql')).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// CTO Round 5: Real-PG multi-page opt-out query proof
//
// Proves the actual SQL predicates used by loadOptOuts work correctly
// against a real PostgreSQL database with >1000 rows, multiple pages,
// global/business/other-business scoping, and count/data consistency.
// ═══════════════════════════════════════════════════════════════

describe('E1 opt-out multi-page SQL predicate proof (real PG)', () => {
  // Test UUIDs — deterministic to enable cleanup
  const TEST_OWNER = 'e1000000-0000-0000-0000-000000000001';
  const TEST_BIZ_OWN = 'e1000000-0000-0000-0000-000000000010';
  const TEST_BIZ_OTHER = 'e1000000-0000-0000-0000-000000000020';
  const TEST_PHONE_PREFIX = '+2340000';

  beforeAll(() => {
    // Create test owner user + two businesses (own + other)
    runSQL(`
      INSERT INTO auth.users (id, email) VALUES ('${TEST_OWNER}', 'e1test@test.local')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO profiles (id, phone) VALUES ('${TEST_OWNER}', '+2340000000000')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO businesses (id, owner_id, name, slug, country_code, status)
        VALUES ('${TEST_BIZ_OWN}', '${TEST_OWNER}', 'E1 Own Biz', 'e1-own-biz-test', 'NG', 'active')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO businesses (id, owner_id, name, slug, country_code, status)
        VALUES ('${TEST_BIZ_OTHER}', '${TEST_OWNER}', 'E1 Other Biz', 'e1-other-biz-test', 'NG', 'active')
        ON CONFLICT (id) DO NOTHING;
    `);

    // Insert 1701 opt-out records, with 1201 matching the own-business/global scope.
    // Use distinct phone numbers to satisfy the unique index.
    //
    // Distribution:
    //   phones 0000..0499: own-business, channel=sms, type=promotional (500 rows)
    //   phones 0500..0999: other-business, channel=whatsapp, type=marketing (500 rows — should be EXCLUDED)
    //   phones 1000..1099: own-business, channel=whatsapp, type=marketing (100 rows)
    //   phone  1100:       global (NULL business_id), channel=whatsapp, type=all (1 row)
    //   phones 1101..1700: own-business, channel=email, type=all (600 rows)
    //
    // Total matching own+global = 500 + 100 + 1 + 600 = 1201
    // Total other-business = 500 (should NOT appear in filtered results)
    // Grand total in table = 1701

    const inserts: string[] = [];

    // Batch 1: 500 own-business sms/promotional
    for (let i = 0; i < 500; i++) {
      const phone = `${TEST_PHONE_PREFIX}${String(i).padStart(4, '0')}`;
      inserts.push(`('${phone}', '${TEST_BIZ_OWN}', 'sms', 'promotional')`);
    }

    // Batch 2: 500 other-business whatsapp/marketing (should be excluded by SQL filter)
    for (let i = 500; i < 1000; i++) {
      const phone = `${TEST_PHONE_PREFIX}${String(i).padStart(4, '0')}`;
      inserts.push(`('${phone}', '${TEST_BIZ_OTHER}', 'whatsapp', 'marketing')`);
    }

    // Batch 3: 100 own-business whatsapp/marketing (blocking opt-outs on "page 2+")
    for (let i = 1000; i < 1100; i++) {
      const phone = `${TEST_PHONE_PREFIX}${String(i).padStart(4, '0')}`;
      inserts.push(`('${phone}', '${TEST_BIZ_OWN}', 'whatsapp', 'marketing')`);
    }

    // Batch 4: 1 global opt-out
    inserts.push(`('${TEST_PHONE_PREFIX}1100', NULL, 'whatsapp', 'all')`);

    // Batch 5: 600 own-business email/all (ensures a third page)
    for (let i = 1101; i <= 1700; i++) {
      const phone = `${TEST_PHONE_PREFIX}${String(i).padStart(4, '0')}`;
      inserts.push(`('${phone}', '${TEST_BIZ_OWN}', 'email', 'all')`);
    }

    // Insert in batches of 200 to avoid SQL length limits
    const batchSize = 200;
    for (let b = 0; b < inserts.length; b += batchSize) {
      const batch = inserts.slice(b, b + batchSize);
      runSQL(`
        INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type)
        VALUES ${batch.join(',\n       ')}
        ON CONFLICT DO NOTHING;
      `);
    }
  });

  afterAll(() => {
    // Cleanup in dependency order
    runSQL(`
      DELETE FROM messaging_opt_outs WHERE phone LIKE '${TEST_PHONE_PREFIX}%';
      DELETE FROM businesses WHERE id IN ('${TEST_BIZ_OWN}', '${TEST_BIZ_OTHER}');
      DELETE FROM profiles WHERE id = '${TEST_OWNER}';
      DELETE FROM auth.users WHERE id = '${TEST_OWNER}';
    `);
  });

  it('total test records inserted = 1701', () => {
    const count = runSQL(`SELECT count(*) FROM messaging_opt_outs WHERE phone LIKE '${TEST_PHONE_PREFIX}%';`);
    expect(parseInt(count, 10)).toBe(1701);
  });

  it('SQL .or() filter includes own-business + global, excludes other-business', () => {
    // This is the EXACT predicate used in loadOptOuts production code:
    //   .is('resubscribed_at', null)
    //   .or('business_id.is.null,business_id.eq.{TEST_BIZ_OWN}')
    // Translated to raw SQL equivalent:
    const count = runSQL(`
      SELECT count(*) FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND resubscribed_at IS NULL
        AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}');
    `);
    // Expected: 500 (own sms) + 100 (own whatsapp) + 1 (global) + 600 (own email) = 1201
    // Excluded: 500 (other-business) NOT counted
    expect(parseInt(count, 10)).toBe(1201);
  });

  it('other-business opt-outs are excluded (500 rows not in filtered result)', () => {
    const otherCount = runSQL(`
      SELECT count(*) FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND business_id = '${TEST_BIZ_OTHER}';
    `);
    expect(parseInt(otherCount, 10)).toBe(500);

    const filteredOtherCount = runSQL(`
      SELECT count(*) FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND resubscribed_at IS NULL
        AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}')
        AND business_id = '${TEST_BIZ_OTHER}';
    `);
    expect(parseInt(filteredOtherCount, 10)).toBe(0);
  });

  it('global opt-out (business_id IS NULL) is included in filtered results', () => {
    const globalCount = runSQL(`
      SELECT count(*) FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND resubscribed_at IS NULL
        AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}')
        AND business_id IS NULL;
    `);
    expect(parseInt(globalCount, 10)).toBe(1);
  });

  it('paginated fetch across >1000 filtered rows retrieves all with (phone, id) ordering', () => {
    // Fetch in pages of 500 using LIMIT/OFFSET with the exact ordering used in production
    const page1 = runSQL(`
      SELECT phone FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND resubscribed_at IS NULL
        AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}')
      ORDER BY phone ASC, id ASC
      LIMIT 500 OFFSET 0;
    `);
    const page1Count = page1.split('\n').filter(Boolean).length;
    expect(page1Count).toBe(500);

    const page2 = runSQL(`
      SELECT phone FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND resubscribed_at IS NULL
        AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}')
      ORDER BY phone ASC, id ASC
      LIMIT 500 OFFSET 500;
    `);
    const page2Count = page2.split('\n').filter(Boolean).length;
    expect(page2Count).toBe(500); // full second page, 201 remain for page 3

    const page3 = runSQL(`
      SELECT phone FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND resubscribed_at IS NULL
        AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}')
      ORDER BY phone ASC, id ASC
      LIMIT 500 OFFSET 1000;
    `);
    const page3Count = page3.split('\n').filter(Boolean).length;
    expect(page3Count).toBe(201);
    expect(page1Count + page2Count + page3Count).toBe(1201);
  });

  it('whatsapp marketing opt-outs on page 2 are retrievable', () => {
    // The 100 own-business whatsapp/marketing opt-outs (phones 1000-1099) should
    // appear in the filtered results. With 500 sms/promotional on phones 0000-0499
    // ordered first, the whatsapp/marketing ones are on page 2.
    const marketingOnPage2 = runSQL(`
      SELECT count(*) FROM (
        SELECT phone, channel, opt_out_type FROM messaging_opt_outs
        WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
          AND resubscribed_at IS NULL
          AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}')
        ORDER BY phone ASC, id ASC
        LIMIT 500 OFFSET 500
      ) sub
      WHERE channel = 'whatsapp' AND opt_out_type = 'marketing';
    `);
    // All 100 whatsapp/marketing opt-outs should be on page 2
    expect(parseInt(marketingOnPage2, 10)).toBeGreaterThan(0);
  });

  it('count and paginated total match exactly', () => {
    const exactCount = runSQL(`
      SELECT count(*) FROM messaging_opt_outs
      WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
        AND resubscribed_at IS NULL
        AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}');
    `);

    // Paginate and sum
    let totalRows = 0;
    let offset = 0;
    const pageSize = 500;
    while (true) {
      const page = runSQL(`
        SELECT phone FROM messaging_opt_outs
        WHERE phone LIKE '${TEST_PHONE_PREFIX}%'
          AND resubscribed_at IS NULL
          AND (business_id IS NULL OR business_id = '${TEST_BIZ_OWN}')
        ORDER BY phone ASC, id ASC
        LIMIT ${pageSize} OFFSET ${offset};
      `);
      const rows = page.split('\n').filter(Boolean).length;
      totalRows += rows;
      if (rows < pageSize) break;
      offset += pageSize;
    }

    expect(totalRows).toBe(parseInt(exactCount, 10));
    expect(totalRows).toBe(1201);
  });
});

}
