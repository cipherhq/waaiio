// Grouping and CSV for Custom Flow answers (#1085). Pure: shared by the API
// and the Flow answers page.
import { escapeCell } from '@/lib/utils/csv-export';

export type AnswerType = 'yes_no' | 'choice' | 'date' | 'text' | 'file';

export interface AnswerRow {
  id: string;
  flow_id: string;
  response_id: string;
  customer_number: string;
  node_id: string;
  question: string;
  answer_type: AnswerType;
  value_text: string | null;
  value_date: string | null;
  file_path?: string | null;
  file_mime: string | null;
  file_size: number | null;
  created_at: string;
}

export interface FlowResponse {
  response_id: string;
  customer_number: string;
  /** Latest answer time in this run. */
  answered_at: string;
  answers: Omit<AnswerRow, 'file_path'>[];
}

/** One customer run per response, newest first; answers in the order given. */
export function groupResponses(rows: AnswerRow[]): FlowResponse[] {
  const byId = new Map<string, FlowResponse>();
  for (const row of rows) {
    const { file_path: _hidden, ...answer } = row;
    const group = byId.get(row.response_id) ?? { response_id: row.response_id, customer_number: row.customer_number, answered_at: row.created_at, answers: [] };
    group.answers.push(answer);
    if (row.created_at > group.answered_at) group.answered_at = row.created_at;
    byId.set(row.response_id, group);
  }
  const groups = [...byId.values()];
  for (const g of groups) g.answers.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return groups.sort((a, b) => b.answered_at.localeCompare(a.answered_at));
}

/** "+2348012345678" from the raw WhatsApp number. */
export const displayNumber = (raw: string) => (raw.startsWith('+') ? raw : `+${raw}`);

export const fileKind = (mime: string | null) => (mime === 'application/pdf' ? 'PDF' : 'Photo');

/** Plain text for one answer in a spreadsheet (files cannot be linked: links expire). */
export function csvValue(answer: Pick<AnswerRow, 'answer_type' | 'value_text' | 'value_date' | 'file_mime'>): string {
  if (answer.answer_type === 'date') return answer.value_date ?? '';
  if (answer.answer_type === 'file') return `${fileKind(answer.file_mime)} (open it on the Flow answers page)`;
  return answer.value_text ?? '';
}

/**
 * One row per customer run, one column per question (in first-asked order).
 * Every cell goes through the formula-injection guard (#713).
 */
export function answersCsv(rows: AnswerRow[]): string {
  const responses = groupResponses(rows);
  const questions: { node_id: string; question: string }[] = [];
  for (const row of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const known = questions.find(q => q.node_id === row.node_id);
    if (!known) questions.push({ node_id: row.node_id, question: row.question });
    else known.question = row.question;
  }
  const header = ['Answered on (UTC)', 'Customer WhatsApp', ...questions.map(q => q.question)];
  const lines = responses.map(r => [
    r.answered_at.slice(0, 16).replace('T', ' '),
    displayNumber(r.customer_number),
    ...questions.map(q => {
      const answer = r.answers.find(a => a.node_id === q.node_id);
      return answer ? csvValue(answer) : '';
    }),
  ]);
  return [header, ...lines].map(cells => cells.map(c => escapeCell(c)).join(',')).join('\r\n');
}
