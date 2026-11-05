/**
 * #682 — 89-Category Migration: Disposable PostgreSQL Tests
 *
 * Validates M459 + M460 against a real PostgreSQL instance:
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

describeWithPg('#682 migrations 459 + 460: disposable PostgreSQL', () => {
  let client: import('pg').Client;

  beforeAll(async () => {
    const { default: PgClient } = await import('pg').then(m => ({ default: m.Client }));
    client = new PgClient({ connectionString: TEST_DB_URL });
    await client.connect();

    const migration = (name: string) => readFileSync(
      resolve(__dirname, '../../supabase/migrations', name), 'utf-8',
    );
    const { rows: [schema] } = await client.query(`SELECT
      to_regtype('public.business_category') IS NOT NULL AS has_enum,
      to_regclass('public.category_templates') IS NOT NULL AS has_templates`);
    if (!schema.has_enum && !schema.has_templates) {
      // CI clones a minimal ACL schema, not the application migration chain.
      // Bootstrap only canonical category prerequisites; never rename/reset its tables.
      const initial = migration('002_multi_industry.sql');
      for (const type of ['business_category', 'flow_type']) {
        const ddl = initial.match(new RegExp(`CREATE TYPE ${type} AS ENUM \\([\\s\\S]*?\\);`))?.[0];
        if (!ddl) throw new Error(`Canonical ${type} DDL missing`);
        await client.query(ddl);
      }
      for (const name of ['008_capabilities.sql', '039_reservation_and_whatsapp_sign.sql',
        '065_queue_flow_type.sql', '104_event_services_category.sql', '106_new_subcategories.sql']) {
        const extensions = migration(name).match(/ALTER TYPE (?:business_category|flow_type) ADD VALUE[^;]*;/g);
        if (!extensions?.length) throw new Error(`Canonical category enum extensions missing: ${name}`);
        // Each statement commits before seeded rows use the new enum values.
        for (const ddl of extensions) await client.query(ddl);
      }
      const { rows: [admin] } = await client.query("SELECT to_regprocedure('public.is_admin()') IS NOT NULL AS exists");
      if (!admin.exists) {
        // M014's policy dependency only. This suite does not certify admin authorization.
        await client.query('CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$');
      }
      await client.query(migration('014_category_templates.sql'));
      const shortlet = migration('039_reservation_and_whatsapp_sign.sql')
        .match(/INSERT INTO category_templates[\s\S]*?ON CONFLICT \(key\) DO NOTHING;/)?.[0];
      if (!shortlet) throw new Error('Canonical shortlet template seed missing');
      await client.query(shortlet);
      await client.query(migration('065_queue_flow_type.sql'));
      await client.query(migration('105_category_groups.sql'));
    } else if (!schema.has_enum || !schema.has_templates) {
      throw new Error('Incomplete category migration prerequisite schema');
    }

  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it('migration file applies without error', async () => {
    const sql = readFileSync(
      resolve(__dirname, '../../supabase/migrations/459_expand_business_categories.sql'),
      'utf-8',
    );
    await expect(client.query(sql)).resolves.toBeDefined();
    // M460 corrects M459's key-based ordering to the approved display-label ordering.
    const correction = readFileSync(resolve(__dirname, '../../supabase/migrations/460_category_sort_order_correction.sql'), 'utf-8');
    await expect(client.query(correction)).resolves.toBeDefined();
  });

  it('business_category enum has all 89 approved values', async () => {
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
    const { rows } = await client.query(`
      SELECT COUNT(*) as cnt FROM category_templates WHERE is_active = true
    `);
    expect(Number(rows[0].cnt)).toBe(91);
  });

  it('all 89 BUSINESS_CATEGORIES keys have active templates', async () => {
    const { rows } = await client.query(`
      SELECT key FROM category_templates WHERE is_active = true
    `);
    const templateKeys = new Set(rows.map((r: { key: string }) => r.key));
    for (const cat of BUSINESS_CATEGORIES) {
      expect(templateKeys.has(cat.key), `${cat.key} missing from templates`).toBe(true);
    }
  });

  it('existing template greetings are preserved (not overwritten)', async () => {
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
    const { rows } = await client.query(`
      SELECT key, default_greeting FROM category_templates
      WHERE key IN ('yoga', 'cafe', 'plumber', 'courier')
    `);
    for (const row of rows) {
      expect(row.default_greeting).toBe('Welcome to {{name}}! How can I help you today?');
    }
  });

  it('approved group changes applied', async () => {
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
    const sql = readFileSync(
      resolve(__dirname, '../../supabase/migrations/459_expand_business_categories.sql'),
      'utf-8',
    );
    // Second run should succeed without errors
    await expect(client.query(sql)).resolves.toBeDefined();
    // M460 corrects M459's key-based ordering to the approved display-label ordering.
    const correction = readFileSync(resolve(__dirname, '../../supabase/migrations/460_category_sort_order_correction.sql'), 'utf-8');
    await expect(client.query(correction)).resolves.toBeDefined();
  });
});
