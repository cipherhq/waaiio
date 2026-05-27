# Business Requirements Document (BRD)

**Product:** Waaiio — AI-Powered WhatsApp & Web Automation Platform
**Entity:** CipherHQ LLC d/b/a Waaiio
**Version:** 1.0 | Date: 2026-05-27

---

## 1. Executive Summary

Waaiio is a no-code SaaS platform that automates bookings, payments, orders, donations, event tickets, and customer engagement via WhatsApp and web for 89 business types across 16 industries. Businesses complete a 4-step onboarding; their customers then interact entirely through WhatsApp or public web pages — no app downloads required. The platform targets underserved SMBs in WhatsApp-dominant markets (Africa) and diaspora communities (North America, UK).

## 2. Business Objectives

- Enable any small business to accept bookings and payments via WhatsApp within 10 minutes of signup
- Monetize through tiered subscriptions plus per-transaction platform fees
- Expand to 5 countries with localized payment gateways and currencies
- Achieve zero-code setup: business owners configure entirely from a dashboard on their phone

## 3. Target Market

**Countries (5):** Nigeria (NGN/Paystack), Ghana (GHS/Paystack), United States (USD/Stripe), Canada (CAD/Stripe), United Kingdom (GBP/Stripe)

**Primary Persona:** Solo business owner, age 25-45, runs a salon/restaurant/church, manages everything on their phone, lives on WhatsApp. Limited technical skills.

**Secondary Persona:** Diaspora business owner in US/CA/UK serving WhatsApp-savvy communities.

**16 Industry Groups:**
1. Beauty & Wellness (salon, barber, spa, nail tech, MUA, tattoo, lash tech, medspa, waxing)
2. Health & Medical (clinic, dental, vet, therapy, optician, physiotherapy)
3. Food & Dining (restaurant, cafe, bar, lounge, bakery, catering, food truck)
4. Delivery & Retail (shop, online store, pharmacy, supermarket, boutique)
5. Home & Auto Services (plumber, electrician, mechanic, cleaner, car wash, HVAC, handyman, pest control, landscaping)
6. Professional Services (consultant, legal, accounting, financial advisor)
7. Hospitality (hotel, shortlet, Airbnb, car rental, B&B)
8. Events & Entertainment (event planner, cinema, music studio, concert venue)
9. Faith & Community (church, mosque, NGO, nonprofit)
10. Fitness (gym, yoga, pilates, dance, martial arts, crossfit, bootcamp)
11. Transport & Logistics (taxi, courier, bus/train, moving company)
12. Education & Training (school, tutor, language school, driving school, training academy)
13. Pet Services (dog walking, pet grooming, pet boarding, pet training)
14. Creative & Media (photographer, videographer, DJ, graphic designer, content creator)
15. Real Estate & Property (real estate agent, property manager, mortgage broker)
16. Government & Public (government office, utility company, parking authority)

## 4. Revenue Model

| Tier | Marketing Name | Monthly (US) | Annual (20% off) | Platform Fee |
|------|---------------|-------------|-----------------|-------------|
| Free | Starter | $0 | $0 | 2.5% |
| Mid | Pro | $39 | $23/mo | 1.5% |
| Top | Premium | $99 | $63/mo | 1.0% |

Country-specific pricing: NG Pro at ₦14,999/mo, GH Pro at GH₵149/mo, GB Pro at £24/mo, CA Pro at C$39/mo. All tiers include a 30-day trial with full feature access. Gateway processing fees (Stripe 2.9%+$0.30, Paystack 1.5%+₦100) are separate and borne by the business.

Revenue streams: subscription fees, per-transaction platform fees, WhatsApp conversation charges (passed through from Meta).

## 5. Competitive Landscape

| Competitor | Gap Waaiio Fills |
|-----------|-----------------|
| WATI | WhatsApp-only, no multi-industry, no native payments |
| ManyChat | Requires flow-building expertise, no payment processing |
| Square | POS generalist, no WhatsApp channel, no Africa |
| Fresha | Beauty vertical only |
| Toast | Restaurant vertical only |

**Waaiio differentiator:** Multi-industry (89 types) + WhatsApp-native payments + Africa-first + zero-code + 7 languages including Pidgin, Yoruba, Igbo, Hausa, Twi.

## 6. Key Business Rules

- Onboarding defaults to free tier; 30-day trial unlocks all features
- Platform fees recorded AFTER payment verification, never before
- Promo discounts apply to full service price, not deposit
- Loyalty/referral are opt-in only, never in category defaults
- Gateway follows the business's payment_gateway setting, not country default
- Confirmation dedup: confirmation_sent_at column ensures only first path sends
- Businesses with is_active=false are inaccessible on public pages
- Business creation capped at 20 per user account

## 7. Success Metrics (KPIs)

- Time to first booking (target: under 24 hours from signup)
- Monthly active businesses, booking completion rate, payment success rate
- Free-to-Pro conversion rate (target: 15-25%), churn rate by tier
- WhatsApp session completion rate, NLU intent accuracy
- Revenue per business (ARPU), platform fee collected

## 8. Compliance Requirements

- **CCPA** (California): data export API, 30-day grace deletion, "Do Not Sell" page
- **GDPR** (EU/UK): DPA, granular cookie consent, PostHog opt-out by default, breach notification template
- **NDPR** (Nigeria): data protection compliance for Nigerian users
- **UK GDPR**: separate compliance track for GB operations
- **Ghana DPA**: data protection for Ghanaian users
- Legal pages: Privacy Policy, Terms of Service, DPA, Acceptable Use Policy, Cookie Policy
- Data export: /api/account/export (rate limited 1/24hr), consent tracking via /api/account/consent
