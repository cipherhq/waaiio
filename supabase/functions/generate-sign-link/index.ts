/**
 * Supabase Edge Function: generate-sign-link
 *
 * Creates a contract signing link and optionally sends it via WhatsApp.
 *
 * POST body: {
 *   business_id: string,
 *   title: string,
 *   template_path?: string,
 *   signer_phone: string,
 *   signer_name?: string,
 *   signer_email?: string,
 *   send_whatsapp?: boolean
 * }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const appUrl = Deno.env.get('APP_URL') || 'https://app.waaiio.com';
const whatsappToken = Deno.env.get('WHATSAPP_TOKEN') || '';
const whatsappPhoneId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';

function generateToken(length = 24): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (!whatsappToken || !whatsappPhoneId) {
    console.log(`[mock] WhatsApp to ${to}: ${text.slice(0, 100)}...`);
    return true;
  }

  const phone = to.replace(/\D/g, '');
  const res = await fetch(
    `https://graph.facebook.com/v22.0/${whatsappPhoneId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${whatsappToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text },
      }),
    },
  );

  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const body = await req.json();
    const { business_id, title, template_path, signer_phone, signer_name, signer_email, send_whatsapp } = body;

    if (!business_id || !title || !signer_phone) {
      return new Response(
        JSON.stringify({ error: 'business_id, title, and signer_phone are required' }),
        { status: 400 },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify business exists
    const { data: business } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', business_id)
      .single();

    if (!business) {
      return new Response(JSON.stringify({ error: 'Business not found' }), { status: 404 });
    }

    const token = generateToken(24);
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    const { data: contract, error } = await supabase
      .from('contracts')
      .insert({
        business_id,
        title,
        template_url: template_path || null,
        signer_name: signer_name || null,
        signer_phone,
        signer_email: signer_email || null,
        token,
        token_expires_at: expiresAt,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error || !contract) {
      console.error('Failed to create contract:', error);
      return new Response(JSON.stringify({ error: 'Failed to create contract' }), { status: 500 });
    }

    const signUrl = `${appUrl}/sign/${token}`;

    // Optionally send WhatsApp message
    if (send_whatsapp !== false) {
      const message = [
        `📝 *Document for Signature*`,
        '',
        `${business.name} has sent you a document to sign:`,
        `📄 ${title}`,
        '',
        `👉 ${signUrl}`,
        '',
        `⏰ Expires in 72 hours.`,
      ].join('\n');

      await sendWhatsApp(signer_phone, message);
    }

    return new Response(
      JSON.stringify({
        sign_url: signUrl,
        contract_id: contract.id,
        token,
        expires_at: expiresAt,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (err) {
    console.error('generate-sign-link error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
  }
});
