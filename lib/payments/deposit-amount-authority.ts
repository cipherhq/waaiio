/**
 * #376 — Deposit amount authority.
 *
 * Fixed-price configuration invariant:
 *   0 <= deposit <= price
 *
 * Variable-price offerings intentionally do not compare deposit to the configured
 * starting price because that value is not the final transaction total.
 */

export interface DepositConfigurationInput {
  price: number;
  deposit: number;
  priceIsVariable: boolean;
}

export interface RuntimeDepositInput {
  requestedDeposit: number;
  transactionTotal: number;
  priceIsVariable: boolean;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Returns a user-facing validation error for an invalid deposit configuration.
 * null means the configuration is valid.
 */
export function getDepositConfigurationError(input: DepositConfigurationInput): string | null {
  const price = finiteNonNegative(input.price);
  const deposit = finiteNonNegative(input.deposit);

  if (input.deposit < 0 || !Number.isFinite(input.deposit)) {
    return 'Deposit must be a non-negative amount.';
  }

  if (!input.priceIsVariable && deposit > price) {
    return 'For fixed-price services and appointments, the deposit cannot exceed the price.';
  }

  return null;
}

/**
 * Enforces the write-path invariant for non-UI callers such as payload builders.
 */
export function assertValidDepositConfiguration(input: DepositConfigurationInput): void {
  const error = getDepositConfigurationError(input);
  if (error) throw new RangeError(error);
}

/**
 * Runtime guard for legacy/stale fixed-price configuration.
 *
 * For a fixed-price transaction, a requested deposit can never exceed the
 * actual transaction total after discounts/quantity are applied. We clamp the
 * stale value instead of allowing a provider initialization above the total.
 *
 * Variable-price offerings preserve existing semantics because their configured
 * price is only a starting price, not authoritative final transaction value.
 */
export function resolveRuntimeDeposit(input: RuntimeDepositInput): {
  amount: number;
  corrected: boolean;
  reason?: 'negative_or_invalid' | 'deposit_exceeds_transaction_total';
} {
  const requested = finiteNonNegative(input.requestedDeposit);
  const total = finiteNonNegative(input.transactionTotal);

  if (!Number.isFinite(input.requestedDeposit) || input.requestedDeposit < 0) {
    return { amount: 0, corrected: true, reason: 'negative_or_invalid' };
  }

  if (!input.priceIsVariable && requested > total) {
    return {
      amount: total,
      corrected: true,
      reason: 'deposit_exceeds_transaction_total',
    };
  }

  return { amount: requested, corrected: false };
}
