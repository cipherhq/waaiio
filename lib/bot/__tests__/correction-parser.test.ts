import { describe, it, expect } from 'vitest';
import { detectCorrection, applyCorrection } from '../correction-parser';
import type { BotSession } from '../bot-types';
import type { CorrectionResult } from '../conversation-types';

const activeSession: BotSession = {
  id: 'sess-1',
  whatsapp_number: '2348000000000',
  user_id: null,
  business_id: 'biz-1',
  current_step: 'select_date',
  session_data: {
    selected_date: 'thursday',
    selected_time: '2pm',
    party_size: 2,
    selected_service_id: 'svc-1',
  },
  is_active: true,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  version: 1,
};

const inactiveSession: BotSession = {
  ...activeSession,
  is_active: false,
  current_step: '',
};

describe('detectCorrection', () => {
  it('detects "actually Friday" as date correction', () => {
    const result = detectCorrection('actually Friday', activeSession);
    expect(result).not.toBeNull();
    expect(result!.field).toBe('date');
    expect(result!.newValue).toBe('friday');
    expect(result!.oldValue).toBe('thursday');
  });

  it('detects "change to tomorrow" as date correction', () => {
    const result = detectCorrection('change to tomorrow', activeSession);
    expect(result).not.toBeNull();
    expect(result!.field).toBe('date');
    expect(result!.newValue).toBe('tomorrow');
  });

  it('detects "for 4 people" as quantity correction', () => {
    const result = detectCorrection('for 4 people', activeSession);
    expect(result).not.toBeNull();
    expect(result!.field).toBe('quantity');
    expect(result!.newValue).toBe(4);
    expect(result!.oldValue).toBe(2);
  });

  it('detects "I meant 4 PM" as time correction', () => {
    const result = detectCorrection('I meant 4 PM', activeSession);
    expect(result).not.toBeNull();
    expect(result!.field).toBe('time');
    expect(result!.newValue).toBe('4 PM');
  });

  it('detects "not that service" as service rejection', () => {
    const result = detectCorrection('not that service', activeSession);
    expect(result).not.toBeNull();
    expect(result!.field).toBe('service');
    expect(result!.newValue).toBeNull();
    expect(result!.oldValue).toBe('svc-1');
  });

  it('detects "same as last time" as repeat_last', () => {
    const result = detectCorrection('same as last time', activeSession);
    expect(result).not.toBeNull();
    expect(result!.field).toBe('repeat_last');
    expect(result!.newValue).toBe(true);
  });

  it('returns null for normal input ("tomorrow")', () => {
    const result = detectCorrection('tomorrow', activeSession);
    expect(result).toBeNull();
  });

  it('returns null when no active session', () => {
    const result = detectCorrection('actually Friday', inactiveSession);
    expect(result).toBeNull();
  });

  it('has confidence of 0.90 for detected corrections', () => {
    const result = detectCorrection('actually Friday', activeSession);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.90);
  });
});

describe('applyCorrection', () => {
  const sessionData: Record<string, unknown> = {
    selected_date: 'thursday',
    selected_time: '2pm',
    party_size: 2,
    selected_service_id: 'svc-1',
  };

  it('updates the correct session field', () => {
    const correction: CorrectionResult = {
      field: 'date',
      oldValue: 'thursday',
      newValue: 'friday',
      confidence: 0.90,
    };

    const updated = applyCorrection(sessionData, correction);
    expect(updated.selected_date).toBe('friday');
  });

  it('preserves other session data', () => {
    const correction: CorrectionResult = {
      field: 'date',
      oldValue: 'thursday',
      newValue: 'friday',
      confidence: 0.90,
    };

    const updated = applyCorrection(sessionData, correction);
    expect(updated.selected_time).toBe('2pm');
    expect(updated.party_size).toBe(2);
    expect(updated.selected_service_id).toBe('svc-1');
  });

  it('handles null newValue (service rejection clears field)', () => {
    const correction: CorrectionResult = {
      field: 'service',
      oldValue: 'svc-1',
      newValue: null,
      confidence: 0.90,
    };

    const updated = applyCorrection(sessionData, correction);
    expect(updated.selected_service_id).toBeUndefined();
    // Other fields remain
    expect(updated.selected_date).toBe('thursday');
  });

  it('does not mutate original session data', () => {
    const original = { ...sessionData };
    const correction: CorrectionResult = {
      field: 'date',
      oldValue: 'thursday',
      newValue: 'friday',
      confidence: 0.90,
    };

    applyCorrection(sessionData, correction);
    expect(sessionData.selected_date).toBe(original.selected_date);
  });
});
