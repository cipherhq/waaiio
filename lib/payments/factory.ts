import type { PaymentGateway } from './types';
import { PaystackGateway } from './paystack';
import { StripeGateway } from './stripe';
import { FlutterwaveGateway } from './flutterwave';
import { SquareGateway } from './square';
import { PayPalGateway } from './paypal';
import { type CountryCode, getPaymentGatewayForCountry, type PaymentGatewayName } from '@/lib/constants';

const paystackInstance = new PaystackGateway();
const stripeInstance = new StripeGateway();
const flutterwaveInstance = new FlutterwaveGateway();
const squareInstance = new SquareGateway();
const paypalInstance = new PayPalGateway();

/**
 * Disabled gateway — returned when ENABLE_PAYMENTS !== 'true'.
 * initializePayment() returns null; no provider call is made.
 */
const disabledGateway: PaymentGateway = {
  initializePayment: async () => null,
  verifyPayment: async () => ({ verified: false, amount: 0, status: 'failed' as const, gatewayReference: '' }),
} as PaymentGateway;

/** Returns true only when customer payment initiation is enabled */
export function isPaymentEnabled(): boolean {
  return process.env.ENABLE_PAYMENTS === 'true';
}

/** Get a PaymentGateway by country code. Returns disabled gateway when payments are off. */
export function getPaymentGateway(countryCode: CountryCode = 'NG'): PaymentGateway {
  if (!isPaymentEnabled()) return disabledGateway;
  const gatewayName = getPaymentGatewayForCountry(countryCode);
  return getPaymentGatewayByName(gatewayName);
}

/** Get a PaymentGateway by explicit name. Returns disabled gateway when payments are off. */
export function getPaymentGatewayByName(name: PaymentGatewayName): PaymentGateway {
  if (!isPaymentEnabled()) return disabledGateway;
  switch (name) {
    case 'stripe': return stripeInstance;
    case 'flutterwave': return flutterwaveInstance;
    case 'square': return squareInstance;
    case 'paypal': return paypalInstance;
    default: return paystackInstance;
  }
}
