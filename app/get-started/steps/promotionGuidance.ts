import type { CapabilityId } from '@/lib/capabilities/types';
import type { BusinessCategoryKey } from '@/lib/constants';

export interface PromotionTip {
  title: string;
  detail: string;
}

export interface PromotionGuidance {
  intro: string;
  tips: readonly PromotionTip[];
  caption: string;
}

type PromotionKind = 'shop' | 'appointments' | 'restaurant' | 'events' | 'giving' | 'general';

const guidanceByKind: Record<PromotionKind, Omit<PromotionGuidance, 'caption'> & { message: string }> = {
  shop: {
    intro: 'Help shoppers find your products right from the places they already follow you.',
    tips: [
      { title: 'Instagram & TikTok bio', detail: 'Add your WhatsApp shopping link to your profile wherever bio links are available.' },
      { title: 'Stories & WhatsApp Status', detail: 'Share new arrivals with your link so customers can start an order.' },
      { title: 'Packaging & receipts', detail: 'Add your QR code to parcels, thank-you cards, or receipts.' },
    ],
    message: 'Shop with us on WhatsApp: ',
  },
  appointments: {
    intro: 'Make it easy for customers to find your booking link.',
    tips: [
      { title: 'Instagram booking bio', detail: 'Add your link to your profile so visitors can book from WhatsApp.' },
      { title: 'Stories & WhatsApp Status', detail: 'Share your services and point followers to your booking link.' },
      { title: 'Front desk & Google profile', detail: 'Display the QR code at reception and add your link to your business profile where supported.' },
    ],
    message: 'Book with us on WhatsApp: ',
  },
  restaurant: {
    intro: 'Let customers find your WhatsApp link when they see your menu.',
    tips: [
      { title: 'Menu & counter QR', detail: 'Place the QR code where customers read the menu or pay.' },
      { title: 'Takeaway packaging', detail: 'Add your QR code to bags or receipts for their next visit.' },
      { title: 'Social media bio', detail: 'Add the link to Instagram or TikTok where profile links are available.' },
    ],
    message: 'See our menu on WhatsApp: ',
  },
  events: {
    intro: 'Put your event link where people hear about your next event.',
    tips: [
      { title: 'Flyers & posters', detail: 'Print the QR code next to your event details.' },
      { title: 'Organizer bio', detail: 'Share the ticket link in your Instagram or TikTok profile.' },
      { title: 'Stories & Status', detail: 'Post event reminders and include the link to get tickets.' },
    ],
    message: 'Find our events on WhatsApp: ',
  },
  giving: {
    intro: 'Give your community a simple way to find your giving link.',
    tips: [
      { title: 'Bulletins & programs', detail: 'Print the QR code in your weekly bulletin or program.' },
      { title: 'Online announcements', detail: 'Share the link in community updates and service announcements.' },
      { title: 'Entrance & welcome desk', detail: 'Display the QR code where visitors can easily scan it.' },
    ],
    message: 'Support us on WhatsApp: ',
  },
  general: {
    intro: 'Share your WhatsApp link wherever your customers already connect with you.',
    tips: [
      { title: 'Social media bio', detail: 'Put the link in your business profile wherever links are supported.' },
      { title: 'WhatsApp Status', detail: 'Tell customers how to reach you and include the link.' },
      { title: 'Flyers & signs', detail: 'Print the QR code for customers to scan.' },
    ],
    message: 'Reach us on WhatsApp: ',
  },
};

/**
 * Category takes precedence over overlapping capabilities so a restaurant
 * with both bookings and ordering still gets restaurant-specific advice.
 * Categories outside these groups fall back to the selected capabilities.
 */
export function getPromotionGuidance(
  category: BusinessCategoryKey | '',
  selectedCapabilities: readonly CapabilityId[],
  waLink: string
): PromotionGuidance {
  let kind: PromotionKind = 'general';

  if (['church', 'mosque', 'ngo', 'crowdfunding_org'].includes(category)) {
    kind = 'giving';
  } else if (['events', 'event_services', 'cinema'].includes(category)) {
    kind = 'events';
  } else if (['restaurant', 'cafe', 'bar', 'lounge', 'food_truck', 'food_delivery', 'bakery', 'catering'].includes(category)) {
    kind = 'restaurant';
  } else if (['shop', 'supermarket', 'instagram_vendor', 'mall_vendor', 'pharmacy'].includes(category)) {
    kind = 'shop';
  } else if (selectedCapabilities.includes('giving')) {
    kind = 'giving';
  } else if (selectedCapabilities.includes('ticketing')) {
    kind = 'events';
  } else if (selectedCapabilities.includes('appointment') || selectedCapabilities.includes('scheduling') || selectedCapabilities.includes('reservation')) {
    kind = 'appointments';
  } else if (selectedCapabilities.includes('ordering')) {
    kind = 'shop';
  }

  const guidance = guidanceByKind[kind];
  return {
    intro: guidance.intro,
    tips: guidance.tips,
    caption: guidance.message + waLink,
  };
}
