'use client';

import { useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { useRouter } from 'next/navigation';

interface ServiceItem {
  name: string;
  price: number;
  duration_minutes: number;
  deposit_amount: number;
  description: string;
}

interface ProductItem {
  name: string;
  price: number;
  description: string;
  category: string;
}

interface OperatingHours {
  [day: string]: { open?: string; close?: string; closed?: boolean };
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

// Category-aware labels
const CATEGORY_CONFIG: Record<string, { itemLabel: string; itemPlural: string; priceLabel: string; durationLabel: string; examples: string; hoursPresets: { label: string; hours: OperatingHours }[] }> = {
  church: {
    itemLabel: 'Service / Gathering',
    itemPlural: 'Services & Gatherings',
    priceLabel: 'Fee',
    durationLabel: 'Duration (min)',
    examples: 'e.g., Sunday Worship, Midweek Service, Bible Study, Prayer Meeting',
    hoursPresets: [
      { label: 'Sunday only', hours: { monday: { closed: true }, tuesday: { closed: true }, wednesday: { closed: true }, thursday: { closed: true }, friday: { closed: true }, saturday: { closed: true }, sunday: { open: '08:00', close: '14:00' } } },
      { label: 'Sun + Midweek', hours: { monday: { closed: true }, tuesday: { closed: true }, wednesday: { open: '17:00', close: '20:00' }, thursday: { closed: true }, friday: { closed: true }, saturday: { closed: true }, sunday: { open: '08:00', close: '14:00' } } },
      { label: 'Multiple days', hours: { monday: { closed: true }, tuesday: { open: '17:00', close: '20:00' }, wednesday: { open: '17:00', close: '20:00' }, thursday: { closed: true }, friday: { open: '18:00', close: '21:00' }, saturday: { closed: true }, sunday: { open: '08:00', close: '14:00' } } },
    ],
  },
  mosque: {
    itemLabel: 'Prayer / Program',
    itemPlural: 'Prayers & Programs',
    priceLabel: 'Fee',
    durationLabel: 'Duration (min)',
    examples: 'e.g., Jummah Prayer, Quran Class, Ramadan Tafsir',
    hoursPresets: [
      { label: 'Friday only', hours: { monday: { closed: true }, tuesday: { closed: true }, wednesday: { closed: true }, thursday: { closed: true }, friday: { open: '12:00', close: '15:00' }, saturday: { closed: true }, sunday: { closed: true } } },
      { label: 'Daily prayers', hours: { monday: { open: '05:00', close: '21:00' }, tuesday: { open: '05:00', close: '21:00' }, wednesday: { open: '05:00', close: '21:00' }, thursday: { open: '05:00', close: '21:00' }, friday: { open: '05:00', close: '21:00' }, saturday: { open: '05:00', close: '21:00' }, sunday: { open: '05:00', close: '21:00' } } },
    ],
  },
  ngo: {
    itemLabel: 'Program / Initiative',
    itemPlural: 'Programs & Initiatives',
    priceLabel: 'Fee',
    durationLabel: 'Duration (min)',
    examples: 'e.g., Youth Empowerment Program, Community Outreach, Skills Workshop',
    hoursPresets: [
      { label: 'Mon-Fri 9am-5pm', hours: { monday: { open: '09:00', close: '17:00' }, tuesday: { open: '09:00', close: '17:00' }, wednesday: { open: '09:00', close: '17:00' }, thursday: { open: '09:00', close: '17:00' }, friday: { open: '09:00', close: '17:00' }, saturday: { closed: true }, sunday: { closed: true } } },
      { label: 'Mon-Sat 9am-5pm', hours: { monday: { open: '09:00', close: '17:00' }, tuesday: { open: '09:00', close: '17:00' }, wednesday: { open: '09:00', close: '17:00' }, thursday: { open: '09:00', close: '17:00' }, friday: { open: '09:00', close: '17:00' }, saturday: { open: '09:00', close: '17:00' }, sunday: { closed: true } } },
    ],
  },
  crowdfunding_org: {
    itemLabel: 'Campaign / Cause',
    itemPlural: 'Campaigns & Causes',
    priceLabel: 'Goal',
    durationLabel: 'Duration (days)',
    examples: 'e.g., School Building Fund, Medical Support, Community Project',
    hoursPresets: [
      { label: 'Always open', hours: { monday: { open: '00:00', close: '23:59' }, tuesday: { open: '00:00', close: '23:59' }, wednesday: { open: '00:00', close: '23:59' }, thursday: { open: '00:00', close: '23:59' }, friday: { open: '00:00', close: '23:59' }, saturday: { open: '00:00', close: '23:59' }, sunday: { open: '00:00', close: '23:59' } } },
    ],
  },
  default: {
    itemLabel: 'Service',
    itemPlural: 'Services',
    priceLabel: 'Price',
    durationLabel: 'Duration (min)',
    examples: 'e.g., Haircut, Consultation, Basic Package',
    hoursPresets: [
      { label: 'Mon-Fri 9am-5pm', hours: { monday: { open: '09:00', close: '17:00' }, tuesday: { open: '09:00', close: '17:00' }, wednesday: { open: '09:00', close: '17:00' }, thursday: { open: '09:00', close: '17:00' }, friday: { open: '09:00', close: '17:00' }, saturday: { closed: true }, sunday: { closed: true } } },
      { label: 'Mon-Sat 9am-7pm', hours: { monday: { open: '09:00', close: '19:00' }, tuesday: { open: '09:00', close: '19:00' }, wednesday: { open: '09:00', close: '19:00' }, thursday: { open: '09:00', close: '19:00' }, friday: { open: '09:00', close: '19:00' }, saturday: { open: '09:00', close: '19:00' }, sunday: { closed: true } } },
      { label: 'Every day 8am-10pm', hours: { monday: { open: '08:00', close: '22:00' }, tuesday: { open: '08:00', close: '22:00' }, wednesday: { open: '08:00', close: '22:00' }, thursday: { open: '08:00', close: '22:00' }, friday: { open: '08:00', close: '22:00' }, saturday: { open: '08:00', close: '22:00' }, sunday: { open: '08:00', close: '22:00' } } },
    ],
  },
};

type Step = 'what' | 'items' | 'hours' | 'greeting' | 'review';

export default function SetupAssistantPage() {
  const business = useBusiness();
  const router = useRouter();
  const cat = business.category || 'other';
  const config = CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.default;

  const faithBased = ['church', 'mosque'].includes(cat);
  const nonProfit = ['ngo', 'crowdfunding_org'].includes(cat);
  const noProductCategory = faithBased || nonProfit; // These categories never sell products
  const foodBased = ['restaurant', 'food_delivery', 'catering'].includes(cat);
  const retailBased = ['shop', 'instagram_vendor', 'mall_vendor', 'pharmacy'].includes(cat);

  // Wizard step
  const [step, setStep] = useState<Step>('what');
  const [businessType, setBusinessType] = useState<'services' | 'products' | 'both' | null>(
    faithBased ? 'services' : foodBased || retailBased ? 'products' : null
  );

  // Items
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [freeTextItems, setFreeTextItems] = useState('');
  const [parsingText, setParsingText] = useState(false);

  // Hours
  const [hours, setHours] = useState<OperatingHours>({});

  // Greeting
  const [greeting, setGreeting] = useState('');

  // Image upload
  const [parsing, setParsing] = useState(false);

  // Apply
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  // ── Step 1: What type of business ──
  const handleBusinessType = (type: 'services' | 'products' | 'both') => {
    setBusinessType(type);
    setStep('items');
  };

  // ── Add item manually ──
  const addService = () => setServices([...services, { name: '', price: 0, duration_minutes: 30, deposit_amount: 0, description: '' }]);
  const addProduct = () => setProducts([...products, { name: '', price: 0, description: '', category: '' }]);

  // ── Parse free text with AI (ONE call) ──
  const parseTextWithAI = async () => {
    if (!freeTextItems.trim()) return;
    setParsingText(true);
    try {
      const res = await fetch('/api/ai-setup/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          message: `Here are my ${businessType === 'products' ? 'products' : 'services'}: ${freeTextItems}`,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.suggestion?.services?.length) {
          setServices(prev => [...prev, ...data.suggestion.services.map((s: ServiceItem) => ({
            name: s.name || '', price: s.price || 0, duration_minutes: s.duration_minutes || 30,
            deposit_amount: s.deposit_amount || 0, description: s.description || '',
          }))]);
        }
        if (data.suggestion?.products?.length) {
          setProducts(prev => [...prev, ...data.suggestion.products.map((p: ProductItem) => ({
            name: p.name || '', price: p.price || 0, description: p.description || '', category: p.category || '',
          }))]);
        }
        setFreeTextItems('');
      } else {
        alert('Ace couldn\'t process that text. Try rephrasing or add items manually.');
      }
    } catch {
      alert('Something went wrong. Please try again.');
    }
    setParsingText(false);
  };

  // ── Image upload → AI extracts items ──
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('business_id', business.id);
    formData.append('type', businessType === 'products' ? 'products' : 'services');
    try {
      const res = await fetch('/api/ai-setup/parse-image', { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json();
        const items = data.items || [];
        if (data.type === 'products' || businessType === 'products') {
          setProducts(prev => [...prev, ...items.map((item: Record<string, unknown>) => ({
            name: (item.name as string) || '', price: (item.price as number) || 0,
            description: (item.description as string) || '', category: (item.category as string) || '',
          }))]);
        } else {
          setServices(prev => [...prev, ...items.map((item: Record<string, unknown>) => ({
            name: (item.name as string) || '', price: (item.price as number) || 0,
            duration_minutes: (item.duration_minutes as number) || 30, deposit_amount: 0,
            description: (item.description as string) || '',
          }))]);
        }
      } else {
        alert('Ace couldn\'t read that image. Try a clearer photo or add items manually.');
      }
    } catch {
      alert('Something went wrong reading the image. Please try again.');
    }
    setParsing(false);
    e.target.value = '';
  };

  // ── Apply setup ──
  const handleApply = async () => {
    setApplying(true);
    try {
      const payload: Record<string, unknown> = { business_id: business.id };
      if (services.length > 0) payload.services = services.filter(s => s.name.trim());
      if (products.length > 0) payload.products = products.filter(p => p.name.trim());
      if (Object.keys(hours).length > 0) payload.operating_hours = hours;
      if (greeting.trim()) payload.greeting = greeting.trim();
      const res = await fetch('/api/ai-setup/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setApplied(true);
      } else {
        alert('Failed to apply setup. Please try again.');
      }
    } catch {
      alert('Something went wrong. Please try again.');
    }
    setApplying(false);
  };

  const totalItems = services.filter(s => s.name.trim()).length + products.filter(p => p.name.trim()).length;

  // ── Success ──
  if (applied) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Setup Complete!</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-1">
            Created {totalItems} item{totalItems !== 1 ? 's' : ''}
            {Object.keys(hours).length > 0 ? ', set operating hours' : ''}
            {greeting ? ', and configured your bot greeting' : ''}.
          </p>
          <p className="text-sm text-gray-400 mb-6">Your WhatsApp bot is ready to go.</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => router.push('/dashboard/services')} className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">View Services</button>
            <button onClick={() => router.push('/dashboard')} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">Dashboard</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Ace AI Assistant</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {step === 'what' && 'Let\'s get your WhatsApp bot set up.'}
            {step === 'items' && `Add your ${businessType === 'products' ? 'products' : config.itemPlural.toLowerCase()}.`}
            {step === 'hours' && 'Set your operating hours.'}
            {step === 'greeting' && 'Customize your bot\'s greeting message.'}
            {step === 'review' && 'Review everything before we create it.'}
          </p>
        </div>
        <button onClick={() => router.push('/dashboard')} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Skip</button>
      </div>

      {/* Progress */}
      <div className="flex gap-1">
        {['what', 'items', 'hours', 'greeting', 'review'].map((s, i) => (
          <div key={s} className={`h-1.5 flex-1 rounded-full ${
            ['what', 'items', 'hours', 'greeting', 'review'].indexOf(step) >= i
              ? 'bg-black dark:bg-white' : 'bg-gray-200 dark:bg-gray-700'
          }`} />
        ))}
      </div>

      {/* ══════════ Step 1: What type ══════════ */}
      {step === 'what' && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">What does {business.name} do?</h2>
          <div className="space-y-2">
            {faithBased ? (
              <>
                <StepButton label={`We hold ${cat === 'mosque' ? 'prayers & programs' : 'services & gatherings'}`} onClick={() => handleBusinessType('services')} />
                <StepButton label={`We collect ${cat === 'mosque' ? 'Zakat, Sadaqah, or donations' : 'tithes, offerings, or donations'}`} onClick={() => handleBusinessType('services')} />
                <StepButton label={`Both — ${cat === 'mosque' ? 'prayers & donations' : 'services & tithes/offerings'}`} onClick={() => handleBusinessType('services')} />
              </>
            ) : nonProfit ? (
              <>
                <StepButton label="We run programs and initiatives" onClick={() => handleBusinessType('services')} />
                <StepButton label="We collect donations and contributions" onClick={() => handleBusinessType('services')} />
                <StepButton label="Both — programs and donations" onClick={() => handleBusinessType('services')} />
              </>
            ) : (
              <>
                <StepButton label="We offer services (appointments, consultations, treatments)" onClick={() => handleBusinessType('services')} />
                <StepButton label="We sell products (food, retail, online store)" onClick={() => handleBusinessType('products')} />
                <StepButton label="Both — services and products" onClick={() => handleBusinessType('both')} />
              </>
            )}
          </div>
        </div>
      )}

      {/* ══════════ Step 2: Add items ══════════ */}
      {step === 'items' && (
        <div className="space-y-4">
          {/* Services section */}
          {(businessType === 'services' || businessType === 'both') && (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{config.itemPlural} ({services.length})</h3>
                <button onClick={addService} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ Add manually</button>
              </div>
              <p className="text-xs text-gray-400">{config.examples}</p>

              {services.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={s.name} onChange={e => { const c = [...services]; c[i] = { ...c[i], name: e.target.value }; setServices(c); }}
                    placeholder={config.itemLabel} className="flex-1 text-sm border border-gray-200 rounded px-2 py-1.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                  <input type="number" value={s.price || ''} onChange={e => { const c = [...services]; c[i] = { ...c[i], price: Number(e.target.value) }; setServices(c); }}
                    placeholder={config.priceLabel} className="w-20 text-sm border border-gray-200 rounded px-2 py-1.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                  <input type="number" value={s.duration_minutes || ''} onChange={e => { const c = [...services]; c[i] = { ...c[i], duration_minutes: Number(e.target.value) }; setServices(c); }}
                    placeholder="Min" title={config.durationLabel} className="w-16 text-sm border border-gray-200 rounded px-2 py-1.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                  <button onClick={() => setServices(services.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Products section */}
          {(businessType === 'products' || businessType === 'both') && (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Products ({products.length})</h3>
                <button onClick={addProduct} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ Add manually</button>
              </div>

              {products.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={p.name} onChange={e => { const c = [...products]; c[i] = { ...c[i], name: e.target.value }; setProducts(c); }}
                    placeholder="Product name" className="flex-1 text-sm border border-gray-200 rounded px-2 py-1.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                  <input type="number" value={p.price || ''} onChange={e => { const c = [...products]; c[i] = { ...c[i], price: Number(e.target.value) }; setProducts(c); }}
                    placeholder="Price" className="w-20 text-sm border border-gray-200 rounded px-2 py-1.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                  <button onClick={() => setProducts(products.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Paste text → AI extracts */}
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-4 space-y-3">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Paste your list and let Ace extract it
            </p>
            <textarea
              value={freeTextItems}
              onChange={e => setFreeTextItems(e.target.value)}
              rows={3}
              placeholder={
                faithBased
                  ? `Paste your schedule here, e.g.:\nSunday Worship - 9am\nMidweek Service - Wednesday 6pm\nBible Study - Friday 5pm`
                  : nonProfit
                  ? `Paste your programs here, e.g.:\nYouth Empowerment Program\nCommunity Outreach\nSkills Workshop - $5`
                  : businessType === 'products'
                  ? `Paste your product list here, e.g.:\nJollof Rice - 2500\nPepper Soup - 1500\nChapman - 800`
                  : `Paste your ${config.itemPlural.toLowerCase()} here, e.g.:\nHaircut - $15\nBeard trim - $10\nKids cut - $12`
              }
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
            <button
              onClick={parseTextWithAI}
              disabled={parsingText || !freeTextItems.trim()}
              className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
            >
              {parsingText ? 'Ace is reading...' : 'Extract with Ace'}
            </button>
          </div>

          {/* Upload image → AI extracts (hidden for faith-based and non-profit) */}
          {!noProductCategory && (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Or upload a photo of your {businessType === 'products' ? 'product catalog' : 'price list'}
            </p>
            <label className="flex items-center justify-center gap-2 cursor-pointer rounded-lg border border-gray-200 dark:border-gray-600 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
              <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" disabled={parsing} />
              {parsing ? (
                <span className="text-sm text-gray-500">Ace is reading your image...</span>
              ) : (
                <>
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-sm text-gray-500">Click to upload photo</span>
                </>
              )}
            </label>
          </div>
          )}

          <div className="flex justify-between">
            <button onClick={() => setStep('what')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
            <button onClick={() => setStep('hours')} className="px-6 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">
              Next: Hours
            </button>
          </div>
        </div>
      )}

      {/* ══════════ Step 3: Operating hours ══════════ */}
      {step === 'hours' && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Operating Hours</h2>

          {/* Presets */}
          <div className="flex flex-wrap gap-2">
            {config.hoursPresets.map((preset, i) => (
              <button
                key={i}
                onClick={() => setHours(preset.hours)}
                className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Manual hours */}
          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4 space-y-2">
            {DAYS.map(day => {
              const h = hours[day] || {};
              const isClosed = h.closed === true;
              return (
                <div key={day} className="flex items-center gap-3">
                  <span className="w-10 text-xs font-medium text-gray-500 uppercase">{DAY_LABELS[day]}</span>
                  <input
                    type="checkbox"
                    checked={!isClosed && !!hours[day]}
                    onChange={e => {
                      const copy = { ...hours };
                      copy[day] = e.target.checked ? { open: '09:00', close: '17:00' } : { closed: true };
                      setHours(copy);
                    }}
                    className="rounded"
                  />
                  {!isClosed && hours[day] ? (
                    <>
                      <input type="time" value={h.open || '09:00'}
                        onChange={e => { const copy = { ...hours }; copy[day] = { ...copy[day], open: e.target.value }; setHours(copy); }}
                        className="text-xs border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                      <span className="text-xs text-gray-400">to</span>
                      <input type="time" value={h.close || '17:00'}
                        onChange={e => { const copy = { ...hours }; copy[day] = { ...copy[day], close: e.target.value }; setHours(copy); }}
                        className="text-xs border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                    </>
                  ) : (
                    <span className="text-xs text-gray-400">{hours[day] ? 'Closed' : 'Not set'}</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep('items')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
            <button onClick={() => setStep('greeting')} className="px-6 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">
              Next: Greeting
            </button>
          </div>
        </div>
      )}

      {/* ══════════ Step 4: Bot greeting ══════════ */}
      {step === 'greeting' && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Bot Greeting Message</h2>
          <p className="text-sm text-gray-500">This is what customers see when they first message your WhatsApp bot.</p>

          {/* Preset suggestions */}
          <div className="space-y-2">
            {[
              faithBased
                ? `Welcome to ${business.name}! ${cat === 'mosque' ? 'Assalamu Alaikum.' : ''} How can we help you today?`
                : `Hi! Welcome to ${business.name}. How can I help you today?`,
              `Hello! Thanks for reaching out to ${business.name}. What would you like to do?`,
              faithBased
                ? `God bless you! Welcome to ${business.name}. Tap a button below to get started.`
                : `Hey there! ${business.name} here. Ready to assist you!`,
            ].map((suggestion, i) => (
              <button
                key={i}
                onClick={() => setGreeting(suggestion)}
                className={`w-full text-left px-3 py-2 text-sm rounded-lg border transition ${
                  greeting === suggestion
                    ? 'border-black bg-gray-50 dark:border-white dark:bg-gray-700'
                    : 'border-gray-200 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700/50'
                } text-gray-700 dark:text-gray-300`}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Or write your own:</label>
            <textarea
              value={greeting}
              onChange={e => setGreeting(e.target.value)}
              rows={2}
              placeholder="Type a custom greeting..."
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep('hours')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
            <button onClick={() => setStep('review')} className="px-6 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">
              Review
            </button>
          </div>
        </div>
      )}

      {/* ══════════ Step 5: Review & confirm ══════════ */}
      {step === 'review' && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Review Your Setup</h2>

          {/* Services summary */}
          {services.filter(s => s.name.trim()).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{config.itemPlural} ({services.filter(s => s.name.trim()).length})</h3>
              <div className="space-y-1">
                {services.filter(s => s.name.trim()).map((s, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-700 dark:text-gray-300">{s.name}</span>
                    <span className="text-gray-500">{s.price > 0 ? `${s.price}` : 'Free'} &middot; {s.duration_minutes}min</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Products summary */}
          {products.filter(p => p.name.trim()).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Products ({products.filter(p => p.name.trim()).length})</h3>
              <div className="space-y-1">
                {products.filter(p => p.name.trim()).map((p, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-700 dark:text-gray-300">{p.name}</span>
                    <span className="text-gray-500">{p.price}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hours summary */}
          {Object.keys(hours).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Operating Hours</h3>
              <div className="space-y-0.5">
                {DAYS.map(day => {
                  const h = hours[day];
                  if (!h) return null;
                  return (
                    <div key={day} className="flex justify-between text-sm">
                      <span className="text-gray-700 dark:text-gray-300 capitalize">{day}</span>
                      <span className="text-gray-500">{h.closed ? 'Closed' : `${h.open} - ${h.close}`}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Greeting summary */}
          {greeting && (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Bot Greeting</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 italic">&ldquo;{greeting}&rdquo;</p>
            </div>
          )}

          {totalItems === 0 && Object.keys(hours).length === 0 && !greeting && (
            <p className="text-sm text-gray-400 text-center py-4">Nothing to create yet. Go back and add some items.</p>
          )}

          <div className="flex justify-between">
            <button onClick={() => setStep('greeting')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
            <button
              onClick={handleApply}
              disabled={applying || (totalItems === 0 && Object.keys(hours).length === 0 && !greeting)}
              className="px-6 py-2.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying ? 'Setting up...' : 'Confirm & Create'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 text-sm rounded-xl border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300 transition"
    >
      {label}
    </button>
  );
}
