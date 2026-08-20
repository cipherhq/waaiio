# Waaiio 32-Capability Certification Matrix

Generated from `shared/capabilities.ts` canonical capability registry.

Every capability must be verified during production-readiness acceptance.

## Matrix

| # | Capability ID | Label | Tier | Dashboard Setup Path | Customer/WhatsApp Path | Expected Persisted State | Expected Business Result | Payment Implication | Failure/Edge Case | UX Checkpoint |
|---|---------------|-------|------|---------------------|----------------------|-------------------------|------------------------|--------------------|--------------------|---------------|
| 1 | `scheduling` | On-Demand Services | Free | /dashboard/services → create service | Customer requests service via WhatsApp | `services` row, `bookings` row | Booking visible in dashboard | Optional deposit/payment | No available slots, service inactive | Service list, booking confirmation |
| 2 | `appointment` | Book Appointments | Free | /dashboard/appointments-management → create | Customer picks date/time/staff | `bookings` row with date/time/staff | Booking in calendar + reservations | Deposit required | Double-booking, staff unavailable | Calendar view, appointment detail |
| 3 | `payment` | Accept Payments | Free | /dashboard/payment-request → create | Customer receives payment link | `payments` row (pending→success) | Payment received notification | Direct payment collection | Failed payment, expired link | Payment request list, status badge |
| 4 | `ordering` | Take Orders | Free | /dashboard/products → create products | Customer browses menu, adds to cart | `orders` row, `order_items` rows | Order in orders list | Full payment or deposit | Out of stock, cancelled order | Product list, order detail, stock |
| 5 | `ticketing` | Sell Tickets | Free | /dashboard/events → create event | Customer buys tickets | `event_tickets` rows, QR codes | Ticket sales in dashboard | Ticket payment | Sold out, invalid QR | Event detail, ticket list, check-in |
| 6 | `reservation` | Book Stays/Rentals | Free | /dashboard/properties → create property | Customer picks check-in/out dates | `reservations` row | Reservation in dashboard | Deposit/full payment | Date conflict, unavailable | Property list, reservation detail |
| 7 | `table_reservation` | Make Reservations | Free | /dashboard/reservations → configure | Customer reserves table with party size | `reservations` row | Reservation visible | Optional deposit | Full capacity, time conflict | Table layout, reservation list |
| 8 | `whatsapp_sign` | E-Signatures | Growth | /dashboard/contracts → create contract | Customer receives document link | `contracts` row, `contract_signers` | Signed document | N/A | Expired link, invalid OTP | Contract list, signature status |
| 9 | `reminders` | Reminders | Free | Settings → enable | Auto-sent before bookings | Reminder sent via WhatsApp | Reduced no-shows | N/A | Failed delivery | Reminder settings |
| 10 | `crowdfunding` | Run Campaigns | Free | /dashboard/campaigns → create | Donors contribute | `campaign_donations` rows | Campaign progress | Donation payment | Goal reached, campaign ended | Campaign detail, donor list |
| 11 | `reports` | Documents | Free | /dashboard/reports → view | N/A (business-only) | Report data | Downloadable reports | N/A | Empty data | Report filters, export |
| 12 | `queue` | Queue Management | Free | /dashboard/queue → configure | Walk-in customers check in | `queue_entries` rows | Queue visible in dashboard | N/A | Queue full | Queue display, turn notification |
| 13 | `feedback` | Reviews | Free | /dashboard/feedback → view | Customer rates after service | `feedback` rows | Reviews in dashboard | N/A | No feedback submitted | Feedback list, rating display |
| 14 | `loyalty` | Loyalty | Growth | /dashboard/loyalty → configure | Points earned on purchase | `loyalty_points` rows | Points balance visible | Points-to-discount | Insufficient points | Points history, rewards |
| 15 | `chat` | Live Chat | Free | /dashboard/chat → view conversations | Customer sends free-form message | `messages` in chat context | Conversation in chat list | N/A | Unread messages | Chat interface, read receipts |
| 16 | `waitlist` | Waitlist | Free | /dashboard/waitlist → configure | Customer joins waitlist | `waitlist_entries` rows | Waitlist in dashboard | N/A | Auto-notification on availability | Waitlist display, notification |
| 17 | `referral` | Referrals | Growth | /dashboard/referrals → configure | Customer shares referral code | `referrals` rows | Referral tracking | Referral reward | Invalid code, self-referral | Referral dashboard |
| 18 | `staff` | Staff Management | Free | /dashboard/staff → add staff | Customer selects staff member | `business_staff` rows | Staff schedule visible | N/A | Staff unavailable | Staff list, schedule |
| 19 | `invoice` | Send Invoices | Free | /dashboard/invoices → create | Customer receives invoice link | `invoices` row | Invoice in list | Invoice payment | Partial payment, overdue | Invoice detail, payment status |
| 20 | `survey` | Surveys | Free | /dashboard/surveys → create | Customer answers survey | `survey_responses` rows | Responses in dashboard | N/A | Incomplete survey | Survey builder, results |
| 21 | `poll` | Polls | Free | /dashboard/polls → create | Customer votes | `poll_votes` rows | Results in dashboard | N/A | Poll closed | Poll results, voting |
| 22 | `giving` | Collect Donations | Free | /dashboard/giving → create | Supporter gives via WhatsApp | `donations` or service-based | Giving dashboard | Donation payment | Recurring giving | Giving options, donor list |
| 23 | `broadcast` | Broadcast Messages | Growth | /dashboard/broadcasts → create | All customers receive message | `broadcast_messages` rows | Delivery stats | N/A | Failed delivery, rate limits | Broadcast editor, delivery report |
| 24 | `recurring` | Subscriptions | Growth | /dashboard/recurring → configure | Customer subscribes | `subscriptions` rows | Active subscriptions | Recurring charge | Failed renewal, cancellation | Subscription list, billing |
| 25 | `auto_reply` | Auto-Reply | Free | Settings → business hours | Customer messages outside hours | Auto-reply sent | Reduced missed messages | N/A | Incorrect timezone | Business hours config |
| 26 | `membership` | Membership Tiers | Growth | /dashboard/membership → configure | Customer auto-upgraded | `membership_tiers`, `customer_memberships` | Tier status visible | Tier-based discounts | Tier downgrade | Tier display, benefits |
| 27 | `estimates` | Quotes/Estimates | Growth | /dashboard/orders/quotes → view | Customer requests quote | `quote_requests` rows | Quote in dashboard | Quote acceptance → order | Quote expired, rejected | Quote detail, acceptance flow |
| 28 | `packages` | Packages | Free | /dashboard/packages → create | Customer buys package | `packages` rows | Package sales | Package payment | Package expired | Package list, redemption |
| 29 | `class_booking` | Classes | Free | /dashboard/classes → create | Customer books class spot | `class_sessions`, `bookings` | Class roster visible | Class payment | Class full, cancelled | Class schedule, roster |
| 30 | `multi_location` | Locations | Growth | /dashboard/locations → add | Customer selects location | `business_locations` rows | Multi-location dashboard | N/A | Location inactive | Location list, switcher |
| 31 | `waiver` | Waivers | Free | /dashboard/waivers → create | Customer signs waiver | `waivers`, `waiver_signatures` | Signed waiver visible | N/A | Expired, declined | Waiver list, signature status |
| 32 | `promo_verification` | Promotions | Growth | /dashboard/promotions → create | Customer submits promo code | `promo_campaigns`, `promo_redemptions` | Winners in dashboard | N/A | Max wins, invalid code, locked | Campaign detail, winner queue, fulfillment |

## Certification Status

- [ ] All 32 capabilities dashboard-verified
- [ ] All applicable WhatsApp flows verified
- [ ] All payment paths sandbox-verified
- [ ] All edge cases documented
- [ ] All UX checkpoints reviewed
