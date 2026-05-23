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
          <p className="mt-2 text-sm text-gray-400">Last updated: May 23, 2026</p>

          <div className="prose-pages mt-10 space-y-8 text-gray-700">

            {/* ── What Are Cookies ────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">1. What Are Cookies?</h2>
              <p className="mt-2 leading-relaxed">
                Cookies are small text files stored on your device when you visit a website. They
                help the site remember your preferences and improve your experience. We also use
                similar technologies such as localStorage and session storage.
              </p>
            </section>

            {/* ── Consent Model ───────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">2. Our Consent Model</h2>
              <p className="mt-2 leading-relaxed">
                In compliance with the UK GDPR, EU GDPR, Canada&rsquo;s PIPEDA, and US state
                privacy laws (including California&rsquo;s CCPA/CPRA), we operate an{' '}
                <strong>opt-in</strong> consent model for non-essential cookies. Non-essential
                cookies are <strong>not set</strong> until you explicitly accept them via our cookie
                consent banner.
              </p>
              <p className="mt-3 leading-relaxed">
                You can change your preference at any time via the &ldquo;Your Privacy Choices&rdquo;
                link in our footer. Essential cookies that are strictly necessary for the operation
                of our website do not require consent and cannot be disabled.
              </p>
            </section>

            {/* ── Cookies We Use ──────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">3. Cookies and Technologies We Use</h2>

              <h3 className="mt-4 text-lg font-medium text-gray-900">3.1 Essential Cookies</h3>
              <p className="mt-2 leading-relaxed">
                These cookies are strictly necessary for the website to function. They cannot be
                disabled.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Cookie / Key</th>
                      <th className="pb-2 pr-4 font-semibold">Provider</th>
                      <th className="pb-2 pr-4 font-semibold">Purpose</th>
                      <th className="pb-2 font-semibold">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">sb-*-auth-token</td>
                      <td className="py-2 pr-4">Supabase</td>
                      <td className="py-2 pr-4">Authentication session -- keeps you signed in to your account</td>
                      <td className="py-2">Session / 1 year</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">waaiio_cookie_consent</td>
                      <td className="py-2 pr-4">Waaiio</td>
                      <td className="py-2 pr-4">Stores your cookie consent preference (accepted/rejected)</td>
                      <td className="py-2">Persistent</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">__vercel_live_token</td>
                      <td className="py-2 pr-4">Vercel</td>
                      <td className="py-2 pr-4">Hosting infrastructure -- required for page delivery</td>
                      <td className="py-2">Session</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className="mt-6 text-lg font-medium text-gray-900">3.2 Analytics Cookies</h3>
              <p className="mt-2 leading-relaxed">
                These cookies help us understand how visitors interact with our website. They are
                only set after you accept non-essential cookies.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Cookie / Key</th>
                      <th className="pb-2 pr-4 font-semibold">Provider</th>
                      <th className="pb-2 pr-4 font-semibold">Purpose</th>
                      <th className="pb-2 font-semibold">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">ph_*</td>
                      <td className="py-2 pr-4">PostHog</td>
                      <td className="py-2 pr-4">Product analytics -- tracks page views, feature usage, and session replays</td>
                      <td className="py-2">1 year</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className="mt-6 text-lg font-medium text-gray-900">3.3 Functional Cookies</h3>
              <p className="mt-2 leading-relaxed">
                These cookies enable enhanced functionality and personalization, such as remembering
                your theme preference.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Cookie / Key</th>
                      <th className="pb-2 pr-4 font-semibold">Provider</th>
                      <th className="pb-2 pr-4 font-semibold">Purpose</th>
                      <th className="pb-2 font-semibold">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">theme</td>
                      <td className="py-2 pr-4">Waaiio</td>
                      <td className="py-2 pr-4">Stores your light/dark theme preference</td>
                      <td className="py-2">Persistent</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">waaiio_dismissed_*</td>
                      <td className="py-2 pr-4">Waaiio</td>
                      <td className="py-2 pr-4">Remembers dismissed banners and tooltips</td>
                      <td className="py-2">Persistent</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className="mt-6 text-lg font-medium text-gray-900">3.4 Third-Party Cookies</h3>
              <p className="mt-2 leading-relaxed">
                These cookies are set by third-party services we integrate with. They are only
                activated after you consent.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-900">
                      <th className="pb-2 pr-4 font-semibold">Cookie / Key</th>
                      <th className="pb-2 pr-4 font-semibold">Provider</th>
                      <th className="pb-2 pr-4 font-semibold">Purpose</th>
                      <th className="pb-2 font-semibold">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="py-2 pr-4 font-mono text-xs">_fbp, _fbc</td>
                      <td className="py-2 pr-4">Meta (Facebook SDK)</td>
                      <td className="py-2 pr-4">Conversion tracking on the Get Started page</td>
                      <td className="py-2">90 days</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── Managing Preferences ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">4. Managing Your Cookie Preferences</h2>
              <p className="mt-2 leading-relaxed">
                You can manage your cookie preferences in several ways:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li><strong>Cookie banner:</strong> When you first visit our website, you can choose to accept or reject non-essential cookies.</li>
                <li><strong>Footer link:</strong> Click &ldquo;Your Privacy Choices&rdquo; in the footer of any page to change your preference at any time.</li>
                <li><strong>Browser settings:</strong> Most browsers allow you to block or delete cookies through their settings. Note that blocking essential cookies may prevent our website from functioning properly.</li>
                <li><strong>Device settings:</strong> On mobile devices, you can manage cookies through your device&rsquo;s privacy settings.</li>
              </ul>
            </section>

            {/* ── Impact of Disabling ─────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">5. Impact of Disabling Cookies</h2>
              <p className="mt-2 leading-relaxed">
                If you choose to reject non-essential cookies, you can still use our website and
                Services normally. However, you may experience reduced functionality in the following
                areas:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>Your theme preference may not be remembered between visits</li>
                <li>Dismissed banners and tooltips may reappear</li>
                <li>We will be unable to collect analytics data to improve the product experience</li>
              </ul>
            </section>

            {/* ── Updates ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">6. Changes to This Cookie Policy</h2>
              <p className="mt-2 leading-relaxed">
                We may update this Cookie Policy from time to time to reflect changes in technology,
                legislation, or our business practices. When we make material changes, we will update
                the &ldquo;Last updated&rdquo; date and, if appropriate, re-request your consent.
              </p>
            </section>

            {/* ── Contact ─────────────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">7. Contact</h2>
              <p className="mt-2 leading-relaxed">
                If you have questions about our use of cookies, contact us at:
              </p>
              <ul className="mt-3 list-none space-y-1.5 pl-0">
                <li><strong>Privacy inquiries:</strong>{' '}
                  <a href="mailto:privacy@waaiio.com" className="text-brand underline">privacy@waaiio.com</a>
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
