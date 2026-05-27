import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Refund Policy — Waaiio',
  description:
    'Waaiio refund policy covering subscription refunds, transaction fees, gateway processing fees, and per-country refund procedures.',
};

export default function RefundPolicyPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Refund Policy</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">Our refund terms for subscriptions, transaction fees, and payment processing.</p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <p className="mt-2 text-sm text-gray-400">Last updated: May 23, 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">

            {/* ── Introduction ─────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">Introduction</h2>
              <p className="mt-2 leading-relaxed">
                This Refund Policy describes the terms under which CipherHQ LLC, doing business as
                Waaiio (&ldquo;Waaiio,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
                &ldquo;our&rdquo;), processes refunds for subscription fees, platform transaction
                fees, and payment gateway charges. This policy applies to all users of our Services
                across all operating countries (United States, Canada, Nigeria, Ghana, and the United
                Kingdom).
              </p>
            </section>

            {/* ── Subscription Refunds ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. Subscription Refunds</h2>

              <h3 className="mt-4 text-lg font-medium text-gray-900">1.1 Monthly Plans</h3>
              <p className="mt-2 leading-relaxed">
                Monthly subscription fees are generally <strong>non-refundable</strong>. When you
                cancel a monthly subscription, your access continues until the end of the current
                billing period. No partial refunds are issued for unused days within a billing cycle.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">1.2 Annual Plans</h3>
              <p className="mt-2 leading-relaxed">
                Annual subscription fees are eligible for a <strong>pro-rated refund</strong> if you
                cancel within 14 days of purchase or renewal. The refund amount is calculated as the
                total annual fee minus the cost of any full months used at the equivalent monthly rate.
                After the 14-day window, annual subscriptions are non-refundable, and your access
                continues until the end of the annual billing period.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">1.3 30-Day Trial</h3>
              <p className="mt-2 leading-relaxed">
                The 30-day trial is free. No charges are incurred during the trial period, so no
                refund applies. If you subscribe to a paid plan after your trial ends, the refund
                terms above apply from the date of your first paid subscription.
              </p>
            </section>

            {/* ── Transaction Fee Refunds ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. Platform Transaction Fees</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio charges a percentage-based platform fee on transactions processed through our
                Services. When a refund is issued to an end customer:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  <strong>Full refund:</strong> If the business issues a full refund to the end
                  customer, the Waaiio platform fee for that transaction is reversed in full. The
                  reversed amount will be credited to the business&rsquo;s next payout cycle.
                </li>
                <li>
                  <strong>Partial refund:</strong> If the business issues a partial refund, the
                  Waaiio platform fee is adjusted proportionally. For example, if 50% of the
                  transaction is refunded, 50% of the platform fee is reversed.
                </li>
              </ul>
            </section>

            {/* ── Gateway Processing Fees ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. Gateway Processing Fees</h2>
              <p className="mt-2 leading-relaxed">
                Payment gateway processing fees charged by third-party providers (Stripe, Paystack,
                Flutterwave, Square, and PayPal) are <strong>non-refundable</strong>. These fees are
                charged by the gateway at the time of payment and are not returned when a refund is
                processed. This is a policy of the gateway providers, not Waaiio.
              </p>
              <p className="mt-3 leading-relaxed">
                This means that when a full refund is issued, the business absorbs the original
                gateway processing fee. We recommend that businesses factor this into their refund
                policies for their own customers.
              </p>
            </section>

            {/* ── How to Request a Refund ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. How to Request a Refund</h2>
              <p className="mt-2 leading-relaxed">To request a refund, please follow these steps:</p>
              <ol className="mt-3 list-decimal space-y-2 pl-5">
                <li>
                  Email{' '}
                  <a href="mailto:hello@waaiio.com" className="text-brand underline">hello@waaiio.com</a>{' '}
                  with the subject line &ldquo;Refund Request.&rdquo;
                </li>
                <li>Include your account email address and the transaction or subscription reference.</li>
                <li>Describe the reason for your refund request.</li>
                <li>
                  Our team will review your request and respond within <strong>2 business days</strong>{' '}
                  with a determination.
                </li>
              </ol>
            </section>

            {/* ── Refund Timeline ─────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Refund Processing Timeline</h2>
              <p className="mt-2 leading-relaxed">
                Once a refund is approved, it typically takes <strong>5 to 10 business days</strong>{' '}
                for the refunded amount to appear in your account or on your payment method. The
                exact timeline depends on your payment gateway and financial institution:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Stripe (US, UK, CA):</strong> 5-10 business days to the original card or bank account.</li>
                <li><strong>Paystack (Nigeria, Ghana):</strong> 5-10 business days to the original payment source.</li>
                <li><strong>Flutterwave:</strong> 5-10 business days depending on the payment channel.</li>
                <li><strong>Square:</strong> 5-10 business days to the original card.</li>
                <li><strong>PayPal:</strong> 3-5 business days to the PayPal account balance or linked funding source.</li>
              </ul>
            </section>

            {/* ── Per-Country Notes ───────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Country-Specific Notes</h2>

              <h3 className="mt-4 text-lg font-medium text-gray-900">6.1 Nigeria</h3>
              <p className="mt-2 leading-relaxed">
                Refunds processed through Paystack are returned to the original payment source (bank
                account or card). Nigerian bank transfers may take slightly longer due to
                inter-bank settlement windows. Refunds are issued in Nigerian Naira (NGN).
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">6.2 United States</h3>
              <p className="mt-2 leading-relaxed">
                Refunds processed through Stripe are returned to the original card used for payment.
                If the original card has been cancelled or expired, the refund is typically routed by
                the card network to the replacement card or bank account. Refunds are issued in US
                Dollars (USD).
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">6.3 Canada</h3>
              <p className="mt-2 leading-relaxed">
                Refunds follow the same Stripe process as the United States. Refunds are issued in
                Canadian Dollars (CAD) or US Dollars (USD) depending on the original transaction
                currency.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">6.4 Ghana</h3>
              <p className="mt-2 leading-relaxed">
                Refunds processed through Paystack are returned to the original payment source.
                Mobile money refunds may take additional processing time. Refunds are issued in
                Ghanaian Cedis (GHS).
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">6.5 United Kingdom</h3>
              <p className="mt-2 leading-relaxed">
                Refunds processed through Stripe are returned to the original card. UK regulations
                provide additional consumer protections under the Consumer Rights Act 2015. Refunds
                are issued in British Pounds (GBP).
              </p>
            </section>

            {/* ── Chargebacks ─────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. Chargebacks</h2>
              <p className="mt-2 leading-relaxed">
                We strongly encourage customers and businesses to contact us before initiating a
                chargeback or dispute with their bank or card issuer. Chargebacks incur additional
                fees from payment processors, and we are often able to resolve issues faster through
                direct communication.
              </p>
              <p className="mt-3 leading-relaxed">
                If a chargeback is filed and subsequently found to be invalid, the original charge
                may be reinstated. Repeated fraudulent chargebacks may result in account suspension
                or termination.
              </p>
              <p className="mt-3 leading-relaxed">
                To resolve a payment dispute, email{' '}
                <a href="mailto:hello@waaiio.com" className="text-brand underline">hello@waaiio.com</a>{' '}
                with details of the transaction in question.
              </p>
            </section>

            {/* ── Business-to-Customer Refunds ────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">8. Business-to-Customer Refunds</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio facilitates payments between businesses and their customers. Each business on
                our platform is responsible for setting and communicating its own refund policy to its
                customers. Waaiio provides the tools for businesses to issue refunds through the
                dashboard, but the decision to refund and the terms of that refund are the
                responsibility of the business owner.
              </p>
              <p className="mt-3 leading-relaxed">
                If you are an end customer seeking a refund for a purchase made through a
                Waaiio-powered business, please contact the business directly. If you are unable to
                reach the business, you may contact us at{' '}
                <a href="mailto:hello@waaiio.com" className="text-brand underline">hello@waaiio.com</a>{' '}
                and we will attempt to facilitate communication.
              </p>
            </section>

            {/* ── Contact ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">9. Contact Us</h2>
              <p className="mt-2 leading-relaxed">
                For refund inquiries, please contact us:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Email:</strong>{' '}
                  <a href="mailto:hello@waaiio.com" className="text-brand underline">hello@waaiio.com</a>
                </li>
                <li><strong>Billing:</strong>{' '}
                  <a href="mailto:billing@waaiio.com" className="text-brand underline">billing@waaiio.com</a>
                </li>
                <li><strong>Company:</strong> CipherHQ LLC (d/b/a Waaiio)</li>
                <li><strong>Location:</strong> United States</li>
              </ul>
            </section>
          </div>
        </div>
      </AnimatedSection>
    </>
  );
}
