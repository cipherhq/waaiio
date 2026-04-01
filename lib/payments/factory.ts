import type { PaymentGateway } from './types';
import { PaystackGateway } from './paystack';
import { StripeGateway } from './stripe';
import { type CountryCode, getPaymentGatewayForCountry, type PaymentGatewayName } from '@/lib/constants';

const paystackInstance = new PaystackGateway();
const stripeInstance = new StripeGateway();

/** Get a PaymentGateway by country code */
export function getPaymentGateway(countryCode: CountryCode = 'NG'): PaymentGateway {
  const gatewayName = getPaymentGatewayForCountry(countryCode);
  return gatewayName === 'stripe' ? stripeInstance : paystackInstance;
}

/** Get a PaymentGateway by explicit name */
export function getPaymentGatewayByName(name: PaymentGatewayName): PaymentGateway {
  return name === 'stripe' ? stripeInstance : paystackInstance;
}
