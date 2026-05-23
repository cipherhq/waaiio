import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Acceptable Use Policy — Waaiio',
  description:
    'Rules governing acceptable use of the Waaiio WhatsApp automation platform, including prohibited activities and content restrictions.',
};

export default function AcceptableUsePage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Acceptable Use Policy</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">Rules governing acceptable use of the Waaiio platform.</p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <p className="mt-2 text-sm text-gray-400">Last updated: May 23, 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">

            {/* ── Overview ────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. Overview</h2>
              <p className="mt-2 leading-relaxed">
                This Acceptable Use Policy (&ldquo;AUP&rdquo;) governs your use of Waaiio&rsquo;s
                WhatsApp automation platform and is incorporated by reference into our{' '}
                <a href="/terms" className="text-brand underline">Terms of Service</a>. By using our
                Services, you agree to comply with this AUP, Meta&rsquo;s WhatsApp Business Policy,
                WhatsApp Commerce Policy, and all applicable laws and regulations in your jurisdiction.
              </p>
              <p className="mt-3 leading-relaxed">
                Waaiio reserves the right to update this policy at any time. Material changes will be
                communicated via email or in-app notification.
              </p>
            </section>

            {/* ── Prohibited Activities ──────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. Prohibited Activities</h2>
              <p className="mt-2 leading-relaxed">You must not use Waaiio to:</p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.1 Spam and Unsolicited Messaging</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Send unsolicited messages to recipients who have not explicitly opted in to receive communications from your business</li>
                <li>Purchase, rent, or harvest phone number lists for the purpose of sending messages</li>
                <li>Send bulk messages that violate WhatsApp&rsquo;s messaging limits or quality guidelines</li>
                <li>Circumvent opt-out requests or make it difficult for recipients to unsubscribe</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.2 Fraud and Deception</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Misrepresent your identity, business, or the nature of your products and services</li>
                <li>Use the Services for phishing, social engineering, or identity theft</li>
                <li>Create fake bookings, orders, or transactions to manipulate the platform</li>
                <li>Process payments for goods or services you do not intend to deliver</li>
                <li>Use the Services for money laundering or terrorist financing</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.3 Illegal Content and Activities</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Sell or promote illegal goods or services, including controlled substances, weapons, counterfeit goods, or stolen property</li>
                <li>Distribute child sexual abuse material (CSAM) or exploit minors in any way</li>
                <li>Facilitate gambling, unless you hold all required licenses in the relevant jurisdiction</li>
                <li>Engage in any activity that violates applicable local, state, national, or international law</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.4 Harassment and Harmful Content</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Transmit threatening, abusive, harassing, defamatory, or discriminatory content</li>
                <li>Engage in stalking, bullying, or intimidation of any individual</li>
                <li>Distribute content that promotes violence, self-harm, or hatred against individuals or groups based on race, ethnicity, religion, gender, sexual orientation, disability, or national origin</li>
                <li>Share private or confidential information about others without their consent (doxxing)</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.5 Technical Abuse</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Attempt to gain unauthorized access to Waaiio&rsquo;s systems, other user accounts, or data</li>
                <li>Distribute malware, viruses, trojans, or other malicious software through the platform</li>
                <li>Interfere with or disrupt the integrity or performance of the Services</li>
                <li>Circumvent rate limits, security controls, or access restrictions</li>
                <li>Reverse engineer, decompile, or attempt to extract the source code of the Services</li>
                <li>Use automated scripts, bots, or scrapers to access the Services without authorization</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.6 Intellectual Property Violations</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Infringe on the intellectual property rights of any third party, including copyrights, trademarks, and patents</li>
                <li>Impersonate another person, business, brand, or organization</li>
                <li>Use Waaiio&rsquo;s trademarks, logos, or branding in a misleading manner</li>
              </ul>
            </section>

            {/* ── WhatsApp-Specific Rules ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. WhatsApp Business Messaging Rules</h2>
              <p className="mt-2 leading-relaxed">
                As a Meta Technology Partner, Waaiio is bound by Meta&rsquo;s WhatsApp Business Platform
                policies. All users must comply with these requirements:
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">3.1 Consent and Opt-In</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>You must obtain clear, informed, and documented consent from each recipient before sending them messages via WhatsApp</li>
                <li>Consent must specify the types of messages the recipient will receive (e.g., booking confirmations, promotional offers, order updates)</li>
                <li>You must maintain records of consent and be able to produce them upon request</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">3.2 Message Windows and Templates</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>24-hour customer service window:</strong> Free-form replies are permitted within 24 hours of a customer&rsquo;s last message. Outside this window, only pre-approved WhatsApp message templates may be used.</li>
                <li><strong>Template messages:</strong> All template messages must be approved by Meta before use. Templates must comply with WhatsApp&rsquo;s content guidelines and may not contain misleading or deceptive content.</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">3.3 Opt-Out and Unsubscribe</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Every broadcast or promotional message must include clear instructions for recipients to unsubscribe</li>
                <li>Opt-out requests must be honored immediately — no further messages may be sent after an opt-out</li>
                <li>Waaiio provides built-in opt-out mechanisms that you must not disable or circumvent</li>
              </ul>

              <h3 className="mt-4 text-lg font-medium text-gray-900">3.4 Message Quality</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Maintain a healthy WhatsApp quality rating. Excessive blocks or reports from recipients may result in messaging restrictions imposed by Meta</li>
                <li>Do not send repetitive, irrelevant, or excessively frequent messages</li>
                <li>Ensure all messages provide genuine value to recipients</li>
              </ul>
            </section>

            {/* ── CASL ────────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. CASL Compliance (Canada)</h2>
              <p className="mt-2 leading-relaxed">
                If you send messages to recipients in Canada, you must also comply with Canada&rsquo;s
                Anti-Spam Legislation (CASL):
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Obtain express consent before sending commercial electronic messages (CEMs)</li>
                <li>Include your business name, mailing address, and contact information in every message</li>
                <li>Provide a working unsubscribe mechanism; process opt-outs within 10 business days</li>
                <li>Implied consent expires after 2 years (existing business relationship) or 6 months (inquiry)</li>
              </ul>
            </section>

            {/* ── Content Restrictions ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Content Restrictions</h2>
              <p className="mt-2 leading-relaxed">
                The following types of content are prohibited on the Waaiio platform, whether in
                WhatsApp messages, business profiles, product listings, or any other content area:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Sexually explicit or pornographic material</li>
                <li>Content promoting violence, self-harm, or substance abuse</li>
                <li>Discriminatory content targeting protected characteristics</li>
                <li>False or misleading health claims</li>
                <li>Multi-level marketing (MLM) or pyramid scheme promotions</li>
                <li>Unauthorized financial advice or unregistered securities offerings</li>
                <li>Content that violates Meta&rsquo;s WhatsApp Commerce Policy</li>
              </ul>
            </section>

            {/* ── Monitoring and Enforcement ──────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Monitoring and Enforcement</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio reserves the right to monitor use of the Services for compliance with this AUP.
                We may use automated tools (including profanity filters and content moderation) to
                detect violations. We are not obligated to monitor but may do so at our discretion.
              </p>
            </section>

            {/* ── Consequences ────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. Consequences of Violations</h2>
              <p className="mt-2 leading-relaxed">
                If you violate this policy, Waaiio may take one or more of the following actions at
                its sole discretion:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Warning:</strong> Issue a written warning with a deadline to remedy the violation</li>
                <li><strong>Suspension:</strong> Temporarily suspend your account and messaging capabilities pending investigation</li>
                <li><strong>Feature restriction:</strong> Disable specific features (e.g., broadcast messaging) while permitting continued use of other Services</li>
                <li><strong>Termination:</strong> Permanently terminate your account without refund</li>
                <li><strong>Legal action:</strong> Report illegal activity to the relevant law enforcement authorities</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                We may also be required to report violations to Meta, which may independently restrict,
                flag, or ban your WhatsApp Business account. Such actions by Meta are outside
                Waaiio&rsquo;s control.
              </p>
            </section>

            {/* ── Reporting Violations ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">8. Reporting Violations</h2>
              <p className="mt-2 leading-relaxed">
                If you become aware of any violation of this Acceptable Use Policy by another user,
                please report it to us immediately. We take all reports seriously and will investigate
                promptly.
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Report abuse:</strong>{' '}
                  <a href="mailto:abuse@waaiio.com" className="text-brand underline">abuse@waaiio.com</a>
                </li>
                <li><strong>General policy questions:</strong>{' '}
                  <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>
                </li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Reports may be submitted anonymously. We will not retaliate against any user who
                reports a violation in good faith.
              </p>
            </section>
          </div>
        </div>
      </AnimatedSection>
    </>
  );
}
