import { describe, it, expect } from 'vitest';
import { detectCorrection, applyCorrection, prepareCorrectionReentry } from '../correction-parser';
import type { BotSession } from '../bot-types';
import type { CorrectionResult } from '../conversation-types';

const baseSession: BotSession = {
  id: 'sess-1',
  whatsapp_number: '2348000000000',
  user_id: null,
  business_id: 'biz-1',
  current_step: 'select_date',
  session_data: {
    active_capability: 'scheduling',
    date: 'thursday',
    selected_date: 'thursday',
    time: '2pm',
    selected_time: '2pm',
    party_size: 2,
    guest_list: [{ name: 'A' }, { name: 'B' }],
    service_id: 'svc-1',
    selected_service_id: 'svc-1',
    staff_id: 'staff-1',
    selected_slot_id: 'slot-old',
    _availability_snapshot: { ok: true },
    confirmation: true,
    _step_history: ['select_service', 'select_date', 'select_time', 'select_quantity', 'confirmation'],
  },
  is_active: true,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  version: 1,
};

function atStep(step: string, data: Record<string, unknown> = {}): BotSession {
  return {
    ...baseSession,
    current_step: step,
    session_data: { ...baseSession.session_data, ...data },
  };
}

const inactiveSession: BotSession = {
  ...baseSession,
  is_active: false,
  current_step: '',
};

describe('detectCorrection', () => {
  it('targets authoritative date selection for a concrete date correction', () => {
    const result = detectCorrection('actually Friday', atStep('select_date'));
    expect(result).toMatchObject({
      field: 'date',
      newValue: 'friday',
      oldValue: 'thursday',
      targetStep: 'select_date',
      confidence: 0.90,
    });
  });

  it('rewinds a date correction from time selection back to date authority', () => {
    const result = detectCorrection('change to tomorrow', atStep('select_time'));
    expect(result).toMatchObject({ field: 'date', newValue: 'tomorrow', targetStep: 'select_date' });
  });

  it('targets the existing time authority step', () => {
    const result = detectCorrection('I meant 4 PM', atStep('select_time'));
    expect(result).toMatchObject({ field: 'time', newValue: '4pm', targetStep: 'select_time' });
  });

  it('targets the existing quantity authority step', () => {
    const result = detectCorrection('for 4 people', atStep('select_quantity'));
    expect(result).toMatchObject({ field: 'quantity', newValue: 4, oldValue: 2, targetStep: 'select_quantity' });
  });

  it.each([
    ['change date', 'date', 'select_date'],
    ['yí ọjọ́ padà', 'date', 'select_date'],
    ['gbanwee ụbọchị', 'date', 'select_date'],
    ['canza rana', 'date', 'select_date'],
    ['changer la date', 'date', 'select_date'],
    ['cambiar fecha', 'date', 'select_date'],
  ] as const)('recognizes multilingual generic date reselection: %s', (text, field, targetStep) => {
    expect(detectCorrection(text, atStep('select_date'))).toMatchObject({ field, newValue: null, targetStep });
  });

  it('re-enters date authority from scheduling confirmation instead of failing closed', () => {
    expect(detectCorrection('change to Friday', atStep('confirmation'))).toMatchObject({
      field: 'date', newValue: 'friday', targetStep: 'select_date',
    });
  });

  it('re-enters time authority from scheduling confirmation', () => {
    expect(detectCorrection('change time to 4pm', atStep('confirmation'))).toMatchObject({
      field: 'time', newValue: '4pm', targetStep: 'select_time',
    });
  });

  it('re-enters quantity authority from scheduling confirmation', () => {
    expect(detectCorrection('make it 4 people', atStep('confirmation'))).toMatchObject({
      field: 'quantity', newValue: 4, targetStep: 'select_quantity',
    });
  });

  it('keeps payment and ordering review boundaries fail closed', () => {
    expect(detectCorrection('change to Friday', atStep('confirm_payment', { active_capability: 'payment' }))).toBeNull();
    expect(detectCorrection('make it 4 items', atStep('review_order_summary', { active_capability: 'ordering' }))).toBeNull();
    expect(detectCorrection('cambiar la talla', atStep('review_order_summary', { active_capability: 'ordering' }))).toBeNull();
  });

  it('targets service reselection only at the existing service authority step', () => {
    expect(detectCorrection('not that service', atStep('select_service'))).toMatchObject({
      field: 'service', newValue: null, targetStep: 'select_service',
    });
    expect(detectCorrection('not that service', atStep('confirmation'))).toBeNull();
  });

  it('targets variant reselection only at an existing variant authority step', () => {
    expect(detectCorrection('cambiar la talla', atStep('select_variant', { active_capability: 'ordering' }))).toMatchObject({
      field: 'variant', newValue: null, targetStep: 'select_variant',
    });
  });

  it('preserves targetless repeat intent without inventing transaction authority', () => {
    const result = detectCorrection('same as last time', atStep('select_date'));
    expect(result).toMatchObject({ field: 'repeat_last', newValue: true, confidence: 0.90 });
    expect(result?.targetStep).toBeUndefined();
  });

  it('returns null for normal input and inactive sessions', () => {
    expect(detectCorrection('tomorrow', atStep('select_date'))).toBeNull();
    expect(detectCorrection('actually Friday', inactiveSession)).toBeNull();
  });
});

describe('prepareCorrectionReentry', () => {
  it('clears date-dependent authority and trims history to select_date', () => {
    const updated = prepareCorrectionReentry(baseSession.session_data, {
      field: 'date', oldValue: 'thursday', newValue: 'friday', confidence: 0.90, targetStep: 'select_date',
    });

    expect(updated.date).toBeUndefined();
    expect(updated.selected_date).toBeUndefined();
    expect(updated.time).toBeUndefined();
    expect(updated.selected_time).toBeUndefined();
    expect(updated.staff_id).toBeUndefined();
    expect(updated.selected_slot_id).toBeUndefined();
    expect(updated._availability_snapshot).toBeUndefined();
    expect(updated.confirmation).toBeUndefined();
    expect(updated._step_history).toEqual(['select_service', 'select_date']);
  });

  it('clears quantity aliases, guest names and stale pricing snapshots', () => {
    const updated = prepareCorrectionReentry({
      ...baseSession.session_data,
      current_quantity: 2,
      quantity: 2,
      _price_snapshot: { total: 100 },
      _stock_snapshot: { ok: true },
    }, {
      field: 'quantity', oldValue: 2, newValue: 4, confidence: 0.90, targetStep: 'select_quantity',
    });

    expect(updated.party_size).toBeUndefined();
    expect(updated.current_quantity).toBeUndefined();
    expect(updated.quantity).toBeUndefined();
    expect(updated.guest_list).toBeUndefined();
    expect(updated._price_snapshot).toBeUndefined();
    expect(updated._stock_snapshot).toBeUndefined();
    expect(updated._step_history).toEqual(['select_service', 'select_date', 'select_time', 'select_quantity']);
  });

  it('does not apply the proposed value before authoritative validation', () => {
    const updated = prepareCorrectionReentry(baseSession.session_data, {
      field: 'time', oldValue: '2pm', newValue: '4pm', confidence: 0.90, targetStep: 'select_time',
    });
    expect(updated.time).toBeUndefined();
    expect(updated.selected_time).toBeUndefined();
  });

  it('does not mutate original session data', () => {
    const original = structuredClone(baseSession.session_data);
    prepareCorrectionReentry(baseSession.session_data, {
      field: 'date', oldValue: 'thursday', newValue: 'friday', confidence: 0.90, targetStep: 'select_date',
    });
    expect(baseSession.session_data).toEqual(original);
  });
});

describe('applyCorrection legacy behavior', () => {
  it('can still apply a concrete date value for targetless/legacy consumers', () => {
    const correction: CorrectionResult = {
      field: 'date', oldValue: 'thursday', newValue: 'friday', confidence: 0.90,
    };
    const updated = applyCorrection(baseSession.session_data, correction);
    expect(updated.date).toBe('friday');
    expect(updated.selected_date).toBe('friday');
    expect(updated.time).toBeUndefined();
  });

  it('uses capability-specific quantity storage', () => {
    const ordering = applyCorrection(
      { active_capability: 'ordering', current_quantity: 1 },
      { field: 'quantity', oldValue: 1, newValue: 3, confidence: 0.90 },
    );
    const ticketing = applyCorrection(
      { active_capability: 'ticketing', quantity: 1 },
      { field: 'quantity', oldValue: 1, newValue: 2, confidence: 0.90 },
    );
    expect(ordering.current_quantity).toBe(3);
    expect(ticketing.quantity).toBe(2);
  });
});
