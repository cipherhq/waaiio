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
 * Keeps the original message, so the #682 check still matches, and says which reply was
 * refused (its text, and its conversation_log entry when known) so it can be removed from the log.
 */
export class RefusedSendError extends Error {
  readonly original: unknown;
  readonly refusedText: string;
  readonly refusedEntry?: LogEntry;
  constructor(original: unknown, refusedText: string, refusedEntry?: LogEntry) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'RefusedSendError';
    this.original = original;
    this.refusedText = refusedText;
    this.refusedEntry = refusedEntry;
  }
}
