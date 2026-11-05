import type { PartyAnswers, PartyQuestion } from '@/lib/parties/rsvp-questions';
import { neutralizeFormulaPrefix } from '@/lib/utils/csv-export';

/** A guest's answer as text. Choice labels come from the current question, else from the question the guest answered. */
export function answerText(question: PartyQuestion, answers: PartyAnswers | null | undefined, answered: PartyQuestion[] = []): string {
  const answer = answers?.[question.id];
  if (answer === undefined || answer === '') return '';
  if (typeof answer === 'boolean') return answer ? 'Yes' : 'No';
  if (question.type !== 'single_choice') return answer;
  const old = answered.find(q => q.id === question.id);
  return question.options?.find(o => o.id === answer)?.label ?? old?.options?.find(o => o.id === answer)?.label ?? answer;
}

export interface GuestCsvRow {
  guest_name: string | null; guest_phone: string; status: string; plus_ones: number;
  tags: string[] | null; dietary_notes: string | null; responded_at: string | null;
  custom_answers?: PartyAnswers | null; saved_question_snapshot?: PartyQuestion[] | null;
}

/** Guest list CSV: the existing columns, then one column per current RSVP question. Free text is exported as plain text so a spreadsheet never runs it as a formula. */
export function guestListCsv(invites: GuestCsvRow[], questions: PartyQuestion[]): string {
  const headers = ['Name', 'Phone', 'Status', 'Plus Ones', 'Tags', 'Dietary Notes', 'Responded At', ...questions.map(q => neutralizeFormulaPrefix(q.label))];
  const rows = invites.map(inv => [
    neutralizeFormulaPrefix(inv.guest_name || ''),
    inv.guest_phone,
    inv.status,
    inv.status === 'accepted' ? String(inv.plus_ones) : '0',
    neutralizeFormulaPrefix((inv.tags || []).join('; ')),
    neutralizeFormulaPrefix(inv.dietary_notes || ''),
    inv.responded_at ? new Date(inv.responded_at).toLocaleString('en-GB') : '',
    ...questions.map(q => neutralizeFormulaPrefix(answerText(q, inv.custom_answers, inv.saved_question_snapshot || []))),
  ]);
  return [headers, ...rows].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
}
