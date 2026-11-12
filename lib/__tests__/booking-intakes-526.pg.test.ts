/**
 * M526 — link a form to a service (client intake), database lane (#963).
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * Fixture: minimal businesses / forms / form_responses / services / bookings
 * with the same owner RLS shape as production, plus an auth.uid() stub that
 * reads request.jwt.claim.sub. M526 is applied from disk as one whole-file
 * statement, twice (idempotency).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M526 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m526 = readFileSync('supabase/migrations/526_booking_intake_forms.sql', 'utf8');
const database = `m526_${randomUUID().replaceAll('-', '')}`;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

suite('M526 booking intake forms (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);

  /** Run fn inside a rolled-back transaction as role, optionally as a signed-in user. */
  async function as<T>(role: string, user: string | null, fn: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
      if (user) await q(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user]);
      await q(`SET LOCAL ROLE ${role}`);
      return await fn();
    } finally {
      await q('ROLLBACK');
    }
  }
  async function errorOf(fn: () => Promise<unknown>): Promise<{ message?: string; code?: string }> {
    try { await fn(); } catch (err) { return err as { message?: string; code?: string }; }
    return {};
  }

  const OWNER_A = randomUUID();
  const OWNER_B = randomUUID();
  const BIZ_PRO = randomUUID();      // Pro ('growth')
  const BIZ_STARTER = randomUUID();  // Starter, trial ended
  const BIZ_TRIAL = randomUUID();    // Starter, trial running
  const BIZ_OTHER = randomUUID();    // another owner's Premium business
  const FORM_PRO = randomUUID();
  const FORM_STARTER = randomUUID();
  const FORM_TRIAL = randomUUID();
  const FORM_OTHER = randomUUID();
  const SVC_PRO = randomUUID();
  const SVC_STARTER = randomUUID();
  const SVC_TRIAL = randomUUID();
  const SVC_OTHER = randomUUID();
  const BOOKING_PRO = randomUUID();
  const BOOKING_OTHER = randomUUID();

  const FIELDS = JSON.stringify([
    { id: 'concern', label: 'Main concern', type: 'textarea', required: true },
    { id: 'meds', label: 'Current medication', type: 'checkbox', required: true, options: ['None', 'Other'] },
    { id: 'notes', label: 'Anything else', type: 'text', required: false },
  ]);

  async function insertIntake(opts: { token?: string; booking?: string | null; expires?: string; business?: string; service?: string; form?: string } = {}) {
    const token = opts.token ?? newToken();
    const { rows } = await q(
      `INSERT INTO public.booking_intakes (business_id, service_id, form_id, booking_id, customer_phone, timing, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, '+2348012345678', 'after_booking', $5, ${opts.expires ?? `now() + interval '7 days'`})
       RETURNING id`,
      [opts.business ?? BIZ_PRO, opts.service ?? SVC_PRO, opts.form ?? FORM_PRO, opts.booking === undefined ? null : opts.booking, sha(token)],
    );
    return { id: rows[0].id as string, token };
  }

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query(`CREATE DATABASE ${database}`);
    const u = new URL(url!); u.pathname = `/${database}`;
    client = new pg.Client({ connectionString: u.toString() }); await client.connect();

    await q(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

      CREATE TABLE public.businesses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid,
        name text,
        subscription_tier text NOT NULL DEFAULT 'free',
        feature_trial_ends_at timestamptz
      );
      CREATE TABLE public.forms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        title varchar(200) NOT NULL,
        fields jsonb NOT NULL DEFAULT '[]'::jsonb,
        is_active boolean NOT NULL DEFAULT true,
        response_count integer NOT NULL DEFAULT 0
      );
      CREATE TABLE public.form_responses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        form_id uuid NOT NULL REFERENCES public.forms(id) ON DELETE CASCADE,
        business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        customer_phone varchar(30),
        customer_name varchar(200),
        customer_email varchar(200),
        answers jsonb NOT NULL DEFAULT '{}'::jsonb,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        submitted_at timestamptz NOT NULL DEFAULT now(),
        submission_source varchar(10) DEFAULT 'web' CHECK (submission_source IN ('web', 'native'))
      );
      CREATE TABLE public.services (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        name varchar NOT NULL,
        price integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE public.bookings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        service_id uuid,
        guest_phone text,
        date date NOT NULL DEFAULT current_date,
        time time NOT NULL DEFAULT '10:00',
        status text NOT NULL DEFAULT 'confirmed'
      );

      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.forms ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.form_responses ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_business ON public.businesses FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
      CREATE POLICY forms_owner ON public.forms FOR ALL TO authenticated
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      CREATE POLICY form_responses_owner_select ON public.form_responses FOR SELECT TO authenticated
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      CREATE POLICY "Owners manage own services" ON public.services FOR ALL TO authenticated
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
        WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      CREATE POLICY bookings_owner ON public.bookings FOR SELECT TO authenticated
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      CREATE POLICY service_all_b ON public.businesses FOR ALL TO service_role USING (true) WITH CHECK (true);
      CREATE POLICY service_all_f ON public.forms FOR ALL TO service_role USING (true) WITH CHECK (true);
      CREATE POLICY service_all_r ON public.form_responses FOR ALL TO service_role USING (true) WITH CHECK (true);
      CREATE POLICY service_all_s ON public.services FOR ALL TO service_role USING (true) WITH CHECK (true);
      CREATE POLICY service_all_k ON public.bookings FOR ALL TO service_role USING (true) WITH CHECK (true);
      GRANT SELECT ON public.businesses, public.forms, public.form_responses, public.bookings TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.services TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses, public.forms, public.form_responses, public.services, public.bookings TO service_role;
      -- Supabase grants new public tables to anon/authenticated by default; reproduce that so the
      -- migration's explicit revokes are what keep booking_intakes closed.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    `);

    await q(
      `INSERT INTO public.businesses (id, owner_id, name, subscription_tier, feature_trial_ends_at) VALUES
        ($1, $5, 'Pro', 'growth', NULL),
        ($2, $5, 'Starter', 'free', now() - interval '1 day'),
        ($3, $5, 'Trial', 'free', now() + interval '10 days'),
        ($4, $6, 'Other', 'business', NULL)`,
      [BIZ_PRO, BIZ_STARTER, BIZ_TRIAL, BIZ_OTHER, OWNER_A, OWNER_B],
    );
    await q(
      `INSERT INTO public.forms (id, business_id, title, fields) VALUES
        ($1, $5, 'Intake', $9), ($2, $6, 'Intake', $9), ($3, $7, 'Intake', $9), ($4, $8, 'Intake', $9)`,
      [FORM_PRO, FORM_STARTER, FORM_TRIAL, FORM_OTHER, BIZ_PRO, BIZ_STARTER, BIZ_TRIAL, BIZ_OTHER, FIELDS],
    );
    await q(
      `INSERT INTO public.services (id, business_id, name) VALUES ($1, $5, 'Session'), ($2, $6, 'Session'), ($3, $7, 'Session'), ($4, $8, 'Session')`,
      [SVC_PRO, SVC_STARTER, SVC_TRIAL, SVC_OTHER, BIZ_PRO, BIZ_STARTER, BIZ_TRIAL, BIZ_OTHER],
    );
    await q(
      `INSERT INTO public.bookings (id, business_id, service_id, guest_phone) VALUES ($1, $3, $4, '+2348012345678'), ($2, $5, $6, '+2348012345678')`,
      [BOOKING_PRO, BOOKING_OTHER, BIZ_PRO, SVC_PRO, BIZ_OTHER, SVC_OTHER],
    );

    await q(m526);
    await q(m526); // idempotent
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  const link = (svc: string, form: string | null, timing: string | null = 'before_booking', freq: string | null = 'first_booking') =>
    q(`UPDATE public.services SET intake_form_id = $2, intake_timing = $3, intake_frequency = $4 WHERE id = $1`, [svc, form, timing, freq]);

  describe('plan guard on services', () => {
    it('accepts Pro, Premium and an active trial', async () => {
      for (const [svc, form] of [[SVC_PRO, FORM_PRO], [SVC_TRIAL, FORM_TRIAL]]) {
        const r = await as('authenticated', OWNER_A, () => link(svc, form));
        expect(r.rowCount).toBe(1);
      }
      const premium = await as('authenticated', OWNER_B, () => link(SVC_OTHER, FORM_OTHER, 'after_booking', 'every_booking'));
      expect(premium.rowCount).toBe(1);
    });

    it('rejects Starter after the trial, for the owner and for the server', async () => {
      const owner = await errorOf(() => as('authenticated', OWNER_A, () => link(SVC_STARTER, FORM_STARTER)));
      expect(owner.code).toBe('42501');
      expect(owner.message).toContain('Pro or Premium');
      const server = await errorOf(() => as('service_role', null, () => link(SVC_STARTER, FORM_STARTER)));
      expect(server.code).toBe('42501');
      const insert = await errorOf(() => as('service_role', null, () => q(
        `INSERT INTO public.services (business_id, name, intake_form_id, intake_timing, intake_frequency) VALUES ($1, 'New', $2, 'before_booking', 'every_booking')`,
        [BIZ_STARTER, FORM_STARTER])));
      expect(insert.code).toBe('42501');
    });

    it('rejects another business form (composite foreign key)', async () => {
      const err = await errorOf(() => as('service_role', null, () => link(SVC_PRO, FORM_OTHER)));
      expect(err.code).toBe('23503');
    });

    it('requires a timing and a frequency, with known values', async () => {
      expect((await errorOf(() => as('service_role', null, () => link(SVC_PRO, FORM_PRO, null, 'first_booking')))).code).toBe('23514');
      expect((await errorOf(() => as('service_role', null, () => link(SVC_PRO, FORM_PRO, 'during', 'first_booking')))).code).toBe('23514');
      expect((await errorOf(() => as('service_role', null, () => link(SVC_PRO, FORM_PRO, 'after_booking', 'sometimes')))).code).toBe('23514');
    });

    it('after the trial ends, clearing a link and editing other fields still work', async () => {
      await link(SVC_TRIAL, FORM_TRIAL); // linked during the trial (fixture role bypasses nothing: business is in trial)
      await q(`UPDATE public.businesses SET feature_trial_ends_at = now() - interval '1 minute' WHERE id = $1`, [BIZ_TRIAL]);
      try {
        const edit = await as('authenticated', OWNER_A, () => q(
          `UPDATE public.services SET name = 'Renamed', price = 500, intake_form_id = intake_form_id WHERE id = $1`, [SVC_TRIAL]));
        expect(edit.rowCount).toBe(1);
        const change = await errorOf(() => as('authenticated', OWNER_A, () => link(SVC_TRIAL, FORM_TRIAL, 'after_booking', 'first_booking')));
        expect(change.code).toBe('42501');
        const clear = await as('authenticated', OWNER_A, () => link(SVC_TRIAL, null, null, null));
        expect(clear.rowCount).toBe(1);
      } finally {
        await q(`UPDATE public.businesses SET feature_trial_ends_at = now() + interval '10 days' WHERE id = $1`, [BIZ_TRIAL]);
      }
    });

    it('rejects Starter with no trial clock, and moving a linked service to a Starter business', async () => {
      await q(`UPDATE public.businesses SET feature_trial_ends_at = NULL WHERE id = $1`, [BIZ_STARTER]);
      try {
        expect((await errorOf(() => as('service_role', null, () => link(SVC_STARTER, FORM_STARTER)))).code).toBe('42501');
      } finally {
        await q(`UPDATE public.businesses SET feature_trial_ends_at = now() - interval '1 day' WHERE id = $1`, [BIZ_STARTER]);
      }
      // A Starter-owned copy of the Pro form id makes the composite FK pass, so only the guard can stop the move.
      await as('service_role', null, async () => {
        await link(SVC_PRO, FORM_PRO, 'after_booking', 'every_booking');
        await q(`INSERT INTO public.forms (id, business_id, title) SELECT gen_random_uuid(), $1, 'x'`, [BIZ_STARTER]);
        const moved = await errorOf(() => q(
          `UPDATE public.services SET business_id = $2, intake_form_id = (SELECT id FROM public.forms WHERE business_id = $2 AND title = 'x') WHERE id = $1`,
          [SVC_PRO, BIZ_STARTER]));
        expect(moved.code).toBe('42501');
      });
    });

    it('a service with no link is unaffected for Starter', async () => {
      const r = await as('authenticated', OWNER_A, () => q(`UPDATE public.services SET price = 900 WHERE id = $1`, [SVC_STARTER]));
      expect(r.rowCount).toBe(1);
    });

    it('deleting the form unlinks the service', async () => {
      const form = randomUUID();
      await q(`INSERT INTO public.forms (id, business_id, title, fields) VALUES ($1, $2, 'Temp', '[]')`, [form, BIZ_PRO]);
      await link(SVC_PRO, form, 'after_booking', 'every_booking');
      await q(`DELETE FROM public.forms WHERE id = $1`, [form]);
      const { rows } = await q(`SELECT intake_form_id FROM public.services WHERE id = $1`, [SVC_PRO]);
      expect(rows[0].intake_form_id).toBeNull();
    });
  });

  describe('booking_intakes integrity', () => {
    it('refuses another business service, form or booking', async () => {
      for (const opts of [{ service: SVC_OTHER }, { form: FORM_OTHER }, { booking: BOOKING_OTHER }]) {
        const err = await errorOf(() => as('service_role', null, () => insertIntake(opts)));
        expect(err.code, JSON.stringify(opts)).toBe('23503');
      }
    });

    it('refuses a second intake for the same booking and form', async () => {
      await as('service_role', null, async () => {
        await insertIntake({ booking: BOOKING_PRO });
        const err = await errorOf(() => insertIntake({ booking: BOOKING_PRO }));
        expect(err.code).toBe('23505');
      });
    });

    it('deleting a booking clears only booking_id; deleting a service removes its intakes', async () => {
      await as('service_role', null, async () => {
        const booking = randomUUID();
        await q(`INSERT INTO public.bookings (id, business_id, service_id, guest_phone) VALUES ($1, $2, $3, '+2348012345678')`, [booking, BIZ_PRO, SVC_PRO]);
        const kept = await insertIntake({ booking });
        await q(`DELETE FROM public.bookings WHERE id = $1`, [booking]);
        const row = (await q(`SELECT booking_id, business_id FROM public.booking_intakes WHERE id = $1`, [kept.id])).rows[0];
        expect(row).toEqual({ booking_id: null, business_id: BIZ_PRO });

        const svc = randomUUID();
        await q(`INSERT INTO public.services (id, business_id, name) VALUES ($1, $2, 'Temp')`, [svc, BIZ_PRO]);
        const gone = await insertIntake({ service: svc });
        await q(`DELETE FROM public.services WHERE id = $1`, [svc]);
        expect((await q(`SELECT 1 FROM public.booking_intakes WHERE id = $1`, [gone.id])).rows).toHaveLength(0);
      });
    });

    it('refuses a malformed token hash, phone, status or timing', async () => {
      const base = `INSERT INTO public.booking_intakes (business_id, service_id, form_id, customer_phone, timing, token_hash, status, expires_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 day')`;
      const good: unknown[] = [BIZ_PRO, SVC_PRO, FORM_PRO, '+2348012345678', 'after_booking', sha('x'), 'pending'];
      const bad: Array<[number, unknown]> = [[5, 'not-a-hash'], [3, '+23480 1234'], [6, 'done'], [4, 'later']];
      for (const [i, value] of bad) {
        const params = [...good]; params[i] = value;
        const err = await errorOf(() => as('service_role', null, () => q(base, params)));
        expect(err.code, String(value)).toBe('23514');
      }
    });
  });

  describe('RLS and grants', () => {
    it('the owner reads their own intakes; another owner and anon read nothing', async () => {
      const { id } = await insertIntake();
      try {
        const own = await as('authenticated', OWNER_A, () => q(`SELECT id FROM public.booking_intakes WHERE id = $1`, [id]));
        expect(own.rows).toHaveLength(1);
        const other = await as('authenticated', OWNER_B, () => q(`SELECT id FROM public.booking_intakes WHERE id = $1`, [id]));
        expect(other.rows).toHaveLength(0);
        const anon = await errorOf(() => as('anon', null, () => q(`SELECT id FROM public.booking_intakes`)));
        expect(anon.code).toBe('42501');
      } finally {
        await q(`DELETE FROM public.booking_intakes WHERE id = $1`, [id]);
      }
    });

    it('authenticated cannot insert, update or delete', async () => {
      const { id } = await insertIntake();
      try {
        const ins = await errorOf(() => as('authenticated', OWNER_A, () => insertIntake()));
        expect(ins.code).toBe('42501');
        const upd = await errorOf(() => as('authenticated', OWNER_A, () => q(`UPDATE public.booking_intakes SET status = 'submitted', submitted_at = now() WHERE id = $1`, [id])));
        expect(upd.code).toBe('42501');
        const del = await errorOf(() => as('authenticated', OWNER_A, () => q(`DELETE FROM public.booking_intakes WHERE id = $1`, [id])));
        expect(del.code).toBe('42501');
      } finally {
        await q(`DELETE FROM public.booking_intakes WHERE id = $1`, [id]);
      }
    });

    it('anon and authenticated cannot execute submit; service_role can', async () => {
      for (const role of ['anon', 'authenticated']) {
        for (const fn of ['public.submit_booking_intake_526', 'private.submit_booking_intake_526']) {
          const err = await errorOf(() => as(role, OWNER_A, () => q(`SELECT ${fn}($1, '{}'::jsonb)`, [newToken()])));
          expect(err.code, `${role} ${fn}`).toBe('42501');
          expect(err.message, `${role} ${fn}`).toMatch(/permission denied/);
        }
      }
      const svc = await errorOf(() => as('service_role', null, () => q(`SELECT public.submit_booking_intake_526($1, '{}'::jsonb)`, [newToken()])));
      expect(svc.message).toBe('Intake unavailable'); // reached the function: unknown token

      // The errors above can come from schema USAGE; check EXECUTE itself too.
      const privs = (await q(`
        SELECT r.role, f.fn, has_function_privilege(r.role, f.fn, 'EXECUTE') AS ok
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role),
               unnest(ARRAY['public.submit_booking_intake_526(text,jsonb)', 'private.submit_booking_intake_526(text,jsonb)',
                            'private.guard_service_intake_526()']) AS f(fn)`)).rows;
      for (const p of privs) {
        const expected = p.role === 'service_role' && p.fn.includes('submit');
        expect(p.ok, `${p.role} ${p.fn}`).toBe(expected);
      }
    });
  });

  describe('submit', () => {
    const submit = (token: string, answers: unknown) =>
      as('service_role', null, () => q(`SELECT public.submit_booking_intake_526($1, $2::jsonb) AS r`, [token, JSON.stringify(answers)]));
    const valid = { concern: 'Trouble sleeping', meds: ['None'] };

    it('rejects a wrong or short token', async () => {
      expect((await errorOf(() => submit(newToken(), valid))).code).toBe('42501');
      expect((await errorOf(() => submit('short', valid))).code).toBe('42501');
      expect((await errorOf(() => submit('x'.repeat(257), valid))).code).toBe('42501');
    });

    it('treats a required checkbox sent as false as missing, and skips a required field with no id', async () => {
      const form = randomUUID();
      await q(`INSERT INTO public.forms (id, business_id, title, fields) VALUES ($1, $2, 'Consent', $3)`, [form, BIZ_PRO, JSON.stringify([
        { id: 'consent', label: 'I agree', type: 'checkbox', required: true },
        { label: 'Broken field without id', type: 'text', required: true },
      ])]);
      const { token } = await insertIntake({ form });
      const err = await errorOf(() => submit(token, { consent: false }));
      expect(err.code).toBe('22023');
      expect(err.message).toBe('A required answer is missing');
      const ok = await submit(token, { consent: true });
      expect(ok.rows[0].r.already_submitted).toBe(false);
    });

    it('rejects an expired link', async () => {
      const { token, id } = await insertIntake();
      await q(`UPDATE public.booking_intakes SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1`, [id]);
      const err = await errorOf(() => submit(token, valid));
      expect(err.code).toBe('22023');
      expect(err.message).toBe('Intake link expired');
      const marked = await insertIntake();
      await q(`UPDATE public.booking_intakes SET status = 'expired' WHERE id = $1`, [marked.id]);
      expect((await errorOf(() => submit(marked.token, valid))).code).toBe('22023');
    });

    it('rejects missing required answers, unknown fields and a non-object', async () => {
      const { token } = await insertIntake();
      for (const answers of [{ concern: 'x' }, { concern: '', meds: ['None'] }, { concern: 'x', meds: [] }, { ...valid, extra: 'y' }, ['x']]) {
        const err = await errorOf(() => submit(token, answers));
        expect(err.code, JSON.stringify(answers)).toBe('22023');
      }
    });

    it('rejects an inactive form', async () => {
      const { token } = await insertIntake();
      await q(`UPDATE public.forms SET is_active = false WHERE id = $1`, [FORM_PRO]);
      try {
        expect((await errorOf(() => submit(token, valid))).code).toBe('42501');
      } finally {
        await q(`UPDATE public.forms SET is_active = true WHERE id = $1`, [FORM_PRO]);
      }
    });

    it('a valid submit saves one response with the intake phone; a repeat returns the same response', async () => {
      const { token, id } = await insertIntake({ booking: null });
      const before = (await q(`SELECT response_count FROM public.forms WHERE id = $1`, [FORM_PRO])).rows[0].response_count;

      await q('BEGIN');
      await q(`SET LOCAL ROLE service_role`);
      const first = (await q(`SELECT public.submit_booking_intake_526($1, $2::jsonb) AS r`, [token, JSON.stringify(valid)])).rows[0].r;
      const again = (await q(`SELECT public.submit_booking_intake_526($1, $2::jsonb) AS r`, [token, JSON.stringify({ concern: 'changed', meds: ['Other'] })])).rows[0].r;
      await q('COMMIT');

      expect(first.already_submitted).toBe(false);
      expect(again).toEqual({ status: 'submitted', form_response_id: first.form_response_id, already_submitted: true });

      const responses = (await q(`SELECT * FROM public.form_responses WHERE metadata->>'booking_intake_id' = $1`, [id])).rows;
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        id: first.form_response_id, form_id: FORM_PRO, business_id: BIZ_PRO,
        customer_phone: '+2348012345678', answers: valid, submission_source: 'web',
      });
      const intake = (await q(`SELECT status, submitted_at, form_response_id FROM public.booking_intakes WHERE id = $1`, [id])).rows[0];
      expect(intake.status).toBe('submitted');
      expect(intake.submitted_at).not.toBeNull();
      expect(intake.form_response_id).toBe(first.form_response_id);
      const after = (await q(`SELECT response_count FROM public.forms WHERE id = $1`, [FORM_PRO])).rows[0].response_count;
      expect(after).toBe(before + 1);

      // The owner can read it; the other business cannot.
      const own = await as('authenticated', OWNER_A, () => q(`SELECT id FROM public.form_responses WHERE id = $1`, [first.form_response_id]));
      expect(own.rows).toHaveLength(1);
      const other = await as('authenticated', OWNER_B, () => q(`SELECT id FROM public.form_responses WHERE id = $1`, [first.form_response_id]));
      expect(other.rows).toHaveLength(0);
    });

    it('two concurrent submits of one link save exactly one response', async () => {
      const { token, id } = await insertIntake();
      const u = new URL(url!); u.pathname = `/${database}`;
      const [c1, c2] = [new pg.Client({ connectionString: u.toString() }), new pg.Client({ connectionString: u.toString() })];
      await Promise.all([c1.connect(), c2.connect()]);
      try {
        const run = (c: pg.Client) => c.query(`SET ROLE service_role`).then(() =>
          c.query(`SELECT public.submit_booking_intake_526($1, $2::jsonb) AS r`, [token, JSON.stringify(valid)]));
        const [a, b] = await Promise.all([run(c1), run(c2)]);
        const flags = [a.rows[0].r.already_submitted, b.rows[0].r.already_submitted].sort();
        expect(flags).toEqual([false, true]);
        expect(a.rows[0].r.form_response_id).toBe(b.rows[0].r.form_response_id);
      } finally {
        await Promise.all([c1.end(), c2.end()]);
      }
      const n = (await q(`SELECT count(*)::int AS n FROM public.form_responses WHERE metadata->>'booking_intake_id' = $1`, [id])).rows[0].n;
      expect(n).toBe(1);
    });
  });

  describe('final catalog', () => {
    it('RLS on, one policy, functions hardened', async () => {
      const rls = (await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.booking_intakes'::regclass`)).rows[0];
      expect(rls.relrowsecurity).toBe(true);
      const policies = (await q(`SELECT policyname, cmd, roles::text FROM pg_policies WHERE tablename = 'booking_intakes'`)).rows;
      expect(policies).toEqual([{ policyname: 'booking_intakes_owner_select', cmd: 'SELECT', roles: '{authenticated}' }]);
      const fns = (await q(`
        SELECT p.oid::regprocedure::text AS sig, prosecdef, proconfig
          FROM pg_proc p WHERE p.oid IN ('private.submit_booking_intake_526(text,jsonb)'::regprocedure,
            'public.submit_booking_intake_526(text,jsonb)'::regprocedure, 'private.guard_service_intake_526()'::regprocedure)
         ORDER BY 1`)).rows;
      expect(fns).toEqual([
        { sig: 'private.guard_service_intake_526()', prosecdef: false, proconfig: ['search_path=pg_catalog'] },
        { sig: 'private.submit_booking_intake_526(text,jsonb)', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'] },
        { sig: 'submit_booking_intake_526(text,jsonb)', prosecdef: false, proconfig: ['search_path=pg_catalog'] },
      ]);
    });
  });
});
