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

/** Get a PaymentGateway by country code */
export function getPaymentGateway(countryCode: CountryCode = 'NG'): PaymentGateway {
  const gatewayName = getPaymentGatewayForCountry(countryCode);
  return getPaymentGatewayByName(gatewayName);
}

/** Get a PaymentGateway by explicit name */
export function getPaymentGatewayByName(name: PaymentGatewayName): PaymentGateway {
  switch (name) {
    case 'stripe': return stripeInstance;
    case 'flutterwave': return flutterwaveInstance;
    case 'square': return squareInstance;
    case 'paypal': return paypalInstance;
    default: return paystackInstance;
  }
}
