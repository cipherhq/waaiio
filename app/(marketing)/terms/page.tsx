import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { markdownToHtml } from '@/lib/markdown';

export async function generateMetadata(): Promise<Metadata> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('site_pages')
    .select('title, meta_description')
    .eq('slug', 'terms')
    .eq('is_published', true)
    .single();

  return {
    title: `${data?.title || 'Terms of Service'} — SmrtRply`,
    description: data?.meta_description || 'SmrtRply terms of service.',
  };
}

export default async function TermsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('site_pages')
    .select('title, content, updated_at')
    .eq('slug', 'terms')
    .eq('is_published', true)
    .single();

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-3xl font-bold text-gray-900">Terms of Service</h1>
        <p className="mt-4 text-gray-500">This page is currently unavailable.</p>
      </div>
    );
  }

  const html = markdownToHtml(data.content);
  const updated = new Date(data.updated_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900">{data.title}</h1>
      <p className="mt-2 text-sm text-gray-400">Last updated: {updated}</p>
      <div
        className="prose-pages mt-10"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
