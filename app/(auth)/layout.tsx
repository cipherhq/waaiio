import Link from 'next/link';
import Image from 'next/image';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Background */}
      <div className="fixed inset-0 -z-10 bg-gradient-to-br from-brand-50 via-white to-gray-50">
        <div className="absolute -left-20 -top-20 h-[400px] w-[400px] rounded-full bg-brand/5 blur-3xl" />
        <div className="absolute -bottom-20 -right-20 h-[300px] w-[300px] rounded-full bg-accent/5 blur-3xl" />
      </div>
      <header className="border-b border-gray-100/50 bg-white/60 backdrop-blur-sm">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 py-4">
          <Link href="/" className="transition-opacity hover:opacity-80">
            <Image src="/logo.png" alt="Waaiio" width={120} height={32} className="h-8 w-auto" priority />
          </Link>
          <Link href="/get-started" className="text-xs font-medium text-brand hover:text-brand-600 transition">
            Create account &rarr;
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-10">
        {children}
      </main>
      <footer className="py-4 text-center text-xs text-gray-400">
        &copy; {new Date().getFullYear()} CipherHQ LLC d/b/a Waaiio
      </footer>
    </div>
  );
}
