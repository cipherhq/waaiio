/**
 * Messaging allowance types and aggregation logic for the billing page.
 *
 * All financial values come directly from authoritative DB columns:
 * - messaging_allowances.remaining_minor → available balance
 * - messaging_spend_periods.spent_minor → terminally charged (confirmed)
 * - messaging_spend_periods.reserved_minor → in-flight reservations (not yet settled)
 *
 * We never derive "used = original − remaining" because that would conflate
 * reserved (pending) and charged (confirmed) amounts. See #261.
 */

export interface MessagingAllowanceRow {
  id: string;
  type: string;
  amount_minor: number;
  currency_code: string;
  remaining_minor: number;
  source_ref: string;
  expires_at: string | null;
  created_at: string;
}

export interface MessagingSpendPeriodRow {
  id: string;
  currency_code: string;
  period_start: string;
  cap_minor: number;
  reserved_minor: number;
  spent_minor: number;
}

/** Per-currency aggregated messaging state derived from authoritative tables */
export interface CurrencyMessagingSummary {
  currency: string;
  /** Sum of remaining_minor across non-expired allowances */
  available: number;
  /** Sum of amount_minor across all allowances (original grants) */
  totalAllocated: number;
  /** spent_minor from current spend period (terminally charged) */
  charged: number;
  /** reserved_minor from current spend period (in-flight, not yet settled) */
  reserved: number;
  /** cap_minor from current spend period */
  cap: number;
  /** Individual allowances for detail view */
  allowances: MessagingAllowanceRow[];
  /** Whether a spend period exists for current month */
  hasSpendPeriod: boolean;
}

/**
 * Aggregates messaging allowances and spend periods into per-currency summaries.
 * All values come directly from authoritative DB columns — no derived arithmetic
 * that would conflate reserved vs charged amounts.
 */
export function buildMessagingSummaries(
  allowances: MessagingAllowanceRow[],
  spendPeriods: MessagingSpendPeriodRow[],
  now?: Date,
): CurrencyMessagingSummary[] {
  const currentTime = now ?? new Date();

  // Group allowances by currency
  const byCurrency = new Map<string, MessagingAllowanceRow[]>();
  for (const a of allowances) {
    const list = byCurrency.get(a.currency_code) || [];
    list.push(a);
    byCurrency.set(a.currency_code, list);
  }

  // Also include currencies that have spend periods but no remaining allowances
  for (const sp of spendPeriods) {
    if (!byCurrency.has(sp.currency_code)) {
      byCurrency.set(sp.currency_code, []);
    }
  }

  const summaries: CurrencyMessagingSummary[] = [];

  for (const [currency, currencyAllowances] of byCurrency) {
    // Sum remaining_minor only from non-expired allowances
    let available = 0;
    let totalAllocated = 0;
    for (const a of currencyAllowances) {
      totalAllocated += a.amount_minor;
      const isExpired = a.expires_at ? new Date(a.expires_at) <= currentTime : false;
      if (!isExpired) {
        available += a.remaining_minor;
      }
    }

    // Find current-month spend period for this currency
    const sp = spendPeriods.find((p) => p.currency_code === currency);

    summaries.push({
      currency,
      available,
      totalAllocated,
      charged: sp?.spent_minor ?? 0,
      reserved: sp?.reserved_minor ?? 0,
      cap: sp?.cap_minor ?? 0,
      allowances: currencyAllowances,
      hasSpendPeriod: !!sp,
    });
  }

  // Sort by currency for deterministic order
  summaries.sort((a, b) => a.currency.localeCompare(b.currency));
  return summaries;
}
