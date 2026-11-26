import { describe, it, expect } from 'vitest';
import { preBookingAnswerLines, preBookingAnswersText, bookingCustomAnswers, REMOVED_QUESTION_LABEL } from '../pre-booking-answers';

const questions = [
  { id: 'q1', question: 'Any dietary needs or allergies?', required: false },
  { id: 'q2', question: 'What is the occasion?', required: true },
];

describe('preBookingAnswerLines', () => {
  it('labels answers by current question id, in question order, and keeps deleted-question answers', () => {
    expect(preBookingAnswerLines({ q_old: 'Window seat', q2: 'Birthday', q1: 'No nuts' }, questions)).toEqual([
      { label: 'Any dietary needs or allergies?', answer: 'No nuts' },
      { label: 'What is the occasion?', answer: 'Birthday' },
      { label: REMOVED_QUESTION_LABEL, answer: 'Window seat' },
    ]);
  });

  it('ignores empty or non-text answers and bad input', () => {
    expect(preBookingAnswerLines({ q1: '  ', q2: 5 }, questions)).toEqual([]);
    expect(preBookingAnswerLines(null, questions)).toEqual([]);
    expect(preBookingAnswerLines(['x'], questions)).toEqual([]);
    expect(preBookingAnswerLines({ q1: 'Yes' }, 'not-an-array')).toEqual([{ label: REMOVED_QUESTION_LABEL, answer: 'Yes' }]);
  });

  it('reads custom_answers from booking metadata and joins lines for CSV', () => {
    const lines = preBookingAnswerLines(bookingCustomAnswers({ duration_minutes: 60, custom_answers: { q1: 'Vegan' } }), questions);
    expect(preBookingAnswersText(lines)).toBe('Any dietary needs or allergies?: Vegan');
    expect(bookingCustomAnswers(null)).toBeUndefined();
  });
});
