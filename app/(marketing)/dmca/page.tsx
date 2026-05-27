import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'DMCA / IP Takedown Policy — Waaiio',
  description:
    'How to file a DMCA takedown notice or counter-notification with Waaiio. Designated agent, repeat infringer policy, and good faith requirements.',
};

export default function DMCAPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">DMCA / IP Takedown Policy</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">How to report intellectual property infringement on our platform.</p>
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
                CipherHQ LLC, doing business as Waaiio (&ldquo;Waaiio,&rdquo; &ldquo;we,&rdquo;
                &ldquo;us,&rdquo; or &ldquo;our&rdquo;), respects the intellectual property rights
                of others and expects our users to do the same. In accordance with the Digital
                Millennium Copyright Act of 1998 (&ldquo;DMCA&rdquo;), 17 U.S.C. &sect; 512, we
                will respond promptly to claims of copyright infringement committed using our
                Services.
              </p>
            </section>

            {/* ── Designated DMCA Agent ───────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. Designated DMCA Agent</h2>
              <p className="mt-2 leading-relaxed">
                Our designated agent to receive notifications of claimed infringement under the DMCA is:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Name:</strong> DMCA Agent, Legal Department</li>
                <li><strong>Company:</strong> CipherHQ LLC (d/b/a Waaiio)</li>
                <li><strong>Email:</strong>{' '}
                  <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>
                </li>
                <li><strong>Location:</strong> United States</li>
              </ul>
            </section>

            {/* ── Filing a Takedown Notice ────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. Filing a Takedown Notice</h2>
              <p className="mt-2 leading-relaxed">
                If you believe that material hosted on or transmitted through our Services infringes
                your copyright, you may submit a written takedown notice to our Designated Agent.
                Under 17 U.S.C. &sect; 512(c)(3), your notice must include all of the following:
              </p>
              <ol className="mt-3 list-decimal space-y-2 pl-5">
                <li>
                  A physical or electronic signature of the copyright owner or a person authorized
                  to act on behalf of the owner.
                </li>
                <li>
                  Identification of the copyrighted work claimed to have been infringed. If multiple
                  copyrighted works are covered by a single notification, provide a representative
                  list of such works.
                </li>
                <li>
                  Identification of the material that is claimed to be infringing or to be the subject
                  of infringing activity and that is to be removed or access to which is to be
                  disabled, and information reasonably sufficient to permit us to locate the material
                  (e.g., URLs, screenshots, or descriptions).
                </li>
                <li>
                  Information reasonably sufficient to permit us to contact you, such as your address,
                  telephone number, and email address.
                </li>
                <li>
                  A statement that you have a good faith belief that use of the material in the manner
                  complained of is not authorized by the copyright owner, its agent, or the law.
                </li>
                <li>
                  A statement that the information in the notification is accurate, and under penalty
                  of perjury, that you are authorized to act on behalf of the owner of an exclusive
                  right that is allegedly infringed.
                </li>
              </ol>
              <p className="mt-3 leading-relaxed">
                Send your completed notice to{' '}
                <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>{' '}
                with the subject line &ldquo;DMCA Takedown Notice.&rdquo;
              </p>
              <p className="mt-3 leading-relaxed">
                <strong>Important:</strong> Misrepresentations in a DMCA notice can result in
                liability for damages, including costs and attorneys&rsquo; fees, under
                17 U.S.C. &sect; 512(f). If you are unsure whether the material infringes your
                copyright, consider seeking legal advice before filing a notice.
              </p>
            </section>

            {/* ── Counter-Notification ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. Counter-Notification Procedure</h2>
              <p className="mt-2 leading-relaxed">
                If you believe that material you posted was removed or disabled by mistake or
                misidentification, you may submit a counter-notification to our Designated Agent.
                Your counter-notification must include:
              </p>
              <ol className="mt-3 list-decimal space-y-2 pl-5">
                <li>Your physical or electronic signature.</li>
                <li>
                  Identification of the material that has been removed or to which access has been
                  disabled, and the location at which the material appeared before it was removed or
                  access was disabled.
                </li>
                <li>
                  A statement under penalty of perjury that you have a good faith belief that the
                  material was removed or disabled as a result of mistake or misidentification of the
                  material to be removed or disabled.
                </li>
                <li>
                  Your name, address, and telephone number, and a statement that you consent to the
                  jurisdiction of the federal district court for the judicial district in which your
                  address is located (or, if outside the United States, any judicial district in which
                  Waaiio may be found), and that you will accept service of process from the person
                  who provided the original takedown notification or an agent of such person.
                </li>
              </ol>
              <p className="mt-3 leading-relaxed">
                Upon receiving a valid counter-notification, we will forward it to the original
                complaining party. If the original party does not file a court action seeking to
                restrain the allegedly infringing activity within 10 to 14 business days, we will
                restore the removed material.
              </p>
            </section>

            {/* ── Repeat Infringer Policy ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. Repeat Infringer Policy</h2>
              <p className="mt-2 leading-relaxed">
                In accordance with the DMCA and other applicable law, Waaiio has adopted a policy of
                terminating, in appropriate circumstances and at our sole discretion, the accounts
                of users who are deemed to be repeat infringers. We may also, at our sole discretion,
                limit access to the Services and/or terminate the accounts of any users who infringe
                any intellectual property rights of others, whether or not there is any repeat
                infringement.
              </p>
              <p className="mt-3 leading-relaxed">
                A &ldquo;repeat infringer&rdquo; is a user who has been the subject of more than one
                valid takedown notice. We track takedown notices on a per-account basis and may
                issue warnings before termination, but reserve the right to terminate without prior
                warning in cases of egregious or willful infringement.
              </p>
            </section>

            {/* ── Good Faith Statement ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Good Faith Requirement</h2>
              <p className="mt-2 leading-relaxed">
                All takedown notices and counter-notifications must be submitted in good faith.
                The DMCA provides that any person who knowingly materially misrepresents that material
                is infringing, or that material was removed or disabled by mistake or
                misidentification, may be subject to liability for damages, including costs and
                attorneys&rsquo; fees (17 U.S.C. &sect; 512(f)).
              </p>
              <p className="mt-3 leading-relaxed">
                We encourage all parties to attempt to resolve disputes directly before filing formal
                notices. If you believe there has been a misunderstanding, please contact{' '}
                <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>{' '}
                and we will do our best to facilitate a resolution.
              </p>
            </section>

            {/* ── Other IP Claims ─────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Other Intellectual Property Claims</h2>
              <p className="mt-2 leading-relaxed">
                If you believe your intellectual property rights have been violated in a manner other
                than copyright infringement (e.g., trademark infringement), please contact{' '}
                <a href="mailto:legal@waaiio.com" className="text-brand underline">legal@waaiio.com</a>{' '}
                with details of the alleged infringement. We will review all reports and take
                appropriate action in accordance with applicable law.
              </p>
            </section>

            {/* ── Contact ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. Contact Information</h2>
              <p className="mt-2 leading-relaxed">
                For all DMCA and intellectual property matters, contact us:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Email:</strong>{' '}
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
