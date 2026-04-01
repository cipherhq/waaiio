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
}

export interface InitPaymentResult {
  url: string;
  reference: string;
}

export interface VerifyResult {
  success: boolean;
}

export interface PaymentGateway {
  name: 'paystack' | 'stripe';
  initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null>;
  verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean>;
}
