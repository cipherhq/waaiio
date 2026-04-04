/**
 * Seed script: Creates one test business per supported category
 * Run: npx tsx scripts/seed-test-businesses.ts
 *
 * Uses service role key from .env.local
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CATEGORIES = [
  { key: 'restaurant', flow: 'scheduling', name: 'Test Restaurant', code: 'test-resto' },
  { key: 'barber', flow: 'scheduling', name: 'Test Barbershop', code: 'test-barber' },
  { key: 'spa', flow: 'scheduling', name: 'Test Spa', code: 'test-spa' },
  { key: 'salon', flow: 'scheduling', name: 'Test Salon', code: 'test-salon' },
  { key: 'gym', flow: 'scheduling', name: 'Test Gym', code: 'test-gym' },
  { key: 'clinic', flow: 'scheduling', name: 'Test Clinic', code: 'test-clinic' },
  { key: 'consultant', flow: 'scheduling', name: 'Test Consultant', code: 'test-consult' },
  { key: 'church', flow: 'payment', name: 'Test Church', code: 'test-church' },
  { key: 'mosque', flow: 'payment', name: 'Test Mosque', code: 'test-mosque' },
  { key: 'school', flow: 'payment', name: 'Test School', code: 'test-school' },
  { key: 'ngo', flow: 'payment', name: 'Test NGO', code: 'test-ngo' },
  { key: 'shop', flow: 'ordering', name: 'Test Shop', code: 'test-shop' },
  { key: 'food_delivery', flow: 'ordering', name: 'Test Food Delivery', code: 'test-food' },
  { key: 'events', flow: 'ticketing', name: 'Test Events', code: 'test-events' },
  { key: 'transport', flow: 'ticketing', name: 'Test Transport', code: 'test-transport' },
  { key: 'cinema', flow: 'ticketing', name: 'Test Cinema', code: 'test-cinema' },
];

const DEFAULT_SERVICES: Record<string, Array<{ name: string; price: number; price_is_variable: boolean; duration_minutes: number | null; deposit_amount: number }>> = {
  restaurant: [
    { name: 'Table for 2', price: 5000, price_is_variable: false, duration_minutes: 90, deposit_amount: 2000 },
    { name: 'Table for 4', price: 10000, price_is_variable: false, duration_minutes: 120, deposit_amount: 5000 },
    { name: 'VIP Table', price: 25000, price_is_variable: false, duration_minutes: 120, deposit_amount: 10000 },
  ],
  barber: [
    { name: 'Regular Haircut', price: 3000, price_is_variable: false, duration_minutes: 30, deposit_amount: 1000 },
    { name: 'Beard Trim', price: 2000, price_is_variable: false, duration_minutes: 20, deposit_amount: 0 },
    { name: 'Full Grooming', price: 7000, price_is_variable: false, duration_minutes: 60, deposit_amount: 2000 },
  ],
  spa: [
    { name: 'Swedish Massage', price: 15000, price_is_variable: false, duration_minutes: 60, deposit_amount: 5000 },
    { name: 'Deep Tissue Massage', price: 20000, price_is_variable: false, duration_minutes: 90, deposit_amount: 7000 },
    { name: 'Facial Treatment', price: 12000, price_is_variable: false, duration_minutes: 45, deposit_amount: 5000 },
  ],
  salon: [
    { name: 'Braids', price: 10000, price_is_variable: false, duration_minutes: 120, deposit_amount: 3000 },
    { name: 'Wash & Set', price: 5000, price_is_variable: false, duration_minutes: 60, deposit_amount: 2000 },
    { name: 'Hair Coloring', price: 15000, price_is_variable: false, duration_minutes: 90, deposit_amount: 5000 },
  ],
  gym: [
    { name: 'Personal Training (1hr)', price: 8000, price_is_variable: false, duration_minutes: 60, deposit_amount: 3000 },
    { name: 'Group Class', price: 3000, price_is_variable: false, duration_minutes: 45, deposit_amount: 0 },
  ],
  clinic: [
    { name: 'General Consultation', price: 10000, price_is_variable: false, duration_minutes: 30, deposit_amount: 5000 },
    { name: 'Dental Checkup', price: 15000, price_is_variable: false, duration_minutes: 45, deposit_amount: 5000 },
  ],
  consultant: [
    { name: '30-min Consultation', price: 20000, price_is_variable: false, duration_minutes: 30, deposit_amount: 10000 },
    { name: '1-hour Session', price: 35000, price_is_variable: false, duration_minutes: 60, deposit_amount: 15000 },
  ],
  church: [
    { name: 'Tithe', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Offering', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Building Fund', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  mosque: [
    { name: 'Zakat', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Sadaqah', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  school: [
    { name: 'Tuition Fee', price: 50000, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
    { name: 'PTA Levy', price: 5000, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
    { name: 'Exam Fee', price: 10000, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
  ],
  ngo: [
    { name: 'Monthly Donation', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'One-time Gift', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  shop: [],
  food_delivery: [],
  events: [],
  transport: [],
  cinema: [],
};

async function seed() {
  // Get or create a test owner
  const testEmail = 'test@smrtrply.com';
  let ownerId: string;

  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  const existing = existingUsers?.users?.find(u => u.email === testEmail);

  if (existing) {
    ownerId = existing.id;
    console.log(`Using existing test user: ${ownerId}`);
  } else {
    const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
      email: testEmail,
      password: 'test1234',
      email_confirm: true,
    });
    if (createErr || !newUser.user) {
      console.error('Failed to create test user:', createErr);
      process.exit(1);
    }
    ownerId = newUser.user.id;
    console.log(`Created test user: ${ownerId}`);
  }

  for (const cat of CATEGORIES) {
    // Check if already exists
    const { data: existingBiz } = await supabase
      .from('businesses')
      .select('id, bot_code')
      .eq('bot_code', cat.code)
      .maybeSingle();

    if (existingBiz) {
      console.log(`  [skip] ${cat.name} already exists (${cat.code})`);
      continue;
    }

    const { data: business, error: bizErr } = await supabase
      .from('businesses')
      .insert({
        owner_id: ownerId,
        name: cat.name,
        slug: cat.code,
        bot_code: cat.code,
        city: 'lagos',
        neighborhood: 'Victoria Island',
        address: '1 Test Street, VI, Lagos',
        phone: '+2348012345678',
        category: cat.key,
        flow_type: cat.flow,
        country_code: 'NG',
        subscription_tier: 'business',
        status: 'active',
        trial_ends_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    if (bizErr || !business) {
      console.error(`  [error] ${cat.name}:`, bizErr?.message);
      continue;
    }

    // Create whatsapp config
    await supabase.from('whatsapp_config').insert({
      business_id: business.id,
      bot_greeting: `Welcome to ${cat.name}! How can I help you today?`,
      auto_confirm: true,
    });

    // Create default services
    const services = DEFAULT_SERVICES[cat.key] || [];
    if (services.length > 0) {
      await supabase.from('services').insert(
        services.map((s, i) => ({
          business_id: business.id,
          name: s.name,
          price: s.price,
          price_is_variable: s.price_is_variable,
          duration_minutes: s.duration_minutes,
          deposit_amount: s.deposit_amount,
          sort_order: i,
        })),
      );
    }

    // Create sample products for shop/food_delivery
    if (cat.key === 'shop') {
      await supabase.from('products').insert([
        { business_id: business.id, name: 'T-Shirt', price: 5000, category: 'Clothing', stock_quantity: 50, sort_order: 0 },
        { business_id: business.id, name: 'Sneakers', price: 25000, category: 'Footwear', stock_quantity: 20, sort_order: 1 },
        { business_id: business.id, name: 'Cap', price: 3000, category: 'Accessories', stock_quantity: 100, sort_order: 2 },
      ]);
    }

    if (cat.key === 'food_delivery') {
      await supabase.from('products').insert([
        { business_id: business.id, name: 'Jollof Rice + Chicken', price: 3500, category: 'Main', sort_order: 0 },
        { business_id: business.id, name: 'Fried Rice + Turkey', price: 4000, category: 'Main', sort_order: 1 },
        { business_id: business.id, name: 'Shawarma', price: 2500, category: 'Snacks', sort_order: 2 },
        { business_id: business.id, name: 'Chapman', price: 1500, category: 'Drinks', sort_order: 3 },
      ]);
    }

    // Create sample events for events/cinema/transport
    if (['events', 'cinema', 'transport'].includes(cat.key)) {
      const eventData = cat.key === 'cinema'
        ? [
            { business_id: business.id, name: 'Black Panther 3', date: '2026-04-15', time: '18:00', venue: 'Screen 1', total_tickets: 100, price: 5000, status: 'published' },
            { business_id: business.id, name: 'Avengers: Secret Wars', date: '2026-04-20', time: '20:00', venue: 'Screen 2', total_tickets: 80, price: 7000, status: 'published' },
          ]
        : cat.key === 'transport'
        ? [
            { business_id: business.id, name: 'Lagos → Abuja (Morning)', date: '2026-04-10', time: '07:00', venue: 'Jibowu Terminal', total_tickets: 50, price: 15000, status: 'published' },
            { business_id: business.id, name: 'Lagos → Ibadan (Afternoon)', date: '2026-04-10', time: '14:00', venue: 'Jibowu Terminal', total_tickets: 50, price: 5000, status: 'published' },
          ]
        : [
            { business_id: business.id, name: 'Afrobeats Night', date: '2026-04-18', time: '20:00', venue: 'Eko Hotel', total_tickets: 500, price: 10000, status: 'published' },
            { business_id: business.id, name: 'Comedy Show', date: '2026-04-25', time: '19:00', venue: 'Terra Kulture', total_tickets: 200, price: 7500, status: 'published' },
          ];

      await supabase.from('events').insert(eventData);
    }

    console.log(`  [ok] ${cat.name} → bot_code: ${cat.code} (${cat.flow})`);
  }

  console.log('\n--- Test Bot Codes ---');
  console.log('Scheduling: test-resto, test-barber, test-spa, test-salon, test-gym, test-clinic, test-consult');
  console.log('Payment:    test-church, test-mosque, test-school, test-ngo');
  console.log('Ordering:   test-shop, test-food');
  console.log('Ticketing:  test-events, test-transport, test-cinema');
  console.log('\nOr use "switch <keyword>" in WhatsApp to swap between businesses!');
  console.log('Test login: test@smrtrply.com / test1234');
}

seed().catch(console.error);
