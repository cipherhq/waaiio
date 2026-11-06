/**
 * Platform fee bank account setting (Owner decision 2026-11-06).
 * Read by app/api/settings/payment-credentials; written only by
 * app/api/admin/platform-settings/fee-bank with a step-up.
 */

export const FEE_BANK_SETTING_KEY = 'platform_bank_ng';

/** Any platform_bank_* key is reserved for the protected fee bank screen. */
export function isFeeBankSettingKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith('platform_bank_');
}

export interface FeeBankValue {
  bank_code: string;
  account_number: string;
  account_name: string;
}

export function validateFeeBankValue(
  input: Record<string, unknown>,
): { ok: true; value: FeeBankValue } | { ok: false; error: string } {
  const bankCode = typeof input.bank_code === 'string' ? input.bank_code.trim() : '';
  const accountNumber = typeof input.account_number === 'string' ? input.account_number.trim() : '';
  const accountName = typeof input.account_name === 'string' ? input.account_name.trim() : '';

  if (!/^\d{3,6}$/.test(bankCode)) return { ok: false, error: 'bank_code must be 3 to 6 digits' };
  if (!/^\d{10}$/.test(accountNumber)) return { ok: false, error: 'account_number must be 10 digits' };
  if (accountName.length === 0 || accountName.length > 100) {
    return { ok: false, error: 'account_name is required (max 100 characters)' };
  }
  return { ok: true, value: { bank_code: bankCode, account_number: accountNumber, account_name: accountName } };
}

export function maskAccountNumber(accountNumber: string): string {
  const digits = String(accountNumber);
  return digits.length <= 4 ? '****' : `******${digits.slice(-4)}`;
}
