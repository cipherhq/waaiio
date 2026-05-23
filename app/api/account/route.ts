import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelSubscription as cancelStripeSub } from '@/lib/payments/stripe-recurring';
import { cancelSubscription as cancelPaystackSub } from '@/lib/payments/paystack-recurring';
import { sendEmail } from '@/lib/email/client';
import { accountDeletionConfirmationEmail } from '@/lib/email/templates';
import { logger } from '@/lib/logger';

/**
 * Enhanced account deletion endpoint.
 * GDPR Article 17 — Right to Erasure
 * CCPA — Right to Delete
 *
 * Supports:
 * - Immediate deletion (default)
 * - 30-day grace period (body: { gracePeriod: true })
 * - Cancels active payment subscriptions
 * - Deactivates WhatsApp bot sessions
 * - Sends confirmation email
 * - Full audit logging
 */

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse optional body for grace period flag
    let gracePeriod = false;
    try {
      const body = await request.json();
      gracePeriod = body?.gracePeriod === true;
    } catch {
      // No body — immediate deletion
    }

    const serviceClient = createServiceClient();

    // Fetch ALL businesses owned by this user (user may own multiple)
    const { data: businesses } = await serviceClient
      .from('businesses')
      .select('id, name')
      .eq('owner_id', user.id);

    if (!businesses || businesses.length === 0) {
      // User with no businesses — still allow account deletion
      logger.info(`[ACCOUNT-DELETE] User ${user.id} has no businesses, deleting auth user only`);
    }

    const businessIds = (businesses || []).map((b: { id: string }) => b.id);

    // Cancel active customer subscriptions on payment gateways
    if (businessIds.length > 0) {
      const { data: activeSubs } = await serviceClient
        .from('customer_subscriptions')
        .select('id, gateway, gateway_subscription_code, metadata, business_id')
        .in('business_id', businessIds)
        .in('status', ['active', 'past_due']);

      if (activeSubs && activeSubs.length > 0) {
        for (const sub of activeSubs) {
          if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
            await cancelStripeSub(sub.gateway_subscription_code).catch((e) =>
              logger.error(`[ACCOUNT] Failed to cancel Stripe sub ${sub.id}:`, e)
            );
          } else if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
            const emailToken = (sub.metadata as Record<string, string>)?.email_token || '';
            await cancelPaystackSub(sub.gateway_subscription_code, emailToken).catch((e) =>
              logger.error(`[ACCOUNT] Failed to cancel Paystack sub ${sub.id}:`, e)
            );
          }
        }

        // Mark all as cancelled in DB
        for (const bizId of businessIds) {
          await serviceClient
            .from('customer_subscriptions')
            .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
            .eq('business_id', bizId)
            .in('status', ['active', 'past_due']);
        }
      }

      // Deactivate all WhatsApp bot sessions
      for (const bizId of businessIds) {
        await serviceClient
          .from('bot_sessions')
          .update({ is_active: false })
          .eq('business_id', bizId)
          .eq('is_active', true);
      }
    }

    if (gracePeriod) {
      // 30-day grace period: mark for deletion instead of immediate delete
      const deletionDate = new Date();
      deletionDate.setDate(deletionDate.getDate() + 30);

      // Update profile metadata with scheduled deletion
      const { data: profile } = await serviceClient
        .from('profiles')
        .select('metadata')
        .eq('id', user.id)
        .maybeSingle();

      const existingMetadata = (profile?.metadata || {}) as Record<string, unknown>;
      await serviceClient
        .from('profiles')
        .update({
          metadata: {
            ...existingMetadata,
            deletion_scheduled: true,
            deletion_date: deletionDate.toISOString(),
            deletion_requested_at: new Date().toISOString(),
          },
        })
        .eq('id', user.id);

      // Soft-delete all businesses
      for (const bizId of businessIds) {
        await serviceClient
          .from('businesses')
          .update({ status: 'deleted' })
          .eq('id', bizId);
      }

      logger.info(`[ACCOUNT-DELETE] User ${user.id} scheduled for deletion on ${deletionDate.toISOString()} (30-day grace period)`);

      // Send confirmation email
      if (user.email) {
        const emailContent = accountDeletionConfirmationEmail(
          user.email.split('@')[0],
          deletionDate.toISOString().split('T')[0],
          true,
        );
        await sendEmail({ to: user.email, ...emailContent }).catch((e) =>
          logger.error('[ACCOUNT-DELETE] Failed to send confirmation email:', e)
        );
      }

      return NextResponse.json({
        success: true,
        gracePeriod: true,
        deletionDate: deletionDate.toISOString(),
        message: 'Your account has been scheduled for deletion in 30 days. You can cancel this by logging back in.',
      });
    }

    // Immediate deletion path
    // Soft-delete all businesses (preserves financial records)
    for (const bizId of businessIds) {
      await serviceClient
        .from('businesses')
        .update({ status: 'deleted' })
        .eq('id', bizId);
    }

    logger.info(`[ACCOUNT-DELETE] User ${user.id} (${user.email}) account deleted immediately. Businesses: ${businessIds.join(', ')}`);

    // Send confirmation email before deleting auth user
    if (user.email) {
      const emailContent = accountDeletionConfirmationEmail(
        user.email.split('@')[0],
        new Date().toISOString().split('T')[0],
        false,
      );
      await sendEmail({ to: user.email, ...emailContent }).catch((e) =>
        logger.error('[ACCOUNT-DELETE] Failed to send confirmation email:', e)
      );
    }

    // Delete auth user (cascades to profiles via FK)
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(user.id);
    if (deleteError) {
      logger.error('[ACCOUNT] Failed to delete auth user:', deleteError);
      return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[ACCOUNT] DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
