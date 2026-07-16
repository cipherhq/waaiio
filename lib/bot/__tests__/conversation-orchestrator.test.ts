import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BotSession } from '../bot-types';

// Mock smart-intent before importing orchestrator
vi.mock('../smart-intent', () => ({
  parseSmartIntentHybrid: vi.fn().mockResolvedValue({
    understood: true,
    intent: 'booking',
    date: 'tomorrow',
    specificTime: '3:00 PM',
    serviceKeywords: ['haircut'],
  }),
}));

// Mock logger to avoid side effects
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { ConversationOrchestrator } from '../conversation-orchestrator';
import { parseSmartIntentHybrid } from '../smart-intent';
import { DEFAULT_CONFIG } from '../conversation-types';

const mockSupabase = {} as never;

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new ConversationOrchestrator(mockSupabase, DEFAULT_CONFIG);
  });

  const activeSession: BotSession = {
    id: 'sess-1',
    whatsapp_number: '2348000000000',
    user_id: null,
    business_id: 'biz-1',
    current_step: 'select_service',
    session_data: { active_capability: 'scheduling' },
    is_active: true,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    version: 1,
  };

  it('returns correction intent when active session and correction pattern detected', async () => {
    const result = await orchestrator.understand(
      'actually Friday',
      'biz-1',
      'salon',
      activeSession,
      '2348000000000',
    );

    expect(result.intent).toBe('modify_existing');
    expect(result.recommendedAction).toBe('apply_correction');
    expect(result.corrections).toBeDefined();
    expect(result.corrections!.length).toBeGreaterThan(0);
    expect(result.corrections![0].field).toBe('date');
  });

  it('returns business_question for temporary questions during active flow', async () => {
    const result = await orchestrator.understand(
      'what time do you close?',
      'biz-1',
      'salon',
      activeSession,
      '2348000000000',
    );

    expect(result.intent).toBe('business_question');
    expect(result.recommendedAction).toBe('answer_business_question');
    expect(result.temporaryQuestion).toBeDefined();
    expect(result.temporaryQuestion!.type).toBe('hours');
  });

  it('returns appropriate intent for booking messages', async () => {
    vi.mocked(parseSmartIntentHybrid).mockResolvedValueOnce({
      understood: true,
      intent: 'booking',
      date: 'tomorrow',
      specificTime: '3:00 PM',
      serviceKeywords: ['haircut'],
    } as never);

    const result = await orchestrator.understand(
      'I need a haircut tomorrow',
      'biz-1',
      'salon',
      null,
      '2348000000000',
    );

    expect(result.intent).toBe('booking');
  });

  it('returns appropriate intent for ordering messages', async () => {
    vi.mocked(parseSmartIntentHybrid).mockResolvedValueOnce({
      understood: true,
      intent: 'ordering',
      date: null,
      specificTime: null,
      serviceKeywords: ['food'],
    } as never);

    const result = await orchestrator.understand(
      'I want to order food',
      'biz-1',
      'restaurant',
      null,
      '2348000000000',
    );

    expect(result.intent).toBe('ordering');
  });

  it('returns unknown for gibberish', async () => {
    vi.mocked(parseSmartIntentHybrid).mockResolvedValueOnce({
      understood: false,
      intent: null,
      date: null,
      specificTime: null,
      serviceKeywords: [],
    } as never);

    const result = await orchestrator.understand(
      'asdfghjkl qwerty',
      'biz-1',
      'salon',
      null,
      '2348000000000',
    );

    expect(result.intent).toBe('unknown');
  });

  it('confidence is high (>0.8) for clear regex matches with service keywords', async () => {
    vi.mocked(parseSmartIntentHybrid).mockResolvedValueOnce({
      understood: true,
      intent: 'booking',
      date: 'tomorrow',
      specificTime: '3:00 PM',
      serviceKeywords: ['haircut'],
    } as never);

    const result = await orchestrator.understand(
      'Book a haircut for tomorrow at 3pm',
      'biz-1',
      'salon',
      null,
      '2348000000000',
    );

    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('entities are extracted (date, time, service) from natural text', async () => {
    vi.mocked(parseSmartIntentHybrid).mockResolvedValueOnce({
      understood: true,
      intent: 'booking',
      date: 'tomorrow',
      specificTime: '3:00 PM',
      quantity: 2,
      serviceKeywords: ['haircut'],
    } as never);

    const result = await orchestrator.understand(
      'Book 2 haircuts for tomorrow at 3pm',
      'biz-1',
      'salon',
      null,
      '2348000000000',
    );

    expect(result.entities.date).toBe('tomorrow');
    expect(result.entities.time).toBe('3:00 PM');
    expect(result.entities.quantity).toBe(2);
    expect(result.entities.serviceName).toBe('haircut');
  });

  it("mode is 'business' when businessId is provided", async () => {
    vi.mocked(parseSmartIntentHybrid).mockResolvedValueOnce({
      understood: true,
      intent: 'booking',
      serviceKeywords: ['haircut'],
    } as never);

    const result = await orchestrator.understand(
      'I want a haircut',
      'biz-1',
      'salon',
      null,
      '2348000000000',
    );

    expect(result.mode).toBe('business');
  });

  it("mode is 'marketplace' when no businessId", async () => {
    vi.mocked(parseSmartIntentHybrid).mockResolvedValueOnce({
      understood: false,
      intent: null,
      serviceKeywords: [],
    } as never);

    const result = await orchestrator.understand(
      'find a salon near me',
      null,
      null,
      null,
      '2348000000000',
    );

    expect(result.mode).toBe('marketplace');
  });
});
