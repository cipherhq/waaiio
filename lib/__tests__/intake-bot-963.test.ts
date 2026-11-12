/**
 * #963 lane 3: the bot's before-booking intake step (scheduling flow
 * `intake_form`), run step by step against an in-memory database.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDb } from './helpers/intake-fake-db';

const env = vi.hoisted(() => ({ tier: 'growth' as string }));
vi.mock('@/lib/trial-status', () => ({ resolveLimitTier: async () => env.tier }));

import { schedulingFlow } from '@/lib/bot/flows/scheduling.flow';
import type { FlowContext, PromptButtons } from '@/lib/bot/flows/types';

type Row = Record<string, unknown>;
const step = (id: string) => schedulingFlow.steps.find(s => s.id === id)!;
const intake = step('intake_form');
const BIZ = 'b1';
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

function setup(over: { service?: Row; form?: Row; intakes?: Row[]; data?: Row } = {}) {
  const db = makeDb({
    services: [{ id: 's1', business_id: BIZ, intake_form_id: 'f1', intake_timing: 'before_booking', intake_frequency: 'every_booking', ...over.service }],
    forms: [{ id: 'f1', business_id: BIZ, title: 'Intake', is_active: true, fields: [{ id: 'q', type: 'text', required: true }], ...over.form }],
    booking_intakes: over.intakes || [],
    // An earlier WhatsApp booking of this client.
    bookings: [{ id: 'k-prev', business_id: BIZ, metadata: {} }],
  });
  const ctx = {
    supabase: db,
    from: '2348012345678',
    session: { id: 'sess', business_id: BIZ, current_step: 'intake_form', session_data: { service_id: 's1', ...over.data }, version: 1 },
    business: { id: BIZ, name: 'Healing Labs', subscription_tier: 'growth', metadata: {} },
    copyLang: 'en',
    t: async (s: string) => s,
  } as unknown as FlowContext;
  return { db, ctx };
}
const linkOf = (body: string) => /\/intake\/([A-Za-z0-9_-]+)/.exec(body)?.[1];

beforeEach(() => { env.tier = 'growth'; });

describe('flow wiring', () => {
  it('runs after the pre-booking questions and continues to select_delivery', async () => {
    const { ctx } = setup();
    expect(await step('pre_booking_questions').next(ctx)).toBe('intake_form');
    expect(await intake.next(ctx)).toBe('select_delivery');
  });
});

describe('when the step applies (skipIf)', () => {
  it('applies to a before-booking form for an entitled business', async () => {
    expect(await intake.skipIf!(setup().ctx)).toBe(false);
  });

  it.each([
    ['no form linked', { service: { intake_form_id: null } }],
    ['after-booking form', { service: { intake_timing: 'after_booking' } }],
    ['appointment booking', { data: { _is_appointment: true } }],
    ['table booking', { data: { _is_table_reservation: true } }],
    ['class booking', { service: { is_class: true } }],
    ['no service chosen', { data: { service_id: undefined } }],
    ['inactive form', { form: { is_active: false } }],
    ['form with a required file question', { form: { fields: [{ id: 'x', type: 'file', required: true }] } }],
    ['already answered in this session', { data: { _intake_done_key: 's1:f1' } }],
    ['rescheduling an existing booking', { data: { _reschedule_booking_id: 'k0' } }],
    ['first booking only and answered before', {
      service: { intake_frequency: 'first_booking' },
      intakes: [{ id: 'old', business_id: BIZ, form_id: 'f1', customer_phone: '+2348012345678', status: 'submitted', booking_id: 'k-prev' }],
    }],
  ])('is skipped: %s', async (_n, over) => {
    expect(await intake.skipIf!(setup(over as never).ctx)).toBe(true);
  });

  it('is skipped for a Starter business after its trial', async () => {
    env.tier = 'free';
    expect(await intake.skipIf!(setup().ctx)).toBe(true);
  });
});

describe('in the executor\'s order (skipIf runs before validate)', () => {
  it('first booking only: the client\'s own fresh answers do not skip the step before they are recorded', async () => {
    const { db, ctx } = setup({ service: { intake_frequency: 'first_booking' } });
    expect(await intake.skipIf!(ctx)).toBe(false);
    await intake.prompt(ctx);
    db.tables.booking_intakes[0].status = 'submitted';
    // Client taps "I've filled it": the executor asks skipIf first.
    expect(await intake.skipIf!(ctx)).toBe(false);
    const r = await intake.validate('intake_done', ctx);
    expect(r).toEqual({ valid: true, data: { _intake_done_key: 's1:f1' } });
    Object.assign(ctx.session.session_data, r.data);
    expect(await intake.skipIf!(ctx)).toBe(true);
  });

  it('a later booking of a first-booking-only form is skipped because of the earlier answer', async () => {
    const { ctx } = setup({
      service: { intake_frequency: 'first_booking' },
      intakes: [{ id: 'earlier', business_id: BIZ, form_id: 'f1', customer_phone: '+2348012345678', status: 'submitted', booking_id: 'k-prev' }],
    });
    expect(await intake.skipIf!(ctx)).toBe(true);
  });
});

describe('asking and waiting', () => {
  it('sends the private link with the two buttons, protected from translation', async () => {
    const { db, ctx } = setup();
    const [msg] = await intake.prompt(ctx);
    const buttons = msg as PromptButtons & { _localization?: { protectedValues?: string[] } };
    expect(buttons.type).toBe('buttons');
    expect(buttons.buttons.map(b => b.id)).toEqual(['intake_done', 'intake_new_link']);
    const token = linkOf(buttons.body)!;
    expect(token).toBeTruthy();
    expect(buttons._localization?.protectedValues?.some(v => v.endsWith(`/intake/${token}`))).toBe(true);
    const [row] = db.tables.booking_intakes;
    expect(row).toMatchObject({ timing: 'before_booking', customer_phone: '+2348012345678', token_hash: sha(token) });
    expect(ctx.session.session_data).toMatchObject({ _intake_id: row.id, _intake_key: 's1:f1' });
    expect(JSON.stringify(ctx.session.session_data)).not.toContain(token);
  });

  it('keeps the same link while it is pending (a client may still have it open)', async () => {
    const { db, ctx } = setup();
    const [first] = await intake.prompt(ctx);
    const hash = db.tables.booking_intakes[0].token_hash;
    const [again] = await intake.prompt(ctx);
    expect(linkOf((again as PromptButtons).body)).toBeUndefined();
    expect((again as PromptButtons).body).toContain('message above');
    expect(db.tables.booking_intakes).toHaveLength(1);
    expect(db.tables.booking_intakes[0].token_hash).toBe(hash);
    expect(linkOf((first as PromptButtons).body)).toBeTruthy();
  });

  it('"I\'ve filled it" before submitting waits, without moving on', async () => {
    const { ctx } = setup();
    await intake.prompt(ctx);
    const r = await intake.validate('intake_done', ctx);
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain('not received your answers');
  });

  it('moves on once the answers are in, and the step is then skipped', async () => {
    const { db, ctx } = setup();
    await intake.prompt(ctx);
    db.tables.booking_intakes[0].status = 'submitted';
    const r = await intake.validate('intake_done', ctx);
    expect(r).toEqual({ valid: true, data: { _intake_done_key: 's1:f1' } });
    Object.assign(ctx.session.session_data, r.data);
    expect(await intake.skipIf!(ctx)).toBe(true);
  });

  it('"Send a new link" rotates the link on the same row', async () => {
    const { db, ctx } = setup();
    const [first] = await intake.prompt(ctx);
    const r = await intake.validate('intake_new_link', ctx);
    expect(r).toMatchObject({ valid: false, persistSessionDataOnFailure: true });
    const [second] = await intake.prompt(ctx);
    const t1 = linkOf((first as PromptButtons).body)!;
    const t2 = linkOf((second as PromptButtons).body)!;
    expect(t2).toBeTruthy();
    expect(t2).not.toBe(t1);
    expect(db.tables.booking_intakes).toHaveLength(1);
    expect(db.tables.booking_intakes[0].token_hash).toBe(sha(t2));
    expect(ctx.session.session_data._intake_force_new).toBeUndefined();
  });

  it('"Send a new link" after the answers are in just moves on (answers are kept)', async () => {
    const { db, ctx } = setup();
    await intake.prompt(ctx);
    db.tables.booking_intakes[0].status = 'submitted';
    expect(await intake.validate('intake_new_link', ctx)).toEqual({ valid: true, data: { _intake_done_key: 's1:f1' } });
    expect(db.tables.booking_intakes).toHaveLength(1);
  });

  it('keeps the link when the intake cannot be read just now', async () => {
    const { db, ctx } = setup();
    await intake.prompt(ctx);
    const hash = db.tables.booking_intakes[0].token_hash;
    const original = db.from;
    (db as { from: unknown }).from = (t: string) => {
      const q = original(t) as Record<string, unknown>;
      if (t === 'booking_intakes') q.maybeSingle = async () => ({ data: null, error: { code: 'XX' } });
      return q;
    };
    const [msg] = await intake.prompt(ctx);
    expect((msg as PromptButtons).body).toContain('message above');
    (db as { from: unknown }).from = original;
    expect(db.tables.booking_intakes[0].token_hash).toBe(hash);
  });

  it('going "back" to the step after it is done says so instead of an error', async () => {
    const { ctx } = setup({ data: { _intake_done_key: 's1:f1' } });
    const [msg] = await intake.prompt(ctx);
    expect(msg).toEqual({ type: 'text', text: '✅ We already have your answers. Send any message to continue.' });
  });

  it('a re-prompt after the answers are in records them and opens no second intake', async () => {
    const { db, ctx } = setup();
    await intake.prompt(ctx);
    db.tables.booking_intakes[0].status = 'submitted';
    const [msg] = await intake.prompt(ctx);
    expect(msg).toEqual({ type: 'text', text: '✅ We already have your answers. Send any message to continue.' });
    expect(db.tables.booking_intakes).toHaveLength(1);
    expect(ctx.session.session_data._intake_done_key).toBe('s1:f1');
    expect(await intake.skipIf!(ctx)).toBe(true);
  });

  it('when the step stops applying mid-way, any reply moves on and the text claims no answers', async () => {
    const { db, ctx } = setup();
    await intake.prompt(ctx);
    db.tables.forms[0].is_active = false;
    expect(await intake.validate('hello', ctx)).toEqual({ valid: true, data: {} });
    const [msg] = await intake.prompt(ctx);
    expect(msg).toEqual({ type: 'text', text: '✅ All set. Send any message to continue.' });
  });

  it('an expired link is replaced automatically', async () => {
    const { db, ctx } = setup();
    await intake.prompt(ctx);
    db.tables.booking_intakes[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await intake.validate('intake_done', ctx);
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain('expired');
    const [next] = await intake.prompt(ctx);
    expect(linkOf((next as PromptButtons).body)).toBeTruthy();
    expect(db.tables.booking_intakes).toHaveLength(1);
  });

  it('a form switched for another service gets a fresh intake, not the old one', async () => {
    const { db, ctx } = setup({ data: { _intake_id: 'other', _intake_key: 's9:f9' } });
    db.tables.booking_intakes.push({ id: 'other', business_id: BIZ, form_id: 'f9', status: 'pending', expires_at: new Date(Date.now() + 1e6).toISOString(), booking_id: null });
    const [msg] = await intake.prompt(ctx);
    expect(linkOf((msg as PromptButtons).body)).toBeTruthy();
    expect(ctx.session.session_data._intake_key).toBe('s1:f1');
    expect(ctx.session.session_data._intake_id).not.toBe('other');
  });
});

describe('saved bot transcript', () => {
  it('keeps "[token]" in conversation_log while the client still gets the full link', async () => {
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const token = 'Ab3dEf_ghIjKlMnOpQrStUvWxYz0123456789-xy';
    const session: { conversation_log: Array<{ role: string; content: string }> } = { conversation_log: [] };
    const messages = [
      { type: 'buttons', body: `Please fill in https://www.waaiio.com/intake/${token}`, buttons: [{ id: 'intake_done', title: "I've filled it" }] },
      { type: 'text', text: `Booked!\n\nPlease fill in https://www.waaiio.com/intake/${token}\n\nWhat next?` },
    ];
    (FlowExecutor.prototype as unknown as { logPromptMessages(s: unknown, m: unknown): void }).logPromptMessages.call({}, session, messages);
    expect(JSON.stringify(session.conversation_log)).not.toContain(token);
    expect(session.conversation_log[0].content).toContain('/intake/[token]');
    expect(messages[0].body).toContain(token);
  });
});

describe('executor: after-send step', () => {
  async function send(fail: boolean) {
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const afterSend = vi.fn(async () => true);
    const sender = { sendText: vi.fn(async () => { if (fail) throw new Error('rejected'); return { success: true }; }) };
    const self = { sendSingleMessage: (FlowExecutor.prototype as unknown as { sendSingleMessage: unknown }).sendSingleMessage, sender };
    await (FlowExecutor.prototype as unknown as { sendMessages(...a: unknown[]): Promise<void> }).sendMessages.call(
      self, '2348012345678', [{ type: 'text', text: 'Booked!', _afterSend: afterSend }], undefined, {}, sender,
    );
    return afterSend;
  }
  it('runs once after WhatsApp accepted the message', async () => {
    expect(await send(false)).toHaveBeenCalledTimes(1);
  });
  it('never runs when the message was not delivered', async () => {
    expect(await send(true)).not.toHaveBeenCalled();
  });
});
