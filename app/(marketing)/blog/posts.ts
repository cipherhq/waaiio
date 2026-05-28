export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  readTime: string;
  date: string;
  content: string;
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'how-to-automate-salon-bookings-whatsapp',
    title: 'How to Automate Your Salon Bookings on WhatsApp',
    excerpt: 'Stop losing customers to missed calls and forgotten DMs. Set up automated booking on WhatsApp in 5 minutes — no app needed, no technical skills required.',
    category: 'Beauty & Wellness',
    readTime: '4 min read',
    date: '2026-05-27',
    content: `
## The Problem

You run a salon. Your phone rings while you're mid-haircut. A DM comes in at 11 PM asking for an appointment. A customer messages "are you free tomorrow?" and you reply 3 hours later — they already booked somewhere else.

Sound familiar? You're not alone. **40% of booking requests come after business hours**, and 67% of customers won't message twice if they don't get an instant reply.

## The Solution: WhatsApp Automation

What if your customers could book, pay, and get confirmed — all on WhatsApp — without you lifting a finger?

That's exactly what Waaiio does. Here's how it works:

### Step 1: Add Your Services (2 minutes)
List your services with prices and duration. Haircut — ₦3,000 — 30 min. Braiding — ₦15,000 — 2 hours. You get the idea.

### Step 2: Share Your WhatsApp Link (30 seconds)
You get a unique link. Share it on your Instagram bio, WhatsApp status, or print it as a QR code for your shop.

### Step 3: Customers Book Themselves
A customer messages "I want to book a haircut for Friday at 3pm." The bot understands, checks your availability, and confirms — instantly. It even collects payment deposits.

## What Makes This Different?

- **No app download** — your customers already have WhatsApp
- **Works in Pidgin** — "I wan barb tomorrow morning" works perfectly
- **24/7** — takes bookings at 2 AM while you sleep
- **Automatic reminders** — customers get a WhatsApp reminder 24 hours and 2 hours before their appointment
- **Payment collection** — deposit or full payment via Paystack or Stripe

## Real Results

Salons using WhatsApp automation typically see:
- 30% more bookings (capturing after-hours requests)
- 60% fewer no-shows (thanks to automated reminders)
- 5+ hours saved per week (no more back-and-forth messaging)

## Get Started Free

Waaiio offers a 30-day free trial with all features included. No credit card required.

[Start your free trial →](https://waaiio.com/get-started)
    `,
  },
  {
    slug: 'whatsapp-church-tithes-offerings-automation',
    title: 'How Churches Can Collect Tithes & Offerings on WhatsApp',
    excerpt: 'Your members already tithe. They already use WhatsApp. Why not combine the two? Here\'s how to set up automated giving on WhatsApp for your church.',
    category: 'Faith & Community',
    readTime: '3 min read',
    date: '2026-05-27',
    content: `
## Why WhatsApp for Church Giving?

Your congregation is already on WhatsApp. They use it to communicate, share prayer requests, and coordinate events. Now they can give tithes, offerings, seeds, and building fund contributions — right from the same app.

## How It Works

1. **Member messages your church's WhatsApp number**
2. **They type "pay tithe 5000"** (or any amount)
3. **Bot sends a secure payment link** (Paystack for Nigeria/Ghana, Stripe for US/UK)
4. **Member pays and gets an instant receipt**
5. **Church dashboard shows all contributions** with member names and amounts

## What You Can Accept

- Tithes
- Offerings (first fruit, thanksgiving, etc.)
- Seeds and pledges
- Building fund contributions
- Event registrations (conferences, retreats)
- Donations from non-members

## Features Built for Churches

- **Multiple giving categories** — members choose what they're giving towards
- **Automatic receipts** — sent via WhatsApp instantly after payment
- **Annual giving statements** — downloadable for tax purposes
- **Service time reminders** — "Sunday Worship at 9 AM tomorrow"
- **Event tickets** — sell conference tickets with QR code check-in
- **7 languages** — works in English, Pidgin, Yoruba, Igbo, Hausa, Twi, and French

## Getting Started

1. Sign up at waaiio.com/get-started
2. Select "Faith & Community" → "Church"
3. Add your giving categories and service times
4. Share your WhatsApp link with your congregation

That's it. Your members can start giving within 5 minutes.

[Start your free trial →](https://waaiio.com/get-started)
    `,
  },
  {
    slug: 'restaurant-whatsapp-ordering-system',
    title: 'Set Up a WhatsApp Ordering System for Your Restaurant',
    excerpt: 'Let customers browse your menu, place orders, and pay — all through WhatsApp. No app, no website needed. Just the messaging app they already use.',
    category: 'Food & Dining',
    readTime: '4 min read',
    date: '2026-05-27',
    content: `
## Beyond Phone Orders

Phone orders are messy. Customers call during rush hour, orders get mixed up, and you're stuck taking orders instead of cooking.

WhatsApp ordering fixes this. Customers browse your menu, add items to cart, and checkout — all in a conversation. You get a clear order with payment confirmed before you start cooking.

## How It Works with Waaiio

### Your Menu on WhatsApp
Add your dishes with prices, descriptions, and photos. When a customer messages, the bot shows your menu as a clean WhatsApp catalog.

### Smart Ordering
Customer types "2 jollof rice and 1 pepper soup" — the bot understands, adds to cart, calculates the total, and asks for delivery address.

### Payment Before Cooking
Customer pays via Paystack or Stripe before you start preparing. No more "I'll pay when it arrives" headaches.

### Order Tracking
Customer gets updates: "Order confirmed", "Being prepared", "Out for delivery". All automatic.

## Why Not Just Use Instagram DMs?

- Instagram DMs don't take payments
- You can't send order updates automatically
- There's no menu catalog
- You have to reply to every single message manually

With Waaiio, the bot handles 90% of orders. You only step in for special requests.

## Features for Restaurants

- Product catalog with images
- Cart + checkout flow
- Delivery zone pricing
- Table reservations
- Reorder ("same again" — loads last order)
- Operating hours (bot only shows available times)

## Try It Free

30-day trial with everything included. Add your menu and start taking WhatsApp orders today.

[Start your free trial →](https://waaiio.com/get-started)
    `,
  },
];
