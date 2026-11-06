/**
 * createWhatsAppUser: a typed (unverified) email must never attach this phone
 * to an existing account found by that email. Runs the real function against
 * an in-memory Supabase double.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWhatsAppUser } from '@/lib/bot/flows/shared/user';

type Profile = { id: string; phone: string | null; email: string | null; first_name?: string; last_name?: string };

let profiles: Profile[];
let authEmails: Set<string>;
let authPhones: Set<string>;
let nextId: number;
const profileUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];

function makeClient() {
  return {
    auth: {
      admin: {
        createUser: vi.fn(async (attrs: { phone?: string; email?: string }) => {
          const digits = (attrs.phone || '').replace(/\D/g, '');
          if (attrs.email && authEmails.has(attrs.email)) {
            return { data: { user: null }, error: { message: 'email already registered' } };
          }
          if (digits && authPhones.has(digits)) {
            return { data: { user: null }, error: { message: 'phone already registered' } };
          }
          const id = `user-${nextId++}`;
          if (attrs.email) authEmails.add(attrs.email);
          if (digits) authPhones.add(digits);
          profiles.push({ id, phone: digits || null, email: attrs.email ?? null });
          return { data: { user: { id } }, error: null };
        }),
      },
    },
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
      let orPhones: string[] = [];
      const eqs: Array<[string, unknown]> = [];
      const match = () =>
        profiles.filter(
          (p) =>
            (orPhones.length === 0 || orPhones.includes(p.phone ?? '')) &&
            eqs.every(([k, v]) => (p as Record<string, unknown>)[k] === v),
        );
      const chain = {
        select: () => chain,
        or: (expr: string) => {
          orPhones = expr.split(',').map((t) => t.replace(/^phone\.eq\./, ''));
          return chain;
        },
        eq: (col: string, val: unknown) => { eqs.push([col, val]); return chain; },
        limit: () => chain,
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        update: (values: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            profileUpdates.push({ id, values });
            const p = profiles.find((x) => x.id === id);
            if (p) Object.assign(p, values);
            return { error: null };
          },
        }),
      };
      return chain;
    },
  } as unknown as Parameters<typeof createWhatsAppUser>[0];
}

beforeEach(() => {
  profiles = [{ id: 'merchant', phone: null, email: 'owner@example.com' }];
  authEmails = new Set(['owner@example.com']);
  authPhones = new Set();
  nextId = 1;
  profileUpdates.length = 0;
});

describe('createWhatsAppUser does not link a phone through an unverified email', () => {
  it('creates a separate phone-only account and leaves the email-matched profile untouched', async () => {
    const id = await createWhatsAppUser(makeClient(), '2348011112222', 'Eve', 'X', 'owner@example.com');

    expect(id).not.toBe('merchant');
    expect(id).toMatch(/^user-/);
    const merchant = profiles.find((p) => p.id === 'merchant')!;
    expect(merchant.phone).toBeNull();
    expect(profileUpdates.some((u) => u.id === 'merchant')).toBe(false);
  });

  it('still returns the existing account for a returning phone', async () => {
    profiles.push({ id: 'customer', phone: '2348011112222', email: null });
    authPhones.add('2348011112222');

    const id = await createWhatsAppUser(makeClient(), '2348011112222', 'Ada', 'Y', 'ada@example.com');

    expect(id).toBe('customer');
  });

  it('still creates a new account with the email when it is not registered', async () => {
    const id = await createWhatsAppUser(makeClient(), '2348099998888', 'New', 'Person', 'new@example.com');

    expect(id).toMatch(/^user-/);
    expect(profiles.find((p) => p.id === id)?.email).toBe('new@example.com');
  });
});
