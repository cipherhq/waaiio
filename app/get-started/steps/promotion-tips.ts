import type { CapabilityId } from '@/lib/capabilities/types';
import type { BusinessCategoryKey } from '@/lib/constants';

export type PromotionTip = {
  id: 'instagram' | 'status' | 'qr';
  title: string;
  description: string;
  copyText?: string;
  copyLabel?: string;
};

type PromotionKind = 'shop' | 'food' | 'appointment' | 'event' | 'giving' | 'general';

function promotionKind(category: BusinessCategoryKey | '', capabilities: CapabilityId[]): PromotionKind {
  if (['restaurant', 'cafe', 'bakery', 'food_truck', 'food_delivery', 'catering', 'bar', 'lounge'].includes(category)) return 'food';
  if (['shop', 'supermarket', 'pharmacy', 'instagram_vendor', 'mall_vendor', 'tailor'].includes(category)) return 'shop';
  if (['events', 'event_services', 'cinema'].includes(category)) return 'event';
  if (['church', 'mosque', 'ngo', 'crowdfunding_org'].includes(category)) return 'giving';
  if (capabilities.includes('ordering')) return 'shop';
  if (capabilities.includes('ticketing')) return 'event';
  if (capabilities.includes('giving')) return 'giving';
  if (capabilities.includes('scheduling') || capabilities.includes('appointment') || capabilities.includes('reservation')) return 'appointment';
  return 'general';
}

/**
 * Post-onboarding promotion tips only; never changes the business's WhatsApp URL.
 * All suggested copy is plain text (React encodes it when displayed).
 */
export function buildPromotionTips(
  category: BusinessCategoryKey | '',
  capabilities: CapabilityId[],
  businessName: string,
  waLink: string,
): PromotionTip[] {
  const kind = promotionKind(category, capabilities);
  const name = businessName.trim() || 'Our business';

  const label: Record<PromotionKind, string> = {
    shop: 'Shop with us on WhatsApp',
    food: 'Order with us on WhatsApp',
    appointment: 'Book with us on WhatsApp',
    event: 'Get tickets on WhatsApp',
    giving: 'Give or contribute on WhatsApp',
    general: 'Message us on WhatsApp',
  };

  const qrPlacement: Record<PromotionKind, string> = {
    shop: 'Put your QR code in parcels, at checkout, or on product packaging.',
    food: 'Put your QR code on menus, takeaway bags, or at the counter.',
    appointment: 'Put your QR code at reception, in appointment cards, or on flyers.',
    event: 'Add your QR code to posters, event flyers, and entrance signs.',
    giving: 'Share the QR code on bulletins, screens, and community notices.',
    general: 'Use the QR code on your flyers, receipts, or wherever customers find you.',
  };

  return [
    {
      id: 'instagram',
      title: 'Instagram bio',
      description: 'Paste a short call to action and your WhatsApp link into your profile bio.',
      copyLabel: 'Copy bio text',
      copyText: [name, label[kind] + ' ↓', waLink].join('\n'),
    },
    {
      id: 'status',
      title: 'WhatsApp Status',
      description: 'Post your link as a status so people who already know you can tap through.',
      copyLabel: 'Copy status caption',
      copyText: [label[kind] + '!', waLink].join('\n'),
    },
    {
      id: 'qr',
      title: 'Print & share your QR',
      description: qrPlacement[kind] + ' Download it from the card above.',
    },
  ];
}
