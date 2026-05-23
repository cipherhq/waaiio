import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Terms of Service — Waaiio',
  description:
    'Terms and conditions governing use of the Waaiio WhatsApp automation platform.',
};

export default function TermsOfServicePage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Terms of Service</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">The agreement between you and Waaiio.</p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <p className="mt-2 text-sm text-gray-400">Last updated: May 23, 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">

            {/* ── Introduction ─────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. Introduction</h2>
              <p className="mt-2 leading-relaxed">
                These Terms of Service (&ldquo;Terms&rdquo;) constitute a legally binding agreement between
                you (&ldquo;you,&rdquo; &ldquo;your,&rdquo; or &ldquo;User&rdquo;) and CipherHQ LLC, doing business as
                Waaiio (&ldquo;Waaiio,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;), governing your access to and use
                of our website at <a href="https://waaiio.com" className="text-brand underline">waaiio.com</a>,
                our WhatsApp automation platform, dashboard, APIs, and all related services
                (collectively, the &ldquo;Services&rdquo;).
              </p>
              <p className="mt-3 leading-relaxed">
                By creating an account or using our Services, you agree to be bound by these Terms,
                our <a href="/privacy" className="text-brand underline">Privacy Policy</a>,
                our <a href="/acceptable-use" className="text-brand underline">Acceptable Use Policy</a>,
                and any additional terms referenced herein. If you do not agree, do not use our
                Services.
              </p>
            </section>

            {/* ── Service Description ─────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. Service Description</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio is an AI-powered WhatsApp business automation platform that enables businesses
                to automate bookings, appointments, payments, orders, reservations, event ticketing,
                donations, customer engagement, and other business operations through the WhatsApp
                Business API. We support businesses across 40+ categories in the United States,
                Canada, Nigeria, Ghana, and the United Kingdom.
              </p>
            </section>

            {/* ── Account Registration ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. Account Registration and Responsibilities</h2>
              <p className="mt-2 leading-relaxed">
                To use our Services, you must create an account and provide accurate, complete, and current
                information. You are responsible for:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Maintaining the confidentiality of your account credentials</li>
                <li>All activities that occur under your account</li>
                <li>Ensuring that your use of the Services complies with all applicable laws and regulations in your jurisdiction</li>
                <li>Obtaining all necessary consents from your customers before using our Services to communicate with them via WhatsApp</li>
                <li>The accuracy and legality of all content, data, and information you provide through the Services</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                You must be at least 18 years of age (or the age of majority in your jurisdiction) to
                create an account. You may only maintain one active business account per legal entity
                unless otherwise agreed in writing.
              </p>
            </section>

            {/* ── Acceptable Use ──────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. Acceptable Use</h2>
              <p className="mt-2 leading-relaxed">
                Your use of the Services is subject to our{' '}
                <a href="/acceptable-use" className="text-brand underline">Acceptable Use Policy</a>,
                which is incorporated into these Terms by reference. You must also comply with
                Meta&rsquo;s WhatsApp Business Policy and all applicable messaging regulations,
                including Canada&rsquo;s Anti-Spam Legislation (CASL) where applicable.
              </p>
              <p className="mt-3 leading-relaxed">
                Violation of the Acceptable Use Policy may result in immediate suspension or
                termination of your account.
              </p>
            </section>

            {/* ── Payment Terms ───────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Payment Terms</h2>

              <h3 className="mt-4 text-lg font-medium text-gray-900">5.1 Subscription Plans</h3>
              <p className="mt-2 leading-relaxed">
                Waaiio offers tiered subscription plans (Starter/Free, Pro/Growth, and Premium/Business)
                with different feature sets and transaction fee rates. Plan details and pricing are
                available on our <a href="/pricing" className="text-brand underline">Pricing page</a>.
                By subscribing to a paid plan, you authorize us to charge the applicable subscription
                fee to your designated payment method on a recurring basis.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">5.2 Platform Transaction Fees</h3>
              <p className="mt-2 leading-relaxed">
                Waaiio charges a percentage-based platform fee on transactions processed through our
                Services. The applicable rate depends on your subscription plan. These fees are in
                addition to any fees charged by payment gateway providers (Stripe, Paystack,
                Flutterwave, Square, or PayPal).
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">5.3 Billing and Renewal</h3>
              <p className="mt-2 leading-relaxed">
                Paid subscriptions are billed in advance on a monthly basis and automatically renew
                unless cancelled before the renewal date. You may cancel your subscription at any
                time through your dashboard. Cancellation takes effect at the end of the current
                billing period.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">5.4 Refund Policy</h3>
              <p className="mt-2 leading-relaxed">
                Subscription fees are generally non-refundable. If you believe you are entitled to a
                refund due to a service deficiency, you may contact{' '}
                <a href="mailto:billing@waaiio.com" className="text-brand underline">billing@waaiio.com</a>{' '}
                within 14 days of the charge. Refund requests will be evaluated on a case-by-case basis.
                Transaction fees earned on processed payments are non-refundable.
              </p>
            </section>

            {/* ── Intellectual Property ───────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Intellectual Property</h2>
              <p className="mt-2 leading-relaxed">
                All intellectual property rights in the Services, including software, design, trademarks,
                logos, and documentation, are owned by or licensed to Waaiio. These Terms grant you a
                limited, non-exclusive, non-transferable, revocable license to access and use the
                Services for your internal business purposes during the term of your subscription.
              </p>
              <p className="mt-3 leading-relaxed">
                You may not copy, modify, distribute, reverse engineer, decompile, or create derivative
                works based on our Services or any part thereof without our prior written consent.
              </p>
            </section>

            {/* ── User Content and Data Ownership ─────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. User Content and Data Ownership</h2>
              <p className="mt-2 leading-relaxed">
                You retain all ownership rights to the data, content, and materials you submit through
                the Services (&ldquo;User Content&rdquo;). By using the Services, you grant Waaiio a
                limited, non-exclusive license to host, store, process, and display your User Content
                solely for the purpose of providing the Services.
              </p>
              <p className="mt-3 leading-relaxed">
                You are the data controller for personal data of your customers processed through our
                platform. You are responsible for ensuring that you have the appropriate legal basis
                and consents to collect, process, and share your customers&rsquo; data through the
                Services.
              </p>
              <p className="mt-3 leading-relaxed">
                Upon termination of your account, we will delete your User Content within 30 days,
                unless retention is required by law or you request data export before deletion.
              </p>
            </section>

            {/* ── Disclaimer of Warranties ────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">8. Disclaimer of Warranties</h2>
              <p className="mt-2 font-semibold uppercase leading-relaxed">
                THE SERVICES ARE PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
                WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE. TO THE
                FULLEST EXTENT PERMITTED BY APPLICABLE LAW, WAAIIO DISCLAIMS ALL WARRANTIES,
                INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
                PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.
              </p>
              <p className="mt-3 leading-relaxed">
                Without limiting the foregoing, Waaiio does not warrant that: (a) the Services will
                be uninterrupted, error-free, or secure; (b) defects will be corrected; (c) the
                Services will meet your specific requirements; or (d) any data or content stored
                through the Services will not be lost or corrupted.
              </p>
            </section>

            {/* ── Limitation of Liability ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">9. Limitation of Liability</h2>
              <p className="mt-2 font-semibold uppercase leading-relaxed">
                TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL WAAIIO, ITS
                OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, OR AFFILIATES BE LIABLE FOR ANY INDIRECT,
                INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS,
                REVENUE, DATA, GOODWILL, OR OTHER INTANGIBLE LOSSES, ARISING OUT OF OR RELATED TO
                YOUR USE OF OR INABILITY TO USE THE SERVICES, REGARDLESS OF THE THEORY OF LIABILITY
                (CONTRACT, TORT, OR OTHERWISE) AND EVEN IF WAAIIO HAS BEEN ADVISED OF THE
                POSSIBILITY OF SUCH DAMAGES.
              </p>
              <p className="mt-3 leading-relaxed">
                Without limiting the above, Waaiio is not liable for:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Missed bookings, appointments, or reservations due to system errors, network issues, or customer error</li>
                <li>Payment processing failures or delays caused by third-party payment gateways</li>
                <li>WhatsApp message delivery failures caused by Meta, network conditions, or recipient device status</li>
                <li>Data loss beyond what is covered by our standard backup and recovery procedures</li>
                <li>Actions taken by third parties using your account credentials</li>
                <li>Loss of business or revenue arising from service interruptions</li>
              </ul>
              <p className="mt-3 font-semibold uppercase leading-relaxed">
                WAAIIO&rsquo;S TOTAL AGGREGATE LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM OR
                RELATED TO THESE TERMS OR THE SERVICES SHALL NOT EXCEED THE GREATER OF (A) THE
                AMOUNTS YOU PAID TO WAAIIO IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING
                RISE TO THE CLAIM, OR (B) ONE HUNDRED UNITED STATES DOLLARS ($100.00 USD).
              </p>
            </section>

            {/* ── Indemnification ─────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">10. Indemnification</h2>
              <p className="mt-2 leading-relaxed">
                You agree to indemnify, defend, and hold harmless Waaiio and its officers, directors,
                employees, agents, and affiliates from and against any and all claims, damages,
                obligations, losses, liabilities, costs, and expenses (including reasonable
                attorneys&rsquo; fees) arising from or related to:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Your use of the Services</li>
                <li>Your violation of these Terms, the Acceptable Use Policy, or any applicable law</li>
                <li>Your User Content or the data you process through the Services</li>
                <li>Any claim by a third party (including your customers) arising from your use of the Services</li>
                <li>Your failure to obtain appropriate consents from your customers for WhatsApp messaging, data collection, or payment processing</li>
              </ul>
            </section>

            {/* ── Dispute Resolution ──────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">11. Dispute Resolution and Governing Law</h2>

              <h3 className="mt-4 text-lg font-medium text-gray-900">11.1 Governing Law</h3>
              <p className="mt-2 leading-relaxed">
                These Terms shall be governed by and construed in accordance with the laws of the
                State of Delaware, United States, without regard to its conflict-of-law principles.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">11.2 Binding Arbitration</h3>
              <p className="mt-2 leading-relaxed">
                Any dispute, controversy, or claim arising out of or relating to these Terms or the
                Services shall be resolved through binding arbitration administered by the American
                Arbitration Association (AAA) under its Commercial Arbitration Rules. The arbitration
                shall be conducted in English, and the seat of arbitration shall be Wilmington,
                Delaware, United States. The arbitrator&rsquo;s decision shall be final and binding,
                and judgment may be entered in any court of competent jurisdiction.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">11.3 Class Action Waiver</h3>
              <p className="mt-2 leading-relaxed">
                YOU AGREE THAT ANY DISPUTE RESOLUTION PROCEEDINGS WILL BE CONDUCTED ONLY ON AN
                INDIVIDUAL BASIS AND NOT IN A CLASS, CONSOLIDATED, OR REPRESENTATIVE ACTION. If
                this class action waiver is found to be unenforceable, then the entirety of this
                arbitration provision shall be null and void.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">11.4 Exceptions</h3>
              <p className="mt-2 leading-relaxed">
                Notwithstanding the above, either party may seek injunctive or equitable relief in
                any court of competent jurisdiction to protect its intellectual property rights.
                Claims eligible for small claims court may be brought there instead of arbitration.
              </p>
            </section>

            {/* ── Account Termination ─────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">12. Account Termination</h2>
              <p className="mt-2 leading-relaxed">
                You may terminate your account at any time through the account deletion feature in
                your dashboard settings or by contacting{' '}
                <a href="mailto:support@waaiio.com" className="text-brand underline">support@waaiio.com</a>.
              </p>
              <p className="mt-3 leading-relaxed">
                We may suspend or terminate your account and access to the Services immediately,
                without prior notice, if:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>You violate these Terms or the Acceptable Use Policy</li>
                <li>Your account is used for fraudulent or illegal activity</li>
                <li>You fail to pay applicable fees when due</li>
                <li>We are required to do so by law, regulation, or order of a government authority</li>
                <li>Meta/WhatsApp restricts or bans your WhatsApp Business account</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Upon termination, your right to use the Services ceases immediately. We will delete
                your account data within 30 days of termination, subject to legal retention requirements.
                Sections that by their nature should survive termination (including Sections 6, 8, 9,
                10, 11, and 14) shall survive.
              </p>
            </section>

            {/* ── Modifications ───────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">13. Modifications to Terms</h2>
              <p className="mt-2 leading-relaxed">
                We reserve the right to modify these Terms at any time. When we make material changes,
                we will provide at least 30 days&rsquo; notice by updating the &ldquo;Last updated&rdquo;
                date at the top of this page and notifying you by email or in-app notification.
                Your continued use of the Services after the effective date of any modifications
                constitutes your acceptance of the updated Terms.
              </p>
              <p className="mt-3 leading-relaxed">
                If you do not agree to the modified Terms, you must discontinue use of the Services
                before the effective date.
              </p>
            </section>

            {/* ── General Provisions ──────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">14. General Provisions</h2>

              <h3 className="mt-4 text-lg font-medium text-gray-900">14.1 Entire Agreement</h3>
              <p className="mt-2 leading-relaxed">
                These Terms, together with the Privacy Policy, Acceptable Use Policy, Data Processing
                Agreement, and Cookie Policy, constitute the entire agreement between you and Waaiio
                regarding the Services and supersede all prior agreements, understandings, and
                communications, whether written or oral.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">14.2 Severability</h3>
              <p className="mt-2 leading-relaxed">
                If any provision of these Terms is found to be invalid, illegal, or unenforceable by
                a court of competent jurisdiction, the remaining provisions shall continue in full
                force and effect. The invalid provision shall be modified to the minimum extent
                necessary to make it valid and enforceable while preserving its original intent.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">14.3 Waiver</h3>
              <p className="mt-2 leading-relaxed">
                No waiver of any term or condition of these Terms shall be deemed a further or
                continuing waiver of such term or any other term. Our failure to exercise or enforce
                any right or provision of these Terms shall not constitute a waiver of such right
                or provision.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">14.4 Assignment</h3>
              <p className="mt-2 leading-relaxed">
                You may not assign or transfer these Terms or your rights under them without our
                prior written consent. Waaiio may assign these Terms in connection with a merger,
                acquisition, reorganization, or sale of all or substantially all of its assets.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">14.5 Force Majeure</h3>
              <p className="mt-2 leading-relaxed">
                Waaiio shall not be liable for any failure or delay in performing its obligations
                under these Terms due to causes beyond its reasonable control, including but not
                limited to acts of God, natural disasters, pandemic, war, terrorism, riots,
                government actions, power failures, internet or telecommunications failures, or
                third-party service provider outages.
              </p>
            </section>

            {/* ── Contact ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">15. Contact Information</h2>
              <p className="mt-2 leading-relaxed">
                For questions about these Terms, please contact us:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>General inquiries:</strong>{' '}
                  <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>
                </li>
                <li><strong>Billing:</strong>{' '}
                  <a href="mailto:billing@waaiio.com" className="text-brand underline">billing@waaiio.com</a>
                </li>
                <li><strong>Support:</strong>{' '}
                  <a href="mailto:support@waaiio.com" className="text-brand underline">support@waaiio.com</a>
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
