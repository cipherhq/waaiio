import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { markdownToHtml } from '@/lib/markdown';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export async function generateMetadata(): Promise<Metadata> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('site_pages')
    .select('title, meta_description')
    .eq('slug', 'privacy')
    .eq('is_published', true)
    .single();

  return {
    title: `${data?.title || 'Privacy Policy'} — Waaiio`,
    description: data?.meta_description || 'Waaiio privacy policy.',
  };
}

export default async function PrivacyPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('site_pages')
    .select('title, content, updated_at')
    .eq('slug', 'privacy')
    .eq('is_published', true)
    .single();

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-3xl font-bold text-gray-900">Privacy Policy</h1>
        <p className="mt-4 text-gray-500">This page is currently unavailable.</p>
      </div>
    );
  }

  const html = markdownToHtml(data.content);
  const updated = new Date(data.updated_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Privacy Policy</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">How we collect, use, and protect your personal information.</p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <p className="mt-2 text-sm text-gray-400">Last updated: {updated}</p>
          <div
            className="prose-pages mt-10"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </AnimatedSection>
    </>
  );
}
