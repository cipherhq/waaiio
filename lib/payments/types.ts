import type { SupabaseClient } from '@supabase/supabase-js';

export interface InitPaymentOpts {
  supabase: SupabaseClient;
  bookingId?: string;
  orderId?: string;
  invoiceId?: string;
  reservationId?: string;
  userId: string;
  amount: number;
  currency: string;
  referenceCode: string;
  businessName: string;
  phone: string;
  userEmail?: string;
  callbackUrl?: string;
  /** Paystack/Flutterwave subaccount code for split payments */
  subaccountCode?: string;
  /** Stripe Connect account ID for split payments */
  stripeAccountId?: string;
  /** Square OAuth merchant ID + access token for split payments */
  squareMerchantId?: string;
  squareAccessToken?: string;
  /** Platform fee in base currency units (e.g. naira, dollars — NOT kobo/cents) */
  platformFeeAmount?: number;
  /** BYO: use business's own gateway API key instead of platform key */
  byoSecretKey?: string;
  /** BYO: platform subaccount code on the business's gateway account */
  byoPlatformSubaccount?: string;
  /** BYO: indicates this is a BYO payment (reversed split) */
  isByo?: boolean;
  /** BYO: the business ID that owns the credentials */
  byoBusinessId?: string;
  /** @deprecated Removed — no verified Paystack Connect documentation */
  connectAccountId?: string;
  /** Campaign ID for donation tracking — set on payment record at creation to avoid webhook race */
  campaignId?: string;
  /** Business ID — stored on payment record for payout reconciliation */
  businessId?: string;
  /** Payment channels to show (e.g. ['card', 'bank_transfer', 'ussd']). Null = all. */
  channels?: string[];
  /** Collection mode for fee tracking: platform, managed_split, byo, connect, flutterwave_mid */
  collectionMode?: string;
  /** Fee bearer: platform, merchant, shared */
  feeBearerMode?: string;
  /** Payout account ID (connection used for this payment) */
  payoutAccountId?: string;
  /** Platform fee amount in base currency units */
  waaiioFee?: number;
}

export interface InitPaymentResult {
  url: string;
  reference: string;
}

export interface VerifyResult {
  success: boolean;
}

export interface RefundPaymentOpts {
  gatewayReference: string;
  /** Amount to refund in base currency units (e.g. naira, dollars — NOT kobo/cents). Omit for full refund. */
  amount?: number;
  currency: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  /** BYO: use business's own gateway API key */
  byoSecretKey?: string;
  /** Paystack Connect account ID */
  connectAccountId?: string;
}

export interface RefundResult {
  success: boolean;
  gatewayRefundReference?: string;
  gatewayResponse?: Record<string, unknown>;
  errorMessage?: string;
}

export interface PaymentGateway {
  name: 'paystack' | 'stripe' | 'flutterwave' | 'square' | 'paypal';
  initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null>;
  verifyPayment(supabase: SupabaseClient, reference: string, byoSecretKey?: string): Promise<boolean>;
  refundPayment(opts: RefundPaymentOpts): Promise<RefundResult>;
}
