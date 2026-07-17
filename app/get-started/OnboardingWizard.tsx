'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import { getPostHogClient } from '@/lib/posthog/client';
import {
  CATEGORY_FLOW_MAP,
  formatCurrency,
  getPricingTiers,
  BUSINESS_CATEGORIES,
  type BusinessCategoryKey,
  type SubscriptionTier,
  type CountryCode,
} from '@/lib/constants';
import { getCategoryList, getCategoryByKey, getCategoryGroups } from '@/lib/categoryConfig';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { loadCountries, getCountryList, getCountry, type CountryRow } from '@/lib/countries';
import { CATEGORY_DEFAULT_CAPABILITIES, CAPABILITIES, CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';
import { useOnboardingPersistence, clearOnboardingDraft, type OnboardingDraft } from '@/hooks/useOnboardingPersistence';
import type { User } from '@supabase/supabase-js';
import {
  StepAuth,
  StepCategory,
  StepFeatures,
  StepPlan,
  StepDetails,
  StepSuccess,
} from './steps';
import type {
  WizardStep,
  AuthSubStep,
  AuthMode,
  WhatsAppMethod,
  ConnectSubStep,
  FbConnectionData,
  DiscoveredWaba,
} from './steps';

declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

// Fallback numbers — used only if DB lookup fails. Empty string = no fallback (safe).
const FALLBACK_WHATSAPP_NUMBERS: Record<string, string> = {
  NG: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || '',
  US: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_US || '',
  GB: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GB || '',
  CA: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_CA || '',
  GH: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GH || '',
};

/* ─── Side Panel Content per Step ─── */

const STEP_PANELS: Record<WizardStep, { title: string; subtitle: string; bullets: string[]; visual: string }> = {
  auth: {
    title: 'Join businesses across 5 countries',
    subtitle: 'Create your account in seconds to get started with WhatsApp automation.',
    bullets: ['No credit card required', '30-day free trial', 'Setup in under 5 minutes'],
    visual: '\u{1F512}',
  },
  category: {
    title: 'One QR code. Any transaction.',
    subtitle: 'Put a sticker on your counter, car park, or church wall. Customers scan it, WhatsApp opens, and they can pay, book, or order instantly.',
    bullets: ['No app download needed', 'Works on any phone with WhatsApp', 'Customers just scan and go'],
    visual: '\u{1F4F1}',
  },
  features: {
    title: 'Your QR code will handle all of this',
    subtitle: 'Every feature you pick works through the same QR code. One scan does it all.',
    bullets: ['Payments, bookings, orders \u2014 one scan', 'Customers never leave WhatsApp', 'Works 24/7, even when you\'re closed'],
    visual: '\u{2728}',
  },
  plan: {
    title: 'Choose your plan',
    subtitle: 'Start free. Your QR code works on every plan.',
    bullets: ['Free 30-day trial', 'Pay-as-you-go transaction fees', 'Upgrade or downgrade anytime', 'Pro & Premium: connect your own WhatsApp number'],
    visual: '\u{1F4B3}',
  },
  details: {
    title: 'Almost ready to print',
    subtitle: 'Fill in your details and we\'ll generate your QR code \u2014 ready to print and stick anywhere.',
    bullets: ['Your unique WhatsApp link', 'Printable QR code sticker', 'Share online or stick on a wall'],
    visual: '\u{1F4CD}',
  },
  success: {
    title: 'Print it. Stick it. You\'re open.',
    subtitle: 'Your QR code is ready. Every scan is a new customer.',
    bullets: ['Print and stick anywhere', 'Share the link online', 'Track every scan in your dashboard'],
    visual: '\u{1F680}',
  },
};

/* ─── WhatsApp Connection Options ─── */

const WA_OPTIONS: {
  key: WhatsAppMethod;
  title: string;
  badge?: string;
  badgeColor?: string;
  description: string;
  pros: string[];
  cons: string[];
}[] = [
  {
    key: 'shared',
    title: 'Start with our number (free)',
    badge: 'Start Here',
    badgeColor: 'bg-green-100 text-green-700',
    description: 'Your bot runs on Waaiio\'s WhatsApp number. You keep your personal WhatsApp — nothing changes on your phone.',
    pros: [
      'Ready in 30 seconds — nothing to set up',
      'Your personal WhatsApp stays exactly as it is',
      'Completely free — no extra costs',
      'You can switch to your own number anytime later',
    ],
    cons: [
      'Customers message our number, not yours',
      'They need your business code to find you',
    ],
  },
  {
    key: 'transfer',
    title: 'Use your own number',
    badge: 'Pro / Premium',
    badgeColor: 'bg-brand-100 text-brand-700',
    description: 'Customers message your business number directly — fully branded. We recommend getting a separate SIM for this (keep your personal number for yourself).',
    pros: [
      'Customers message YOUR number — looks professional',
      'No bot code needed — they just message and it works',
      'Best for businesses that already share their number with customers',
    ],
    cons: [
      'WhatsApp app stops working on this number (it becomes bot-only)',
      'Tip: buy a cheap SIM (as low as ₦200) and use THAT number',
      'Your personal WhatsApp is safe — just use a different number for the bot',
      'Takes about 15 minutes to set up via Facebook',
    ],
  },
  {
    key: 'coexist',
    title: 'Keep WhatsApp Business + add bot',
    badge: 'Advanced',
    badgeColor: 'bg-amber-100 text-amber-700',
    description: 'If you already use WhatsApp Business app, you can add Waaiio\'s bot without losing your app. Both work at the same time.',
    pros: [
      'Your WhatsApp Business app keeps working',
      'Bot handles bookings and payments automatically',
      'You still reply to customers manually when needed',
    ],
    cons: [
      'Only works with WhatsApp Business app (not regular WhatsApp)',
      'Needs a Facebook Business Manager account',
      'Some features are limited in this mode',
    ],
  },
];

/* ─── Warnings for connecting own number ─── */

const OWN_NUMBER_WARNINGS = [
  {
    number: 1,
    title: 'Use a separate SIM for the bot',
    text: 'The number you connect becomes bot-only — WhatsApp app stops working on it. We recommend buying a cheap SIM (₦200-500) and using that number for the bot. Your personal number stays untouched.',
  },
  {
    number: 2,
    title: 'WhatsApp app stops on this number',
    text: 'Once connected, you manage everything from your Waaiio dashboard (not the WhatsApp app). The bot handles customer messages 24/7 automatically.',
  },
  {
    number: 3,
    title: 'Old chats don\'t transfer',
    text: 'Your previous WhatsApp conversations won\'t move to Waaiio. But new customers who message will be handled by the bot right away.',
  },
  {
    number: 4,
    title: 'You can always switch back',
    text: 'If you change your mind, you can disconnect the number and go back to using the WhatsApp app normally. You can also switch to using our shared number at any time.',
  },
];

const COEXIST_WARNINGS = [
  {
    number: 1,
    title: 'WhatsApp Business app required',
    text: 'Coexistence only works with the WhatsApp Business app, not the regular WhatsApp app. Download WhatsApp Business from your app store if you haven\'t already.',
  },
  {
    number: 2,
    title: '24-hour messaging window',
    text: 'By Meta\'s policy, you can reply to customers within 24 hours of their last message. After that, you\'ll need to use pre-approved message templates.',
  },
  {
    number: 3,
    title: 'Dual message handling',
    text: 'The Waaiio bot handles automated flows (bookings, payments, etc). You can still chat personally in the WhatsApp Business app, but avoid conflicting with bot conversations.',
  },
  {
    number: 4,
    title: 'Meta Business verification',
    text: 'You\'ll need a verified Facebook Business Manager account. This can take a few days if not already set up.',
  },
];

function getQueryParam(key: string): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(key);
}

function OnboardingWizard() {
  useCategoryConfig(); // trigger DB load for category templates
  const router = useRouter();
  const preselectedPlan = getQueryParam('plan') as SubscriptionTier | null;
  const billingInterval = getQueryParam('billing') === 'annual' ? 'year' : 'month';
  const successBusinessId = getQueryParam('business_id');
  const successStep = getQueryParam('step');

  const [step, setStep] = useState<WizardStep>('auth');
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Auth state
  const [authMode, setAuthMode] = useState<AuthMode>('email');
  const [authStep, setAuthStep] = useState<AuthSubStep>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [pinId, setPinId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  // Country
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>('NG');
  const [countryList, setCountryList] = useState<CountryRow[]>(getCountryList());
  const [sharedWhatsAppNumber, setSharedWhatsAppNumber] = useState<string>('');

  // Load the correct shared WhatsApp number from DB
  useEffect(() => {
    async function loadSharedNumber() {
      try {
        const supabase = createClient();
        // Try country-specific shared channel first
        let { data } = await supabase
          .from('whatsapp_channels')
          .select('phone_number')
          .eq('country_code', selectedCountry)
          .eq('channel_type', 'shared')
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        if (!data) {
          // Fallback: any active shared channel
          const result = await supabase
            .from('whatsapp_channels')
            .select('phone_number')
            .eq('channel_type', 'shared')
            .eq('is_active', true)
            .limit(1)
            .maybeSingle();
          data = result.data;
        }

        if (data?.phone_number) {
          setSharedWhatsAppNumber(data.phone_number);
        }
      } catch { /* use fallback */ }
    }
    loadSharedNumber();
  }, [selectedCountry]);

  useEffect(() => {
    loadCountries().then(() => setCountryList(getCountryList()));
  }, []);

  // Category
  const [category, setCategory] = useState<BusinessCategoryKey | ''>('');
  const [categorySearch, setCategorySearch] = useState('');
  const [selectedCapabilities, setSelectedCapabilities] = useState<CapabilityId[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  // Owner details
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  // Business details
  const [name, setName] = useState('');
  const [nameCheckStatus, setNameCheckStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const nameCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [customBotCode, setCustomBotCode] = useState('');
  const [suggestedBotCode, setSuggestedBotCode] = useState('');
  const [botCodeStatus, setBotCodeStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [botCodeEdited, setBotCodeEdited] = useState(false);
  const botCodeCheckRef = useRef<NodeJS.Timeout | null>(null);
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [address, setAddress] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');

  // Bot persona
  const [botAlias, setBotAlias] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [agreedToDataProcessing, setAgreedToDataProcessing] = useState(false);
  const [botGreeting, setBotGreeting] = useState('');

  // WhatsApp connection
  const [waMethod, setWaMethod] = useState<WhatsAppMethod>('shared');
  const [connectSubStep, setConnectSubStep] = useState<ConnectSubStep>('choose');
  const [ownPhone, setOwnPhone] = useState('');
  const [fbConnecting, setFbConnecting] = useState(false);
  const [fbConnected, setFbConnected] = useState(false);
  const [showManualGuide, setShowManualGuide] = useState(false);
  const fbSdkLoaded = useRef(false);
  const [fbSdkReady, setFbSdkReady] = useState(false);
  const fbWabaIdRef = useRef('');
  const fbPhoneNumberIdRef = useRef('');
  const [fbConnectionData, setFbConnectionData] = useState<FbConnectionData | null>(null);

  // Discovered WABAs and phones from Facebook
  const [discoveredWabas, setDiscoveredWabas] = useState<DiscoveredWaba[]>([]);
  const [selectedWabaId, setSelectedWabaId] = useState('');
  const [selectedPhoneId, setSelectedPhoneId] = useState('');

  // Plan & payment
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionTier>(
    preselectedPlan && ['growth', 'business'].includes(preselectedPlan) ? preselectedPlan : 'free'
  );
  const [businessId, setBusinessId] = useState('');
  const [botCode, setBotCode] = useState('');

  // Success state
  const [successData, setSuccessData] = useState<{ bot_code: string; business_id: string } | null>(null);

  // Draft restored indicator
  const [showDraftRestored, setShowDraftRestored] = useState(false);

  // ── Onboarding Persistence ──
  const restoreDraft = useCallback((draft: OnboardingDraft) => {
    setStep(draft.step);
    setSelectedCountry(draft.selectedCountry);
    setCity(draft.city);
    setState(draft.state);
    setZipCode(draft.zipCode);
    setSelectedGroup(draft.selectedGroup);
    setCategory(draft.category as BusinessCategoryKey | '');
    setSelectedCapabilities(draft.selectedCapabilities);
    setName(draft.businessName);
    setFirstName(draft.firstName);
    setLastName(draft.lastName);
    setAddress(draft.address);
    setBusinessPhone(draft.phone);
    setEmail(draft.email);
    setCustomBotCode(draft.customBotCode);
    setSelectedPlan(draft.selectedPlan);
    setWaMethod(draft.waMethod);
    setShowDraftRestored(true);
    // Auto-dismiss the indicator after 4 seconds
    setTimeout(() => setShowDraftRestored(false), 4000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formStateForPersistence = useMemo(() => ({
    step,
    selectedCountry,
    city,
    state,
    zipCode,
    selectedGroup,
    category,
    selectedCapabilities,
    businessName: name,
    firstName,
    lastName,
    address,
    phone: businessPhone,
    email,
    customBotCode,
    selectedPlan,
    waMethod,
  }), [step, selectedCountry, city, state, zipCode, selectedGroup, category, selectedCapabilities, name, firstName, lastName, address, businessPhone, email, customBotCode, selectedPlan, waMethod]);

  useOnboardingPersistence(user, formStateForPersistence, restoreDraft);

  // Category search computed values
  const allCategories = getCategoryList();
  const allCategoriesSorted = [...allCategories].filter(c => c.key !== 'other').sort((a, b) => a.label.localeCompare(b.label));
  const popularCategories = ['restaurant', 'barber', 'salon', 'church', 'shop', 'hotel', 'gym', 'events', 'consultant', 'clinic']
    .map(k => allCategories.find(c => c.key === k))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const popularKeys = new Set(['restaurant', 'barber', 'salon', 'church', 'shop', 'hotel', 'gym', 'events', 'consultant', 'clinic']);

  const filteredCategories = categorySearch.trim()
    ? allCategoriesSorted.filter(c =>
        c.label.toLowerCase().includes(categorySearch.toLowerCase()) ||
        c.key.toLowerCase().includes(categorySearch.toLowerCase())
      )
    : allCategoriesSorted;

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user: u } }) => {
      if (u) {
        setUser(u);
        if (successStep === 'success' && successBusinessId) {
          setBusinessId(successBusinessId);
          setStep('success');
        } else if (successStep === 'whatsapp' && successBusinessId) {
          setBusinessId(successBusinessId);
          setStep('success');
        } else {
          setStep('category');
        }
      }
      setLoading(false);
    });
  }, [successStep, successBusinessId]);

  // Track onboarding funnel steps
  useEffect(() => {
    const ph = getPostHogClient();
    if (!ph) return;
    const stepMap: Record<WizardStep, string> = {
      auth: 'onboarding_auth',
      category: 'onboarding_category',
      features: 'onboarding_features',
      plan: 'onboarding_plan',
      details: 'onboarding_details',
      success: 'onboarding_success',
    };
    ph.capture(stepMap[step], { step, category: category || undefined, country: selectedCountry });
  }, [step]);

  // Clear draft on successful completion
  useEffect(() => {
    if (step === 'success') {
      clearOnboardingDraft();
    }
  }, [step]);

  useEffect(() => {
    if (step !== 'success' || successData) return;
    if (!successBusinessId) return;

    const ref = getQueryParam('reference') || getQueryParam('trxref');
    verifyPayment(ref || '', successBusinessId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, successBusinessId]);

  // Listen for Facebook Embedded Signup messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.origin?.endsWith('facebook.com')) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH') {
            fbWabaIdRef.current = data.data.waba_id || '';
            fbPhoneNumberIdRef.current = data.data.phone_number_id || '';
          } else if (data.event === 'CANCEL') {
            setFbConnecting(false);
          } else if (data.event === 'ERROR') {
            setFbConnecting(false);
            setError('An error occurred during Facebook signup. Please try again.');
          }
        }
      } catch {
        // Not a JSON message from FB, ignore
      }
    };

    window.addEventListener('message', handleMessage);
    return () => { window.removeEventListener('message', handleMessage); };
  }, []);

  // Facebook SDK — clean load following Meta's official pattern.
  // We remove any stale script/state first to guarantee fbAsyncInit fires.
  useEffect(() => {
    const appId = (process.env.NEXT_PUBLIC_META_APP_ID || '').trim();
    if (!appId || fbSdkLoaded.current) return;

    // 1. Define the callback the SDK will invoke when fully ready
    window.fbAsyncInit = function () {
      if (fbSdkLoaded.current) return;
      window.FB.init({ appId, cookie: true, xfbml: true, version: 'v22.0' });
      fbSdkLoaded.current = true;
      setFbSdkReady(true);
    };

    // 2. Remove any stale FB SDK script (e.g. from prior next/script or cached page)
    //    so the fresh script triggers fbAsyncInit when it loads
    const stale = document.getElementById('facebook-jssdk');
    if (stale) {
      stale.remove();
      (window as any).FB = undefined;
    }

    // 3. Inject a fresh script tag
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);
  }, []);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (nameCheckTimeoutRef.current) clearTimeout(nameCheckTimeoutRef.current);
      if (botCodeCheckRef.current) clearTimeout(botCodeCheckRef.current);
    };
  }, []);

  function handleNameChange(value: string) {
    setName(value);
    if (nameCheckTimeoutRef.current) clearTimeout(nameCheckTimeoutRef.current);
    if (!value || value.trim().length < 2) {
      setNameCheckStatus('idle');
      setSuggestedBotCode('');
      if (!botCodeEdited) { setCustomBotCode(''); setBotCodeStatus('idle'); }
      return;
    }
    setNameCheckStatus('checking');
    nameCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const codeParam = botCodeEdited && customBotCode ? `&bot_code=${encodeURIComponent(customBotCode)}` : '';
        const res = await fetch(`/api/onboarding/check-name?name=${encodeURIComponent(value.trim())}${codeParam}`);
        const data = await res.json();
        setNameCheckStatus(data.slug_available !== false ? (data.code_available ? 'available' : 'taken') : 'taken');
        setSuggestedBotCode(data.suggested_code || data.bot_code || '');
        // Auto-fill bot code if user hasn't manually edited it
        if (!botCodeEdited) {
          setCustomBotCode(data.suggested_code || data.bot_code || '');
          setBotCodeStatus(data.code_available ? 'available' : 'taken');
        }
      } catch {
        setNameCheckStatus('idle');
      }
    }, 500);
  }

  function handleBotCodeChange(value: string) {
    // Normalize: uppercase, hyphens for spaces, only alphanumeric + hyphens
    const cleaned = value.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').slice(0, 30);
    setCustomBotCode(cleaned);
    setBotCodeEdited(true);
    if (botCodeCheckRef.current) clearTimeout(botCodeCheckRef.current);
    if (!cleaned || cleaned.length < 2) {
      setBotCodeStatus('idle');
      return;
    }
    setBotCodeStatus('checking');
    botCodeCheckRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/onboarding/check-name?name=${encodeURIComponent(name.trim())}&bot_code=${encodeURIComponent(cleaned)}`);
        const data = await res.json();
        setBotCodeStatus(data.code_available ? 'available' : 'taken');
      } catch {
        setBotCodeStatus('idle');
      }
    }, 400);
  }

  async function verifyPayment(reference: string, bid?: string) {
    setLoading(true);
    try {
      const res = await fetch('/api/onboarding/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference: reference || undefined,
          business_id: bid || successBusinessId || businessId,
          plan: selectedPlan,
          billing_interval: billingInterval,
        }),
      });
      const data = await res.json();
      if (data.bot_code) {
        setSuccessData({ bot_code: data.bot_code, business_id: data.business_id });
        setBotCode(data.bot_code);
      } else {
        setError(data.message || 'Payment verification failed');
      }
    } catch {
      setError('Failed to verify payment');
    } finally {
      setLoading(false);
    }
  }

  // ── Auth Handlers ──

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!phone) return;
    setAuthLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Failed to send OTP'); return; }
      setPinId(data.pin_id);
      setAuthStep('otp');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return;
    setAuthLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp, pin_id: pinId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Invalid OTP'); return; }
      // Session is set via cookies by the verify route — refresh client to pick it up
      const supabase = createClient();
      const { data: { user: u } } = await supabase.auth.getUser();
      setUser(u);
      setStep('category');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleEmailSignup(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setAuthLoading(true);
    setError('');
    try {
      const supabase = createClient();

      // Check if the user already exists by trying to sign in first
      const { data: signInData } = await supabase.auth.signInWithPassword({ email, password });
      if (signInData.session) {
        // Existing user with correct password — log them in and continue onboarding
        setUser(signInData.user);
        getPostHogClient()?.capture('login_from_signup', { method: 'email' });

        // Check if they already have a business
        const { count } = await supabase
          .from('businesses')
          .select('id', { count: 'exact', head: true })
          .eq('owner_id', signInData.user!.id);
        if (count && count > 0) {
          // Already has a business — redirect to dashboard
          window.location.href = '/dashboard';
          return;
        }
        setStep('category');
        return;
      }

      // Not an existing user — proceed with signup
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/get-started`,
        },
      });
      if (signUpError) {
        // Friendly error messages
        if (signUpError.message.includes('already registered') || signUpError.message.includes('already been registered')) {
          setError('This email is already registered. Try signing in instead, or use a different email.');
        } else if (signUpError.message.includes('rate limit')) {
          setError('Too many attempts. Please wait a few minutes and try again.');
        } else {
          setError(signUpError.message);
        }
        return;
      }

      // Supabase returns a user without a session when email confirmation is required
      // but also when the user already exists (security measure to prevent enumeration)
      if (signUpData.session) {
        setUser(signUpData.user);
        getPostHogClient()?.capture('signup_completed', { method: 'email' });
        setStep('category');
      } else if (signUpData.user) {
        // Check if this is a fake "success" for an existing user (no identities = already exists)
        if (signUpData.user.identities && signUpData.user.identities.length === 0) {
          setError('An account with this email already exists. Please sign in instead.');
        } else {
          setEmailSent(true);
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch (err) {
      console.error('[SIGNUP] Error:', err);
      setError('Network error. Please check your connection and try again.');
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Facebook Embedded Signup ──

  function launchWhatsAppSignup() {
    if (!window.FB || !fbSdkLoaded.current) {
      setError('Facebook is still loading. Please wait a moment and try again.');
      return;
    }

    setFbConnecting(true);
    setError('');
    fbWabaIdRef.current = '';
    fbPhoneNumberIdRef.current = '';

    const configId = (process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID || '').trim();

    window.FB.login(
      function (response: any) {
        if (response.authResponse) {
          const code = response.authResponse.code;

          // Exchange code immediately (codes expire fast) and discover WABAs/phones
          fetch('/api/auth/facebook/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          })
            .then((res) => res.json())
            .then((data) => {
              if (data.access_token && data.wabas?.length > 0) {
                setDiscoveredWabas(data.wabas);
                // Auto-select first WABA and first phone
                const firstWaba = data.wabas[0];
                setSelectedWabaId(firstWaba.waba_id);
                if (firstWaba.phones.length > 0) {
                  const lastPhone = firstWaba.phones[firstWaba.phones.length - 1];
                  setSelectedPhoneId(lastPhone.id);
                }
                // Store the access token for later use in callback
                fbWabaIdRef.current = firstWaba.waba_id;
                fbPhoneNumberIdRef.current = firstWaba.phones.length > 0
                  ? firstWaba.phones[firstWaba.phones.length - 1].id
                  : '';
                // Store token data temporarily
                setFbConnectionData({
                  waba_id: firstWaba.waba_id,
                  phone_number_id: firstWaba.phones.length > 0 ? firstWaba.phones[firstWaba.phones.length - 1].id : '',
                  access_token: data.access_token,
                  token_expires_at: data.token_expires_at,
                });
                setFbConnecting(false);
                setFbConnected(true);
              } else {
                setFbConnecting(false);
                setError(data.message || 'No WhatsApp Business Account found. Please try again.');
              }
            })
            .catch(() => {
              setFbConnecting(false);
              setError('Network error exchanging Facebook code. Please try again.');
            });
        } else {
          setFbConnecting(false);
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {
            business: { name: name || undefined },
          },
          featureType: '',
          sessionInfoVersion: '3',
        },
      }
    );
  }

  async function handleFbConnectAndRegister() {
    if (!fbConnectionData) return;

    // Use selected WABA/phone from the phone_select step
    const wabaId = selectedWabaId || fbConnectionData.waba_id;
    const phoneId = selectedPhoneId || fbConnectionData.phone_number_id;

    // Find the selected phone's display info
    const selectedWaba = discoveredWabas.find(w => w.waba_id === wabaId);
    const selectedPhone = selectedWaba?.phones.find(p => p.id === phoneId);

    // Existing business upgrading from shared number — just connect WhatsApp
    if (successStep === 'whatsapp' && successBusinessId) {
      setLoading(true);
      setError('');
      try {
        const fbRes = await fetch('/api/auth/facebook/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: successBusinessId,
            access_token: fbConnectionData.access_token,
            token_expires_at: fbConnectionData.token_expires_at,
            waba_id: wabaId,
            phone_number_id: phoneId,
            connection_method: waMethod,
          }),
        });
        const fbData = await fbRes.json();
        if (!fbRes.ok) {
          setError(fbData.message || 'Failed to connect WhatsApp number');
          return;
        }
        // Redirect back to dashboard
        router.push('/dashboard/settings');
        router.refresh();
      } catch {
        setError('Network error. Please try again.');
      } finally {
        setLoading(false);
      }
      return;
    }

    // New business onboarding — register first, then connect
    if (!name || !city || !address || !businessPhone || !category) return;
    setLoading(true);
    setError('');
    try {
      // Step 1: Register the business
      const registerRes = await fetch('/api/onboarding/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, city, state, zip_code: zipCode, address,
          phone: businessPhone, category, country: selectedCountry,
          bot_alias: botAlias || undefined,
          bot_greeting: botGreeting || undefined,
          bot_code: customBotCode || undefined,
          wa_method: waMethod,
          wa_own_phone: selectedPhone?.display_phone_number || ownPhone || undefined,
          capabilities: selectedCapabilities.length > 0 ? selectedCapabilities : undefined,
        }),
      });
      const registerData = await registerRes.json();
      if (!registerRes.ok) {
        setError(registerData.message || 'Registration failed');
        return;
      }

      setBusinessId(registerData.business_id);
      setBotCode(registerData.bot_code);
      getPostHogClient()?.capture('business_created', { category, country: selectedCountry, businessId: registerData.business_id });

      // Step 2: Connect the WhatsApp channel
      const fbRes = await fetch('/api/auth/facebook/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: registerData.business_id,
          access_token: fbConnectionData.access_token,
          token_expires_at: fbConnectionData.token_expires_at,
          waba_id: wabaId,
          phone_number_id: phoneId,
          connection_method: waMethod,
        }),
      });
      const fbData = await fbRes.json();
      if (!fbRes.ok) {
        console.error('WhatsApp channel creation warning:', fbData.message);
        // Non-fatal — business is created, channel can be retried from dashboard
      }

      // Free plan: verify immediately and go to success
      const verifyRes = await fetch('/api/onboarding/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: registerData.business_id, plan: 'free', billing_interval: billingInterval }),
      });
      const verifyData = await verifyRes.json();
      if (verifyData.bot_code) {
        setSuccessData({ bot_code: verifyData.bot_code, business_id: verifyData.business_id });
        setBotCode(verifyData.bot_code);
        setStep('success');
      } else {
        setError(verifyData.message || 'Activation failed');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Registration Handler ──

  async function handleRegister(e: React.FormEvent | React.MouseEvent) {
    e.preventDefault();
    if (!name || !city || !address || !businessPhone || !category) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: firstName,
          last_name: lastName,
          name,
          city,
          state,
          zip_code: zipCode,
          address,
          phone: businessPhone,
          category,
          country: selectedCountry,
          bot_alias: botAlias || undefined,
          bot_greeting: botGreeting || undefined,
          bot_code: customBotCode || undefined,
          wa_method: waMethod,
          wa_own_phone: waMethod !== 'shared' ? ownPhone : undefined,
          capabilities: selectedCapabilities.length > 0 ? selectedCapabilities : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Registration failed'); return; }
      setBusinessId(data.business_id);
      setBotCode(data.bot_code);

      if (selectedPlan === 'free') {
        // Free plan: verify immediately and go to success
        const verifyRes = await fetch('/api/onboarding/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_id: data.business_id, plan: 'free', billing_interval: billingInterval }),
        });
        const verifyData = await verifyRes.json();
        if (verifyData.bot_code) {
          setSuccessData({ bot_code: verifyData.bot_code, business_id: verifyData.business_id });
          setBotCode(verifyData.bot_code);
          setStep('success');
        } else {
          setError(verifyData.message || 'Activation failed');
        }
      } else {
        // Paid plan: redirect to payment gateway
        const payRes = await fetch('/api/onboarding/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_id: data.business_id, plan: selectedPlan, billing_interval: billingInterval }),
        });
        const payData = await payRes.json();
        if (!payRes.ok) { setError(payData.message || 'Payment initialization failed'); return; }
        window.location.href = payData.authorization_url || payData.url;
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Payment Handler ──

  async function handlePay() {
    if (!businessId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, plan: selectedPlan, billing_interval: billingInterval }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Payment initialization failed'); return; }
      window.location.href = data.authorization_url;
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Free plan handler ──

  async function handleStartFree() {
    if (!businessId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, plan: 'free', billing_interval: billingInterval }),
      });
      const data = await res.json();
      if (data.bot_code) {
        setSuccessData({ bot_code: data.bot_code, business_id: data.business_id });
        setBotCode(data.bot_code);
        setStep('success');
      } else {
        setError(data.message || 'Activation failed');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Derived state ──

  const flowType = category ? CATEGORY_FLOW_MAP[category] : null;
  const categoryInfo = category ? getCategoryByKey(category) : null;

  const defaultGreeting = (() => {
    if (!category || !name) return 'Welcome! How can I help you today?';
    switch (category) {
      case 'restaurant': return `Welcome to ${name}! I can help you book a table. When would you like to dine?`;
      case 'barber': return `Welcome to ${name}! I can help you book an appointment. What service would you like?`;
      case 'spa': case 'salon': return `Welcome to ${name}! I can help you book a session. What would you like?`;
      case 'church': case 'mosque': return `Welcome to ${name}! I can help you with giving. What would you like to give towards?`;
      case 'school': return `Welcome to ${name}! I can help you make payments. Select a category to proceed.`;
      case 'shop': case 'food_delivery': return `Welcome to ${name}! Browse our products and place an order.`;
      case 'events': return `Welcome to ${name}! Check out our upcoming events and get your tickets!`;
      default: return `Welcome to ${name}! How can I help you today?`;
    }
  })();

  // ── Step indicator ──

  const steps: { key: WizardStep; label: string }[] = [
    { key: 'auth', label: 'Sign Up' },
    { key: 'category', label: 'Needs' },
    { key: 'details', label: 'Details' },
    { key: 'success', label: 'Live!' },
  ];

  const stepIndex = steps.findIndex(s => s.key === step);

  // For shared numbers: wa.me/{waaiioNumber}?text={botCode}
  // For dedicated numbers (transfer/coexist): wa.me/{theirOwnNumber} (no bot code needed)
  const sharedNumber = sharedWhatsAppNumber || FALLBACK_WHATSAPP_NUMBERS[selectedCountry] || '';
  const dedicatedNumber = fbConnectionData?.phone_number?.replace(/[^0-9]/g, '') || ownPhone.replace(/[^0-9]/g, '');
  const waNumber = waMethod !== 'shared' && dedicatedNumber ? dedicatedNumber : sharedNumber;
  const waLink = waMethod !== 'shared' && dedicatedNumber
    ? `https://wa.me/${dedicatedNumber}`
    : `https://wa.me/${sharedNumber}?text=${encodeURIComponent(successData?.bot_code || botCode)}`;
  const localTiers = getPricingTiers(selectedCountry);

  // Compute the minimum required plan based on selected features
  // IMPORTANT: This useMemo must be BEFORE any conditional returns (React hooks rule)
  const requiredPlan = useMemo(() => {
    let highest: 'free' | 'growth' | 'business' = 'free';
    for (const cap of selectedCapabilities) {
      const tier = CAPABILITY_TIER_REQUIREMENTS[cap] || 'free';
      if (tier === 'business') { highest = 'business'; break; }
      if (tier === 'growth' && highest === 'free') highest = 'growth';
    }
    return highest;
  }, [selectedCapabilities]);

  const panel = STEP_PANELS[step];

  // Loading state — MUST be after all hooks (React rules of hooks)
  if (loading && step === 'auth') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  function handleConnectContinue() {
    if (waMethod === 'shared') {
      // No warnings needed for shared, go straight to registration
      handleRegister({ preventDefault: () => {} } as React.FormEvent);
    } else if (connectSubStep === 'choose') {
      setConnectSubStep('warnings');
    } else if (connectSubStep === 'warnings') {
      setConnectSubStep('setup');
    } else {
      // Setup done, register
      handleRegister({ preventDefault: () => {} } as React.FormEvent);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* ── Left Side: Branded Panel ── */}
      <div className="hidden w-[420px] flex-shrink-0 bg-gradient-to-br from-brand-900 via-brand to-brand-700 lg:flex lg:flex-col">
        <div className="flex flex-1 flex-col justify-between p-10">
          <Link href="/">
            <Image src="/logo.png" alt="Waaiio" width={120} height={32} className="h-8 w-auto brightness-0 invert" />
          </Link>

          <div className="flex-1 flex flex-col justify-center">
            <div className="mb-6 text-6xl">{panel.visual}</div>
            <h2 className="text-2xl font-bold text-white">{panel.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-brand-200">{panel.subtitle}</p>
            <ul className="mt-8 space-y-3">
              {panel.bullets.map((b) => (
                <li key={b} className="flex items-center gap-3 text-sm text-brand-100">
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent/20">
                    <svg className="h-3 w-3 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  {b}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-2">
            {steps.map((s, i) => (
              <div key={s.key} className={`h-1.5 rounded-full transition-all duration-300 ${i <= stepIndex ? 'w-8 bg-accent' : 'w-4 bg-white/20'}`} />
            ))}
          </div>
        </div>
      </div>

      {/* ── Right Side: Form ── */}
      <div className="flex flex-1 flex-col">
        {/* Mobile header */}
        <header className="border-b border-gray-100 bg-white lg:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <Link href="/">
              <Image src="/logo.png" alt="Waaiio" width={105} height={28} className="h-7 w-auto" />
            </Link>
            <span className="text-xs text-gray-400">Step {stepIndex + 1} of {steps.length}</span>
          </div>
        </header>

        {/* Step indicator */}
        <div className="border-b border-gray-100 bg-white px-4 py-4 lg:px-10 lg:py-6">
          <div className="mx-auto max-w-xl">
            <div className="flex items-center justify-between">
              {steps.map((s, i) => (
                <div key={s.key} className="flex items-center">
                  <div className="flex flex-col items-center">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition ${
                      i < stepIndex ? 'bg-brand text-white' : i === stepIndex ? 'bg-brand text-white ring-4 ring-brand-100' : 'bg-gray-100 text-gray-400'
                    }`}>
                      {i < stepIndex ? (
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      ) : i + 1}
                    </div>
                    <span className={`mt-1 hidden text-[10px] sm:block ${i <= stepIndex ? 'font-medium text-brand' : 'text-gray-400'}`}>{s.label}</span>
                  </div>
                  {i < steps.length - 1 && <div className={`mx-1 h-0.5 w-3 sm:mx-1.5 sm:w-8 ${i < stepIndex ? 'bg-brand' : 'bg-gray-200'}`} />}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Main content area */}
        <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-8 lg:px-10">
          <div className="w-full max-w-xl">
            {/* Cancel / Exit button */}
            {step !== 'auth' && step !== 'success' && (
              <div className="mb-4 flex justify-end">
                <button
                  type="button"
                  onClick={async () => {
                    if (confirm('Are you sure you want to cancel? Your progress will not be saved.')) {
                      clearOnboardingDraft();
                      const supabase = createClient();
                      await supabase.auth.signOut();
                      window.location.href = '/';
                    }
                  }}
                  className="text-xs text-gray-400 hover:text-red-500 transition"
                >
                  Cancel &amp; Exit
                </button>
              </div>
            )}

            {showDraftRestored && (
              <div className="mb-4 flex items-center gap-2 rounded-lg bg-brand-50 border border-brand-100 px-4 py-2.5 text-sm text-brand-700 animate-in fade-in slide-in-from-top-2 duration-300">
                <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Your previous progress has been restored.</span>
                <button onClick={() => setShowDraftRestored(false)} className="ml-auto text-brand-400 hover:text-brand-600">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            )}

            {error && (
              <div className="mb-6 rounded-xl bg-red-50 border border-red-100 p-4 text-sm text-red-700">
                {error}
                <button onClick={() => setError('')} className="ml-2 font-semibold underline">Dismiss</button>
              </div>
            )}

            {/* ── Step 1: Auth ── */}
            {step === 'auth' && (
              <StepAuth
                email={email}
                setEmail={setEmail}
                password={password}
                setPassword={setPassword}
                authLoading={authLoading}
                emailSent={emailSent}
                setEmailSent={setEmailSent}
                handleEmailSignup={handleEmailSignup}
                setAuthLoading={setAuthLoading}
              />
            )}

            {/* ── Step 2: Category ── */}
            {step === 'category' && (
              <StepCategory
                selectedCountry={selectedCountry}
                setSelectedCountry={setSelectedCountry}
                countryList={countryList}
                setCity={setCity}
                selectedGroup={selectedGroup}
                setSelectedGroup={setSelectedGroup}
                category={category}
                setCategory={setCategory}
                setSelectedCapabilities={setSelectedCapabilities}
                setSelectedPlan={setSelectedPlan}
                setStep={setStep}
              />
            )}

            {/* ── Step 3: Features ── */}
            {step === 'features' && (
              <StepFeatures
                selectedCapabilities={selectedCapabilities}
                setSelectedCapabilities={setSelectedCapabilities}
                selectedPlan={selectedPlan}
                setSelectedPlan={setSelectedPlan}
                selectedCountry={selectedCountry}
                category={category}
                requiredPlan={requiredPlan}
                localTiers={localTiers}
                billingInterval={billingInterval}
                setStep={setStep}
              />
            )}

            {/* ── Step 4: Plan ── */}
            {step === 'plan' && (
              <StepPlan
                selectedPlan={selectedPlan}
                setSelectedPlan={setSelectedPlan}
                selectedCapabilities={selectedCapabilities}
                setSelectedCapabilities={setSelectedCapabilities}
                selectedCountry={selectedCountry}
                requiredPlan={requiredPlan}
                localTiers={localTiers}
                billingInterval={billingInterval}
                setStep={setStep}
              />
            )}

            {/* ── Step 5: Details ── */}
            {step === 'details' && (
              <StepDetails
                firstName={firstName}
                setFirstName={setFirstName}
                lastName={lastName}
                setLastName={setLastName}
                name={name}
                handleNameChange={handleNameChange}
                nameCheckStatus={nameCheckStatus}
                customBotCode={customBotCode}
                handleBotCodeChange={handleBotCodeChange}
                botCodeStatus={botCodeStatus}
                suggestedBotCode={suggestedBotCode}
                address={address}
                setAddress={setAddress}
                city={city}
                setCity={setCity}
                state={state}
                setState={setState}
                zipCode={zipCode}
                setZipCode={setZipCode}
                businessPhone={businessPhone}
                setBusinessPhone={setBusinessPhone}
                selectedCountry={selectedCountry}
                selectedPlan={selectedPlan}
                waMethod={waMethod}
                setWaMethod={setWaMethod}
                ownPhone={ownPhone}
                setOwnPhone={setOwnPhone}
                fbConnecting={fbConnecting}
                setFbConnecting={setFbConnecting}
                fbConnected={fbConnected}
                setFbConnected={setFbConnected}
                fbSdkReady={fbSdkReady}
                fbConnectionData={fbConnectionData}
                setFbConnectionData={setFbConnectionData}
                discoveredWabas={discoveredWabas}
                setDiscoveredWabas={setDiscoveredWabas}
                agreedToTerms={agreedToTerms}
                setAgreedToTerms={setAgreedToTerms}
                agreedToDataProcessing={agreedToDataProcessing}
                setAgreedToDataProcessing={setAgreedToDataProcessing}
                loading={loading}
                error={error}
                category={category}
                categoryInfo={categoryInfo}
                localTiers={localTiers}
                launchWhatsAppSignup={launchWhatsAppSignup}
                handleRegister={handleRegister}
                setStep={setStep}
              />
            )}

            {/* Persona and Connect steps removed — persona is post-signup, connect is merged into details */}
            {/* Old plan step removed — now in step 3 above */}

            {/* ── Step 7: Success ── */}
            {step === 'success' && (
              <StepSuccess
                loading={loading}
                successData={successData}
                waMethod={waMethod}
                waLink={waLink}
                selectedCapabilities={selectedCapabilities}
                error={error}
                setStep={setStep}
                setError={setError}
                fbConnectionData={fbConnectionData}
              />
            )}
          </div>
        </div>
      </div>
      {/* Facebook SDK is injected via useEffect above (Meta's official pattern) */}
    </div>
  );
}

/* ─── Setup Step Component ─── */

function SetupStep({ number, title, description, link, linkLabel, note }: {
  number: number;
  title: string;
  description: string;
  link?: string;
  linkLabel?: string;
  note?: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
        <p className="mt-1 text-sm leading-relaxed text-gray-600">{description}</p>
        {note && (
          <p className="mt-1.5 text-xs text-amber-600 bg-amber-50 rounded px-2 py-1 inline-block">{note}</p>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
          >
            {linkLabel || link}
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}

/* ─── Plan Option Card ─── */

function PlanOption({ selected, onClick, name, price, period, features, popular }: {
  selected: boolean; onClick: () => void; name: string; price: string; period: string; features: string[]; popular?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selected ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'}`}>
      {popular && <span className="absolute -top-2.5 right-4 rounded-full bg-brand px-3 py-0.5 text-[10px] font-bold text-white">Popular</span>}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-bold text-gray-900">{name}</h3>
          <p className="mt-1"><span className="text-xl font-bold text-gray-900">{price}</span>{period && <span className="text-sm text-gray-500">{period}</span>}</p>
        </div>
        <div className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${selected ? 'border-brand bg-brand' : 'border-gray-300'}`}>
          {selected && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
        </div>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {features.slice(0, 4).map(f => (
          <li key={f} className="flex items-start gap-1.5 text-xs text-gray-600">
            <svg className="mt-0.5 h-3 w-3 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            <span className="line-clamp-1">{f}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

/* ─── QR Code Display ─── */

function QRCodeDisplay({ value }: { value: string }) {
  const [loaded, setLoaded] = useState(false);
  const componentRef = useRef<React.ComponentType<{ value: string; size: number; level: string }> | null>(null);

  useEffect(() => {
    import('qrcode.react').then(mod => {
      componentRef.current = mod.QRCodeSVG as unknown as React.ComponentType<{ value: string; size: number; level: string }>;
      setLoaded(true);
    }).catch(() => {});
  }, []);

  if (!loaded || !componentRef.current) {
    return <div className="mx-auto flex h-48 w-48 items-center justify-center rounded-xl bg-gray-100 text-xs text-gray-400">QR Code</div>;
  }

  const QR = componentRef.current;
  return (
    <div className="inline-block rounded-2xl bg-white p-5 shadow-lg border border-gray-100">
      <QR value={value} size={192} level="M" />
    </div>
  );
}

// Export the wizard for dynamic import from page wrapper
export { OnboardingWizard };
