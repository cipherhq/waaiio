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

}
