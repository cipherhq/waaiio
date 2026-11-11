/**
 * #682 / #976: a business send refused by the financial gate (no balance or spend cap reached).
 * Nothing reached Meta. BotService.handleMessage answers these with the rate-limited platform notice.
 */
export function isFinancialDenial(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('Financial authorization denied:')
    || msg.includes('insufficient_allowance_balance')
    || msg.includes('spend_cap_exceeded');
}

type LogEntry = { role: 'bot' | 'user'; content: string; timestamp: string };

/**
 * #976: thrown by FlowExecutor when a flow reply was refused by the financial gate.
 * Keeps the original message, so BotService's #682 check still matches, and carries the
 * conversation_log entries of the replies that were never sent, so they can be removed.
 */
export class RefusedSendError extends Error {
  readonly original: unknown;
  readonly unsentLogEntries: LogEntry[];
  constructor(original: unknown, unsentLogEntries: LogEntry[]) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'RefusedSendError';
    this.original = original;
    this.unsentLogEntries = unsentLogEntries;
  }
}
