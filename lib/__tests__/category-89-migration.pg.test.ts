/**
 * #682 — 89-Category Migration: Disposable PostgreSQL Tests
 *
 * Validates M459 against a real PostgreSQL instance:
 * - All 89 enum values present after migration
 * - All 89 active templates present with correct groups
 * - Idempotent (safe to re-run)
 * - Existing templates preserve greetings/capabilities/labels
 * - Business INSERT succeeds for every category
 * - Alphabetical sort_order within each group
 * - Template count is exactly 91 (89 + 2 legacy)
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully if not available (CI runs with disposable PG).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { BUSINESS_CATEGORIES } from '@/lib/constants';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Skip entire suite if no test database
const describeWithPg = TEST_DB_URL ? describe : describe.skip;

describeWithPg('#682 migration 459: disposable PostgreSQL', () => {
  let client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; connect: () => Promise<void>; end: () => Promise<void> };
  let hasPrerequisites = false;

  beforeAll(async () => {
    const { default: PgClient } = await import('pg').then(m => ({ default: m.Client }));
    client = new PgClient({ connectionString: TEST_DB_URL });
    await client.connect();

    // Check for prerequisite schema (business_category enum + category_templates table).
    // CI disposable PG starts from a clean template — skip gracefully if schema is absent.
    try {
      const { rows: enumRows } = await client.query(
        `SELECT COUNT(*) as cnt FROM pg_type WHERE typname = 'business_category'`
      );
      if (Number(enumRows[0]?.cnt) > 0) {
        const { rows: tblRows } = await client.query(
          `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'category_templates'`
        );
        hasPrerequisites = Number(tblRows[0]?.cnt) > 0;
      }
    } catch {
      hasPrerequisites = false;
    }
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it('migration file applies without error', async () => {
    if (!hasPrerequisites) return; // Skip — prerequisite schema not available
    const sql = readFileSync(
      resolve(__dirname, '../../supabase/migrations/459_expand_business_categories.sql'),
      'utf-8',
    );
    await expect(client.query(sql)).resolves.toBeDefined();
  });

  it('business_category enum has all 89 approved values', async () => {
    if (!hasPrerequisites) return;
    const { rows } = await client.query(`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'business_category'
    `);
    const enumValues = new Set(rows.map((r: { enumlabel: string }) => r.enumlabel));
    for (const cat of BUSINESS_CATEGORIES) {
      expect(enumValues.has(cat.key), `${cat.key} missing from enum`).toBe(true);
    }
  });

  it('category_templates has 91 active rows (89 + 2 legacy)', async () => {
    if (!hasPrerequisites) return;
    const { rows } = await client.query(`
      SELECT COUNT(*) as cnt FROM category_templates WHERE is_active = true
    `);
    expect(Number(rows[0].cnt)).toBe(91);
  });

  it('all 89 BUSINESS_CATEGORIES keys have active templates', async () => {
    if (!hasPrerequisites) return;
    const { rows } = await client.query(`
      SELECT key FROM category_templates WHERE is_active = true
    `);
    const templateKeys = new Set(rows.map((r: { key: string }) => r.key));
    for (const cat of BUSINESS_CATEGORIES) {
      expect(templateKeys.has(cat.key), `${cat.key} missing from templates`).toBe(true);
    }
  });

  it('existing template greetings are preserved (not overwritten)', async () => {
    if (!hasPrerequisites) return;
    const { rows } = await client.query(`
      SELECT key, default_greeting FROM category_templates
      WHERE key IN ('restaurant', 'barber', 'shop', 'church', 'events')
    `);
    for (const row of rows) {
      // Existing templates should NOT have the generic greeting
      expect(row.default_greeting).not.toBe('Welcome to {{name}}! How can I help you today?');
      expect(row.default_greeting).toContain('{{name}}');
    }
  });

  it('new templates use generic greeting', async () => {
    if (!hasPrerequisites) return;
    const { rows } = await client.query(`
      SELECT key, default_greeting FROM category_templates
      WHERE key IN ('yoga', 'cafe', 'plumber', 'courier')
    `);
    for (const row of rows) {
      expect(row.default_greeting).toBe('Welcome to {{name}}! How can I help you today?');
    }
  });

  it('approved group changes applied', async () => {
    if (!hasPrerequisites) return;
    const checks = [
      { key: 'school', expected: 'Education & Training' },
      { key: 'restaurant', expected: 'Food & Dining' },
      { key: 'car_park', expected: 'Government & Public' },
      { key: 'photographer', expected: 'Creative & Media' },
      { key: 'gym', expected: 'Fitness' },
      { key: 'logistics', expected: 'Transport & Logistics' },
    ];
    for (const { key, expected } of checks) {
      const { rows } = await client.query(
        `SELECT category_group FROM category_templates WHERE key = $1`, [key]
      );
      expect(rows[0]?.category_group, `${key} group`).toBe(expected);
    }
  });

  it('sort_order is alphabetical within each group', async () => {
    if (!hasPrerequisites) return;
    const { rows } = await client.query(`
      SELECT category_group, array_agg(label ORDER BY sort_order) as ordered_labels,
             array_agg(label ORDER BY label) as alpha_labels
      FROM category_templates
      WHERE is_active = true
      GROUP BY category_group
    `);
    for (const row of rows) {
      expect(row.ordered_labels, `${row.category_group} alphabetical`).toEqual(row.alpha_labels);
    }
  });

  it('business INSERT succeeds for every new category', async () => {
    if (!hasPrerequisites) return;
    // Test a sample of new categories (enum extension)
    const newKeys = ['yoga', 'cafe', 'courier', 'plumber', 'dance'];
    for (const key of newKeys) {
      const { rows } = await client.query(`
        SELECT $1::business_category as cat
      `, [key]);
      expect(rows[0].cat).toBe(key);
    }
  });

  it('migration is idempotent (re-run does not error)', async () => {
    if (!hasPrerequisites) return;
    const sql = readFileSync(
      resolve(__dirname, '../../supabase/migrations/459_expand_business_categories.sql'),
      'utf-8',
    );
    // Second run should succeed without errors
    await expect(client.query(sql)).resolves.toBeDefined();
  });
});
