import type { Metadata } from 'next';
import Link from 'next/link';
import { BLOG_POSTS } from './posts';

export const metadata: Metadata = {
  title: 'Blog — Waaiio',
  description: 'Tips, guides, and stories about automating your business on WhatsApp. Learn how salons, restaurants, churches, and more use Waaiio.',
  alternates: { canonical: '/blog' },
};

export default function BlogPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Blog</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">Tips, guides, and stories about automating your business on WhatsApp</p>
        </div>
      </section>

      <section className="bg-white py-16">
        <div className="mx-auto max-w-4xl px-4">
          <div className="grid gap-8 sm:grid-cols-2">
            {BLOG_POSTS.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group rounded-2xl border border-gray-100 bg-white p-6 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl hover:shadow-brand/5"
              >
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <span>{post.category}</span>
                  <span>·</span>
                  <span>{post.readTime}</span>
                </div>
                <h2 className="mt-3 text-lg font-semibold text-gray-900 group-hover:text-brand transition">{post.title}</h2>
                <p className="mt-2 text-sm text-gray-500 line-clamp-3">{post.excerpt}</p>
                <p className="mt-4 text-xs font-medium text-brand">Read more →</p>
              </Link>
            ))}
          </div>

          {BLOG_POSTS.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-lg font-semibold text-gray-900">Coming soon</p>
              <p className="mt-2 text-sm text-gray-500">We're working on helpful guides for your business. Check back soon!</p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
