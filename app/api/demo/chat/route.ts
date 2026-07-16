import { NextResponse, type NextRequest } from 'next/server';
import { rateLimitResponseAsync } from '@/lib/rate-limit';

/**
 * POST /api/demo/chat
 *
 * Lightweight demo bot for the landing page.
 * Uses regex-based intent detection (free, no LLM calls).
 * Returns simulated bot responses without creating any database records.
 */

// Rate limit: 30 messages per IP per minute (prevent abuse)
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const rateLimit = await rateLimitResponseAsync(`demo:${ip}`, 30, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const { message, category } = await request.json();
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'Message required' }, { status: 400 });
    }

    const text = message.trim().toLowerCase();
    const response = generateDemoResponse(text, category || 'barber');

    return NextResponse.json(response);
  } catch {
    return NextResponse.json({ text: 'Sorry, something went wrong. Try again!' });
  }
}

interface DemoResponse {
  text: string;
  buttons?: Array<{ id: string; title: string }>;
}

function generateDemoResponse(text: string, category: string): DemoResponse {
  // ── Greetings ──
  if (/^(hi|hello|hey|yo|sup|hiya|good\s*(morning|afternoon|evening)|assalamu|salaam)$/i.test(text)) {
    return getGreeting(category);
  }

  // ── Booking intent ──
  if (/\b(book|reserve|appointment|schedule|barb|haircut|trim|cut|shave|massage|facial)\b/i.test(text)
    || /\b(i\s*wan|abeg|make\s*i)\b.*\b(barb|cut|book|trim)\b/i.test(text)) {

    // Check for date/time in the message
    const hasTime = /\b(\d{1,2}(:\d{2})?\s*(am|pm)|morning|afternoon|evening|tomorrow|today)\b/i.test(text);

    if (hasTime) {
      const time = extractTime(text);
      const date = /tomorrow/i.test(text) ? 'Tomorrow' : 'Today';
      const service = extractService(text, category);
      return {
        text: `Got it! Looking up *${service}* for *${date}* at *${time}*... ✨\n\n✅ *Appointment Confirmed!*\n\n${getServiceEmoji(category)} ${service}\n📅 ${date}, ${time}\n📍 Demo Business\n🔑 Ref: BK-${Math.floor(1000 + Math.random() * 9000)}\n\n💳 Pay here 👇\npay.waaiio.com/demo\n\n💡 *What you can do:*\n• Type *my bookings* to view appointments\n• Type *reschedule* to change time\n• Type *cancel* to cancel`,
      };
    }

    return getServiceMenu(category);
  }

  // ── Ordering intent ──
  if (/\b(order|buy|menu|food|chop|eat|hungry|deliver|purchase)\b/i.test(text)
    || /\b(i\s*wan|abeg)\b.*\b(chop|eat|order|buy)\b/i.test(text)) {
    return {
      text: `Here's our menu:\n\n🍛 *Jollof Rice & Chicken* — ₦3,500\n🍗 *Pounded Yam & Egusi* — ₦4,000\n🌯 *Shawarma Platter* — ₦2,500\n🥤 *Chapman* — ₦1,000\n\nType the item name or number to add to cart.`,
      buttons: [{ id: 'order_1', title: 'Jollof Rice' }, { id: 'order_2', title: 'Shawarma' }, { id: 'view_cart', title: 'View Cart' }],
    };
  }

  // ── Payment intent ──
  if (/\b(pay|tithe|offering|donate|donation|zakat|sadaqah|fees|dues|levy)\b/i.test(text)) {
    return {
      text: `What would you like to pay for?\n\n1. Pay Tithe\n2. Give Offering\n3. Seed / Donation\n4. Pay Dues`,
      buttons: [{ id: 'pay_tithe', title: 'Pay Tithe' }, { id: 'pay_offering', title: 'Give Offering' }, { id: 'pay_dues', title: 'Pay Dues' }],
    };
  }

  // ── Ticket intent ──
  if (/\b(ticket|event|show|concert|movie)\b/i.test(text)) {
    return {
      text: `🎪 *Upcoming Events:*\n\n1. 🎵 Live Music Night — Sat, May 3 — ₦5,000\n2. 🎤 Comedy Show — Sun, May 4 — ₦3,000\n3. 🎭 Drama Festival — Fri, May 9 — ₦2,500\n\nWhich event would you like tickets for?`,
      buttons: [{ id: 'event_1', title: 'Live Music' }, { id: 'event_2', title: 'Comedy Show' }],
    };
  }

  // ── Service/number selections ──
  if (/^[1-4]$/.test(text)) {
    const services = ['Haircut', 'Beard Trim', 'Full Grooming', 'Kids Cut'];
    const prices = ['$30', '$15', '$50', '$20'];
    const idx = parseInt(text) - 1;
    return {
      text: `${services[idx]} — ${prices[idx]} ${getServiceEmoji(category)}\n\nWhen would you like to come in?`,
    };
  }

  // ── My bookings ──
  if (/\b(my\s*)?(bookings?|appointments?|orders?|upcoming|schedule)\b/i.test(text)) {
    return {
      text: `📋 *Your Upcoming Bookings:*\n\n1. ${getServiceEmoji(category)} Haircut\n   📅 Tomorrow, 3:00 PM\n   🔑 Ref: BK-7291\n\n2. ${getServiceEmoji(category)} Full Grooming\n   📅 Friday, 10:00 AM\n   🔑 Ref: BK-4821\n\nType a number to manage, or *book* for a new one.`,
    };
  }

  // ── Reschedule ──
  if (/\b(reschedule|change\s*(time|date|my)|move\s*(appointment|booking))\b/i.test(text)) {
    return {
      text: `Which booking would you like to reschedule?\n\n1. ${getServiceEmoji(category)} Haircut — Tomorrow, 3:00 PM\n2. ${getServiceEmoji(category)} Full Grooming — Friday, 10:00 AM\n\nType the number to select.`,
    };
  }

  // ── Receipt ──
  if (/\b(receipt|history|transaction)\b/i.test(text)) {
    return { text: `Generating your receipt... 📄\n\n🧾 *Payment Receipt*\n\n${getServiceEmoji(category)} Demo Business\n✂️ Haircut\n💰 $30.00\n📅 Today\n🔑 Ref: BK-7291\n\nThank you!` };
  }

  // ── Loyalty ──
  if (/\b(points?|loyalty|rewards?|stars?)\b/i.test(text)) {
    return { text: `🏆 *Your Loyalty Points*\n\n⭐ 150 points\n🎁 Next reward at 200 points (Free haircut!)\n\nKeep booking to earn more!` };
  }

  // ── Cancel ──
  if (/^cancel$/i.test(text)) {
    return { text: `Action cancelled. Send *Hi* to start fresh. 🙏` };
  }

  // ── Help ──
  if (/\b(help|what\s*can|options|commands)\b/i.test(text)) {
    return {
      text: `Here's what I can help with:\n\n• *Book* — Schedule an appointment\n• *Order* — Place a food order\n• *Pay* — Make a payment\n• *My bookings* — View your appointments\n• *Reschedule* — Change booking time\n• *Receipt* — Get your last receipt\n• *My points* — Check loyalty balance\n• *Cancel* — Exit current action\n\nOr just tell me what you need in your own words!`,
    };
  }

  // ── Fallback — still try to be helpful ──
  return getGreeting(category);
}

function getGreeting(category: string): DemoResponse {
  const greetings: Record<string, DemoResponse> = {
    barber: {
      text: `Welcome to the demo! 💈\n\nI'm an AI-powered WhatsApp bot. Here's what I can do:\n\n✂️ Book appointments instantly\n💳 Collect payments in chat\n⏰ Send automatic reminders\n🏆 Track loyalty points\n\nTry it — type something like *"I wan barb tomorrow 3pm"*`,
      buttons: [{ id: 'book', title: 'Book Appointment' }, { id: 'services', title: 'View Services' }, { id: 'points', title: 'My Points' }],
    },
    restaurant: {
      text: `Welcome! 🍽️\n\nI'm an AI-powered WhatsApp bot for restaurants.\n\n🛒 Take orders automatically\n💳 Payment links in chat\n📦 Delivery tracking\n⭐ Customer feedback\n\nTry typing *"I want to order food"*`,
      buttons: [{ id: 'order', title: 'Place Order' }, { id: 'book', title: 'Book Table' }, { id: 'menu', title: 'View Menu' }],
    },
    church: {
      text: `Welcome! ⛪\n\nI'm an AI-powered WhatsApp bot for churches.\n\n💰 Collect tithes & offerings\n🎟️ Event tickets\n📊 Member management\n📄 Annual statements\n\nTry typing *"pay tithe"*`,
      buttons: [{ id: 'pay', title: 'Give / Pay' }, { id: 'events', title: 'Events' }, { id: 'receipt', title: 'My Receipt' }],
    },
  };
  return greetings[category] || greetings.barber;
}

function getServiceMenu(category: string): DemoResponse {
  if (category === 'restaurant') {
    return {
      text: `What would you like to order?\n\n1. 🍛 Jollof Rice & Chicken — ₦3,500\n2. 🍗 Pounded Yam & Egusi — ₦4,000\n3. 🌯 Shawarma Platter — ₦2,500`,
    };
  }
  return {
    text: `What service would you like?\n\n1. ✂️ Haircut — $30\n2. 🪒 Beard Trim — $15\n3. 💈 Full Grooming — $50\n4. 👶 Kids Cut — $20`,
  };
}

function extractService(text: string, _category: string): string {
  if (/barb|haircut|cut/i.test(text)) return 'Haircut';
  if (/beard|trim/i.test(text)) return 'Beard Trim';
  if (/groom/i.test(text)) return 'Full Grooming';
  return 'Haircut';
}

function extractTime(text: string): string {
  const timeMatch = text.match(/(\d{1,2})(:\d{2})?\s*(am|pm)/i);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const ampm = timeMatch[3].toUpperCase();
    return `${hour}:00 ${ampm}`;
  }
  if (/morning/i.test(text)) return '10:00 AM';
  if (/afternoon/i.test(text)) return '2:00 PM';
  if (/evening/i.test(text)) return '5:00 PM';
  return '3:00 PM';
}

function getServiceEmoji(category: string): string {
  const emojis: Record<string, string> = {
    barber: '💈', salon: '💅', spa: '🧖', restaurant: '🍽️', church: '⛪',
    mosque: '🕌', shop: '🛍️', gym: '💪', clinic: '🏥', hotel: '🏨',
  };
  return emojis[category] || '📋';
}
