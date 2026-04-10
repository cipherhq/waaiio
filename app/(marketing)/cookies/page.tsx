import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Cookie Policy — Waaiio',
  description:
    'How Waaiio uses cookies and similar technologies on our website and dashboard.',
};

export default function CookiePolicyPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Cookie Policy</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">How we use cookies and similar technologies on our website.</p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <p className="mt-2 text-sm text-gray-400">Last updated: April 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                What Are Cookies?
              </h2>
              <p className="mt-2 leading-relaxed">
                Cookies are small text files stored on your device when you visit a
                website. They help the site remember your preferences and improve
                your experience. We also use similar technologies such as
                localStorage.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Our Consent Model
              </h2>
              <p className="mt-2 leading-relaxed">
                In compliance with the UK GDPR, EU GDPR, Canada&rsquo;s PIPEDA, and
                US state privacy laws (including California&rsquo;s CCPA/CPRA), we
                operate an <strong>opt-in</strong> consent model.
                Non-essential cookies are <strong>not set</strong> until you
                explicitly accept them. You can change your preference at any time
                via the &ldquo;Your Privacy Choices&rdquo; link in our footer.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Cookies We Use
              </h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Cookie / Key</th>
                      <th className="pb-2 pr-4 font-semibold">Provider</th>
                      <th className="pb-2 pr-4 font-semibold">Purpose</th>
                      <th className="pb-2 pr-4 font-semibold">Duration</th>
                      <th className="pb-2 font-semibold">Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">
                        sb-*-auth-token
                      </td>
                      <td className="py-2 pr-4">Supabase</td>
                      <td className="py-2 pr-4">
                        Authentication session — keeps you signed in
                      </td>
                      <td className="py-2 pr-4">Session / 1 year</td>
                      <td className="py-2">
                        <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                          Essential
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">
                        waaiio_cookie_consent
                      </td>
                      <td className="py-2 pr-4">Waaiio</td>
                      <td className="py-2 pr-4">
                        Stores your cookie consent preference
                      </td>
                      <td className="py-2 pr-4">Persistent</td>
                      <td className="py-2">
                        <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                          Essential
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">_fbp, _fbc</td>
                      <td className="py-2 pr-4">Meta (Facebook SDK)</td>
                      <td className="py-2 pr-4">
                        Conversion tracking on Get Started page
                      </td>
                      <td className="py-2 pr-4">90 days</td>
                      <td className="py-2">
                        <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                          Third-party
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Managing Your Preferences
              </h2>
              <p className="mt-2 leading-relaxed">
                You can change or withdraw your cookie consent at any time by
                clicking &ldquo;Your Privacy Choices&rdquo; in the footer of any
                page. You can also clear cookies from your browser settings.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Contact</h2>
              <p className="mt-2 leading-relaxed">
                If you have questions about our use of cookies, email us at{' '}
                <a
                  href="mailto:privacy@waaiio.com"
                  className="text-brand underline"
                >
                  privacy@waaiio.com
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
