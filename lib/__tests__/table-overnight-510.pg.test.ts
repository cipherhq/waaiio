/**
 * M510 — late-night (overnight) table reservations. Real PostgreSQL proof
 * (disposable local database, created and dropped by this file).
 *
 * Applies M476, M477 and M510 from disk on a minimal fixture and calls the real
 * book_table_atomic. Owner decision 2026-11-04 (revised), table bookings only:
 *   - a booking is allowed when it fits completely inside the business's open
 *     time from businesses.operating_hours; close <= open closes the next day,
 *     open == close is 24 hours from that time;
 *   - bookings keep their real calendar date; starts after midnight are fine
 *     when the business is open then; back-to-back open days join up; a closed
 *     day contributes no open time;
 *   - no usable hours for the date: no business-hours check, an end past 24:00
 *     is past_midnight (as M476). Seating resources' own windows stay
 *     non-overnight.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M510 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m476 = readFileSync('supabase/migrations/476_seating_resources_table_reservation.sql', 'utf8');
const m477 = readFileSync('supabase/migrations/477_exclude_table_bookings_from_slot_capacity.sql', 'utf8');
const m510 = readFileSync('supabase/migrations/510_table_overnight_reservations.sql', 'utf8');
const database = `m510_${randomUUID().replaceAll('-', '')}`;
const SIGNATURE = 'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)';

// 2026-11-06 is a Friday (D); D-1 Thursday, D+1 Saturday.
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const MON = '2026-11-09';
const TUE = '2026-11-10';
const LATE = { open: '18:00', close: '02:00' };
// Saturday has no entry (no usable hours => no business-hours check), so a
// D+1 00:15 start is a valid booking for the cross-midnight overlap cases.
const HOURS = {
  thursday: LATE,
  friday: { ...LATE, closed: false },
  monday: { open: '09:00', close: '17:00' }, // daytime
  tuesday: { open: '09:00', close: '00:00', is_open: true }, // closes at midnight
  wednesday: { closed: true },
};

type Resource = { id: string; duration: number; deposit: number };

suite('M510 overnight table reservations (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  let targetUrl: string;
  let userId: string;
  let slotSrcBefore: string;

  const q = (text: string, params?: unknown[]) => client.query(text, params);

  async function business(hours: unknown = HOURS): Promise<string> {
    const { rows: [b] } = await q(`INSERT INTO businesses (name, operating_hours) VALUES ('Lounge', $1::jsonb) RETURNING id`, [JSON.stringify(hours)]);
    return b.id;
  }
  async function resource(biz: string, opts: { duration?: number; deposit?: number; from?: string | null; to?: string | null } = {}): Promise<Resource> {
    const duration = opts.duration ?? 90, deposit = opts.deposit ?? 0;
    const { rows: [r] } = await q(
      `INSERT INTO seating_resources (business_id, name, capacity, min_party_size, deposit_amount, reservation_duration_minutes, available_from, available_to)
       VALUES ($1, 'Booth', 6, 1, $2, $3, $4::time, $5::time) RETURNING id`,
      [biz, deposit, duration, opts.from ?? null, opts.to ?? null],
    );
    return { id: r.id, duration, deposit };
  }
  // The app path: expected deposit/duration equal the resource's (M383 pattern).
  async function book(db: pg.Client, biz: string, res: Resource, date: string, time: string, session: string | null = null) {
    const { rows: [row] } = await db.query(
      `SELECT * FROM public.book_table_atomic($1::uuid, $2, $3, $4, $5::date, $6, 2, $7,
         'Guest', '+2340000', NULL, NULL, $8, 'none', 'confirmed', $8, $8, $7)`,
      [session, biz, userId, res.id, date, time, res.duration, res.deposit],
    );
    return row as { booking_id: string | null; reference_code: string | null; slot_available: boolean };
  }
  const bookErr = (biz: string, res: Resource, date: string, time: string) => book(client, biz, res, date, time);

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    targetUrl = target.toString();
    client = new pg.Client({ connectionString: targetUrl }); await client.connect();

    // Minimal final-state fixture for M476/M477 (as in table-reservation-730-db),
    // plus businesses.operating_hours (001: JSONB NOT NULL DEFAULT '{}').
    await q(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TYPE flow_type AS ENUM ('scheduling', 'payment', 'ordering', 'ticketing', 'reservation', 'appointment', 'queue');
      CREATE TYPE reservation_status AS ENUM ('pending', 'confirmed', 'in_progress', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'completed');
      CREATE TYPE booking_channel AS ENUM ('whatsapp', 'dashboard', 'api');
      CREATE TYPE deposit_status AS ENUM ('none', 'pending', 'paid');
      CREATE TABLE businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test Business',
        timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
        operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'
      );
      CREATE TABLE profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_code VARCHAR(10) UNIQUE,
        business_id UUID NOT NULL REFERENCES businesses(id),
        user_id UUID NOT NULL REFERENCES profiles(id),
        service_id UUID, appointment_id UUID, staff_id UUID, staff_name TEXT,
        date DATE NOT NULL,
        time TIME NOT NULL,
        party_size INTEGER NOT NULL DEFAULT 1,
        flow_type flow_type,
        channel booking_channel NOT NULL DEFAULT 'whatsapp',
        deposit_amount INTEGER NOT NULL DEFAULT 0,
        deposit_status deposit_status NOT NULL DEFAULT 'none',
        status reservation_status NOT NULL DEFAULT 'pending',
        total_amount INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        guest_name TEXT, guest_phone TEXT, guest_email TEXT, special_requests TEXT,
        venue_address TEXT, end_date DATE, addons_snapshot JSONB, promo_code_id UUID,
        location_id UUID, class_session_id UUID, original_date DATE, original_time TEXT,
        rescheduled_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        bot_session_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION public.generate_reference_code() RETURNS TRIGGER AS $$
      BEGIN NEW.reference_code := 'BW-' || substr(md5(random()::text), 1, 7); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER set_reference_code BEFORE INSERT ON bookings FOR EACH ROW
        WHEN (NEW.reference_code IS NULL) EXECUTE FUNCTION generate_reference_code();
      CREATE TABLE services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        name TEXT, price INTEGER DEFAULT 0, deposit_amount INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT true,
        max_capacity INTEGER DEFAULT 1, duration_minutes INTEGER DEFAULT 30, is_class BOOLEAN DEFAULT false,
        requires_staff BOOLEAN DEFAULT false, staff_ids TEXT[], metadata JSONB DEFAULT '{}', class_schedule JSONB,
        auto_approve BOOLEAN DEFAULT true
      );
      CREATE TABLE appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        name TEXT, requires_staff BOOLEAN DEFAULT false, available_days TEXT[], available_from TIME, available_to TIME
      );
      CREATE TABLE business_staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        name TEXT, is_active BOOLEAN DEFAULT true, schedule JSONB DEFAULT '{}'
      );
      CREATE TABLE class_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        service_id UUID REFERENCES services(id), date DATE, start_time TIME, capacity INTEGER DEFAULT 10,
        status TEXT DEFAULT 'scheduled', staff_id UUID, location_id UUID
      );
      CREATE OR REPLACE FUNCTION check_staff_availability(p_staff_id UUID, p_biz UUID, p_date DATE, p_time TEXT, p_dur INTEGER DEFAULT 30)
        RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ BEGIN RETURN QUERY SELECT true, 'ok'; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION check_appointment_schedule(p_appt UUID, p_biz UUID, p_date DATE, p_time TEXT)
        RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ BEGIN RETURN QUERY SELECT true, 'ok'; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION public.has_admin_role(roles TEXT[]) RETURNS BOOLEAN AS $$ BEGIN RETURN false; END $$ LANGUAGE plpgsql;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$ BEGIN RETURN 'service_role'; END $$ LANGUAGE plpgsql;
    `);
    await q(m476);
    await q(m477);
    // Earlier-migration grants the SECURITY INVOKER RPC relies on (M293, M415).
    await q(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT ALL ON public.businesses TO service_role;
      GRANT SELECT, UPDATE ON public.bookings TO service_role;
    `);
    slotSrcBefore = (await q(`SELECT md5(prosrc) AS h FROM pg_proc WHERE proname = 'book_slot_atomic'`)).rows[0].h;
    const { rows: [u] } = await q(`INSERT INTO profiles DEFAULT VALUES RETURNING id`);
    userId = u.id;
  }, 60000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('before 510: M476 rejects a late booking on an overnight day with past_midnight', async () => {
    const biz = await business();
    const res = await resource(biz);
    await expect(bookErr(biz, res, FRI, '23:30')).rejects.toThrow(/^past_midnight:/);
  });

  it('applies 510 (self-check passes) and re-applies cleanly', async () => {
    await q(m510);
    await q(m510);
    const { rows: [fn] } = await q(`SELECT prosecdef, proconfig, pg_get_function_result(oid) AS result FROM pg_proc WHERE oid = $1::regprocedure`, [SIGNATURE]);
    expect(fn.prosecdef).toBe(false); // SECURITY INVOKER
    expect(fn.proconfig).toBeNull(); // no SET
    expect(fn.result).toBe('TABLE(booking_id uuid, reference_code text, slot_available boolean)');
    expect((await q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'book_table_atomic'`)).rows[0].n).toBe(1);
  });

  it('ACL is service_role only (catalog)', async () => {
    const { rows: [p] } = await q(`SELECT
      has_function_privilege('service_role', $1, 'EXECUTE') AS svc,
      has_function_privilege('anon', $1, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', $1, 'EXECUTE') AS auth`, [SIGNATURE]);
    expect(p).toEqual({ svc: true, anon: false, auth: false });
  });

  it('self-check fails (and rolls back) if the function were SECURITY DEFINER', async () => {
    await q('BEGIN');
    try {
      await q(`ALTER FUNCTION ${SIGNATURE} SECURITY DEFINER`);
      // CREATE OR REPLACE without SECURITY DEFINER restores INVOKER, so drive the check block alone.
      const check = m510.slice(m510.lastIndexOf('DO $$'));
      await expect(q(check)).rejects.toThrow(/510 SELF-CHECK FAILED: book_table_atomic must be SECURITY INVOKER/);
    } finally { await q('ROLLBACK'); }
  });

  describe('Friday 18:00-02:00', () => {
    it('23:30 + 90 min (ends 01:00) is allowed and stored on Friday 23:30; deposit unchanged', async () => {
      const biz = await business();
      const res = await resource(biz, { deposit: 5000 });
      const r = await book(client, biz, res, FRI, '23:30');
      expect(r.slot_available).toBe(true);
      const { rows: [b] } = await q(`SELECT date::text, time::text, deposit_amount, deposit_status::text, status::text, total_amount, metadata FROM bookings WHERE id = $1`, [r.booking_id]);
      expect(b).toEqual({ date: FRI, time: '23:30:00', deposit_amount: 5000, deposit_status: 'pending', status: 'pending', total_amount: 5000, metadata: { duration_minutes: 90 } });
    });

    it('Owner example: 23:00 + 90 min (ends 00:30) is allowed', async () => {
      const biz = await business();
      expect((await book(client, biz, await resource(biz), FRI, '23:00')).slot_available).toBe(true);
    });

    it('22:00 + 90 min (ends 23:30) is allowed', async () => {
      const biz = await business();
      expect((await book(client, biz, await resource(biz), FRI, '22:00')).slot_available).toBe(true);
    });

    it('ending exactly at closing (23:30 + 150 = 02:00) is allowed', async () => {
      const biz = await business();
      expect((await book(client, biz, await resource(biz, { duration: 150 }), FRI, '23:30')).slot_available).toBe(true);
    });

    it('23:30 + 180 min (ends 02:30, past the 02:00 close) is rejected with after_closing', async () => {
      const biz = await business();
      await expect(bookErr(biz, await resource(biz, { duration: 180 }), FRI, '23:30'))
        .rejects.toThrow(/^after_closing:Reservation would extend past closing time 02:00$/);
    });

    it('01:00 start is rejected with before_opening when the table opens at 18:00', async () => {
      const biz = await business();
      await expect(bookErr(biz, await resource(biz, { from: '18:00' }), FRI, '01:00')).rejects.toThrow(/^before_opening:/);
    });

    // Revised rule: Friday 01:00 is inside Thursday's 18:00-02:00 night.
    it('Friday 01:00 with no table window is Thursday night: + 60 allowed, + 90 after_closing 02:00', async () => {
      const biz = await business();
      expect((await book(client, biz, await resource(biz, { duration: 60 }), FRI, '01:00')).slot_available).toBe(true);
      await expect(bookErr(biz, await resource(biz), FRI, '01:00'))
        .rejects.toThrow(/^after_closing:Reservation would extend past closing time 02:00$/);
    });

    it('15:00 start with no table window is rejected (before_opening); 18:00 is allowed', async () => {
      const biz = await business();
      const res = await resource(biz);
      await expect(bookErr(biz, res, FRI, '15:00')).rejects.toThrow(/^before_opening:Earliest reservation time is 18:00$/);
      await expect(bookErr(biz, res, FRI, '17:59')).rejects.toThrow(/^before_opening:/);
      expect((await book(client, biz, res, FRI, '18:00')).slot_available).toBe(true);
    });

    it('a start of 24:00 is not before midnight and keeps past_midnight', async () => {
      const biz = await business();
      await expect(bookErr(biz, await resource(biz, { duration: 60 }), FRI, '24:00')).rejects.toThrow(/^past_midnight:/);
    });

    it("the table's own available_to is still enforced (after_closing)", async () => {
      const biz = await business();
      await expect(bookErr(biz, await resource(biz, { from: '18:00', to: '23:59' }), FRI, '23:30'))
        .rejects.toThrow(/^after_closing:Reservation would extend past closing time 23:59:00$/);
    });

    it('seating_no_overnight is unchanged: a table window of 18:00-02:00 is still refused', async () => {
      const biz = await business();
      await expect(resource(biz, { from: '18:00', to: '02:00' })).rejects.toThrow(/seating_no_overnight/);
    });
  });

  it('daytime day (Monday 09:00-17:00): 23:30 + 90 is outside open time (day_unavailable)', async () => {
    const biz = await business();
    await expect(bookErr(biz, await resource(biz), MON, '23:30'))
      .rejects.toThrow(/^day_unavailable:The business is not open at that time on Monday$/);
  });

  it('00:00 close (Tuesday 09:00-00:00): an end of exactly 24:00 is allowed, one minute more is not', async () => {
    const biz = await business();
    expect((await book(client, biz, await resource(biz, { duration: 60 }), TUE, '23:00')).slot_available).toBe(true);
    await expect(bookErr(biz, await resource(biz, { duration: 61 }), TUE, '23:00')).rejects.toThrow(/^after_closing:/);
  });

  // P2-2: a closed day is refused before the midnight checks, so a late booking
  // on a closed day gets day_unavailable (the bot's "time not available"), not
  // past_midnight. These three cases previously expected past_midnight.
  describe('closed day plus a late booking gives day_unavailable', () => {
    const closed: Array<[string, unknown]> = [
      ['closed day {closed:true}', { friday: { closed: true } }],
      ['{open, close, closed:true}', { friday: { ...LATE, closed: true } }],
      ['{open, close, is_open:false}', { friday: { ...LATE, is_open: false } }],
    ];
    for (const [name, hours] of closed) {
      it(name, async () => {
        const biz = await business(hours);
        await expect(bookErr(biz, await resource(biz), FRI, '23:30'))
          .rejects.toThrow(/^day_unavailable:The business is closed on Friday$/);
      });
    }
  });

  describe('equal or 00:00 opening and closing (close <= open)', () => {
    it('00:00/00:00 without closed closes at midnight: 23:00 + 60 ok, 23:30 + 90 after_closing', async () => {
      const biz = await business({ friday: { open: '00:00', close: '00:00' } });
      expect((await book(client, biz, await resource(biz, { duration: 60 }), FRI, '23:00')).slot_available).toBe(true);
      await expect(bookErr(biz, await resource(biz), FRI, '23:30'))
        .rejects.toThrow(/^after_closing:Reservation would extend past closing time 00:00$/);
    });

    it('18:00/18:00 is 24 hours from 18:00: 17:59 before_opening, 23:30 + 480 ok, end exactly 18:00 next day ok, one minute more not', async () => {
      const biz = await business({ friday: { open: '18:00', close: '18:00' } });
      await expect(bookErr(biz, await resource(biz), FRI, '17:59')).rejects.toThrow(/^before_opening:Earliest reservation time is 18:00$/);
      expect((await book(client, biz, await resource(biz, { duration: 480 }), FRI, '23:30')).slot_available).toBe(true);
      // Table durations stop at 480, so the 24-hour bound is shown through M476's
      // caller-duration path (p_expected_duration NULL), unchanged by M510.
      const raw = async (minutes: number) => {
        const res = await resource(biz);
        return q(`SELECT * FROM public.book_table_atomic(NULL, $1, $2, $3, $4::date, '18:00', 2, $5,
          'Guest', '+2340000', NULL, NULL, 0, 'none', 'confirmed', 0, NULL, NULL)`, [biz, userId, res.id, FRI, minutes]);
      };
      expect((await raw(1440)).rows[0].slot_available).toBe(true); // ends Saturday 18:00
      await expect(raw(1441)).rejects.toThrow(/^after_closing:Reservation would extend past closing time 18:00$/);
    });
  });

  describe('booking statuses across midnight (same statuses as M476)', () => {
    for (const [status, blocks] of [['pending', true], ['in_progress', true], ['completed', false], ['no_show', false]] as const) {
      it(`${status} D 23:30-01:00 ${blocks ? 'blocks' : 'does not block'} D+1 00:15`, async () => {
        const biz = await business();
        const res = await resource(biz);
        const first = await book(client, biz, res, FRI, '23:30');
        await q(`UPDATE bookings SET status = $2::reservation_status WHERE id = $1`, [first.booking_id, status]);
        expect((await book(client, biz, res, SAT, '00:15')).slot_available).toBe(!blocks);
      });
    }
  });

  it('lock key is bigint-safe: abs(int4 -2147483648) errors, the ::bigint form used by 510 does not', async () => {
    await expect(q(`SELECT abs((-2147483648)::int4)`)).rejects.toThrow(/integer out of range/);
    expect((await q(`SELECT abs((-2147483648)::int4::bigint) AS k`)).rows[0].k).toBe('2147483648');
    const { rows: [fn] } = await q(`SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure`, [SIGNATURE]);
    expect(fn.prosrc).toMatch(/v_lock_key := abs\(hashtext\(\s*p_business_id::text \|\| '\|sr\|' \|\| p_seating_resource_id::text\s*\)::bigint\);/);
    expect(fn.prosrc).toContain('pg_advisory_xact_lock(v_lock_key)');
  });

  describe('malformed hours keep past_midnight (fail closed)', () => {
    const cases: Array<[string, unknown]> = [
      ['closed as string "false"', { friday: { ...LATE, closed: 'false' } }],
      ['is_open as string "true"', { friday: { ...LATE, is_open: 'true' } }],
      ['12-hour strings', { friday: { open: '6pm', close: '2am' } }],
      ['single-digit hour', { friday: { open: '18:00', close: '2:00' } }],
      ['24:00 close', { friday: { open: '18:00', close: '24:00' } }],
      ['seconds included', { friday: { open: '18:00:00', close: '02:00:00' } }],
      ['numbers', { friday: { open: 18, close: 2 } }],
      ['missing close', { friday: { open: '18:00' } }],
      ['day missing', { saturday: LATE }],
      ['empty hours', {}],
      ['day is a string', { friday: '18:00-02:00' }],
      ['day is an array', { friday: ['18:00', '02:00'] }],
      ['hours is an array', [LATE]],
    ];
    for (const [name, hours] of cases) {
      it(name, async () => {
        const biz = await business(hours);
        await expect(bookErr(biz, await resource(biz), FRI, '23:30')).rejects.toThrow(/^past_midnight:/);
      });
    }
  });

  describe('start must fall inside business hours (Owner decision 2026-11-04, second)', () => {
    const WED = '2026-11-11';

    it('daytime 09:00-17:00: 08:00 is rejected (before_opening), 09:00 is allowed', async () => {
      const biz = await business();
      const res = await resource(biz);
      await expect(bookErr(biz, res, MON, '08:00')).rejects.toThrow(/^before_opening:Earliest reservation time is 09:00$/);
      expect((await book(client, biz, res, MON, '09:00')).slot_available).toBe(true);
    });

    it('daytime 09:00-17:00: must end by closing (15:30 + 90 ok, 16:00 + 90 after_closing)', async () => {
      const biz = await business();
      const res = await resource(biz);
      expect((await book(client, biz, res, MON, '15:30')).slot_available).toBe(true);
      await expect(bookErr(biz, await resource(biz), MON, '16:00'))
        .rejects.toThrow(/^after_closing:Reservation would extend past closing time 17:00$/);
    });

    const closedDays: Array<[string, unknown]> = [
      ['{closed:true}', { wednesday: { closed: true } }],
      ['{open, close, closed:true}', { wednesday: { open: '09:00', close: '17:00', closed: true } }],
      ['{open, close, is_open:false}', { wednesday: { open: '09:00', close: '17:00', is_open: false } }],
    ];
    for (const [name, hours] of closedDays) {
      it(`closed day ${name} is rejected (day_unavailable)`, async () => {
        const biz = await business(hours);
        await expect(bookErr(biz, await resource(biz), WED, '12:00'))
          .rejects.toThrow(/^day_unavailable:The business is closed on Wednesday$/);
      });
    }

    const noUsableHours: Array<[string, unknown]> = [
      ['{} hours', {}],
      ['day missing', { monday: { open: '09:00', close: '17:00' } }],
      ['12-hour strings', { wednesday: { open: '9am', close: '5pm' } }],
      ['missing close', { wednesday: { open: '09:00' } }],
      ['closed as string "true"', { wednesday: { open: '09:00', close: '17:00', closed: 'true' } }],
      ['day is a string', { wednesday: '09:00-17:00' }],
    ];
    for (const [name, hours] of noUsableHours) {
      it(`no usable hours (${name}) accepts as before: 03:00 and 20:00 on Wednesday`, async () => {
        const biz = await business(hours);
        const res = await resource(biz);
        expect((await book(client, biz, res, WED, '03:00')).slot_available).toBe(true);
        expect((await book(client, biz, res, WED, '20:00')).slot_available).toBe(true);
      });
    }

    it("the table's own window still applies inside business hours", async () => {
      const biz = await business();
      await expect(bookErr(biz, await resource(biz, { from: '10:00' }), MON, '09:30')).rejects.toThrow(/^before_opening:Earliest reservation time is 10:00:00$/);
      await expect(bookErr(biz, await resource(biz, { to: '15:00' }), MON, '14:00')).rejects.toThrow(/^after_closing:Reservation would extend past closing time 15:00:00$/);
      const { rows: [r] } = await q(`INSERT INTO seating_resources (business_id, name, available_days) VALUES ($1, 'Weekend', '{saturday}') RETURNING id`, [biz]);
      await expect(bookErr(biz, { id: r.id, duration: 90, deposit: 0 }, MON, '10:00')).rejects.toThrow(/^day_unavailable:This resource is not available on Monday$/);
    });
  });

  describe('revised rule: the booking must fit inside the open time (D-1, D, D+1 joined)', () => {
    const NIGHT = { open: '22:00', close: '06:00' };
    const ALL_DAY = { open: '00:00', close: '00:00' };

    it('Mon 22:00-06:00, Tue closed: Tue 01:00 + 90 allowed (stored Tue 01:00); Tue 05:00 + 90 after_closing; Tue 06:30 day_unavailable', async () => {
      const biz = await business({ monday: NIGHT, tuesday: { closed: true } });
      const res = await resource(biz);
      const r = await book(client, biz, res, TUE, '01:00');
      expect(r.slot_available).toBe(true);
      expect((await q(`SELECT date::text, time::text FROM bookings WHERE id = $1`, [r.booking_id])).rows[0]).toEqual({ date: TUE, time: '01:00:00' });
      await expect(bookErr(biz, res, TUE, '05:00')).rejects.toThrow(/^after_closing:Reservation would extend past closing time 06:00$/);
      await expect(bookErr(biz, res, TUE, '06:30')).rejects.toThrow(/^day_unavailable:The business is closed on Tuesday$/);
    });

    it('Mon and Tue 22:00-06:00: Tue 06:30 is before_opening 22:00', async () => {
      const biz = await business({ monday: NIGHT, tuesday: NIGHT });
      await expect(bookErr(biz, await resource(biz), TUE, '06:30')).rejects.toThrow(/^before_opening:Earliest reservation time is 22:00$/);
    });

    it('Mon closed, Tue 22:00-06:00: Tue 01:00 is refused (before_opening 22:00)', async () => {
      const biz = await business({ monday: { closed: true }, tuesday: NIGHT });
      await expect(bookErr(biz, await resource(biz), TUE, '01:00')).rejects.toThrow(/^before_opening:Earliest reservation time is 22:00$/);
    });

    it('Mon 22:00-06:00, Tue 09:00-17:00: the gap is refused (07:00 before_opening 09:00, 18:00 day_unavailable)', async () => {
      const biz = await business({ monday: NIGHT, tuesday: { open: '09:00', close: '17:00' } });
      const res = await resource(biz);
      await expect(bookErr(biz, res, TUE, '07:00')).rejects.toThrow(/^before_opening:Earliest reservation time is 09:00$/);
      await expect(bookErr(biz, res, TUE, '18:00')).rejects.toThrow(/^day_unavailable:The business is not open at that time on Tuesday$/);
      expect((await book(client, biz, res, TUE, '04:00')).slot_available).toBe(true);
    });

    it('single 00:00/00:00 day (Sat has no hours): 23:30 + 90 after_closing 00:00, 23:00 + 60 allowed', async () => {
      const biz = await business({ friday: ALL_DAY });
      await expect(bookErr(biz, await resource(biz), FRI, '23:30')).rejects.toThrow(/^after_closing:Reservation would extend past closing time 00:00$/);
      expect((await book(client, biz, await resource(biz, { duration: 60 }), FRI, '23:00')).slot_available).toBe(true);
    });

    it('single 00:00/00:00 day followed by a closed day: 23:30 + 90 after_closing 00:00', async () => {
      const biz = await business({ friday: ALL_DAY, saturday: { closed: true } });
      await expect(bookErr(biz, await resource(biz), FRI, '23:30')).rejects.toThrow(/^after_closing:/);
    });

    it('consecutive 00:00/00:00 days join: Fri 23:30 + 90 allowed', async () => {
      const biz = await business({ friday: ALL_DAY, saturday: ALL_DAY });
      expect((await book(client, biz, await resource(biz), FRI, '23:30')).slot_available).toBe(true);
    });

    it('Fri 18:00-02:00 + Sat 02:00-06:00 join at 02:00', async () => {
      const biz = await business({ friday: LATE, saturday: { open: '02:00', close: '06:00' } });
      expect((await book(client, biz, await resource(biz, { duration: 300 }), FRI, '23:00')).slot_available).toBe(true); // to Sat 04:00
      expect((await book(client, biz, await resource(biz, { duration: 120 }), SAT, '01:30')).slot_available).toBe(true); // 01:30-03:30
      await expect(bookErr(biz, await resource(biz, { duration: 480 }), FRI, '23:30')).rejects.toThrow(/^after_closing:Reservation would extend past closing time 06:00$/);
      await expect(bookErr(biz, await resource(biz), SAT, '05:00')).rejects.toThrow(/^after_closing:Reservation would extend past closing time 06:00$/);
    });

    it('Fri 18:00-02:00 + Sat 03:00-06:00 do not join: Sat 01:30 + 60 after_closing 02:00, Sat 02:30 before_opening 03:00', async () => {
      const biz = await business({ friday: LATE, saturday: { open: '03:00', close: '06:00' } });
      await expect(bookErr(biz, await resource(biz, { duration: 60 }), SAT, '01:30')).rejects.toThrow(/^after_closing:Reservation would extend past closing time 02:00$/);
      await expect(bookErr(biz, await resource(biz), SAT, '02:30')).rejects.toThrow(/^before_opening:Earliest reservation time is 03:00$/);
    });

    it("no usable hours for the booking's own date means no check, even after an overnight day (Mon 22:00-06:00, Tue missing: Tue 12:00 allowed)", async () => {
      const biz = await business({ monday: NIGHT });
      expect((await book(client, biz, await resource(biz), TUE, '12:00')).slot_available).toBe(true);
    });
  });

  describe('overlap across D and D+1', () => {
    it('D 23:30-01:00 booked first blocks D+1 00:15', async () => {
      const biz = await business();
      const res = await resource(biz);
      expect((await book(client, biz, res, FRI, '23:30')).slot_available).toBe(true);
      expect(await book(client, biz, res, SAT, '00:15')).toEqual({ booking_id: null, reference_code: null, slot_available: false });
    });

    it('D+1 00:15 booked first blocks D 23:30-01:00', async () => {
      const biz = await business();
      const res = await resource(biz);
      expect((await book(client, biz, res, SAT, '00:15')).slot_available).toBe(true);
      expect((await book(client, biz, res, FRI, '23:30')).slot_available).toBe(false);
    });

    it('D-1 direction: Thursday 23:30-01:00 blocks Friday 00:30', async () => {
      // Friday without hours, so 00:30 Friday is itself a valid start
      const biz = await business({ thursday: LATE });
      const res = await resource(biz);
      expect((await book(client, biz, res, THU, '23:30')).slot_available).toBe(true);
      expect((await book(client, biz, res, FRI, '00:30')).slot_available).toBe(false);
    });

    it('back-to-back across midnight is allowed (D 23:30-01:00 then D+1 01:00)', async () => {
      const biz = await business();
      const res = await resource(biz);
      expect((await book(client, biz, res, FRI, '23:30')).slot_available).toBe(true);
      expect((await book(client, biz, res, SAT, '01:00')).slot_available).toBe(true);
    });

    it('a cancelled late booking does not block, and another table is independent', async () => {
      const biz = await business();
      const res = await resource(biz), other = await resource(biz);
      const first = await book(client, biz, res, FRI, '23:30');
      expect((await book(client, biz, other, SAT, '00:15')).slot_available).toBe(true);
      await q(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [first.booking_id]);
      expect((await book(client, biz, res, SAT, '00:15')).slot_available).toBe(true);
    });
  });

  it('concurrency: D 23:30 and D+1 00:15 on the same table in two sessions — exactly one wins', async () => {
    const biz = await business();
    const res = await resource(biz);
    const a = new pg.Client({ connectionString: targetUrl }); await a.connect();
    const b = new pg.Client({ connectionString: targetUrl }); await b.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const first = await book(a, biz, res, FRI, '23:30'); // holds the (business, resource) lock
      expect(first.slot_available).toBe(true);
      const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const second = book(b, biz, res, SAT, '00:15');
      // B must be waiting on the advisory lock even though its date differs
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        const { rows } = await q(`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [bPid]);
        waiting = rows[0]?.wait_event_type === 'Lock' && rows[0]?.wait_event === 'advisory';
        if (!waiting) await new Promise(r => setTimeout(r, 20));
      }
      expect(waiting).toBe(true);
      await a.query('COMMIT');
      expect((await second).slot_available).toBe(false);
      await b.query('COMMIT');
      const { rows } = await q(`SELECT date::text, time::text FROM bookings WHERE seating_resource_id = $1 AND status IN ('pending','confirmed','in_progress')`, [res.id]);
      expect(rows).toEqual([{ date: FRI, time: '23:30:00' }]);
    } finally {
      await a.end(); await b.end();
    }
  });

  it('idempotency: a retry of the same late selection returns the same booking', async () => {
    const biz = await business();
    const res = await resource(biz, { deposit: 2500 });
    const session = randomUUID();
    const first = await book(client, biz, res, FRI, '23:30', session);
    const retry = await book(client, biz, res, FRI, '23:30', session);
    expect(first.slot_available).toBe(true);
    expect(retry).toEqual(first);
    expect((await q(`SELECT count(*)::int AS n FROM bookings WHERE bot_session_id = $1`, [session])).rows[0].n).toBe(1);
  });

  it('service_role executes a late booking (INVOKER reads operating_hours with its own grants)', async () => {
    const biz = await business();
    const res = await resource(biz);
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      expect((await q('SELECT current_user AS u')).rows[0].u).toBe('service_role');
      expect((await book(client, biz, res, FRI, '23:30')).slot_available).toBe(true);
    } finally { await q('ROLLBACK'); }
  });

  for (const role of ['anon', 'authenticated']) {
    it(`${role} is denied EXECUTE (SQLSTATE 42501)`, async () => {
      const biz = await business();
      const res = await resource(biz);
      let code: string | undefined, message = '';
      await q('BEGIN');
      try {
        await q(`SET LOCAL ROLE ${role}`);
        expect((await q('SELECT current_user AS u')).rows[0].u).toBe(role);
        await book(client, biz, res, FRI, '23:30');
      } catch (err) {
        code = (err as { code?: string }).code; message = (err as Error).message;
      } finally { await q('ROLLBACK'); }
      expect(code).toBe('42501');
      expect(message).toMatch(/permission denied for function book_table_atomic/);
    });
  }

  it('book_slot_atomic is untouched by 510 and still books (smoke)', async () => {
    expect((await q(`SELECT md5(prosrc) AS h FROM pg_proc WHERE proname = 'book_slot_atomic'`)).rows[0].h).toBe(slotSrcBefore);
    const biz = await business();
    const { rows: [r] } = await q(
      `SELECT * FROM book_slot_atomic($1, $2, NULL, NULL, $3::date, '19:00', 1, 1, 'scheduling', 0, 'none', 'confirmed', 'Svc', '+1', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`,
      [biz, userId, FRI],
    );
    expect(r.slot_available).toBe(true);
    expect(r.booking_id).toBeTruthy();
  });
});
