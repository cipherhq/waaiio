import { redirect } from 'next/navigation';

/**
 * Short URL redirect: /i/{id} → /join-event/{id}
 * Keeps shared links short and clean in WhatsApp/social.
 */
export default async function ShortInvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/join-event/${id}`);
}
