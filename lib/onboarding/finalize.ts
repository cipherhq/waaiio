import type { SupabaseClient } from '@supabase/supabase-js';
import type { CapabilityId } from '@/lib/capabilities/types';

/**
 * Shared onboarding finalization — runs after capability initialization.
 * Used by both fresh registration and pending-business retry.
 *
 * Required operations throw on failure.
 * Optional operations (emails, analytics) are handled separately by the caller.
 */
export async function finalizeOnboarding(
  service: SupabaseClient,
  params: {
    businessId: string;
    userId: string;
    capabilities: CapabilityId[];
    firstName?: string;
    lastName?: string;
  },
): Promise<void> {
  const { businessId, userId, capabilities, firstName, lastName } = params;

  // ── Optional: Canned responses (if chat enabled) ──
  // Sample content — should not block onboarding if it fails
  if (capabilities.includes('chat')) {
    const { count, error: countError } = await service
      .from('canned_responses')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId);

    if (countError) {
      // Log but don't block — canned responses are optional sample content
      console.warn('[ONBOARDING] Canned response count query failed:', countError.message);
    } else if (!count || count === 0) {
      const defaultCanned = [
        { title: 'Thanks for waiting', message_text: 'Thanks for your patience! How can I help you?', sort_order: 0 },
        { title: 'Operating hours', message_text: 'Our operating hours are Monday - Saturday, 9am - 6pm.', sort_order: 1 },
        { title: 'Price inquiry', message_text: "I'd be happy to help with pricing! What are you interested in?", sort_order: 2 },
        { title: 'How to book', message_text: 'I can help you get started. Would you like to proceed?', sort_order: 3 },
        { title: 'Follow up', message_text: 'Just following up on our conversation. Is there anything else I can help with?', sort_order: 4 },
      ];
      const { error } = await service.from('canned_responses').insert(
        defaultCanned.map(cr => ({ business_id: businessId, ...cr })),
      );
      if (error) {
        // Optional content — log but don't block onboarding
        console.warn('[ONBOARDING] Canned response insert failed:', error.message);
      }
    }
  }

  // ── Required: Profile role and name update ──
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (profileError) {
    throw new Error(`Profile read failed: ${profileError.message}`);
  }

  const isFirstBusiness = !profile?.role || profile.role === 'diner';
  const profileUpdate: Record<string, string> = {};
  if (isFirstBusiness) profileUpdate.role = 'restaurant_owner';
  if (firstName) profileUpdate.first_name = String(firstName).trim();
  if (lastName) profileUpdate.last_name = String(lastName).trim();

  if (Object.keys(profileUpdate).length > 0) {
    const { error } = await service
      .from('profiles')
      .update(profileUpdate)
      .eq('id', userId);
    if (error) {
      throw new Error(`Profile update failed: ${error.message}`);
    }
  }
}
