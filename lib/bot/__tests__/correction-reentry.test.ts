import { describe, expect, it, vi } from 'vitest';
import { handleCorrectionReentry } from '../handlers/correction-reentry';
import type { BotContext, BotSession } from '../bot-types';

function makeSession(textStep = 'confirmation'): BotSession {
  return {
    id: 'sess-correction',
    whatsapp_number: '2348000000000',
    user_id: 'user-1',
    business_id: 'biz-1',
    current_step: textStep,
    session_data: {
      active_capability: 'scheduling',
      capabilities: ['scheduling'],
      date: '2026-10-10',
      selected_date: '2026-10-10',
      time: '14:00',
      selected_time: '14:00',
      staff_id: 'staff-1',
      party_size: 2,
      selected_slot_id: 'slot-old',
      _availability_snapshot: { ok: true },
      confirmation: true,
      _step_history: ['select_service', 'select_date', 'select_time', 'select_quantity', 'confirmation'],
    },
    is_active: true,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    version: 7,
  };
}

function makeContext(casResult: unknown = { success: true, version: 8 }) {
  const execute = vi.fn().mockResolvedValue(undefined);
  const rpc = vi.fn().mockResolvedValue({ data: casResult, error: null });
  const single = vi.fn().mockResolvedValue({
    data: {
      id: 'biz-1',
      name: 'Test Biz',
      slug: 'test-biz',
      category: 'salon',
      flow_type: 'scheduling',
      subscription_tier: 'pro',
      trial_ends_at: null,
      metadata: {},
      operating_hours: {},
      country_code: 'NG',
      payment_gateway: 'paystack',
    },
    error: null,
  });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });

  const ctx = {
    supabase: { rpc, from },
    flowExecutor: { execute },
    messageSender: {},
    standaloneService: {},
    intelligence: {},
  } as unknown as BotContext;

  return { ctx, rpc, from, execute };
}

describe('handleCorrectionReentry', () => {
  it('CAS-rewinds before sending a concrete correction through FlowExecutor', async () => {
    const session = makeSession();
    const { ctx, rpc, execute } = makeContext();

    const result = await handleCorrectionReentry(ctx, '2348000000000', session, 'change to Friday');

    expect(result).toEqual({ handled: true });
    expect(rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-correction',
      p_expected_version: 7,
      p_current_step: 'select_date',
    }));

    const casArgs = rpc.mock.calls[0][1] as { p_session_data: Record<string, unknown> };
    expect(casArgs.p_session_data.date).toBeUndefined();
    expect(casArgs.p_session_data.time).toBeUndefined();
    expect(casArgs.p_session_data.staff_id).toBeUndefined();
    expect(casArgs.p_session_data.selected_slot_id).toBeUndefined();
    expect(casArgs.p_session_data._availability_snapshot).toBeUndefined();
    expect(casArgs.p_session_data._step_history).toEqual(['select_service', 'select_date']);

    expect(session.current_step).toBe('select_date');
    expect(session.version).toBe(8);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe('2348000000000');
    expect(execute.mock.calls[0][1]).toBe('change to Friday');
    expect(execute.mock.calls[0][2]).toBe(session);
  });

  it('re-prompts the existing authority step for a generic reselection', async () => {
    const session = makeSession('select_date');
    const { ctx, execute } = makeContext();

    const result = await handleCorrectionReentry(ctx, '2348000000000', session, 'change date');

    expect(result).toEqual({ handled: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toBe('');
    expect(session.current_step).toBe('select_date');
  });

  it('fails closed on CAS version conflict without validation or output work', async () => {
    const session = makeSession();
    const { ctx, rpc, from, execute } = makeContext({ success: false, reason: 'version_conflict' });

    const result = await handleCorrectionReentry(ctx, '2348000000000', session, 'change to Friday');

    expect(result).toEqual({ handled: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(session.current_step).toBe('confirmation');
    expect(session.version).toBe(7);
  });

  it('does nothing for ordinary text or a tenantless session', async () => {
    const ordinary = makeSession();
    const { ctx, rpc } = makeContext();
    expect(await handleCorrectionReentry(ctx, '2348000000000', ordinary, 'Friday')).toEqual({ handled: false });
    expect(rpc).not.toHaveBeenCalled();

    const tenantless = { ...makeSession(), business_id: null };
    expect(await handleCorrectionReentry(ctx, '2348000000000', tenantless, 'change to Friday')).toEqual({ handled: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});
