import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Anti-Money Laundering & KYC Policy — Waaiio',
  description:
    'Waaiio AML and KYC policy covering business verification levels, document requirements, transaction monitoring, and payout controls across 5 countries.',
};

export default function AMLKYCPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Anti-Money Laundering &amp; KYC Policy</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">How we verify businesses and prevent financial crime on our platform.</p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <p className="mt-2 text-sm text-gray-400">Last updated: May 23, 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">

            {/* ── Purpose ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. Purpose</h2>
              <p className="mt-2 leading-relaxed">
                CipherHQ LLC, doing business as Waaiio (&ldquo;Waaiio,&rdquo; &ldquo;we,&rdquo;
                &ldquo;us,&rdquo; or &ldquo;our&rdquo;), is committed to preventing the use of our
                platform for money laundering, terrorist financing, fraud, or other financial crimes.
                This Anti-Money Laundering (&ldquo;AML&rdquo;) and Know Your Customer
                (&ldquo;KYC&rdquo;) Policy outlines our procedures for verifying the identity of
                businesses using our Services and monitoring transactions for suspicious activity.
              </p>
              <p className="mt-3 leading-relaxed">
                Waaiio operates across five countries &mdash; the United States, Canada, Nigeria,
                Ghana, and the United Kingdom &mdash; and this policy is designed to comply with
                applicable AML laws in each jurisdiction, including the Bank Secrecy Act (US),
                Proceeds of Crime (Money Laundering) and Terrorist Financing Act (Canada), the Money
                Laundering (Prohibition) Act (Nigeria), the Anti-Money Laundering Act (Ghana), and
                the Proceeds of Crime Act 2002 and Money Laundering Regulations 2017 (UK).
              </p>
            </section>

            {/* ── KYC Requirements ────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. KYC Verification Levels</h2>
              <p className="mt-2 leading-relaxed">
                All businesses on Waaiio are assigned a verification level that determines the extent
                of their platform privileges. Verification levels are:
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.1 Unverified</h3>
              <p className="mt-2 leading-relaxed">
                New accounts before any identity documents are submitted. Unverified businesses
                can explore the dashboard and configure settings but cannot receive payouts or
                process live transactions.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.2 Basic Verification</h3>
              <p className="mt-2 leading-relaxed">
                Requires the business owner&rsquo;s government-issued photo ID and confirmation of
                the business name and address. Basic verification unlocks live transactions and
                payouts up to standard thresholds.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.3 Standard Verification</h3>
              <p className="mt-2 leading-relaxed">
                Requires all Basic verification documents plus formal business registration documents
                (see Section 3 for country-specific requirements). Standard verification raises
                payout limits and enables higher-volume transaction processing.
              </p>

              <h3 className="mt-4 text-lg font-medium text-gray-900">2.4 Full Verification</h3>
              <p className="mt-2 leading-relaxed">
                Required for businesses processing high transaction volumes or operating in
                high-risk categories. Includes additional due diligence such as proof of address for
                beneficial owners, source of funds documentation, and in some cases enhanced
                screening against sanctions lists and politically exposed persons (PEP) databases.
              </p>
            </section>

            {/* ── Documents Per Country ───────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. Document Requirements by Country</h2>
              <p className="mt-2 leading-relaxed">
                The following documents are required for Standard and Full verification, depending on
                the business&rsquo;s country of operation:
              </p>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Country</th>
                      <th className="pb-2 pr-4 font-semibold">Business Registration</th>
                      <th className="pb-2 font-semibold">Additional Documents</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4 font-medium">United States</td>
                      <td className="py-2 pr-4">EIN letter from the IRS, Articles of Incorporation or Organization</td>
                      <td className="py-2">Government-issued photo ID of owner(s), proof of address</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">Canada</td>
                      <td className="py-2 pr-4">Business Number (BN) from CRA, Certificate of Incorporation</td>
                      <td className="py-2">Government-issued photo ID, proof of address</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">Nigeria</td>
                      <td className="py-2 pr-4">CAC Certificate of Incorporation or Business Name Registration</td>
                      <td className="py-2">NIN or international passport of director(s), utility bill</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">Ghana</td>
                      <td className="py-2 pr-4">Registrar General&rsquo;s Department Certificate of Registration</td>
                      <td className="py-2">Ghana Card or passport of director(s), utility bill</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">United Kingdom</td>
                      <td className="py-2 pr-4">Companies House Certificate of Incorporation, company number</td>
                      <td className="py-2">Passport or driving licence of director(s), proof of address</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p className="mt-4 leading-relaxed">
                We may request additional documents depending on the nature and volume of
                transactions. Documents are reviewed within 2 to 5 business days of submission.
              </p>
            </section>

            {/* ── Transaction Monitoring ──────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. Transaction Monitoring</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio employs automated and manual monitoring systems to detect and flag suspicious
                activity on our platform. This includes:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Unusual transaction volumes or amounts that deviate significantly from a business&rsquo;s historical pattern</li>
                <li>Rapid or repeated small transactions that may indicate structuring (smurfing)</li>
                <li>Transactions involving high-risk geographies or sanctioned entities</li>
                <li>Mismatches between declared business type and actual transaction patterns</li>
                <li>Multiple failed payment attempts followed by a successful one</li>
                <li>Refund patterns that suggest abuse or money laundering (e.g., large refunds to different accounts than the payer)</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Flagged transactions are reviewed by our compliance team. We may contact the business
                owner for additional information or documentation before clearing the flag.
              </p>
            </section>

            {/* ── Reporting Obligations ───────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Reporting Obligations</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio is obligated to file Suspicious Activity Reports (SARs) with the relevant
                authorities when we identify or have reasonable grounds to suspect that a transaction
                or series of transactions involves proceeds of crime, money laundering, or terrorist
                financing. Reports are filed with:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>United States:</strong> Financial Crimes Enforcement Network (FinCEN)</li>
                <li><strong>Canada:</strong> Financial Transactions and Reports Analysis Centre of Canada (FINTRAC)</li>
                <li><strong>Nigeria:</strong> Nigerian Financial Intelligence Unit (NFIU)</li>
                <li><strong>Ghana:</strong> Financial Intelligence Centre (FIC)</li>
                <li><strong>United Kingdom:</strong> National Crime Agency (NCA)</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                We are prohibited by law from informing the subject of a SAR that a report has been
                or will be filed (&ldquo;tipping off&rdquo;).
              </p>
            </section>

            {/* ── Payout Controls ─────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Payout Controls</h2>
              <p className="mt-2 leading-relaxed">
                To protect the integrity of our platform and comply with AML requirements, we enforce
                the following payout controls:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  <strong>Verification required:</strong> Payouts are only available to businesses
                  that have completed at least Basic verification. Higher payout thresholds require
                  Standard or Full verification.
                </li>
                <li>
                  <strong>Cooling period:</strong> New accounts are subject to a holding period before
                  their first payout. The duration depends on the verification level and country of
                  operation.
                </li>
                <li>
                  <strong>Velocity limits:</strong> We impose daily, weekly, and monthly payout limits
                  based on the business&rsquo;s verification level and transaction history.
                  Businesses may request limit increases by submitting additional documentation.
                </li>
                <li>
                  <strong>Payout holds:</strong> We may place a hold on payouts if suspicious
                  activity is detected, a chargeback or dispute is pending, or additional verification
                  is required.
                </li>
              </ul>
            </section>

            {/* ── Right to Suspend ────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. Right to Suspend or Terminate Accounts</h2>
              <p className="mt-2 leading-relaxed">
                Waaiio reserves the right to suspend, restrict, or terminate any account at any time
                if we reasonably believe:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>The account is being used for money laundering, terrorist financing, fraud, or other illegal activity</li>
                <li>The account holder has provided false, misleading, or incomplete information during verification</li>
                <li>The account holder has failed to provide requested documentation within a reasonable timeframe</li>
                <li>A law enforcement authority or regulatory body has requested or ordered us to do so</li>
                <li>Continued operation of the account poses a risk to our platform, other users, or the public</li>
              </ul>
              <p className="mt-3 leading-relaxed">
                Account suspension or termination under this section may occur without prior notice.
                Any funds held at the time of suspension will be retained pending the outcome of any
                investigation and may be released, returned, or forfeited in accordance with
                applicable law.
              </p>
            </section>

            {/* ── Sanctions Screening ─────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">8. Sanctions Screening</h2>
              <p className="mt-2 leading-relaxed">
                We screen business owners and beneficial owners against applicable sanctions lists,
                including the U.S. Office of Foreign Assets Control (OFAC) Specially Designated
                Nationals (SDN) list, the UK HM Treasury sanctions list, the UN Security Council
                Consolidated List, and relevant national lists in our countries of operation.
                Screening is performed at onboarding and periodically thereafter.
              </p>
            </section>

            {/* ── Record Keeping ──────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">9. Record Keeping</h2>
              <p className="mt-2 leading-relaxed">
                We retain KYC documents, transaction records, and any suspicious activity reports
                for a minimum of 5 years after the business relationship has ended, or longer as
                required by applicable law. Records are stored securely and access is restricted to
                authorized compliance personnel.
              </p>
            </section>

            {/* ── Employee Training ───────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">10. Training and Awareness</h2>
              <p className="mt-2 leading-relaxed">
                All Waaiio employees and contractors who handle customer data, process transactions,
                or make compliance-related decisions receive regular training on AML requirements,
                KYC procedures, and suspicious activity identification. Training is updated annually
                and whenever significant regulatory changes occur.
              </p>
            </section>

            {/* ── Updates ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">11. Changes to This Policy</h2>
              <p className="mt-2 leading-relaxed">
                We may update this AML &amp; KYC Policy from time to time to reflect changes in
                applicable law, regulatory guidance, or our internal procedures. When we make material
                changes, we will update the &ldquo;Last updated&rdquo; date at the top of this page.
              </p>
            </section>

            {/* ── Contact ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">12. Contact Us</h2>
              <p className="mt-2 leading-relaxed">
                For questions about our AML &amp; KYC procedures, please contact us:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Compliance:</strong>{' '}
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
