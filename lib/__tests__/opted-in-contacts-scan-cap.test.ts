/**
 * #948 follow-up — the opted-in list says when it may be incomplete.
 *
 * listOptedInContacts reads at most MAX_CONSENT_ROWS consent rows. When it stops
 * there with rows possibly unread, `truncated` must be true even if fewer than
 * MAX_CONTACTS people were found, so the Broadcasts page says "could not be
 * confirmed" rather than "not opted in". Runs against the in-memory store that
 * applies filters, ordering and ranges for real.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMemoryDb } from './helpers/memory-db';
import { listOptedInContacts, MAX_CONSENT_ROWS, MAX_CONTACTS } from '@/lib/forms/opted-in-contacts';

const BIZ = 'biz-a';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const phone = (i: number) => `+234810${String(i).padStart(7, '0')}`;

/** `people` distinct numbers, each with `rowsEach` granted marketing consent rows. */
function consentRows(people: number, rowsEach: number) {
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  for (let i = 0; i < people; i++) {
    for (let k = 0; k < rowsEach; k++) {
      n++;
      rows.push({
        id: `c-${String(n).padStart(6, '0')}`, business_id: BIZ, phone: phone(i), channel: 'whatsapp',
        purpose: 'marketing', status: 'granted', expires_at: null, created_at: new Date(NOW - n * 1000).toISOString(),
      });
    }
  }
  return rows;
}

const list = (rows: Record<string, unknown>[]) => {
  const db = createMemoryDb({ customer_consents: rows, messaging_opt_outs: [], customer_profiles: [] });
  return listOptedInContacts(db as unknown as SupabaseClient, BIZ, NOW, 'marketing');
};

describe('listOptedInContacts — truncated flag', () => {
  it.each([
    ['granted', null, true], ['revoked', null, false], ['unknown', null, false],
    ['granted', '2000-01-01', false],
  ])('a newer pending marketing request preserves effective %s with expiry %s', async (status, expires_at, allowed) => {
    const existing = consentRows(1, 1)[0];
    const out = await list([{ ...existing, status, expires_at },
      { ...existing, id: 'pending', status: 'pending', created_at: new Date(NOW).toISOString() }]);
    expect(out.contacts).toEqual(allowed ? [{ phone: phone(0), name: null }] : []);
  });

  it('pending alone never grants access, and STOP still suppresses a grant followed by pending', async () => {
    const existing = consentRows(1, 1)[0];
    const pending = { ...existing, id: 'pending', status: 'pending', created_at: new Date(NOW).toISOString() };
    expect((await list([pending])).contacts).toEqual([]);
    const db = createMemoryDb({ customer_consents: [existing, pending], messaging_opt_outs: [{ phone: phone(0), business_id: null, channel: 'whatsapp' }] });
    expect((await listOptedInContacts(db as unknown as SupabaseClient, BIZ, NOW)).contacts).toEqual([]);
  });

  it('does not change latest-record behavior for utility consent', async () => {
    const existing = { ...consentRows(1, 1)[0], purpose: 'utility' };
    const db = createMemoryDb({ customer_consents: [existing,
      { ...existing, id: 'pending', status: 'pending', created_at: new Date(NOW).toISOString() }] });
    expect((await listOptedInContacts(db as unknown as SupabaseClient, BIZ, NOW, 'utility')).contacts).toEqual([]);
  });

  it('is false when every consent row was read and the list is under the contact cap', async () => {
    const rows = consentRows(100, 49); // 4,900 rows, under the scan cap
    expect(rows.length).toBeLessThan(MAX_CONSENT_ROWS);
    const out = await list(rows);
    expect(out.contacts).toHaveLength(100);
    expect(out.truncated).toBe(false);
  });

  it('is true when the consent scan cap is hit, even with fewer than MAX_CONTACTS people found', async () => {
    const rows = consentRows(120, 50); // 6,000 rows: the scan stops at 5,000
    expect(rows.length).toBeGreaterThan(MAX_CONSENT_ROWS);
    const out = await list(rows);
    // Only the people whose rows fell inside the first 5,000 are seen.
    expect(out.contacts).toHaveLength(MAX_CONSENT_ROWS / 50);
    expect(out.contacts.length).toBeLessThan(MAX_CONTACTS);
    expect(out.truncated).toBe(true);
  });

  it('is still true when more than MAX_CONTACTS people opted in (unchanged)', async () => {
    const out = await list(consentRows(MAX_CONTACTS + 1, 1));
    expect(out.contacts).toHaveLength(MAX_CONTACTS);
    expect(out.truncated).toBe(true);
  });
});
