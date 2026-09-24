import { describe, expect, it, vi } from 'vitest';
import { invoiceFlow } from '../invoice.flow';
import { crowdfundingFlow } from '../crowdfunding.flow';
import { createMockContext, getStep } from './helpers';
import type { FlowContext } from '../types';

const { mockHandleSavedCardInput } = vi.hoisted(() => ({
  mockHandleSavedCardInput: vi.fn().mockResolvedValue(null),
}));

vi.mock('../shared/saved-card-flow', () => ({
  buildSavedCardOffer: vi.fn().mockResolvedValue(null),
  handleSavedCardInput: mockHandleSavedCardInput,
}));

function callContext(): FlowContext {
  const ctx = createMockContext();
  ctx.session.session_data = {
    ...ctx.session.session_data,
    _saved_method_id: 'saved-method-1',
    _invoice_id: 'invoice-1',
    _invoice_ref: 'INV-1',
    _invoice_amount: 2500,
    donation_ref_code: 'DON-1',
    donation_amount: 1500,
    campaign_id: 'campaign-1',
  };
  return ctx;
}

describe('saved-card attempt reference persistence', () => {
  it('reuses one invoice reference across PIN retries', async () => {
    mockHandleSavedCardInput.mockClear();
    const ctx = callContext();
    const step = getStep(invoiceFlow, 'invoice_pay');

    await step.validate('pay_saved', ctx);
    const firstRef = mockHandleSavedCardInput.mock.calls[0][2].reference;

    ctx.session.session_data._awaiting_card_pin = true;
    await step.validate('1234', ctx);
    const retryRef = mockHandleSavedCardInput.mock.calls[1][2].reference;

    expect(firstRef).toMatch(/^INV-1-saved-/);
    expect(retryRef).toBe(firstRef);
  });

  it('reuses one giving reference across PIN retries', async () => {
    mockHandleSavedCardInput.mockClear();
    const ctx = callContext();
    const step = getStep(crowdfundingFlow, 'donation_payment');

    await step.validate('pay_saved', ctx);
    const firstRef = mockHandleSavedCardInput.mock.calls[0][2].reference;

    ctx.session.session_data._awaiting_card_pin = true;
    await step.validate('1234', ctx);
    const retryRef = mockHandleSavedCardInput.mock.calls[1][2].reference;

    expect(firstRef).toMatch(/^DON-1-saved-/);
    expect(retryRef).toBe(firstRef);
  });
});
