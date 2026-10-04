import { describe, it, expect } from 'vitest';
import { detectCorrection, applyCorrection } from '../correction-parser';
import type { BotSession } from '../bot-types';
import type { CorrectionResult } from '../conversation-types';

const activeSession: BotSession = {
  id: 'sess-1',
  whatsapp_number: '2348000000000',
  user_id: null,
  business_id: 'biz-1',
  current_step: 'review_booking',
  session_data: {
    active_capability: 'scheduling',
    date: 'thursday',
    time: '2pm',
    party_size: 2,
    selected_service_id: 'svc-1',
    selected_slot_id: 'slot-old',
    availability: { ok: true },
    confirmation: true,
  },
  is_active: true,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  version: 1,
};

const inactiveSession: BotSession = { ...activeSession, is_active: false, current_step: '' };

describe('detectCorrection', () => {
  it('detects explicit date correction and targets authoritative date selection', () => {
    const result = detectCorrection('actually Friday', activeSession);
    expect(result).toMatchObject({ field: 'date', oldValue: 'thursday', newValue: 'friday', targetStep: 'select_date' });
  });

  it('detects explicit time correction and targets time validation', () => {
    const result = detectCorrection('I meant 4 PM', activeSession);
    expect(result).toMatchObject({ field: 'time', newValue: '4 pm', targetStep: 'select_time' });
  });

  it('detects explicit quantity correction and targets booking party size', () => {
    const result = detectCorrection('for 4 people', activeSession);
    expect(result).toMatchObject({ field: 'quantity', oldValue: 2, newValue: 4, targetStep: 'select_party_size' });
  });

  it.each([
    ['en', 'change date', 'date', 'select_date'],
    ['pcm', 'change date abeg', 'date', 'select_date'],
    ['yo', 'yí ọjọ́ padà', 'date', 'select_date'],
    ['ig', 'gbanwee ụbọchị', 'date', 'select_date'],
    ['ha', 'canza rana', 'date', 'select_date'],
    ['tw', 'sesa da', 'date', 'select_date'],
    ['fr', 'changer la date', 'date', 'select_date'],
    ['es', 'cambiar fecha', 'date', 'select_date'],
  ] as const)('recognizes safe date re-selection for %s', (_lang, text, field, targetStep) => {
    expect(detectCorrection(text, activeSession)).toMatchObject({ field, newValue: null, targetStep });
  });

  it.each([
    ['change service', 'service', 'select_service'],
    ['change service abeg', 'service', 'select_service'],
    ['yí iṣẹ́ padà', 'service', 'select_service'],
    ['gbanwee ọrụ', 'service', 'select_service'],
    ['canza sabis', 'service', 'select_service'],
    ['sesa service', 'service', 'select_service'],
    ['changer de service', 'service', 'select_service'],
    ['cambiar servicio', 'service', 'select_service'],
  ] as const)('recognizes multilingual service re-selection: %s', (text, field, targetStep) => {
    expect(detectCorrection(text, activeSession)).toMatchObject({ field, newValue: null, targetStep });
  });

  it('does not treat ordinary customer content as a correction', () => {
    expect(detectCorrection('Back Street Cafe tomorrow at 4', activeSession)).toBeNull();
  });

  it('returns null when no active session', () => {
    expect(detectCorrection('change date', inactiveSession)).toBeNull();
  });
});

describe('applyCorrection', () => {
  it('date correction invalidates downstream time/slot/availability/confirmation', () => {
    const updated = applyCorrection(activeSession.session_data, {
      field: 'date', oldValue: 'thursday', newValue: 'friday', confidence: 0.9, targetStep: 'select_date',
    });
    expect(updated.date).toBe('friday');
    expect(updated.time).toBeUndefined();
    expect(updated.selected_slot_id).toBeUndefined();
    expect(updated.availability).toBeUndefined();
    expect(updated.confirmation).toBeUndefined();
  });

  it('service re-selection clears service and dependent scheduling state', () => {
    const updated = applyCorrection(activeSession.session_data, {
      field: 'service', oldValue: 'svc-1', newValue: null, confidence: 0.9, targetStep: 'select_service',
    });
    expect(updated.selected_service_id).toBeUndefined();
    expect(updated.date).toBeUndefined();
    expect(updated.time).toBeUndefined();
    expect(updated.selected_slot_id).toBeUndefined();
  });

  it('quantity correction clears stale price/reservation/payment authority values', () => {
    const updated = applyCorrection({
      ...activeSession.session_data,
      price: 100,
      total_amount: 200,
      stock_reservation_id: 'stock-r1',
      payment_url: 'https://example.invalid/pay',
      payment_reference: 'ref-old',
    }, {
      field: 'quantity', oldValue: 2, newValue: 3, confidence: 0.9, targetStep: 'select_party_size',
    });
    expect(updated.party_size).toBe(3);
    expect(updated.price).toBeUndefined();
    expect(updated.total_amount).toBeUndefined();
    expect(updated.stock_reservation_id).toBeUndefined();
    expect(updated.payment_url).toBeUndefined();
    expect(updated.payment_reference).toBeUndefined();
  });

  it('does not mutate the original session data', () => {
    const original = { ...activeSession.session_data };
    applyCorrection(activeSession.session_data, {
      field: 'date', oldValue: 'thursday', newValue: 'friday', confidence: 0.9,
    });
    expect(activeSession.session_data).toEqual(original);
  });
});
