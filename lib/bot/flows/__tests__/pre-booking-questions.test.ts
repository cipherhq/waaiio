import { describe, it, expect } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { schedulingFlow } from '../scheduling.flow';
import type { FlowContext } from '../types';

// Pre-booking questions step: optional questions offer a Skip button (typed
// "skip" still works), required questions cannot be skipped, answers are stored
// by question id and a skipped question stores nothing.
const step = getStep(schedulingFlow, 'pre_booking_questions');

const QUESTIONS = [
  { id: 'q_diet', question: 'Any dietary needs or allergies?', required: false },
  { id: 'q_occasion', question: 'What is the occasion?', required: true },
];

function ctxAt(index: number, answers: Record<string, string> = {}, copyLang: FlowContext['copyLang'] = 'en'): FlowContext {
  const ctx = createMockContext({ copyLang });
  ctx.business!.metadata = { pre_booking_questions: QUESTIONS };
  ctx.session.current_step = 'pre_booking_questions';
  ctx.session.session_data = { _pbq_index: index, _pbq_answers: { ...answers } };
  return ctx;
}

/** Applies a valid result the way the executor merges it into session data. */
async function answer(ctx: FlowContext, input: string) {
  const result = await step.validate!(input, ctx);
  if (result.valid) Object.assign(ctx.session.session_data, result.data);
  return result;
}

describe('pre_booking_questions step', () => {
  it('optional question shows a Skip button instead of the "Type skip" hint', async () => {
    const [msg] = await step.prompt(ctxAt(0));
    expect(msg.type).toBe('buttons');
    const m = msg as { body: string; buttons: Array<{ id: string; title: string }> };
    expect(m.body).toContain('Any dietary needs or allergies? (1/2)');
    expect(m.body).not.toMatch(/Type \*skip\*/);
    expect(m.buttons).toEqual([{ id: 'pbq_skip', title: 'Skip' }]);
  });

  it('Skip button title is localized like other booking buttons', async () => {
    const [msg] = await step.prompt(ctxAt(0, {}, 'yo'));
    expect((msg as { buttons: Array<{ title: string }> }).buttons[0].title).toBe('Fò');
  });

  it('tapping Skip moves on and stores nothing for that question', async () => {
    const ctx = ctxAt(0);
    const result = await answer(ctx, 'pbq_skip');
    expect(result.valid).toBe(true);
    expect(ctx.session.session_data._pbq_index).toBe(1);
    expect(ctx.session.session_data._pbq_answers).toEqual({});
    expect(await step.next(ctx)).toBe('pre_booking_questions');
  });

  it('typing "skip" still skips an optional question', async () => {
    const ctx = ctxAt(0);
    const result = await answer(ctx, '  SKIP ');
    expect(result.valid).toBe(true);
    expect(ctx.session.session_data._pbq_answers).toEqual({});
    expect(ctx.session.session_data._pbq_index).toBe(1);
  });

  it('required question is plain text with no Skip button', async () => {
    const [msg] = await step.prompt(ctxAt(1));
    expect(msg.type).toBe('text');
    expect((msg as { text: string }).text).toBe('📋 What is the occasion? (2/2)');
  });

  it.each(['pbq_skip', 'skip', ''])('required question cannot be skipped with %j', async input => {
    const ctx = ctxAt(1);
    const result = await answer(ctx, input);
    expect(result.valid).toBe(false);
    expect(ctx.session.session_data._pbq_index).toBe(1);
    expect(ctx.session.session_data._pbq_answers).toEqual({});
  });

  it('stores the typed answer by question id and finishes after the last question', async () => {
    const ctx = ctxAt(0);
    await answer(ctx, 'No nuts please');
    expect(ctx.session.session_data._pbq_answers).toEqual({ q_diet: 'No nuts please' });
    await answer(ctx, 'Birthday');
    expect(ctx.session.session_data._pbq_answers).toEqual({ q_diet: 'No nuts please', q_occasion: 'Birthday' });
    expect(ctx.session.session_data._pbq_index).toBe(2);
    expect(await step.next(ctx)).toBe('intake_form');
  });
});
