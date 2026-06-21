import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { wrap, btn, h, p } from '@/lib/email/templates';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const supabase = createServiceClient();

    // Auth: require admin role
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin role
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError) {
      logger.error('[RESELLER_INVITE] Profile lookup error:', profileError.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden — admin role required' }, { status: 403 });
    }

    const body = await request.json();
    const { reseller_id } = body as { reseller_id: string };

    if (!reseller_id) {
      return NextResponse.json({ error: 'Missing required field: reseller_id' }, { status: 400 });
    }

    // Look up the reseller
    const { data: reseller, error: resellerError } = await supabase
      .from('resellers')
      .select('id, user_id, company_name')
      .eq('id', reseller_id)
      .single();

    if (resellerError || !reseller) {
      return NextResponse.json({ error: 'Reseller not found' }, { status: 404 });
    }

    // Look up the reseller's email via profiles
    const { data: resellerProfile, error: rpError } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', reseller.user_id)
      .single();

    if (rpError) {
      logger.error('[RESELLER_INVITE] Reseller profile lookup error:', rpError.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
    if (!resellerProfile?.email) {
      return NextResponse.json({ error: 'Reseller has no email on file' }, { status: 400 });
    }

    // Generate invite token
    const invite_token = crypto.randomUUID();

    // Update reseller with invite token
    const { error: updateError } = await supabase
      .from('resellers')
      .update({ invite_token })
      .eq('id', reseller_id);

    if (updateError) {
      logger.error('[RESELLER_INVITE] Failed to set invite token:', updateError.message);
      return NextResponse.json({ error: 'Failed to generate invite' }, { status: 500 });
    }

    // Send invite email
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
    const setupUrl = `${appUrl}/reseller-setup?token=${invite_token}`;
    const firstName = resellerProfile.full_name?.split(' ')[0] || 'there';

    const emailResult = await sendEmail({
      to: resellerProfile.email,
      subject: "You've been invited to the Waaiio Partner Program",
      html: wrap(`
        ${h(`Hi ${firstName},`)}
        ${p("You've been invited to join the <strong>Waaiio Partner Program</strong> as a reseller partner.")}
        ${p("As a partner, you'll be able to create and manage sub-accounts for your clients, earn commissions on their transactions, and use your own branding.")}
        ${p("Click below to complete your setup — it only takes a minute.")}
        ${btn('Complete Setup', setupUrl)}
        ${p("If you didn't expect this invitation, you can safely ignore this email.")}
      `),
    });

    if (!emailResult.success) {
      logger.error('[RESELLER_INVITE] Email send failed:', emailResult.error);
      // Don't fail the request — token is saved, admin can share the link manually
    }

    return NextResponse.json({
      success: true,
      invite_token,
      setup_url: setupUrl,
      email_sent: emailResult.success,
    });
  } catch (err) {
    logger.error('[RESELLER_INVITE] Unexpected error:', (err as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
