import type { SupabaseClient } from '@supabase/supabase-js';

export interface InitPaymentOpts {
  supabase: SupabaseClient;
  bookingId?: string;
  orderId?: string;
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
  /** Platform fee in base currency units (e.g. naira, dollars — NOT kobo/cents) */
  platformFeeAmount?: number;
}

export interface InitPaymentResult {
  url: string;
  reference: string;
}

export interface VerifyResult {
  success: boolean;
}

export interface PaymentGateway {
  name: 'paystack' | 'stripe' | 'flutterwave' | 'square';
  initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null>;
  verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean>;
}
