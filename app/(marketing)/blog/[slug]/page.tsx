import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BLOG_POSTS } from '../posts';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) return { title: 'Post Not Found' };

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  return {
    title: `${post.title} — Waaiio Blog`,
    description: post.excerpt,
    alternates: { canonical: `${baseUrl}/blog/${slug}` },
    openGraph: {
      title: post.title,
      description: post.excerpt,
      url: `${baseUrl}/blog/${slug}`,
      type: 'article',
      publishedTime: post.date,
    },
  };
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) notFound();

  // Simple markdown-like rendering (## headings, **bold**, [links](url), lists)
  const renderContent = (content: string) => {
    return content
      .trim()
      .split('\n\n')
      .map((block, i) => {
        const trimmed = block.trim();
        if (trimmed.startsWith('## ')) {
          return <h2 key={i} className="mt-8 text-xl font-bold text-gray-900">{trimmed.slice(3)}</h2>;
        }
        if (trimmed.startsWith('### ')) {
          return <h3 key={i} className="mt-6 text-lg font-semibold text-gray-900">{trimmed.slice(4)}</h3>;
        }
        if (trimmed.startsWith('- ')) {
          const items = trimmed.split('\n').filter(l => l.startsWith('- '));
          return (
            <ul key={i} className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-gray-600">
              {items.map((item, j) => (
                <li key={j} dangerouslySetInnerHTML={{ __html: formatInline(item.slice(2)) }} />
              ))}
            </ul>
          );
        }
        if (trimmed.startsWith('1. ') || trimmed.startsWith('2. ')) {
          const items = trimmed.split('\n').filter(l => /^\d+\. /.test(l));
          return (
            <ol key={i} className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-gray-600">
              {items.map((item, j) => (
                <li key={j} dangerouslySetInnerHTML={{ __html: formatInline(item.replace(/^\d+\.\s/, '')) }} />
              ))}
            </ol>
          );
        }
        if (trimmed.startsWith('[') && trimmed.includes('](')) {
          const match = trimmed.match(/\[(.+?)\]\((.+?)\)/);
          if (match) {
            return (
              <p key={i} className="mt-4">
                <a href={match[2]} className="inline-flex items-center gap-1 rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white hover:bg-brand-600 transition">
                  {match[1]}
                </a>
              </p>
            );
          }
        }
        return <p key={i} className="mt-3 text-sm leading-relaxed text-gray-600" dangerouslySetInnerHTML={{ __html: formatInline(trimmed) }} />;
      });
  };

  function formatInline(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>')
      .replace(/\[(.+?)\]\((.+?)\)/g, (_, label, href) => {
        const safeHref = /^(https?:\/\/|\/[^/])/.test(href) ? href : '#';
        return `<a href="${safeHref}" class="text-brand hover:underline">${label}</a>`;
      });
  }

  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-3xl px-4 text-center">
          <div className="flex items-center justify-center gap-2 text-sm text-brand-200">
            <span>{post.category}</span>
            <span>·</span>
            <span>{post.readTime}</span>
          </div>
          <h1 className="mt-4 text-3xl font-extrabold text-white lg:text-4xl">{post.title}</h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-brand-200">{post.excerpt}</p>
        </div>
      </section>

      <section className="bg-white py-12">
        <article className="mx-auto max-w-2xl px-4">
          {renderContent(post.content)}

          <div className="mt-12 border-t border-gray-100 pt-8 text-center">
            <Link href="/blog" className="text-sm font-medium text-brand hover:text-brand-600 transition">
              ← Back to Blog
            </Link>
          </div>
        </article>
      </section>
    </>
  );
}
