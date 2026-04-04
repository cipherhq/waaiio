-- CMS-editable site pages
CREATE TABLE IF NOT EXISTS public.site_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  meta_description TEXT,
  is_published BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.site_pages ENABLE ROW LEVEL SECURITY;

-- Anyone can read published pages
CREATE POLICY "Anyone can read published pages"
  ON public.site_pages FOR SELECT
  USING (is_published = true);

-- Business owners can manage pages (for now, any authenticated user who owns a business)
CREATE POLICY "Authenticated users can manage pages"
  ON public.site_pages FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.businesses WHERE owner_id = auth.uid())
  );

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.handle_site_pages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_site_pages_updated
  BEFORE UPDATE ON public.site_pages
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_site_pages_updated_at();

-- Seed with default content
INSERT INTO public.site_pages (slug, title, content, meta_description) VALUES
(
  'terms',
  'Terms of Service',
  E'## 1. Acceptance of Terms\n\nBy accessing or using SmrtRply ("the Platform"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our platform.\n\n## 2. Our Service\n\nSmrtRply provides WhatsApp-powered booking and automation tools for businesses. We act as a technology provider enabling businesses to manage bookings, orders, and appointments through WhatsApp.\n\n## 3. Account Registration\n\nTo use SmrtRply, you must create a business account with accurate information. You are responsible for maintaining the security of your account and for all activities under your account.\n\n## 4. Bookings & Payments\n\n- Bookings made through your SmrtRply-powered WhatsApp bot are your responsibility to fulfil.\n- Deposits collected through the platform are processed via Paystack (Nigeria/Ghana) or Stripe (US/UK/Canada).\n- You agree to honour refund policies you set for your business.\n\n## 5. Acceptable Use\n\nYou agree not to:\n\n- Use the platform for any unlawful purpose.\n- Send spam or unsolicited messages through the WhatsApp bot.\n- Attempt to access other users'' accounts or data.\n- Interfere with the platform''s operation or security.\n\n## 6. Limitation of Liability\n\nSmrtRply is provided "as is" without warranties of any kind. We are not liable for any damages arising from your use of the platform, including but not limited to missed bookings, payment disputes, or service interruptions.\n\n## 7. Changes to Terms\n\nWe may update these terms from time to time. Continued use of the platform after changes constitutes acceptance of the updated terms.\n\n## 8. Contact\n\nFor questions about these terms, contact us at legal@smrtrply.com.',
  'SmrtRply terms of service — the rules for using our WhatsApp automation platform.'
),
(
  'privacy',
  'Privacy Policy',
  E'## 1. Information We Collect\n\nWhen you use SmrtRply, we may collect:\n\n- **Account information:** business name, email, phone number, address.\n- **Booking data:** customer names, phone numbers, booking details processed through your WhatsApp bot.\n- **Usage data:** platform features used, interaction patterns.\n- **Payment information:** processed securely by our payment partners.\n\n## 2. How We Use Your Information\n\nWe use your information to:\n\n- Operate and maintain your WhatsApp booking bot.\n- Process bookings and payments on your behalf.\n- Send notifications and reminders to you and your customers.\n- Improve our platform and services.\n- Prevent fraud and enforce our terms.\n\n## 3. Information Sharing\n\n- **Customers:** booking confirmations and reminders are sent to customers via WhatsApp.\n- **Payment processors:** payment data is handled by Paystack or Stripe. We do not store full card details.\n- **WhatsApp/Gupshup:** messages are delivered through our WhatsApp Business API provider.\n\nWe do not sell your personal information to third parties.\n\n## 4. Data Security\n\nWe implement industry-standard security measures including encrypted connections, secure authentication, and access controls.\n\n## 5. Your Rights\n\nYou have the right to:\n\n- Access your business and customer data.\n- Update or correct your information.\n- Request deletion of your account and data.\n- Export your booking data.\n\n## 6. Contact Us\n\nFor privacy questions, contact us at privacy@smrtrply.com.',
  'SmrtRply privacy policy — how we handle your data.'
);
