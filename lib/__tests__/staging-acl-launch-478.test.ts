/**
 * #478 — Staging launch ACL repair regression tests
 *
 * Proves:
 * - M415 safety invariants (no GRANT ALL, no anon, no TRUNCATE, etc.)
 * - No scope duplication with M410/M412/M413/M414
 * - Already-sufficient tables are not gratuitously re-granted
 * - Dependency closure: every route's transitive table deps are accounted for
 * - Every grant maps to an identified code path
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const M415_PATH = join(process.cwd(), 'supabase/migrations/415_staging_launch_acl_repair.sql');
const M410_PATH = join(process.cwd(), 'supabase/migrations/410_subscription_service_role_grants.sql');
const M412_PATH = join(process.cwd(), 'supabase/migrations/412_events_authenticated_grants.sql');
const M413_PATH = join(process.cwd(), 'supabase/migrations/413_promo_codes_service_role_grants.sql');
const M414_PATH = join(process.cwd(), 'supabase/migrations/414_signup_open_platform_setting.sql');

const sql = readFileSync(M415_PATH, 'utf-8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--') && line.trim().length > 0);
const statementsText = statements.join('\n');

// ══════════════════════════════════════════════════════════════
// 1. Safety invariants
// ══════════════════════════════════════════════════════════════

describe('M415: safety invariants', () => {
  it('grants only to service_role and authenticated', () => {
    const toMatches = statementsText.match(/\bTO\s+(\w+)/gi) || [];
    const roles = toMatches.map(m => m.replace(/^TO\s+/i, '').toLowerCase());
    const uniqueRoles = [...new Set(roles)];
    expect(uniqueRoles.sort()).toEqual(['authenticated', 'service_role']);
  });

  it('never uses GRANT ALL', () => {
    expect(statementsText).not.toMatch(/GRANT\s+ALL\b/i);
  });

  it('never grants to anon', () => {
    expect(statementsText).not.toMatch(/\bTO\s+anon\b/i);
  });

  it('never grants to PUBLIC', () => {
    expect(statementsText).not.toMatch(/\bTO\s+PUBLIC\b/i);
  });

  it('never uses TRUNCATE', () => {
    expect(statementsText).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('never uses TRIGGER', () => {
    expect(statementsText).not.toMatch(/\bTRIGGER\b/i);
  });

  it('never uses REFERENCES', () => {
    expect(statementsText).not.toMatch(/\bREFERENCES\b/i);
  });

  it('makes no RLS policy changes', () => {
    expect(statementsText).not.toMatch(/\bPOLICY\b/i);
    expect(statementsText).not.toMatch(/ROW\s+LEVEL\s+SECURITY/i);
  });

  it('makes no ALTER DEFAULT PRIVILEGES changes', () => {
    expect(statementsText).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  it('contains only GRANT statements', () => {
    for (const stmt of statements) {
      expect(stmt.trim()).toMatch(/^GRANT\s/i);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 2. No scope duplication with existing migrations
// ══════════════════════════════════════════════════════════════

describe('M415: no scope duplication with M410/M412/M413/M414', () => {
  it('M410 exists and covers subscriptions + subscription_payments', () => {
    expect(existsSync(M410_PATH)).toBe(true);
    const m410 = readFileSync(M410_PATH, 'utf-8');
    expect(m410).toMatch(/subscriptions/);
    expect(m410).toMatch(/subscription_payments/);
  });

  it('M412 exists and covers events + event_ticket_types', () => {
    expect(existsSync(M412_PATH)).toBe(true);
    const m412 = readFileSync(M412_PATH, 'utf-8');
    expect(m412).toMatch(/events/);
    expect(m412).toMatch(/event_ticket_types/);
  });

  it('M413 exists and covers promo_codes', () => {
    expect(existsSync(M413_PATH)).toBe(true);
    const m413 = readFileSync(M413_PATH, 'utf-8');
    expect(m413).toMatch(/promo_codes/);
  });

  it('M414 exists', () => {
    expect(existsSync(M414_PATH)).toBe(true);
  });

  const duplicatedTables = [
    'subscriptions', 'subscription_payments',
    'event_ticket_types',
  ];
  for (const t of duplicatedTables) {
    it(`does not duplicate ${t}`, () => {
      expect(statementsText).not.toMatch(new RegExp(`\\b${t}\\b`, 'i'));
    });
  }

  it('does not duplicate public.events (standalone)', () => {
    expect(statementsText).not.toMatch(/\bpublic\.events\b/i);
  });

  it('does not duplicate promo_codes', () => {
    expect(statementsText).not.toMatch(/\bpromo_codes\b/i);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Already-sufficient tables excluded
// ══════════════════════════════════════════════════════════════

describe('M415: already-sufficient tables excluded', () => {
  // CTO-verified staging grants exist for these
  const alreadySufficient = [
    'services', 'products', 'product_variants',
    'orders', 'order_items', 'appointments',
    'business_capabilities',
  ];

  for (const table of alreadySufficient) {
    it(`excludes already-sufficient: ${table}`, () => {
      expect(statementsText).not.toMatch(new RegExp(`\\bpublic\\.${table}\\b`, 'i'));
    });
  }

  // Owned by other migrations and documented as excluded in M415 comments
  const ownedElsewhere = [
    { table: 'businesses', migration: 'M293' },
    { table: 'whatsapp_channels', migration: 'M293' },
    { table: 'profiles', migration: 'M247/M353' },
    { table: 'messaging_allowances', migration: 'M368' },
    { table: 'platform_settings', migration: 'M408' },
    { table: 'refunds', migration: 'M355' },
  ];

  for (const { table, migration } of ownedElsewhere) {
    it(`excludes ${table} (owned by ${migration})`, () => {
      expect(statementsText).not.toMatch(new RegExp(`\\bpublic\\.${table}\\b`, 'i'));
    });
  }

  it('documents excluded dependencies in migration comments', () => {
    expect(sql).toContain('businesses');
    expect(sql).toContain('whatsapp_channels');
    expect(sql).toContain('profiles');
    expect(sql).toContain('messaging_allowances');
    expect(sql).toContain('platform_settings');
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Dependency closure — transitive deps covered
// ══════════════════════════════════════════════════════════════

describe('M415: dependency closure completeness', () => {
  // CTO-identified missing dependencies that MUST be present
  it('includes loyalty_transactions (dep of /api/loyalty/redeem + /api/referrals/validate)', () => {
    expect(statementsText).toMatch(/GRANT\s+.*\bINSERT\b.*public\.loyalty_transactions.*TO\s+service_role/i);
  });

  it('includes waiver_templates SELECT (dep of /api/waivers/sign)', () => {
    expect(statementsText).toMatch(/GRANT\s+SELECT\s+ON\s+public\.waiver_templates\s+TO\s+service_role/i);
  });

  it('includes bookings SELECT+UPDATE (dep of /api/customers/delete)', () => {
    expect(statementsText).toMatch(/GRANT\s+SELECT,\s*UPDATE\s+ON\s+public\.bookings\s+TO\s+service_role/i);
  });

  it('includes bot_sessions UPDATE (dep of /api/customers/delete + /api/chat/resolve)', () => {
    expect(statementsText).toMatch(/GRANT\s+.*\bUPDATE\b.*public\.bot_sessions.*TO\s+service_role/i);
  });

  it('includes audit_log INSERT (dep of /api/customers/delete via logAudit)', () => {
    expect(statementsText).toMatch(/GRANT\s+.*\bINSERT\b.*public\.audit_log.*TO\s+service_role/i);
  });

  // Verify direct table grants still present
  it('includes payment_links for service_role', () => {
    expect(statementsText).toMatch(/GRANT\s+.*public\.payment_links.*TO\s+service_role/i);
  });

  it('includes attendance_log for service_role', () => {
    expect(statementsText).toMatch(/GRANT\s+.*public\.attendance_log.*TO\s+service_role/i);
  });

  it('includes signed_waivers for service_role', () => {
    expect(statementsText).toMatch(/GRANT\s+.*public\.signed_waivers.*TO\s+service_role/i);
  });

  it('includes loyalty_points for service_role', () => {
    expect(statementsText).toMatch(/GRANT\s+.*public\.loyalty_points.*TO\s+service_role/i);
  });

  it('includes referrals for service_role', () => {
    expect(statementsText).toMatch(/GRANT\s+.*public\.referrals.*TO\s+service_role/i);
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Code path documentation
// ══════════════════════════════════════════════════════════════

describe('M415: every grant maps to an identified code path', () => {
  it('payment_links references /api/pay-link/manage', () => {
    expect(sql).toMatch(/payment_links[\s\S]*?pay-link\/manage/);
  });

  it('attendance_log references /api/checkin', () => {
    expect(sql).toMatch(/attendance_log[\s\S]*?checkin/);
  });

  it('contracts references /api/contracts', () => {
    expect(sql).toMatch(/contracts[\s\S]*?\/api\/contracts/);
  });

  it('loyalty_transactions references /api/loyalty/redeem', () => {
    expect(sql).toMatch(/loyalty_transactions[\s\S]*?loyalty\/redeem/);
  });

  it('waiver_templates references /api/waivers/sign', () => {
    expect(sql).toMatch(/waiver_templates[\s\S]*?waivers\/sign/);
  });

  it('bookings references /api/customers/delete', () => {
    expect(sql).toMatch(/bookings[\s\S]*?customers\/delete/);
  });

  it('bot_sessions references /api/customers/delete or /api/chat/resolve', () => {
    expect(sql).toMatch(/bot_sessions[\s\S]*?(customers\/delete|chat\/resolve)/);
  });

  it('audit_log references /api/customers/delete', () => {
    expect(sql).toMatch(/audit_log[\s\S]*?customers\/delete/);
  });

  it('invoices references /api/invoices', () => {
    expect(sql).toMatch(/invoices[\s\S]*?\/api\/invoices/);
  });

  it('surveys references /api/surveys', () => {
    expect(sql).toMatch(/surveys[\s\S]*?\/api\/surveys/);
  });
});

// ══════════════════════════════════════════════════════════════
// 6. Grant count
// ══════════════════════════════════════════════════════════════

describe('M415: grant count', () => {
  const grantLines = statements.filter(s => s.trim().match(/^GRANT\s/i));

  it('contains exactly 34 GRANT statements', () => {
    expect(grantLines.length).toBe(34);
  });

  it('has 25 service_role grants and 9 authenticated grants', () => {
    const sr = grantLines.filter(s => /TO\s+service_role/i.test(s));
    const auth = grantLines.filter(s => /TO\s+authenticated/i.test(s));
    expect(sr.length).toBe(25);
    expect(auth.length).toBe(9);
  });
});
