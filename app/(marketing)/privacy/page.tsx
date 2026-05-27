import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Privacy Policy — Waaiio',
  description:
    'How Waaiio collects, uses, stores, and protects personal information. Covers CCPA, GDPR, UK GDPR, NDPR, PIPEDA, and Ghana DPA compliance.',
};

export default function PrivacyPolicyPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Privacy Policy</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">How we collect, use, and protect your personal information.</p>
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
                This Privacy Policy describes how CipherHQ LLC, doing business as Waaiio
                (&ldquo;Waaiio,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;),
                collects, uses, discloses, and protects personal information when you use our
                website at <a href="https://waaiio.com" className="text-brand underline">waaiio.com</a>,
                our WhatsApp automation platform, dashboard, APIs, and related services
                (collectively, the &ldquo;Services&rdquo;).
              </p>
              <p className="mt-3 leading-relaxed">
                Waaiio operates in the United States, Canada, Nigeria, Ghana, and the United
                Kingdom. This policy is designed to comply with the California Consumer Privacy Act
                (CCPA/CPRA), the EU General Data Protection Regulation (GDPR), the UK General Data
                Protection Regulation (UK GDPR), the Nigeria Data Protection Regulation (NDPR), and
                the Ghana Data Protection Act, 2012 (Act 843).
              </p>
              <p className="mt-3 leading-relaxed">
                By using our Services, you acknowledge that you have read and understood this
                Privacy Policy. If you do not agree with our practices, please do not use our
                Services.
              </p>
            </section>

            {/* ── Data We Collect ──────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. Information We Collect</h2>

              <h3 className="mt-4 text-lg font-medium text-gray-900">1.1 Business Owners (Data Controllers)</h3>
              <p className="mt-2 leading-relaxed">When you register for a Waaiio account, we collect:</p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Full name and email address</li>
                <li>Phone number</li>
                <li>Business name, category, address, and operating country</li>
                <li>Payment credentials (processed by third-party payment gateways; we do not store card numbers)</li>
                <li>Business logo and branding assets you upload</li>
                <li>Subscription plan and billing history</li>
              </ul>

              <h3 className="mt-6 text-lg font-medium text-gray-900">1.2 End Customers</h3>
              <p className="mt-2 leading-relaxed">
                When customers interact with a business through Waaiio&rsquo;s WhatsApp automation, we process:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Name and phone number (provided via WhatsApp)</li>
                <li>Email address (when optionally provided)</li>
                <li>Booking, reservation, and appointment details</li>
                <li>Order history and preferences</li>
                <li>Payment transaction amounts and gateway references (no card numbers)</li>
                <li>WhatsApp conversation messages, timestamps, and media (images, audio) exchanged with the business</li>
                <li>E-signature records for contracts</li>
                <li>Event ticket purchase history</li>
              </ul>

              <h3 className="mt-6 text-lg font-medium text-gray-900">1.3 Website Visitors</h3>
              <p className="mt-2 leading-relaxed">When you visit our website, we may collect:</p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>IP address and approximate location (country/region)</li>
                <li>Browser type, operating system, and device information</li>
                <li>Pages visited, referral source, and session duration</li>
                <li>Cookie and localStorage identifiers (see our <a href="/cookies" className="text-brand underline">Cookie Policy</a>)</li>
              </ul>

              <h3 className="mt-6 text-lg font-medium text-gray-900">1.4 Information Collected Automatically</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Analytics data:</strong> We use PostHog to collect anonymized usage events, page views, and feature interactions.</li>
                <li><strong>Error monitoring:</strong> Sentry captures error logs, stack traces, and performance metrics. These may include request metadata but not message content.</li>
                <li><strong>AI processing logs:</strong> When our AI features (powered by Anthropic Claude) process messages for intent detection or language translation, we log usage metrics (token counts, costs) but do not store the raw message content in AI provider systems beyond the processing window.</li>
              </ul>
            </section>

            {/* ── How We Use Data ─────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. How We Use Your Information</h2>
              <p className="mt-2 leading-relaxed">We use personal information for the following purposes:</p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Service delivery:</strong> Processing bookings, orders, payments, tickets, and reservations on behalf of businesses.</li>
                <li><strong>WhatsApp messaging:</strong> Delivering automated and manual messages between businesses and their customers via the WhatsApp Business API.</li>
                <li><strong>AI-powered features:</strong> Natural language understanding for intent detection, language translation, and smart booking (via Anthropic Claude).</li>
                <li><strong>Payment processing:</strong> Facilitating transactions through Stripe, Paystack, Flutterwave, Square, and PayPal.</li>
                <li><strong>Account management:</strong> Authentication, authorization, and account security.</li>
                <li><strong>Communications:</strong> Sending transactional emails (booking confirmations, payment receipts, password resets) via Resend.</li>
                <li><strong>Analytics and improvement:</strong> Understanding usage patterns to improve our Services (via PostHog).</li>
                <li><strong>Error monitoring and debugging:</strong> Identifying and resolving technical issues (via Sentry).</li>
                <li><strong>Legal compliance:</strong> Meeting our obligations under applicable laws and regulations.</li>
                <li><strong>Fraud prevention:</strong> Detecting and preventing fraudulent activity, abuse, and security incidents.</li>
              </ul>
            </section>

            {/* ── Legal Basis ─────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. Legal Basis for Processing (GDPR / UK GDPR / NDPR)</h2>
              <p className="mt-2 leading-relaxed">
                Where GDPR, UK GDPR, or NDPR applies, we process personal data on the following legal bases:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Performance of a contract:</strong> Processing necessary to deliver our Services to business owners who have subscribed to a plan.</li>
                <li><strong>Legitimate interests:</strong> Analytics, fraud prevention, platform security, and product improvement, where these interests are not overridden by data subject rights.</li>
                <li><strong>Consent:</strong> Non-essential cookies, marketing communications, and optional data collection where we request and obtain explicit consent.</li>
                <li><strong>Legal obligation:</strong> Processing required to comply with applicable laws, such as tax reporting, anti-money laundering, and responding to lawful requests from authorities.</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                For end customers whose data is processed through our platform, the business owner
                is the data controller and determines the legal basis for processing. Waaiio acts as
                a data processor on their behalf (see our <a href="/dpa" className="text-brand underline">Data Processing Agreement</a>).
              </p>
            </section>

            {/* ── Data Sharing ────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. Who We Share Data With</h2>
              <p className="mt-2 leading-relaxed">
                We do not sell your personal information. We share data only with the following
                categories of service providers, each bound by data processing agreements:
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Provider</th>
                      <th className="pb-2 pr-4 font-semibold">Purpose</th>
                      <th className="pb-2 font-semibold">Data Shared</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4">Supabase (AWS)</td>
                      <td className="py-2 pr-4">Database, authentication, file storage</td>
                      <td className="py-2">All platform data (encrypted at rest)</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Meta / WhatsApp</td>
                      <td className="py-2 pr-4">WhatsApp Business API message delivery</td>
                      <td className="py-2">Phone numbers, message content, media</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Stripe</td>
                      <td className="py-2 pr-4">Payment processing (US, UK, CA)</td>
                      <td className="py-2">Transaction amounts, customer identifiers</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Paystack</td>
                      <td className="py-2 pr-4">Payment processing (Nigeria, Ghana)</td>
                      <td className="py-2">Transaction amounts, customer identifiers</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Flutterwave</td>
                      <td className="py-2 pr-4">Payment processing (Africa)</td>
                      <td className="py-2">Transaction amounts, customer identifiers</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Square</td>
                      <td className="py-2 pr-4">Payment processing (US)</td>
                      <td className="py-2">Transaction amounts, customer identifiers</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">PayPal</td>
                      <td className="py-2 pr-4">Payment processing</td>
                      <td className="py-2">Transaction amounts, customer identifiers</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Resend</td>
                      <td className="py-2 pr-4">Transactional email delivery</td>
                      <td className="py-2">Email addresses, email content</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">PostHog</td>
                      <td className="py-2 pr-4">Product analytics</td>
                      <td className="py-2">Anonymized usage events, page views</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Anthropic</td>
                      <td className="py-2 pr-4">AI intent detection and language translation</td>
                      <td className="py-2">Message text (processed, not stored)</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Sentry</td>
                      <td className="py-2 pr-4">Error monitoring and performance</td>
                      <td className="py-2">Error logs, request metadata</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Vercel</td>
                      <td className="py-2 pr-4">Application hosting and edge functions</td>
                      <td className="py-2">Request logs, IP addresses</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Gupshup</td>
                      <td className="py-2 pr-4">WhatsApp Business API provider</td>
                      <td className="py-2">Phone numbers, message content</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-4 leading-relaxed">
                We may also disclose information when required by law, to protect our rights, or in
                connection with a merger, acquisition, or sale of assets (with prior notice where
                legally required).
              </p>
            </section>

            {/* ── Data Retention ──────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Data Retention</h2>
              <p className="mt-2 leading-relaxed">We retain personal data as follows:</p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Account data:</strong> Retained for the duration of your account plus 30 days after deletion.</li>
                <li><strong>Booking and order data:</strong> Retained for 3 years after the last transaction for business reporting and dispute resolution.</li>
                <li><strong>Payment records:</strong> Retained for 7 years to comply with tax and financial reporting obligations.</li>
                <li><strong>WhatsApp conversation logs:</strong> Retained for 2 years from the date of the last message, then automatically purged.</li>
                <li><strong>Analytics data:</strong> Aggregated and anonymized; retained indefinitely in aggregate form.</li>
                <li><strong>Error logs:</strong> Retained for 90 days.</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Business owners may request earlier deletion of their data and their customers&rsquo; data by contacting us (see Section 10 below).
              </p>
            </section>

            {/* ── CCPA Rights ─────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Your Rights Under the California Consumer Privacy Act (CCPA/CPRA)</h2>
              <p className="mt-2 leading-relaxed">
                If you are a California resident, you have the following rights:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Right to know:</strong> You may request the categories and specific pieces of personal information we have collected about you, the sources of that information, the purposes for collection, and the third parties with whom we share it.</li>
                <li><strong>Right to delete:</strong> You may request that we delete your personal information, subject to certain legal exceptions.</li>
                <li><strong>Right to correct:</strong> You may request that we correct inaccurate personal information.</li>
                <li><strong>Right to opt-out of sale or sharing:</strong> We do not sell or share your personal information for cross-context behavioral advertising. No opt-out is necessary.</li>
                <li><strong>Right to non-discrimination:</strong> We will not discriminate against you for exercising any of your CCPA rights.</li>
                <li><strong>Right to limit use of sensitive personal information:</strong> We do not use sensitive personal information for purposes beyond what is necessary to provide our Services.</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                To exercise your CCPA rights, email{' '}
                <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>{' '}
                or use the account deletion feature in your dashboard settings. We will verify your
                identity and respond within 45 days.
              </p>
              <p className="mt-3 leading-relaxed">
                <strong>Right to appeal:</strong> If we deny your CCPA request in whole or in part,
                you have the right to appeal the decision. To submit an appeal, email{' '}
                <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>{' '}
                with the subject line &ldquo;CCPA Appeal&rdquo; within 30 days of receiving our
                denial. We will review your appeal and respond within 60 days. If you are not
                satisfied with the outcome of the appeal, you may contact the California Attorney
                General&rsquo;s office to file a complaint.
              </p>
            </section>

            {/* ── GDPR Rights ─────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. Your Rights Under GDPR, UK GDPR, and NDPR</h2>
              <p className="mt-2 leading-relaxed">
                If you are located in the European Economic Area, the United Kingdom, or Nigeria, you have the following rights:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Right of access:</strong> Obtain a copy of your personal data and information about how it is processed.</li>
                <li><strong>Right to rectification:</strong> Request correction of inaccurate or incomplete personal data.</li>
                <li><strong>Right to erasure:</strong> Request deletion of your personal data (&ldquo;right to be forgotten&rdquo;), subject to legal retention requirements.</li>
                <li><strong>Right to data portability:</strong> Receive your personal data in a structured, commonly used, machine-readable format.</li>
                <li><strong>Right to object:</strong> Object to processing based on legitimate interests, including profiling.</li>
                <li><strong>Right to restrict processing:</strong> Request limitation of processing in certain circumstances.</li>
                <li><strong>Right to withdraw consent:</strong> Where processing is based on consent, you may withdraw consent at any time without affecting the lawfulness of prior processing.</li>
                <li><strong>Right to lodge a complaint:</strong> You may file a complaint with your local supervisory authority (e.g., the ICO in the UK, the NITDA in Nigeria, or the Data Protection Commission in Ghana).</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                To exercise these rights, contact{' '}
                <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>.
                We will respond within 30 days (or as required by applicable law).
              </p>
            </section>

            {/* ── Ghana DPA ───────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">8. Ghana Data Protection Act (Act 843)</h2>
              <p className="mt-2 leading-relaxed">
                If you are located in Ghana, the Data Protection Act, 2012 (Act 843) provides you with rights similar to those described in Section 7, including the right to access, correct, and delete your personal data. Waaiio is committed to processing data in accordance with Act 843 and the regulations issued by the Data Protection Commission of Ghana.
              </p>
            </section>

            {/* ── PIPEDA (Canada) ──────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">8A. Personal Information Protection and Electronic Documents Act (PIPEDA) — Canada</h2>
              <p className="mt-2 leading-relaxed">
                If you are located in Canada, the Personal Information Protection and Electronic
                Documents Act (PIPEDA) and applicable provincial privacy legislation provide you
                with the following rights:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Right of access:</strong> You may request access to your personal information held by Waaiio, including information about how it has been used and to whom it has been disclosed.</li>
                <li><strong>Right to correction:</strong> You may request correction of any inaccurate or incomplete personal information.</li>
                <li><strong>Right to withdraw consent:</strong> You may withdraw your consent for the collection, use, or disclosure of your personal information, subject to legal or contractual restrictions and reasonable notice.</li>
                <li><strong>Right to challenge compliance:</strong> You may challenge our compliance with PIPEDA by contacting our Privacy Officer (see Section 16 below) or by filing a complaint with the Office of the Privacy Commissioner of Canada.</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Waaiio collects, uses, and discloses personal information only for purposes that a
                reasonable person would consider appropriate in the circumstances, and only with
                meaningful consent. We limit collection to what is necessary for the identified
                purposes and retain personal information only as long as necessary to fulfill those
                purposes.
              </p>
              <p className="mt-3 leading-relaxed">
                To exercise your rights under PIPEDA, contact{' '}
                <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>.
                We will respond within 30 days.
              </p>
            </section>

            {/* ── International Transfers ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">9. International Data Transfers</h2>
              <p className="mt-2 leading-relaxed">
                Our primary infrastructure is hosted in the United States. Personal data collected
                from users in the EEA, UK, Nigeria, Ghana, and Canada may be transferred to and
                processed in the United States and other jurisdictions where our service providers
                operate. We protect these transfers using:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Standard Contractual Clauses (SCCs) approved by the European Commission</li>
                <li>UK International Data Transfer Agreement (IDTA) for UK-originating transfers</li>
                <li>EU-US Data Privacy Framework certification (where applicable)</li>
                <li>Contractual protections with all sub-processors requiring equivalent safeguards</li>
              </ul>
            </section>

            {/* ── How to Exercise Rights ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">10. How to Exercise Your Rights</h2>
              <p className="mt-2 leading-relaxed">You can exercise your privacy rights through the following methods:</p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Self-service:</strong> Use the account deletion feature in your dashboard under Settings &gt; Account to delete your account and all associated data.</li>
                <li><strong>Email:</strong> Send a request to <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a> with your name, email address, and the specific right you wish to exercise.</li>
                <li><strong>Authorized agent:</strong> You may designate an authorized agent to submit a request on your behalf. We may require verification of the agent&rsquo;s authority.</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                We will verify your identity before processing any request and respond within the
                timeframes required by applicable law (typically 30 to 45 days).
              </p>
            </section>

            {/* ── Children ────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">11. Children&rsquo;s Privacy</h2>
              <p className="mt-2 leading-relaxed">
                Our Services are not directed to individuals under the age of 13 (or 16 in the EEA/UK).
                We do not knowingly collect personal information from children. If we become aware
                that we have collected personal data from a child without appropriate parental consent,
                we will take steps to delete that information promptly. If you believe a child has
                provided us with personal information, please contact{' '}
                <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>.
              </p>
            </section>

            {/* ── Security ────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">12. Data Security</h2>
              <p className="mt-2 leading-relaxed">
                We implement industry-standard technical and organizational measures to protect
                personal data, including:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Encryption in transit (TLS 1.2+) and at rest (AES-256)</li>
                <li>Row-level security (RLS) policies enforcing strict data isolation between businesses</li>
                <li>Bcrypt password hashing via Supabase Auth</li>
                <li>HMAC signature verification on all payment gateway webhooks</li>
                <li>Rate limiting on API endpoints</li>
                <li>CSRF protection via origin header validation</li>
                <li>Regular access reviews and least-privilege access controls</li>
                <li>Automated vulnerability scanning and dependency updates</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                No method of transmission or storage is 100% secure. While we strive to protect
                your data, we cannot guarantee absolute security.
              </p>
            </section>

            {/* ── Cookies ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">13. Cookies and Tracking Technologies</h2>
              <p className="mt-2 leading-relaxed">
                We use cookies and similar technologies as described in our{' '}
                <a href="/cookies" className="text-brand underline">Cookie Policy</a>.
                Non-essential cookies are only set after you provide explicit consent via our
                cookie banner. You can manage your preferences at any time through the
                &ldquo;Your Privacy Choices&rdquo; link in our footer.
              </p>
            </section>

            {/* ── Do Not Track ────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">14. Do Not Track Signals</h2>
              <p className="mt-2 leading-relaxed">
                Our Services do not currently respond to &ldquo;Do Not Track&rdquo; (DNT) browser
                signals, as there is no industry-standard protocol for DNT. However, we honor
                cookie consent preferences as described in our Cookie Policy and support the Global
                Privacy Control (GPC) signal where technically feasible.
              </p>
            </section>

            {/* ── Changes ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">15. Changes to This Privacy Policy</h2>
              <p className="mt-2 leading-relaxed">
                We may update this Privacy Policy from time to time. When we make material changes,
                we will notify you by updating the &ldquo;Last updated&rdquo; date at the top of
                this page and, where appropriate, by email or in-app notification. Your continued
                use of our Services after the effective date of any changes constitutes your
                acceptance of the updated policy.
              </p>
            </section>

            {/* ── Contact ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">16. Contact Us</h2>
              <p className="mt-2 leading-relaxed">
                If you have questions, concerns, or requests regarding this Privacy Policy or our
                data practices, please contact us:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Privacy inquiries:</strong>{' '}
                  <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>
                </li>
                <li><strong>Data Protection Officer:</strong>{' '}
                  <a href="mailto:dpo@waaiio.com" className="text-brand underline">dpo@waaiio.com</a>
                </li>
                <li><strong>Legal inquiries:</strong>{' '}
                  <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>
                </li>
                <li><strong>Company:</strong> CipherHQ LLC (d/b/a Waaiio)</li>
                <li><strong>Mailing address:</strong> CipherHQ LLC, 1209 Orange Street, Wilmington, DE 19801, United States</li>
              </ul>
            </section>
          </div>
        </div>
      </AnimatedSection>
    </>
  );
}
