/**
 * Stripe 3DS Authentication Page
 *
 * Validates a signed, expiring auth token bound to an exact Waaiio payment,
 * retrieves the PaymentIntent client_secret server-side, and renders Stripe.js
 * confirmCardPayment for 3DS completion.
 *
 * Security:
 * - Token is HMAC-signed with SAVED_CARD_AUTH_SECRET
 * - client_secret is NEVER in WhatsApp — only exposed inside this page
 * - Token binds exact payment_id, customer, nonce, version, and expiry
 * - Server validates token + loads durable payment row before serving client_secret
 * - Replay: token is reusable until expiry for the same PI (browser refresh safe)
 *   but immediately invalidated when superseded by a regenerated link
 */
import { createServiceClient } from '@/lib/supabase/service';
import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '@/lib/logger';

export const metadata = {
  title: 'Payment Verification — Waaiio',
  robots: 'noindex',
};

function getAuthSecret(): string {
  return process.env.SAVED_CARD_AUTH_SECRET || '';
}

interface TokenPayload {
  payment_id: string;
  nonce: string;
  auth_version: number;
  exp: number;
}

function verifyToken(tokenStr: string): TokenPayload | null {
  try {
    const decoded = JSON.parse(Buffer.from(tokenStr, 'base64url').toString('utf-8'));
    const { sig, ...payload } = decoded;
    if (!sig || !payload.payment_id || !payload.nonce || !payload.exp) return null;

    const secret = getAuthSecret();
    if (!secret) return null;

    const expectedSig = createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    if (Date.now() / 1000 > payload.exp) return null;

    return payload as TokenPayload;
  } catch {
    return null;
  }
}

export default async function PaymentAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const params = await searchParams;
  const tokenStr = params.t;

  if (!tokenStr) {
    return <AuthError message="Missing authentication token." />;
  }

  const payload = verifyToken(tokenStr);
  if (!payload) {
    return <AuthError message="Invalid or expired link. Return to WhatsApp to request a new one." />;
  }

  const supabase = createServiceClient();

  // Validate auth attempt row (supersession check)
  const { data: attempt } = await supabase
    .from('saved_card_auth_attempts')
    .select('id, superseded_at, consumed_at, customer_phone')
    .eq('payment_id', payload.payment_id)
    .eq('auth_version', payload.auth_version)
    .eq('nonce', payload.nonce)
    .maybeSingle();

  if (!attempt) {
    return <AuthError message="Authentication attempt not found." />;
  }

  if (attempt.superseded_at) {
    return <AuthError message="This link has been replaced. Return to WhatsApp for a new verification link." />;
  }

  // Load durable payment row
  const { data: payment } = await supabase
    .from('payments')
    .select('id, status, gateway, gateway_reference')
    .eq('id', payload.payment_id)
    .single();

  if (!payment) {
    return <AuthError message="Payment not found." />;
  }

  if (payment.status === 'success') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
        <div className="mx-auto max-w-sm">
          <div className="text-5xl mb-4">✅</div>
          <h1 className="text-2xl font-bold text-gray-900">Payment Confirmed</h1>
          <p className="mt-3 text-sm text-gray-600">Your payment has been confirmed. You can return to WhatsApp.</p>
        </div>
      </div>
    );
  }

  if (payment.gateway !== 'stripe' || payment.status !== 'pending') {
    return <AuthError message="This payment cannot be verified at this time." />;
  }

  // Retrieve client_secret from the durable payment row's gateway_reference (pi_...)
  const piId = payment.gateway_reference;
  if (!piId || !piId.startsWith('pi_')) {
    return <AuthError message="Payment verification not available." />;
  }

  // Mark consumed (audit)
  if (!attempt.consumed_at) {
    await supabase
      .from('saved_card_auth_attempts')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', attempt.id);
  }

  // Get client_secret from Stripe
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return <AuthError message="Payment verification temporarily unavailable." />;
  }

  let clientSecret: string | null = null;
  try {
    const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const pi = await res.json();
    clientSecret = (pi.client_secret as string) || null;
  } catch {
    return <AuthError message="Could not connect to payment provider." />;
  }

  if (!clientSecret) {
    return <AuthError message="Payment verification not available." />;
  }

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-sm">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="text-2xl font-bold text-gray-900">Bank Verification</h1>
        <p className="mt-3 text-sm text-gray-600 mb-6">
          Your bank requires additional verification for this payment.
        </p>
        <div id="stripe-auth-container" />
        <p id="auth-status" className="mt-4 text-sm text-gray-500" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
(async function() {
  const statusEl = document.getElementById('auth-status');
  try {
    statusEl.textContent = 'Loading verification...';
    const stripe = window.Stripe ? window.Stripe('${publishableKey}') : null;
    if (!stripe) {
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.onload = async function() {
        const s = window.Stripe('${publishableKey}');
        await doConfirm(s);
      };
      document.head.appendChild(script);
    } else {
      await doConfirm(stripe);
    }
  } catch (e) {
    statusEl.textContent = 'Verification failed. Please return to WhatsApp.';
  }

  async function doConfirm(stripe) {
    statusEl.textContent = 'Verifying with your bank...';
    const { error, paymentIntent } = await stripe.confirmCardPayment('${clientSecret}');
    if (error) {
      statusEl.textContent = 'Verification failed: ' + error.message;
    } else if (paymentIntent && paymentIntent.status === 'succeeded') {
      document.querySelector('.text-5xl').textContent = '✅';
      document.querySelector('h1').textContent = 'Payment Confirmed';
      statusEl.textContent = 'Your payment has been confirmed. You can return to WhatsApp.';
    } else {
      statusEl.textContent = 'Verification is processing. You can return to WhatsApp.';
    }
  }
})();
`,
          }}
        />
      </div>
    </div>
  );
}

function AuthError({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-sm">
        <div className="text-5xl mb-4">⚠️</div>
        <h1 className="text-2xl font-bold text-gray-900">Verification Unavailable</h1>
        <p className="mt-3 text-sm text-gray-600">{message}</p>
      </div>
    </div>
  );
}
