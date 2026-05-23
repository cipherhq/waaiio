# Waaiio Category & Capability Specification
## Last Updated: 2026-05-23

## Architecture

**Industry Groups** (16) → **Business Types** (labels) → **Capabilities** (from group)

The group determines what capabilities a business gets. The specific business type is a label that customizes bot language, dashboard wording, and default services.

## Industry Groups

### 1. Beauty & Wellness
**Types:** Salon, Barber, Spa, Nail Tech, MUA, Tattoo, Lash Tech, Medspa, Waxing
**Capabilities:** appointment, payment, feedback, chat, staff, broadcast, reminders, auto_reply, packages
**Booking type:** appointment (customer picks person + time)

### 2. Health & Medical
**Types:** Clinic, Dental, Veterinary, Therapy, Optician, Physiotherapy
**Capabilities:** appointment, payment, feedback, chat, staff, queue, waitlist, reminders, reports, auto_reply
**Booking type:** appointment (patient picks doctor + time)
**Note:** forms capability available as opt-in toggle for intake forms

### 3. Food & Dining
**Types:** Restaurant, Cafe, Bar, Lounge, Bakery, Catering, Food Truck
**Capabilities:** table_reservation, ordering, payment, feedback, chat, waitlist, broadcast, auto_reply, multi_location
**Booking type:** table_reservation (party size + time) + ordering (menu/catalog)

### 4. Delivery & Retail
**Types:** Shop, Online Store, Pharmacy, Supermarket, Boutique
**Capabilities:** ordering, payment, feedback, chat, broadcast
**Booking type:** ordering (browse + cart + checkout)

### 5. Home & Auto Services
**Types:** Plumber, Electrician, Mechanic, Cleaner, Car Wash, HVAC, Handyman, Pest Control, Landscaping
**Capabilities:** scheduling, payment, invoice, feedback, chat, reminders, estimates
**Booking type:** scheduling (customer requests service, business assigns worker)

### 6. Professional Services
**Types:** Consultant, Legal, Accounting, Real Estate Agent, Financial Advisor
**Capabilities:** appointment, scheduling, payment, invoice, feedback, chat, reminders, recurring, whatsapp_sign
**Booking type:** appointment (meet person) + scheduling (do work)

### 7. Hospitality
**Types:** Hotel, Shortlet, Airbnb, Car Rental, Bed & Breakfast
**Capabilities:** reservation, payment, feedback, chat, waitlist, staff, broadcast, survey
**Booking type:** reservation (check-in/check-out dates)

### 8. Events & Entertainment
**Types:** Event Planner, Cinema, Music Studio, DJ, Concert Venue
**Capabilities:** ticketing, appointment, payment, invoice, feedback, chat, broadcast, waitlist, whatsapp_sign
**Booking type:** ticketing (buy tickets with QR) + appointment (book services)

### 9. Faith & Community
**Types:** Church, Mosque, NGO, Nonprofit, Community Center
**Capabilities:** giving, appointment, ticketing, payment, feedback, chat, broadcast, recurring, poll, crowdfunding
**Booking type:** giving (donations) + appointment (counseling) + ticketing (events)

### 10. Fitness
**Types:** Gym, Yoga Studio, Pilates, Dance Studio, Martial Arts, CrossFit, Bootcamp
**Capabilities:** appointment, scheduling, payment, feedback, chat, recurring, membership, auto_reply, class_booking, packages
**Booking type:** appointment (personal training) + class_booking (group classes) + packages (session bundles)

### 11. Transport & Logistics
**Types:** Taxi, Courier, Bus/Train, Moving Company, Shipping, Delivery Service
**Capabilities:** ticketing, payment, feedback, chat
**Booking type:** ticketing (book a trip) + payment (delivery fees)

### 12. Education & Training
**Types:** School, Tutor, Language School, Driving School, Training Academy, Bootcamp, Online Course
**Capabilities:** appointment, scheduling, payment, feedback, chat, recurring, broadcast, survey, class_booking
**Booking type:** appointment (1:1 lessons) + class_booking (group classes) + recurring (term fees)

### 13. Pet Services
**Types:** Dog Walking, Pet Grooming, Pet Boarding, Pet Training, Vet
**Capabilities:** appointment, scheduling, payment, feedback, chat, reminders
**Booking type:** appointment (grooming, vet) + scheduling (walking, boarding)

### 14. Creative & Media
**Types:** Photographer, Videographer, DJ, Graphic Designer, Content Creator, Music Producer
**Capabilities:** appointment, payment, invoice, whatsapp_sign, feedback, chat, estimates
**Booking type:** appointment (book session) + estimates (send quote for project)

### 15. Real Estate & Property
**Types:** Real Estate Agent, Property Manager, Mortgage Broker
**Capabilities:** appointment, payment, invoice, whatsapp_sign, feedback, chat, broadcast
**Booking type:** appointment (property viewing)

### 16. Government & Public
**Types:** Government Office, Embassy, Utility Company, Parking Authority
**Capabilities:** payment, queue, feedback, chat
**Booking type:** payment (fees/permits) + queue (walk-in service)

---

## New Capabilities to Build (4)

### estimates
- Send price quote to customer via WhatsApp
- Customer approves or declines
- Approved quote converts to booking/order
- Track quote history + conversion rate
- DB: quote_requests table already exists
- Groups: Home & Auto Services, Creative & Media

### packages
- Business creates packages: "10 Sessions for $200" (save 20%)
- Customer buys package via WhatsApp or web
- Each visit deducts 1 session
- Dashboard shows remaining sessions per customer
- DB: new packages + package_redemptions tables
- Groups: Beauty & Wellness, Fitness

### class_booking
- Business creates classes: "Yoga 6pm Mon/Wed/Fri — 20 spots"
- Customer signs up for a class (not a 1:1 appointment)
- Shows spots remaining
- Waitlist when full
- DB: reuse services table with is_class=true + max_capacity
- Groups: Fitness, Education & Training

### multi_location
- Business has 2+ branches
- Bot asks "Which location?" before booking
- Each location has own operating hours, staff, services
- Dashboard filters by location
- DB: locations table already exists, bot needs routing step
- Groups: Food & Dining (chain restaurants), any business with branches

---

## Opt-in Capabilities (not in any group default)
These are enabled manually by the business owner from dashboard:
- loyalty (points system)
- referral (refer-a-friend rewards)
- intake_forms (auto-send form after booking — toggle on forms capability)

---

## Migration Plan
1. Update CATEGORY_DEFAULT_CAPABILITIES to use group-based mapping
2. Update BUSINESS_CATEGORIES with new types + groups
3. Update onboarding to show 16 groups → pick specific type
4. Build 4 new capabilities (estimates, packages, class_booking, multi_location)
5. Build "Explore Features" page for capability discovery
