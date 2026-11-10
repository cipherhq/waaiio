/**
 * #963 lane 2: server check of client intake answers, and the service
 * payload's intake fields.
 */
import { describe, expect, it } from 'vitest';
import { answerableFields, checkIntakeAnswers } from '@/lib/intake/answers';
import { buildServicePayload, type ServiceFormInput } from '@/lib/services/payload-builders';

const FIELDS = [
  { id: 'concern', label: 'Main concern', type: 'textarea', required: true },
  { id: 'agree', label: 'I agree', type: 'checkbox', required: true },
  { id: 'freq', label: 'How often', type: 'select', required: false, options: ['Daily', 'Weekly'] },
  { id: 'mood', label: 'Mood', type: 'radio', required: false, options: ['Good', 'Low'] },
  { id: 'meds', label: 'Medication', type: 'multi_select', required: false, options: ['None', 'Other'] },
  { id: 'age', label: 'Age', type: 'number', required: false },
  { id: 'mail', label: 'Email', type: 'email', required: false },
  { id: 'tel', label: 'Phone', type: 'phone', required: false },
  { id: 'dob', label: 'Date of birth', type: 'date', required: false },
];
const VALID = { concern: 'Sleep', agree: true };

describe('checkIntakeAnswers', () => {
  it('accepts valid answers and drops empty optional ones', () => {
    const r = checkIntakeAnswers(FIELDS, { ...VALID, freq: 'Daily', mood: 'Low', meds: ['None'], age: '34', mail: 'a@b.co', tel: '+234 801 234 5678', dob: '1990-05-01', mail2: undefined });
    expect(r.ok).toBe(false); // mail2 is not a field
    const ok = checkIntakeAnswers(FIELDS, { ...VALID, freq: 'Daily', meds: [], age: '' });
    expect(ok).toEqual({ ok: true, answers: { concern: 'Sleep', agree: true, freq: 'Daily' } });
  });

  it('applies the database "missing" rule to required answers', () => {
    for (const bad of [{ agree: true }, { concern: '', agree: true }, { concern: 'x', agree: false }, { concern: 'x' }]) {
      const r = checkIntakeAnswers(FIELDS, bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/is required/);
    }
  });

  it('rejects wrong types, options outside the list, and malformed values', () => {
    const cases: Array<Record<string, unknown>> = [
      { freq: 'Monthly' }, { mood: ['Good'] }, { meds: ['None', 'None'] }, { meds: ['Nope'] }, { meds: 'None' },
      { age: 'abc' }, { age: {} }, { mail: 'not-an-email' }, { tel: 'call me' }, { dob: '01/05/1990' },
      { agree: 'yes' }, { concern: 42 }, { concern: 'x'.repeat(5001) },
    ];
    for (const extra of cases) {
      expect(checkIntakeAnswers(FIELDS, { ...VALID, ...extra }).ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it('rejects unknown field ids and non-object answers', () => {
    expect(checkIntakeAnswers(FIELDS, { ...VALID, extra: 'x' }).ok).toBe(false);
    for (const bad of [null, [], 'x', 5]) expect(checkIntakeAnswers(FIELDS, bad).ok).toBe(false);
  });

  it('refuses a form whose file question is required, and never accepts a file answer', () => {
    const withFile = [...FIELDS, { id: 'scan', label: 'Scan', type: 'file', required: true }];
    expect(checkIntakeAnswers(withFile, VALID).ok).toBe(false);
    const optionalFile = [...FIELDS, { id: 'scan', label: 'Scan', type: 'file', required: false }];
    expect(checkIntakeAnswers(optionalFile, VALID).ok).toBe(true);
    expect(checkIntakeAnswers(optionalFile, { ...VALID, scan: 'https://x' }).ok).toBe(false);
    expect(answerableFields(optionalFile).map(f => f.id)).not.toContain('scan');
  });

  it('ignores malformed field definitions', () => {
    expect(answerableFields([null, 'x', { label: 'no id', type: 'text' }, { id: '', type: 'text' }, FIELDS[0]]).map(f => f.id)).toEqual(['concern']);
    expect(answerableFields('nope')).toEqual([]);
  });
});

describe('buildServicePayload intake fields', () => {
  const base: ServiceFormInput = {
    businessId: 'b', name: 'Session', price: 0, price_is_variable: false, duration_minutes: 30, buffer_minutes: 0,
    deposit_amount: 0, status: 'active', sort_order: 0, billing_type: 'one_time', is_featured: false,
    requires_staff: false, staff_ids: [], allow_staff_selection: false, is_package: false, included_service_ids: [],
    quote_enabled: false, is_class: false,
  };

  it('sends no intake columns when the caller does not pass intake (existing callers unchanged)', () => {
    const p = buildServicePayload(base) as Record<string, unknown>;
    expect(Object.keys(p).filter(k => k.startsWith('intake_'))).toEqual([]);
  });

  it('sends the link, and clears timing and frequency when the form is removed', () => {
    expect(buildServicePayload({ ...base, intake: { form_id: 'f1', timing: 'after_booking', frequency: 'every_booking' } }))
      .toMatchObject({ intake_form_id: 'f1', intake_timing: 'after_booking', intake_frequency: 'every_booking' });
    expect(buildServicePayload({ ...base, intake: { form_id: null, timing: 'after_booking', frequency: 'every_booking' } }))
      .toMatchObject({ intake_form_id: null, intake_timing: null, intake_frequency: null });
  });
});
