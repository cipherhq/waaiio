# Waaiio 32-Capability Certification Matrix

Generated from `shared/capabilities.ts` canonical registry + `CAPABILITY_TIER_REQUIREMENTS`.

## Matrix

| # | Capability ID | Canonical Label | Tier | Dashboard Path | WhatsApp Path | Expected State | Payment | Edge Case | UX Checkpoint |
|---|---------------|----------------|------|----------------|---------------|----------------|---------|-----------|---------------|
| 1 | `appointment` | Appointments | Free | /dashboard/appointments-management | Customer picks date/time/staff | `bookings` row | Deposit | Double-booking, staff unavailable | Calendar, detail |
| 2 | `scheduling` | Services | Free | /dashboard/services | Customer requests service | `services`, `bookings` | Optional deposit | Service inactive | Service list |
| 3 | `payment` | Payments | Free | /dashboard/payment-request | Customer receives payment link | `payments` row | Direct payment | Failed payment, expired link | Payment list |
| 4 | `ordering` | Online Store | Free | /dashboard/products | Customer browses, orders | `orders`, `order_items` | Full/deposit | Out of stock, cancelled | Product list, order detail |
| 5 | `ticketing` | Ticketing | Free | /dashboard/events | Customer buys tickets | `event_tickets`, QR | Ticket payment | Sold out | Event detail, check-in |
| 6 | `giving` | Giving | Free | /dashboard/giving | Supporter gives via WhatsApp | Service-based giving | Donation | Recurring giving | Giving options |
| 7 | `chat` | Chat | Free | /dashboard/chat | Customer sends message | Chat messages | N/A | Unread messages | Chat interface |
| 8 | `feedback` | Reviews | Free | /dashboard/feedback | Customer rates service | `feedback` rows | N/A | No feedback | Feedback list |
| 9 | `poll` | Polls | Free | /dashboard/polls | Customer votes | `poll_votes` | N/A | Poll closed | Poll results |
| 10 | `reservation` | Reservations | Pro | /dashboard/properties | Customer picks dates | `reservations` | Deposit/full | Date conflict | Property list |
| 11 | `table_reservation` | Table Reservations | Free | /dashboard/reservations | Customer reserves table | `reservations` | Optional deposit | Full capacity | Reservation list |
| 12 | `recurring` | Subscriptions | Pro | /dashboard/recurring | Customer subscribes | `subscriptions` | Recurring charge | Failed renewal, cancel | Subscription list |
| 13 | `broadcast` | Broadcasts | Pro | /dashboard/broadcasts | All customers receive | `broadcast_messages` | N/A | Failed delivery, rate limit | Broadcast editor |
| 14 | `membership` | Loyalty Tiers | Pro | /dashboard/membership | Auto-upgrade | `membership_tiers` | Tier discounts | Downgrade | Tier display |
| 15 | `survey` | Surveys | Pro | /dashboard/surveys | Customer answers | `survey_responses` | N/A | Incomplete | Survey builder |
| 16 | `invoice` | Invoices | Pro | /dashboard/invoices | Customer receives invoice | `invoices` | Invoice payment | Partial, overdue | Invoice detail |
| 17 | `auto_reply` | Auto-Reply | Pro | Settings → hours | Auto-sent outside hours | Auto-reply sent | N/A | Wrong timezone | Hours config |
| 18 | `loyalty` | Loyalty | Pro | /dashboard/loyalty | Points earned | `loyalty_points` | Points-to-discount | Insufficient points | Points history |
| 19 | `referral` | Referral | Pro | /dashboard/referrals | Customer shares code | `referrals` | Referral reward | Self-referral | Referral dashboard |
| 20 | `reminders` | Reminders | Pro | Settings → enable | Auto-sent before bookings | Reminder sent | N/A | Failed delivery | Reminder settings |
| 21 | `staff` | Staff | Premium | /dashboard/staff | Customer selects staff | `business_staff` | N/A | Staff unavailable | Staff list |
| 22 | `whatsapp_sign` | E-Signatures | Premium | /dashboard/contracts | Customer signs document | `contracts`, `signers` | N/A | Expired, invalid OTP | Contract list |
| 23 | `reports` | Documents | Premium | /dashboard/reports | N/A (business-only) | Report data | N/A | Empty data | Report filters |
| 24 | `waitlist` | Waitlist | Premium | /dashboard/waitlist | Customer joins waitlist | `waitlist_entries` | N/A | Auto-notification | Waitlist display |
| 25 | `queue` | Queue | Premium | /dashboard/queue | Walk-in checks in | `queue_entries` | N/A | Queue full | Queue display |
| 26 | `crowdfunding` | Campaigns | Premium | /dashboard/campaigns | Donors contribute | `campaign_donations` | Donation | Goal reached | Campaign detail |
| 27 | `estimates` | Estimates & Quotes | Free | /dashboard/orders/quotes | Customer requests quote | `quote_requests` | Quote → order | Expired, rejected | Quote detail |
| 28 | `packages` | Session Packages | Pro | /dashboard/packages | Customer buys package | VERIFY | Package payment | Package expired | VERIFY |
| 29 | `class_booking` | Class Booking | Pro | /dashboard/classes | Customer books class | `class_sessions`, `bookings` | Class payment | Class full | Class schedule |
| 30 | `multi_location` | Multi-Location | Pro | /dashboard/locations | Customer selects location | `business_locations` | N/A | Location inactive | Location list |
| 31 | `waiver` | Waivers | Pro | /dashboard/waivers | Customer signs waiver | `waivers`, `signatures` | N/A | Expired, declined | Waiver list |
| 32 | `promo_verification` | Promotions | Pro | /dashboard/promotions | Customer submits code | `promo_campaigns`, `promo_redemptions` | N/A | Max wins, invalid code | Campaign detail |

## Certification Status

- [ ] All 32 capabilities dashboard-verified
- [ ] All applicable WhatsApp flows verified
- [ ] All payment paths sandbox-verified
- [ ] All edge cases documented
- [ ] All UX checkpoints reviewed
