import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { getCurrencyCode } from '@/lib/constants';
import type { CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

interface BankAccount {
  bank_name: string;
  account_number: string;
  account_name: string;
}

interface BankTransferCheckResult {
  qualifies: boolean;
  bankAccount: BankAccount | null;
  /** Platform settings (cached) — reuse for transfer_expiry_hours */
  platformSettings: Awaited<ReturnType<typeof loadPlatformSettings>>;
}

/**
 * Check if a business qualifies for direct bank transfer and return bank account details.
 * Qualification: NG/GH country + growth/business tier + amount >= minimum.
 */
export async function checkBankTransferEligibility(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    countryCode: CountryCode;
    subscriptionTier: string;
    amount: number;
  },
): Promise<BankTransferCheckResult> {
  const ps = await loadPlatformSettings({ useServiceClient: true });
  const { countryCode: cc, subscriptionTier: tier, amount } = params;

  const minBankTransfer = ps.minimum_bank_transfer[cc] ?? 10000;
  const qualifies =
    (cc === 'NG' || cc === 'GH') &&
    (tier === 'growth' || tier === 'business') &&
    amount >= minBankTransfer;

  if (!qualifies) {
    return { qualifies: false, bankAccount: null, platformSettings: ps };
  }

  const { data: ba } = await supabase
    .from('business_bank_accounts')
    .select('bank_name, account_number, account_name')
    .eq('business_id', params.businessId)
    .eq('is_active', true)
    .eq('is_default', true)
    .maybeSingle();

  return { qualifies: !!ba, bankAccount: ba, platformSettings: ps };
}

/**
 * Insert a pending_transfers record and return the generated transfer reference.
 */
export async function createPendingTransfer(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    entityId: {
      booking_id?: string;
      order_id?: string;
      reservation_id?: string;
      invoice_id?: string;
      campaign_id?: string;
    };
    customerPhone: string;
    customerName: string;
    amount: number;
    countryCode: CountryCode;
    transferExpiryHours: number;
  },
): Promise<string> {
  const transferRef = 'WA-' + randomBytes(3).toString('hex').toUpperCase().slice(0, 4);

  const { error } = await supabase.from('pending_transfers').insert({
    business_id: params.businessId,
    ...params.entityId,
    customer_phone: params.customerPhone.startsWith('+') ? params.customerPhone : `+${params.customerPhone}`,
    customer_name: params.customerName,
    expected_amount: Math.round(params.amount * 100),
    currency: getCurrencyCode(params.countryCode),
    reference_code: transferRef,
    status: 'pending',
    expires_at: new Date(Date.now() + params.transferExpiryHours * 60 * 60 * 1000).toISOString(),
  });

  if (error) {
    logger.error('[BANK-TRANSFER] Failed to insert pending_transfer:', error.message);
  }

  return transferRef;
}

/**
 * Format the bank transfer details block for WhatsApp messages.
 */
export function formatBankTransferBlock(
  bankAccount: BankAccount,
  amount: string,
  transferRef: string,
): string {
  return [
    `Bank: ${bankAccount.bank_name}`,
    `Account: ${bankAccount.account_number}`,
    `Name: ${bankAccount.account_name}`,
    `Amount: ${amount}`,
    `Reference/Narration: *${transferRef}*`,
    '',
    `⚠️ Use reference *${transferRef}* as your transfer narration.`,
    `After transferring, tap "I've Sent It" or send your receipt screenshot.`,
  ].join('\n');
}

/**
 * Standard buttons for bank-transfer-only payment (no online option).
 */
export const BANK_ONLY_BUTTONS = [
  { id: 'sent_transfer', title: "I've Sent Transfer" },
  { id: 'go_back', title: 'Cancel' },
] as const;

/**
 * Standard buttons for dual-option payment (online + bank transfer).
 */
export const DUAL_OPTION_BUTTONS = [
  { id: 'i_paid_online', title: "I've Paid Online" },
  { id: 'sent_transfer', title: "I've Sent Transfer" },
  { id: 'go_back', title: 'Cancel' },
] as const;
