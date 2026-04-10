import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Data Processing Agreement — Waaiio',
  description:
    'Data Processing Agreement covering how Waaiio processes personal data on behalf of business customers.',
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
          <p className="mt-2 text-sm text-gray-400">Last updated: April 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                1. Roles &amp; Definitions
              </h2>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  <strong>Data Controller:</strong> You, the business owner who
                  determines the purposes and means of processing personal data of
                  your customers.
                </li>
                <li>
                  <strong>Data Processor:</strong> Waaiio Limited, which processes
                  personal data on your behalf to deliver WhatsApp automation
                  services.
                </li>
                <li>
                  <strong>Data Subjects:</strong> Your customers and contacts whose
                  personal data is processed through Waaiio.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                2. Scope of Processing
              </h2>
              <p className="mt-2 leading-relaxed">
                Waaiio processes personal data solely to provide the services you
                have subscribed to, including but not limited to: delivering
                WhatsApp messages, processing bookings and orders, handling
                payments, and maintaining conversation history. We do not sell
                personal data or use it for our own marketing purposes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                3. Sub-processors
              </h2>
              <p className="mt-2 leading-relaxed">
                We use the following sub-processors to deliver our services. Each
                sub-processor is bound by data processing agreements that provide
                protections consistent with this DPA.
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
                      <td className="py-2 pr-4">
                        Message delivery via WhatsApp Business API
                      </td>
                      <td className="py-2">US / Global</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Gupshup</td>
                      <td className="py-2 pr-4">
                        WhatsApp Business API provider
                      </td>
                      <td className="py-2">US / India</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Supabase (AWS)</td>
                      <td className="py-2 pr-4">
                        Database hosting, authentication, real-time infrastructure
                      </td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Paystack</td>
                      <td className="py-2 pr-4">
                        Payment processing (Africa)
                      </td>
                      <td className="py-2">Nigeria</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Stripe</td>
                      <td className="py-2 pr-4">
                        Payment processing (UK, Canada)
                      </td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Square</td>
                      <td className="py-2 pr-4">
                        Payment processing (United States)
                      </td>
                      <td className="py-2">US</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Flutterwave</td>
                      <td className="py-2 pr-4">
                        Payment processing (Africa, alternative)
                      </td>
                      <td className="py-2">Nigeria</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Vercel</td>
                      <td className="py-2 pr-4">
                        Application hosting and edge functions
                      </td>
                      <td className="py-2">US / Global</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 leading-relaxed">
                We will notify you of any intended changes to the list of
                sub-processors, giving you an opportunity to object.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                4. Data Security Measures
              </h2>
              <p className="mt-2 leading-relaxed">
                Waaiio implements appropriate technical and organisational measures
                to protect personal data, including:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Encryption in transit (TLS 1.2+) and at rest (AES-256)</li>
                <li>
                  Row-level security (RLS) policies ensuring data isolation between
                  business accounts
                </li>
                <li>Regular access reviews and least-privilege access controls</li>
                <li>Automated vulnerability scanning and dependency updates</li>
                <li>Secure authentication via Supabase Auth with bcrypt hashing</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                5. Breach Notification
              </h2>
              <p className="mt-2 leading-relaxed">
                In the event of a personal data breach, Waaiio will:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  Notify you without undue delay, and in any event within{' '}
                  <strong>72 hours</strong> of becoming aware of the breach (as
                  required by GDPR Article 33)
                </li>
                <li>
                  Provide details of the nature of the breach, the categories and
                  approximate number of data subjects affected, and the likely
                  consequences
                </li>
                <li>
                  Describe the measures taken or proposed to address the breach and
                  mitigate its effects
                </li>
                <li>
                  Cooperate with you and any supervisory authority in investigating
                  and resolving the breach
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                6. Data Subject Rights
              </h2>
              <p className="mt-2 leading-relaxed">
                Waaiio will assist you in fulfilling data subject requests under
                applicable privacy laws, including rights of:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Access — obtaining a copy of their personal data</li>
                <li>Rectification — correcting inaccurate data</li>
                <li>Erasure — deleting personal data (&ldquo;right to be forgotten&rdquo;)</li>
                <li>Portability — receiving data in a machine-readable format</li>
                <li>Restriction — limiting how data is processed</li>
                <li>Objection — objecting to certain types of processing</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                As the data controller, you are responsible for responding to data
                subject requests. Waaiio will provide reasonable assistance and
                tooling to help you comply.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                7. International Data Transfers
              </h2>
              <p className="mt-2 leading-relaxed">
                Where personal data is transferred outside the European Economic
                Area (EEA) or the United Kingdom, Waaiio relies on:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  Standard Contractual Clauses (SCCs) approved by the European
                  Commission
                </li>
                <li>
                  UK International Data Transfer Agreement (IDTA) for UK-originating
                  transfers
                </li>
                <li>
                  Adequacy decisions where available (e.g., EU-US Data Privacy
                  Framework)
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                8. Data Retention &amp; Deletion
              </h2>
              <p className="mt-2 leading-relaxed">
                Waaiio retains personal data only for as long as necessary to
                provide our services to you. Upon termination of your account, we
                will delete or anonymise all personal data within 30 days, unless
                retention is required by law.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Contact</h2>
              <p className="mt-2 leading-relaxed">
                For questions about this DPA, email our Data Protection Officer at{' '}
                <a
                  href="mailto:dpo@waaiio.com"
                  className="text-brand underline"
                >
                  dpo@waaiio.com
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </AnimatedSection>
    </>
  );
}
