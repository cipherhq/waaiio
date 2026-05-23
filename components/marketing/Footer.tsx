import Link from 'next/link';
import { WaaiioMark, WaaiioWordmark } from './WaaiioLogo';
import PrivacyChoicesButton from './PrivacyChoicesButton';

export default function Footer() {
  return (
    <footer className="bg-gradient-to-b from-gray-900 to-black text-white">
      <div className="h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />
      <div className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          {/* Brand */}
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2">
              <WaaiioMark />
              <WaaiioWordmark variant="light" />
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-gray-400">
              WhatsApp automation with 20+ capabilities — bookings,
              payments, orders, ticketing, loyalty, broadcasts, and more.
              24/7 on the app your customers already use.
            </p>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-500">
              <svg className="h-4 w-4 text-[#25D366]" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
              Built on WhatsApp Business Platform
            </p>
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/5 border border-white/10 px-3 py-1">
              <svg className="h-3.5 w-3.5 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 5.523 4.477 10 10 10s10-4.477 10-10S17.523 2 12 2zm4.586 7.414l-5.293 5.293a1 1 0 01-1.414 0L7.172 12a1 1 0 111.414-1.414l2.293 2.293 4.586-4.586a1 1 0 111.414 1.414z" />
              </svg>
              <span className="text-[11px] font-medium text-gray-300">Meta Business Partner</span>
            </div>
            <div className="mt-4 flex items-center gap-3 text-gray-500">
              <a href="https://wa.me/2349060009740" target="_blank" rel="noopener noreferrer" className="transition hover:text-[#25D366]" aria-label="WhatsApp">
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </a>
              <a href="https://x.com/waaiio" target="_blank" rel="noopener noreferrer" className="transition hover:text-white" aria-label="X (Twitter)">
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
              </a>
              <a href="https://linkedin.com/company/waaiio" target="_blank" rel="noopener noreferrer" className="transition hover:text-blue-400" aria-label="LinkedIn">
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                </svg>
              </a>
            </div>
          </div>

          {/* Product */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Product</h3>
            <ul className="mt-4 space-y-3">
              <li><Link href="/features" className="text-sm text-gray-300 transition hover:text-white">Features</Link></li>
              <li><Link href="/pricing" className="text-sm text-gray-300 transition hover:text-white">Pricing</Link></li>
              <li><Link href="/about" className="text-sm text-gray-300 transition hover:text-white">About</Link></li>
              <li><Link href="/#faq" className="text-sm text-gray-300 transition hover:text-white">FAQ</Link></li>
              <li><Link href="/help" className="text-sm text-gray-300 transition hover:text-white">Help Center</Link></li>
              <li><Link href="/get-started" className="text-sm text-gray-300 transition hover:text-white">Get Started</Link></li>
            </ul>
          </div>

          {/* Solutions */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Solutions</h3>
            <ul className="mt-4 space-y-3">
              <li><Link href="/features#scheduling" className="text-sm text-gray-300 transition hover:text-white">Scheduling</Link></li>
              <li><Link href="/features#payments" className="text-sm text-gray-300 transition hover:text-white">Payments</Link></li>
              <li><Link href="/features#payments" className="text-sm text-gray-300 transition hover:text-white">Ordering</Link></li>
              <li><Link href="/features#payments" className="text-sm text-gray-300 transition hover:text-white">Ticketing</Link></li>
              <li><Link href="/features#engagement" className="text-sm text-gray-300 transition hover:text-white">Loyalty &amp; Referrals</Link></li>
              <li><Link href="/features#engagement" className="text-sm text-gray-300 transition hover:text-white">Broadcasts</Link></li>
              <li><Link href="/features#scheduling" className="text-sm text-gray-300 transition hover:text-white">Queue Management</Link></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Legal</h3>
            <ul className="mt-4 space-y-3">
              <li><Link href="/terms" className="text-sm text-gray-300 transition hover:text-white">Terms of Service</Link></li>
              <li><Link href="/privacy" className="text-sm text-gray-300 transition hover:text-white">Privacy Policy</Link></li>
              <li><Link href="/cookies" className="text-sm text-gray-300 transition hover:text-white">Cookie Policy</Link></li>
              <li><Link href="/acceptable-use" className="text-sm text-gray-300 transition hover:text-white">Acceptable Use</Link></li>
              <li><Link href="/dpa" className="text-sm text-gray-300 transition hover:text-white">Data Processing (DPA)</Link></li>
              <li><Link href="/do-not-sell" className="text-sm text-gray-300 transition hover:text-white">Do Not Sell My Info</Link></li>
              <li><PrivacyChoicesButton /></li>
              <li><Link href="/contact" className="text-sm text-gray-300 transition hover:text-white">Contact</Link></li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
          <p className="text-sm text-gray-500">
            &copy; {new Date().getFullYear()} Waaiio. All rights reserved.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            {[
              { flag: '\ud83c\uddf3\ud83c\uddec', name: 'Nigeria' },
              { flag: '\ud83c\uddfa\ud83c\uddf8', name: 'US' },
              { flag: '\ud83c\uddec\ud83c\udde7', name: 'UK' },
              { flag: '\ud83c\udde8\ud83c\udde6', name: 'Canada' },
              { flag: '\ud83c\uddec\ud83c\udded', name: 'Ghana' },
            ].map((c) => (
              <span key={c.name} className="flex items-center gap-1 text-xs text-gray-500">
                <span>{c.flag}</span> {c.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
