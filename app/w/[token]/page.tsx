import { redirect } from 'next/navigation';

export default async function ShortWaiverRedirect({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  redirect(`/waiver/${token}`);
}
