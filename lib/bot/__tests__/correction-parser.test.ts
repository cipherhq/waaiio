import { describe, it, expect } from 'vitest';
import { detectCorrection, applyCorrection } from '../correction-parser';
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
    service_id: 'svc-1',
    selected_service_id: 'svc-1',
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
  it('detects "actually Friday" as date correction at a safe date step', () => {
    const result = detectCorrection('actually Friday', atStep('select_date'));
    expect(result).not.toBeNull();
    expect(result!.field).toBe('date');
    expect(result!.newValue).toBe('friday');
    expect(result!.oldValue).toBe('thursday');
  });

  it('detects "change to tomorrow" as date correction while choosing time', () => {
    const result = detectCorrection('change to tomorrow', atStep('select_time'));
    expect(result).not.toBeNull();
    expect(result!.field).toBe('date');
    expect(result!.newValue).toBe('tomorrow');
  });

  it('detects quantity correction only at the existing quantity authority step', () => {
    const result = detectCorrection('for 4 people', atStep('select_quantity'));
    expect(result).not.toBeNull();
    expect(result!.field).toBe('quantity');
    expect(result!.newValue).toBe(4);
    expect(result!.oldValue).toBe(2);
  });

  it('detects time correction only at the existing time authority step', () => {
    const result = detectCorrection('I meant 4 PM', atStep('select_time'));
    expect(result).not.toBeNull();
    expect(result!.field).toBe('time');
    expect(result!.newValue).toBe('4pm');
  });

  it('detects service rejection at the service selection step', () => {
    const result = detectCorrection('not that service', atStep('select_service'));
    expect(result).not.toBeNull();
    expect(result!.field).toBe('service');
    expect(result!.newValue).toBeNull();
    expect(result!.oldValue).toBe('svc-1');
  });

  it('detects "same as last time" as repeat_last without inventing transaction authority', () => {
    const result = detectCorrection('same as last time', atStep('select_date'));
    expect(result).not.toBeNull();
    expect(result!.field).toBe('repeat_last');
    expect(result!.newValue).toBe(true);
  });

  it('returns null for normal input ("tomorrow")', () => {
    expect(detectCorrection('tomorrow', atStep('select_date'))).toBeNull();
  });

  it('fails closed for a date edit after the flow has reached confirmation', () => {
    expect(detectCorrection('change to tomorrow', atStep('confirm_booking'))).toBeNull();
  });

  it('fails closed for a quantity edit outside the quantity authority step', () => {
    expect(detectCorrection('make it 4 people', atStep('review_booking'))).toBeNull();
  });

  it('returns null when no active session', () => {
    expect(detectCorrection('actually Friday', inactiveSession)).toBeNull();
  });

  it('has confidence of 0.90 for detected corrections', () => {
    const result = detectCorrection('actually Friday', atStep('select_date'));
    expect(result?.confidence).toBe(0.90);
  });
});

describe('applyCorrection', () => {
  const sessionData: Record<string, unknown> = {
    active_capability: 'scheduling',
    date: 'thursday',
    selected_date: 'thursday',
    time: '2pm',
    selected_time: '2pm',
    party_size: 2,
    service_id: 'svc-1',
    selected_service_id: 'svc-1',
    _selected_slot: 'slot-1',
    _availability_snapshot: { ok: true },
  };

  it('updates date aliases and invalidates downstream time/availability state', () => {
    const correction: CorrectionResult = {
      field: 'date', oldValue: 'thursday', newValue: 'friday', confidence: 0.90,
    };
    const updated = applyCorrection(sessionData, correction);
    expect(updated.date).toBe('friday');
    expect(updated.selected_date).toBe('friday');
    expect(updated.time).toBeUndefined();
    expect(updated.selected_time).toBeUndefined();
    expect(updated._selected_slot).toBeUndefined();
    expect(updated._availability_snapshot).toBeUndefined();
    expect(updated.party_size).toBe(2);
  });

  it('updates time and invalidates stale slot/availability state', () => {
    const correction: CorrectionResult = {
      field: 'time', oldValue: '2pm', newValue: '4pm', confidence: 0.90,
    };
    const updated = applyCorrection(sessionData, correction);
    expect(updated.time).toBe('4pm');
    expect(updated.selected_time).toBe('4pm');
    expect(updated._selected_slot).toBeUndefined();
    expect(updated._availability_snapshot).toBeUndefined();
  });

  it('clears service and dependent scheduling authority', () => {
    const correction: CorrectionResult = {
      field: 'service', oldValue: 'svc-1', newValue: null, confidence: 0.90,
    };
    const updated = applyCorrection(sessionData, correction);
    expect(updated.service_id).toBeUndefined();
    expect(updated.selected_service_id).toBeUndefined();
    expect(updated.date).toBeUndefined();
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

  it('does not mutate original session data', () => {
    const original = structuredClone(sessionData);
    applyCorrection(sessionData, {
      field: 'date', oldValue: 'thursday', newValue: 'friday', confidence: 0.90,
    });
    expect(sessionData).toEqual(original);
  });
});
