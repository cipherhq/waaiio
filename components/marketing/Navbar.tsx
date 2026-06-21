'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { motion, useScroll, useMotionValueEvent } from 'framer-motion';
import { WaaiioMark, WaaiioWordmark } from './WaaiioLogo';
import MobileMenu from './MobileMenu';
import { createClient } from '@/lib/supabase/client';

const NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/white-label', label: 'White Label' },
  { href: '/directory', label: 'Directory' },
  { href: '/help', label: 'Help' },
];

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const { scrollY } = useScroll();

  useMotionValueEvent(scrollY, 'change', (latest) => {
    setScrolled(latest > 50);
  });

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      setLoggedIn(!!session);
    });
  }, []);

  // Hero pages where nav starts transparent
  const isHeroPage = pathname === '/';

  return (
    <>
      <header
        className={`fixed left-0 right-0 top-0 z-40 transition-all duration-300 ${
          scrolled || !isHeroPage
            ? 'border-b border-gray-200/60 bg-white/85 shadow-sm backdrop-blur-lg'
            : 'bg-transparent'
        }`}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            <WaaiioMark />
            <WaaiioWordmark variant={scrolled || !isHeroPage ? 'dark' : 'light'} />
          </Link>

          {/* Desktop links */}
          <div className="hidden items-center gap-1 md:flex">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  pathname === link.href
                    ? 'bg-brand-50 font-semibold text-brand'
                    : scrolled || !isHeroPage
                      ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                      : 'text-white/90 hover:bg-white/10 hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-3">
            {loggedIn ? (
              <div className="hidden items-center gap-2 sm:flex">
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Link
                    href="/dashboard"
                    className={`rounded-xl px-5 py-2 text-sm font-semibold transition ${
                      scrolled || !isHeroPage
                        ? 'bg-brand text-white hover:bg-brand-500'
                        : 'bg-white text-gray-900 hover:bg-gray-100'
                    }`}
                  >
                    Dashboard
                  </Link>
                </motion.div>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <button
                    onClick={async () => {
                      const supabase = createClient();
                      await supabase.auth.signOut();
                      window.location.href = '/';
                    }}
                    className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
                      scrolled || !isHeroPage
                        ? 'border border-gray-300 text-gray-600 hover:bg-gray-100'
                        : 'border border-white/30 text-white/90 hover:bg-white/10'
                    }`}
                  >
                    Log Out
                  </button>
                </motion.div>
              </div>
            ) : (
              <>
                <Link
                  href="/login"
                  className={`hidden text-sm font-medium transition md:inline-flex ${
                    scrolled || !isHeroPage ? 'text-gray-700 hover:text-gray-900' : 'text-white/90 hover:text-white'
                  }`}
                >
                  Log In
                </Link>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Link
                    href="/get-started"
                    className={`hidden rounded-xl px-5 py-2 text-sm font-bold shadow-lg transition sm:inline-flex ${
                      scrolled || !isHeroPage
                        ? 'bg-accent text-gray-900 shadow-accent/20 hover:bg-accent-400'
                        : 'bg-white text-gray-900 shadow-white/10 hover:bg-gray-100'
                    }`}
                  >
                    Get Started
                  </Link>
                </motion.div>
              </>
            )}

            <button
              onClick={() => setMenuOpen(true)}
              className={`rounded-lg p-2 transition-colors md:hidden ${
                scrolled || !isHeroPage ? 'text-gray-700 hover:bg-gray-100' : 'text-white hover:bg-white/10'
              }`}
              aria-label="Open menu"
              aria-expanded={menuOpen}
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <MobileMenu
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        links={NAV_LINKS}
        loggedIn={loggedIn}
      />
    </>
  );
}
