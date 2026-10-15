export interface PaymentLinkCreateDenial {
  status: 403;
  reason: 'business_setup_incomplete' | 'business_suspended';
  message: string;
}

/**
 * Lifecycle gate for creating new Scan-to-Pay/payment links.
 *
 * Creation is new customer/payment activity, so setup-incomplete and suspended
 * businesses must fail closed. Existing active-business behavior is preserved.
 */
export function getPaymentLinkCreateDenial(
  businessStatus: string | null | undefined,
): PaymentLinkCreateDenial | null {
  if (businessStatus === 'pending') {
    return {
      status: 403,
      reason: 'business_setup_incomplete',
      message: 'Complete business setup before creating payment links.',
    };
  }

  if (businessStatus === 'suspended') {
    return {
      status: 403,
      reason: 'business_suspended',
      message: 'This business is suspended and cannot create payment links.',
    };
  }

  return null;
}
