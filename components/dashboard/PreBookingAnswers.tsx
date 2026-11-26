'use client';

import React from 'react';
import { bookingCustomAnswers, preBookingAnswerLines } from '@/lib/bookings/pre-booking-answers';

/**
 * Shows a booking's pre-booking answers as "Question: Answer" lines, next to
 * Special Requests in the booking details. Renders nothing when there are none.
 */
export function PreBookingAnswers({ metadata, questions }: { metadata: unknown; questions: unknown }) {
  const lines = preBookingAnswerLines(bookingCustomAnswers(metadata), questions);
  if (lines.length === 0) return null;
  return (
    <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-4" data-testid="pre-booking-answers">
      <h3 className="text-xs font-semibold uppercase text-yellow-700 mb-2">Pre-booking Answers</h3>
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={i} className="text-sm text-yellow-800 whitespace-pre-line">
            <span className="font-medium">{l.label}:</span> {l.answer}
          </li>
        ))}
      </ul>
    </div>
  );
}
