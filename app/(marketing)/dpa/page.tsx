import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Data Processing Agreement — Waaiio',
  description:
    'Data Processing Agreement covering how Waaiio processes personal data on behalf of business customers under GDPR, UK GDPR, and NDPR.',
};

export default function DPAPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Data Processing Agreement</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">How Waaiio processes personal data on behalf of business customers.</p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <p className="mt-2 text-sm text-gray-400">Last updated: May 28, 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">

            {/* ── Preamble ────────────────────────────────────── */}
            <section>
              <p className="leading-relaxed">
                This Data Processing Agreement (&ldquo;DPA&rdquo;) forms part of the Terms of Service
                between you (&ldquo;Controller&rdquo; or &ldquo;Business&rdquo;) and CipherHQ LLC, doing business as
                Waaiio (&ldquo;Processor&rdquo; or &ldquo;Waaiio&rdquo;), and governs the processing of personal data
                by Waaiio on behalf of the Controller. This DPA applies to the extent that GDPR
                (EU), UK GDPR, NDPR (Nigeria), or Ghana DPA (Act 843) applies to the processing.
              </p>
            </section>

            {/* ── 1. Roles & Definitions ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. Roles and Definitions</h2>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  <strong>Data Controller:</strong> You, the business owner who determines the
                  purposes and means of processing personal data of your customers through Waaiio.
                </li>
                <li>
                  <strong>Data Processor:</strong> CipherHQ LLC (d/b/a Waaiio), which processes
                  personal data on your behalf to deliver the Services.
                </li>
                <li>
                  <strong>Data Subjects:</strong> Your customers, contacts, and end users whose
                  personal data is processed through Waaiio.
                </li>
                <li>
                  <strong>Personal Data:</strong> Any information relating to an identified or
                  identifiable natural person, as defined by applicable data protection law.
                </li>
                <li>
                  <strong>Sub-processor:</strong> A third-party entity engaged by Waaiio to assist
                  in processing personal data on behalf of the Controller.
                </li>
              </ul>
            </section>

            {/* ── 2. Scope of Processing ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. Scope and Purpose of Processing</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio processes personal data solely for the purpose of providing the Services you
                have subscribed to, including:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Delivering and receiving WhatsApp messages on behalf of your business</li>
                <li>Processing bookings, appointments, orders, and reservations</li>
                <li>Processing payment transactions (via integrated payment gateways)</li>
                <li>Generating and delivering event tickets with QR codes</li>
                <li>Maintaining conversation history and customer records</li>
                <li>AI-powered intent detection and language translation</li>
                <li>Sending transactional emails (booking confirmations, receipts)</li>
                <li>Generating reports and analytics on your business operations</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Waaiio does not sell personal data, use it for its own marketing purposes, or process
                it for any purpose other than providing the Services as instructed by the Controller.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">Categories of Personal Data Processed</h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Contact information: names, phone numbers, email addresses</li>
                <li>Transactional data: booking details, order items, payment amounts, gateway references</li>
                <li>Communication data: WhatsApp messages, timestamps, media files</li>
                <li>Contract data: e-signature records</li>
                <li>Technical data: IP addresses, device identifiers (for website visitors)</li>
              </ul>
            </section>

            {/* ── 3. Data Processing Instructions ────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. Data Processing Instructions</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio shall process personal data only in accordance with documented instructions
                from the Controller, unless required to do so by applicable law. If Waaiio is
                required to process personal data for any purpose other than as instructed, Waaiio
                shall inform the Controller of that legal requirement prior to processing, unless
                prohibited by law.
              </p>
              <p className="mt-3 leading-relaxed">
                If Waaiio believes that an instruction from the Controller infringes applicable data
                protection law, Waaiio shall promptly notify the Controller.
              </p>
            </section>

            {/* ── 4. Confidentiality ─────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. Confidentiality</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio shall ensure that all personnel authorized to process personal data are bound
                by appropriate confidentiality obligations. Access to personal data is restricted to
                personnel who require it to perform the Services.
              </p>
            </section>

            {/* ── 5. Sub-processors ──────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Sub-processors</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio uses the following sub-processors to deliver the Services. Each sub-processor
                is bound by data processing agreements providing protections consistent with this DPA.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Sub-processor</th>
                      <th className="pb-2 pr-4 font-semibold">Purpose</th>
                      <th className="pb-2 font-semibold">Location</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4">Meta Platforms / WhatsApp</td>
                      <td className="py-2 pr-4">Message delivery via WhatsApp Business API</td>
                      <td className="py-2">US / Global</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Gupshup</td>
                      <td className="py-2 pr-4">WhatsApp Business API provider</td>
                      <td className="py-2">US / India</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Supabase (AWS)</td>
                      <td className="py-2 pr-4">Database, authentication, file storage, real-time infrastructure</td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Stripe</td>
                      <td className="py-2 pr-4">Payment processing (US, UK, Canada)</td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Paystack</td>
                      <td className="py-2 pr-4">Payment processing (Nigeria, Ghana)</td>
                      <td className="py-2">Nigeria</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Flutterwave</td>
                      <td className="py-2 pr-4">Payment processing (Africa)</td>
                      <td className="py-2">Nigeria</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Square</td>
                      <td className="py-2 pr-4">Payment processing (US)</td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">PayPal</td>
                      <td className="py-2 pr-4">Payment processing</td>
                      <td className="py-2">US / Global</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Resend</td>
                      <td className="py-2 pr-4">Transactional email delivery</td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">PostHog</td>
                      <td className="py-2 pr-4">Product analytics (anonymized events)</td>
                      <td className="py-2">US / EU</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Anthropic</td>
                      <td className="py-2 pr-4">AI intent detection and language translation</td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Sentry</td>
                      <td className="py-2 pr-4">Error monitoring and performance tracking</td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Vercel</td>
                      <td className="py-2 pr-4">Application hosting and edge functions</td>
                      <td className="py-2">US / Global</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Upstash</td>
                      <td className="py-2 pr-4">API rate limiting and bot spam prevention</td>
                      <td className="py-2">US (Global Edge)</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">OpenAI</td>
                      <td className="py-2 pr-4">Whisper voice-to-text transcription</td>
                      <td className="py-2">US</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 leading-relaxed">
                Waaiio shall notify the Controller of any intended changes to the list of
                sub-processors at least 14 days in advance, giving the Controller an opportunity to
                object. If the Controller objects on reasonable data protection grounds, the parties
                shall discuss the objection in good faith. If no resolution can be reached, the
                Controller may terminate the affected Services.
              </p>
            </section>

            {/* ── 6. Security Measures ───────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Technical and Organizational Security Measures</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio implements appropriate technical and organisational measures to protect
                personal data against unauthorized access, alteration, disclosure, or destruction,
                including:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Encryption in transit (TLS 1.2+) and at rest (AES-256)</li>
                <li>Row-level security (RLS) policies ensuring complete data isolation between business accounts</li>
                <li>Secure authentication via Supabase Auth with bcrypt password hashing</li>
                <li>HMAC signature verification on all payment gateway webhooks</li>
                <li>API rate limiting (60 writes / 120 reads per minute per IP)</li>
                <li>CSRF protection via origin header validation</li>
                <li>Regular access reviews and least-privilege access controls</li>
                <li>Automated vulnerability scanning and dependency updates</li>
                <li>Input validation and sanitization on all user-facing endpoints</li>
                <li>Secure session management with automatic expiration</li>
              </ul>
            </section>

            {/* ── 7. Breach Notification ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. Data Breach Notification</h2>
              <p className="mt-2 leading-relaxed">
                In the event of a personal data breach, Waaiio shall:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  Notify the Controller without undue delay, and in any event within{' '}
                  <strong>72 hours</strong> of becoming aware of the breach (as required by GDPR
                  Article 33 and NDPR)
                </li>
                <li>
                  Provide details including: the nature of the breach, the categories and approximate
                  number of data subjects affected, the likely consequences, and a description of
                  measures taken or proposed to mitigate the breach
                </li>
                <li>
                  Provide the Controller with a designated contact point for further information
                </li>
                <li>
                  Cooperate fully with the Controller and any supervisory authority in investigating,
                  remediating, and reporting the breach
                </li>
                <li>
                  Document all personal data breaches, including the facts, effects, and remedial
                  actions taken
                </li>
              </ul>
            </section>

            {/* ── 8. Data Subject Rights ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">8. Assistance with Data Subject Requests</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio shall assist the Controller in fulfilling data subject requests under
                applicable privacy laws, including:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Access:</strong> Providing a copy of the data subject&rsquo;s personal data</li>
                <li><strong>Rectification:</strong> Correcting inaccurate or incomplete personal data</li>
                <li><strong>Erasure:</strong> Deleting personal data (&ldquo;right to be forgotten&rdquo;)</li>
                <li><strong>Portability:</strong> Providing data in a structured, machine-readable format (JSON/CSV export)</li>
                <li><strong>Restriction:</strong> Limiting processing in certain circumstances</li>
                <li><strong>Objection:</strong> Ceasing certain types of processing upon objection</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                As the Data Controller, you are responsible for responding to data subject requests
                directly. If Waaiio receives a request from a data subject, Waaiio shall promptly
                forward it to you and shall not respond to the request directly unless instructed to
                do so by you. Waaiio provides self-service tools (data export, account deletion) to
                assist you in fulfilling these requests.
              </p>
            </section>

            {/* ── 9. International Transfers ──────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">9. International Data Transfers</h2>
              <p className="mt-2 leading-relaxed">
                Where personal data is transferred outside the European Economic Area (EEA), the
                United Kingdom, Nigeria, or Ghana to a jurisdiction that does not benefit from an
                adequacy decision, Waaiio ensures appropriate safeguards through:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  Standard Contractual Clauses (SCCs) as approved by the European Commission
                  (Commission Implementing Decision (EU) 2021/914)
                </li>
                <li>
                  UK International Data Transfer Agreement (IDTA) or UK Addendum to the EU SCCs for
                  UK-originating transfers
                </li>
                <li>
                  EU-US Data Privacy Framework certification (where applicable)
                </li>
                <li>
                  Contractual obligations on all sub-processors requiring equivalent data protection
                  safeguards
                </li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Waaiio shall promptly notify the Controller if it becomes aware that it can no longer
                comply with the transfer safeguards, and shall cooperate with the Controller to
                identify alternative transfer mechanisms.
              </p>
            </section>

            {/* ── 10. Audit Rights ────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">10. Audit Rights</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio shall make available to the Controller all information necessary to demonstrate
                compliance with this DPA and shall allow for and contribute to audits, including
                inspections, conducted by the Controller or an independent auditor mandated by the
                Controller, subject to the following conditions:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>The Controller shall provide at least 30 days&rsquo; written notice of any audit</li>
                <li>Audits shall be conducted during normal business hours and shall not unreasonably disrupt Waaiio&rsquo;s operations</li>
                <li>The Controller shall bear the costs of any audit, unless the audit reveals material non-compliance by Waaiio</li>
                <li>All information obtained through audits shall be treated as confidential</li>
                <li>Audits shall be limited to no more than one per calendar year, unless required by a supervisory authority or following a data breach</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Where Waaiio holds third-party certifications or audit reports (e.g., SOC 2, ISO 27001)
                relevant to the Services, these may be provided to satisfy audit requirements.
              </p>
            </section>

            {/* ── 11. Data Retention & Deletion ──────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">11. Data Retention and Deletion</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio retains personal data only for as long as necessary to provide the Services.
                Upon termination of the Controller&rsquo;s account:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Waaiio shall delete or anonymize all personal data within 30 days, unless retention is required by applicable law</li>
                <li>The Controller may request a data export (JSON or CSV) prior to account deletion</li>
                <li>Payment records may be retained for up to 7 years to comply with tax and financial reporting obligations</li>
                <li>Anonymized aggregate data may be retained indefinitely for analytics purposes</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Upon request, Waaiio shall certify in writing that it has deleted or returned all
                personal data in accordance with this section.
              </p>
            </section>

            {/* ── 12. DPIA Assistance ─────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">12. Data Protection Impact Assessments</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio shall provide reasonable assistance to the Controller in conducting data
                protection impact assessments (DPIAs) and prior consultations with supervisory
                authorities, where required under applicable data protection law, taking into account
                the nature of the processing and the information available to Waaiio.
              </p>
            </section>

            {/* ── 13. Term and Termination ────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">13. Term and Termination</h2>
              <p className="mt-2 leading-relaxed">
                This DPA shall remain in effect for the duration of the Controller&rsquo;s use of the
                Services and shall automatically terminate when the Controller&rsquo;s account is
                deleted or the Terms of Service are terminated, subject to the data retention
                obligations described in Section 11.
              </p>
              <p className="mt-3 leading-relaxed">
                Sections that by their nature should survive termination (including Sections 4, 7, 10,
                and 11) shall survive the termination of this DPA.
              </p>
            </section>

            {/* ── 14. Liability ───────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">14. Liability</h2>
              <p className="mt-2 leading-relaxed">
                Each party&rsquo;s liability under this DPA is subject to the limitations of liability
                set out in the Terms of Service. Nothing in this DPA limits either party&rsquo;s
                liability for breaches of applicable data protection law to the extent such
                limitation would not be permitted by law.
              </p>
            </section>

            {/* ── Contact ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">15. Contact</h2>
              <p className="mt-2 leading-relaxed">
                For questions about this Data Processing Agreement, contact:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Data Protection Officer:</strong>{' '}
                  <a href="mailto:dpo@waaiio.com" className="text-brand underline">dpo@waaiio.com</a>
                </li>
                <li><strong>Privacy inquiries:</strong>{' '}
                  <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>
                </li>
                <li><strong>Legal:</strong>{' '}
                  <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>
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
