/**
 * Issue #395 Part 2: Launch opt-in, regional routing, QR/button parity,
 * subscriber attribution, idempotency, and isolation tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Launch opt-in handler tests ──

describe('Launch opt-in handler', () => {
  let handleLaunchOptIn: typeof import('@/lib/bot/launch-optin').handleLaunchOptIn;
  let LAUNCH_OPTIN_PATTERN: RegExp;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/bot/launch-optin');
    handleLaunchOptIn = mod.handleLaunchOptIn;
    LAUNCH_OPTIN_PATTERN = mod.LAUNCH_OPTIN_PATTERN;
  });

  // ── Pattern matching ──

  it('matches "Notify me when Waaiio launches" (exact)', () => {
    expect(LAUNCH_OPTIN_PATTERN.test('Notify me when Waaiio launches')).toBe(true);
  });

  it('matches with (button) suffix', () => {
    expect(LAUNCH_OPTIN_PATTERN.test('Notify me when Waaiio launches (button)')).toBe(true);
  });

  it('matches with (qr) suffix', () => {
    expect(LAUNCH_OPTIN_PATTERN.test('Notify me when Waaiio launches (qr)')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(LAUNCH_OPTIN_PATTERN.test('notify me when waaiio launches')).toBe(true);
    expect(LAUNCH_OPTIN_PATTERN.test('NOTIFY ME WHEN WAAIIO LAUNCHES')).toBe(true);
  });

  it('does NOT match unrelated messages', () => {
    expect(LAUNCH_OPTIN_PATTERN.test('Hi')).toBe(false);
    expect(LAUNCH_OPTIN_PATTERN.test('Book an appointment')).toBe(false);
    expect(LAUNCH_OPTIN_PATTERN.test('pay 5000')).toBe(false);
    expect(LAUNCH_OPTIN_PATTERN.test('BARBER001')).toBe(false);
    expect(LAUNCH_OPTIN_PATTERN.test('cancel')).toBe(false);
  });

  // ── QR/button parity ──

  it('QR and button produce the same opt-in action (both handled)', async () => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: { country_code: 'NG' }, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        return { upsert: mockUpsert };
      }),
    // eslint-disable-next-line
    } as any;
    const sendReply = vi.fn().mockResolvedValue(undefined);

    // Button
    const r1 = await handleLaunchOptIn(mockSupabase, '+2348001234567', 'Notify me when Waaiio launches (button)', '12029226251', sendReply);
    expect(r1).toBe(true);

    // QR
    const r2 = await handleLaunchOptIn(mockSupabase, '+2348001234567', 'Notify me when Waaiio launches (qr)', '12029226251', sendReply);
    expect(r2).toBe(true);

    // Both should trigger upsert and reply
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenCalledTimes(2);
  });

  // ── Signup source attribution ──

  it('detects "button" source from message suffix', async () => {
    const upsertArgs: unknown[] = [];
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }) }) };
        }
        return {
          upsert: vi.fn((data: unknown) => {
            upsertArgs.push(data);
            return Promise.resolve({ error: null });
          }),
        };
      }),
    // eslint-disable-next-line
    } as any;

    await handleLaunchOptIn(mockSupabase, '+1234', 'Notify me when Waaiio launches (button)', undefined, vi.fn());
    expect(upsertArgs[0]).toMatchObject({ signup_source: 'button' });
  });

  it('detects "qr" source from message suffix', async () => {
    const upsertArgs: unknown[] = [];
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }) }) };
        }
        return {
          upsert: vi.fn((data: unknown) => {
            upsertArgs.push(data);
            return Promise.resolve({ error: null });
          }),
        };
      }),
    // eslint-disable-next-line
    } as any;

    await handleLaunchOptIn(mockSupabase, '+1234', 'Notify me when Waaiio launches (qr)', undefined, vi.fn());
    expect(upsertArgs[0]).toMatchObject({ signup_source: 'qr' });
  });

  it('defaults to "direct" source when no suffix', async () => {
    const upsertArgs: unknown[] = [];
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }) }) };
        }
        return {
          upsert: vi.fn((data: unknown) => {
            upsertArgs.push(data);
            return Promise.resolve({ error: null });
          }),
        };
      }),
    // eslint-disable-next-line
    } as any;

    await handleLaunchOptIn(mockSupabase, '+1234', 'Notify me when Waaiio launches', undefined, vi.fn());
    expect(upsertArgs[0]).toMatchObject({ signup_source: 'direct' });
  });

  // ── Idempotency ──

  it('uses upsert with onConflict wa_number for idempotent replays', async () => {
    let upsertOptions: unknown = null;
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }) }) };
        }
        return {
          upsert: vi.fn((_data: unknown, opts: unknown) => {
            upsertOptions = opts;
            return Promise.resolve({ error: null });
          }),
        };
      }),
    // eslint-disable-next-line
    } as any;

    await handleLaunchOptIn(mockSupabase, '+1234', 'Notify me when Waaiio launches', undefined, vi.fn());
    expect(upsertOptions).toMatchObject({ onConflict: 'wa_number' });
  });

  // ── Isolation from bot flows ──

  it('returns false for normal bot messages (does not interfere)', async () => {
    const mockSupabase = {} as never;
    const sendReply = vi.fn();

    expect(await handleLaunchOptIn(mockSupabase, '+1234', 'Hi', undefined, sendReply)).toBe(false);
    expect(await handleLaunchOptIn(mockSupabase, '+1234', 'BARBER001', undefined, sendReply)).toBe(false);
    expect(await handleLaunchOptIn(mockSupabase, '+1234', 'book appointment', undefined, sendReply)).toBe(false);
    expect(await handleLaunchOptIn(mockSupabase, '+1234', 'pay 5000', undefined, sendReply)).toBe(false);
    expect(await handleLaunchOptIn(mockSupabase, '+1234', 'cancel', undefined, sendReply)).toBe(false);
    expect(await handleLaunchOptIn(mockSupabase, '+1234', 'exit', undefined, sendReply)).toBe(false);
    expect(await handleLaunchOptIn(mockSupabase, '+1234', 'home', undefined, sendReply)).toBe(false);

    // No replies sent for non-matching messages
    expect(sendReply).not.toHaveBeenCalled();
  });

  // ── Confirmation message ──

  it('sends a friendly confirmation on successful opt-in', async () => {
    const sendReply = vi.fn();
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }) }) };
        }
        return { upsert: vi.fn().mockResolvedValue({ error: null }) };
      }),
    // eslint-disable-next-line
    } as any;

    await handleLaunchOptIn(mockSupabase, '+1234', 'Notify me when Waaiio launches', undefined, sendReply);

    expect(sendReply).toHaveBeenCalledOnce();
    const msg = sendReply.mock.calls[0][1];
    expect(msg).toContain('list');
    expect(msg).toContain('STOP');
  });

  // ── DB failure resilience ──

  it('still sends confirmation even if DB upsert fails', async () => {
    const sendReply = vi.fn();
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }) }) };
        }
        return { upsert: vi.fn().mockResolvedValue({ error: { message: 'DB down' } }) };
      }),
    // eslint-disable-next-line
    } as any;

    const result = await handleLaunchOptIn(mockSupabase, '+1234', 'Notify me when Waaiio launches', undefined, sendReply);
    expect(result).toBe(true);
    expect(sendReply).toHaveBeenCalledOnce(); // User still gets confirmation
  });
});

// ── Regional routing tests ──

describe('Regional WhatsApp routing', () => {
  it('launch page uses /api/launch/regions (no hard-coded numbers)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/(marketing)/launch/LaunchClient.tsx', 'utf-8');
    expect(src).toContain('/api/launch/regions');
    // Must NOT contain hard-coded phone numbers
    expect(src).not.toMatch(/12029226251/); // shared number should not be hard-coded
  });

  it('QR code and button use the same WhatsApp number', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/(marketing)/launch/LaunchClient.tsx', 'utf-8');
    // Both use buildWhatsAppLink with selectedRegion.phone
    expect(src).toContain("buildWhatsAppLink(selectedRegion.phone, 'button')");
    expect(src).toContain("buildWhatsAppLink(selectedRegion.phone, 'qr')");
  });

  it('region selector allows manual override', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/(marketing)/launch/LaunchClient.tsx', 'utf-8');
    expect(src).toContain('setSelectedCode');
    expect(src).toContain('<select');
    expect(src).toContain('auto-detected');
  });

  it('regions API reuses whatsapp_channels (shared, active)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/launch/regions/route.ts', 'utf-8');
    expect(src).toContain("'whatsapp_channels'");
    expect(src).toContain("'shared'");
    expect(src).toContain("'is_active'");
  });
});

// ── Launch subscriber table isolation ──

describe('Launch subscriber isolation', () => {
  it('launch_subscribers table is separate from bot_sessions', () => {
    const fs = require('fs');
    const migration = fs.readFileSync('supabase/migrations/402_launch_subscribers.sql', 'utf-8');
    expect(migration).toContain('launch_subscribers');
    expect(migration).not.toContain('bot_sessions');
  });

  it('launch_subscribers has RLS enabled', () => {
    const fs = require('fs');
    const migration = fs.readFileSync('supabase/migrations/402_launch_subscribers.sql', 'utf-8');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('is_admin()');
  });

  it('launch_subscribers has UNIQUE constraint on wa_number', () => {
    const fs = require('fs');
    const migration = fs.readFileSync('supabase/migrations/402_launch_subscribers.sql', 'utf-8');
    expect(migration).toContain('UNIQUE (wa_number)');
  });

  it('opt_in_status has CHECK constraint', () => {
    const fs = require('fs');
    const migration = fs.readFileSync('supabase/migrations/402_launch_subscribers.sql', 'utf-8');
    expect(migration).toContain("opt_in_status IN ('active', 'opted_out')");
  });

  it('notification_status has CHECK constraint', () => {
    const fs = require('fs');
    const migration = fs.readFileSync('supabase/migrations/402_launch_subscribers.sql', 'utf-8');
    expect(migration).toContain("notification_status IN ('pending', 'sent', 'failed', 'skipped')");
  });
});
