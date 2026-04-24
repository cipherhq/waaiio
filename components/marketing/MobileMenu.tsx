'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';

interface MobileMenuProps {
  isOpen: boolean;
  onClose: () => void;
  links: { href: string; label: string }[];
  loggedIn: boolean;
}

export default function MobileMenu({ isOpen, onClose, links, loggedIn }: MobileMenuProps) {
  const pathname = usePathname();

  useEffect(() => {
    if (isOpen) {
      document.body.classList.add('menu-open');
    } else {
      document.body.classList.remove('menu-open');
    }
    return () => document.body.classList.remove('menu-open');
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-50 flex flex-col bg-gray-950/95 backdrop-blur-xl"
        >
          <div className="flex items-center justify-end px-6 pt-5">
            <button
              onClick={onClose}
              className="p-2 text-white/80 transition-colors hover:text-white"
              aria-label="Close menu"
            >
              <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <nav className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
            {links.map((link, i) => (
              <motion.div
                key={link.href}
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.06, duration: 0.4 }}
              >
                <Link
                  href={link.href}
                  onClick={onClose}
                  className={`block px-4 py-3 text-2xl font-semibold transition-colors ${
                    pathname === link.href ? 'text-brand-300' : 'text-white/90 hover:text-white'
                  }`}
                >
                  {link.label}
                </Link>
              </motion.div>
            ))}

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.4 }}
              className="mt-8 flex flex-col gap-3"
            >
              {loggedIn ? (
                <>
                  <Link
                    href="/dashboard"
                    onClick={onClose}
                    className="inline-block rounded-xl bg-brand px-8 py-3 text-center text-lg font-semibold text-white transition hover:bg-brand-500"
                  >
                    Dashboard
                  </Link>
                  <button
                    onClick={async () => {
                      const supabase = createClient();
                      await supabase.auth.signOut();
                      onClose();
                      window.location.href = '/';
                    }}
                    className="inline-block rounded-xl border border-white/20 px-8 py-3 text-center text-lg font-semibold text-white transition hover:bg-white/10"
                  >
                    Log Out
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    onClick={onClose}
                    className="inline-block rounded-xl border border-white/20 px-8 py-3 text-center text-lg font-semibold text-white transition hover:bg-white/10"
                  >
                    Log In
                  </Link>
                  <Link
                    href="/get-started"
                    onClick={onClose}
                    className="inline-block rounded-xl bg-accent px-8 py-3 text-center text-lg font-bold text-gray-900 transition hover:bg-accent-400"
                  >
                    Get Started
                  </Link>
                </>
              )}
            </motion.div>
          </nav>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
