'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { getPostHogClient } from '@/lib/posthog/client';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { OtpInput } from '@/components/auth/OtpInput';
import AddressAutocomplete from '@/components/ui/AddressAutocomplete';
import {
  CATEGORY_FLOW_MAP,
  formatCurrency,
  getPricingTiers,
  getCitiesForCountry,
  type BusinessCategoryKey,
  type SubscriptionTier,
  type CountryCode,
} from '@/lib/constants';
import { getCategoryList, getCategoryByKey } from '@/lib/categoryConfig';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { loadCountries, getCountryList, getCountry, type CountryRow } from '@/lib/countries';
import { CATEGORY_DEFAULT_CAPABILITIES, CAPABILITIES, type CapabilityId } from '@/lib/capabilities/types';
import type { User } from '@supabase/supabase-js';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

const WHATSAPP_NUMBERS: Record<CountryCode, string> = {
  NG: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_NG || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER || '2349XXXXXXXXX',
  US: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_US || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_US || '12025551234',
  GB: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GB || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_GB || '447911123456',
  CA: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_CA || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_CA || '14165551234',
  GH: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GH || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_GH || '233241234567',
};

/* ─── Category Grouping for Onboarding ─── */

const CATEGORY_GROUPS: { label: string; keys: BusinessCategoryKey[] }[] = [
  {
    label: 'Food & Hospitality',
    keys: ['restaurant', 'food_delivery', 'catering', 'hotel', 'shortlet'],
  },
  {
    label: 'Health & Beauty',
    keys: ['barber', 'salon', 'spa', 'gym', 'clinic', 'dental', 'veterinary', 'tattoo', 'pharmacy'],
  },
  {
    label: 'Professional Services',
    keys: ['consultant', 'tutor', 'photographer', 'real_estate', 'travel_agency', 'coworking', 'laundry', 'tailor', 'funeral'],
  },
  {
    label: 'Retail & Commerce',
    keys: ['shop', 'instagram_vendor', 'mall_vendor', 'logistics', 'car_wash', 'car_park'],
  },
  {
    label: 'Religious & Education',
    keys: ['church', 'mosque', 'school', 'ngo', 'crowdfunding_org'],
  },
  {
    label: 'Entertainment & Transport',
    keys: ['events', 'cinema', 'transport', 'taxi'],
  },
  {
    label: 'Government & Other',
    keys: ['government', 'other'],
  },
];

type WizardStep = 'auth' | 'category' | 'plan' | 'details' | 'success';
type AuthSubStep = 'phone' | 'otp';
type AuthMode = 'phone' | 'email';
type WhatsAppMethod = 'shared' | 'transfer' | 'coexist';
type ConnectSubStep = 'choose' | 'warnings' | 'setup' | 'phone_select';

/* ─── Side Panel Content per Step ─── */

const STEP_PANELS: Record<WizardStep, { title: string; subtitle: string; bullets: string[]; visual: string }> = {
  auth: {
    title: 'Join 100+ businesses',
    subtitle: 'Create your account in seconds to get started with WhatsApp automation.',
    bullets: ['No credit card required', '7-day free trial', 'Setup in under 5 minutes'],
    visual: '&#x1F512;',
  },
  category: {
    title: 'Tell us about your business',
    subtitle: 'Select your country and industry to get started.',
    bullets: ['Available in 5 countries', '40+ business categories', 'Industry-specific automation'],
    visual: '&#x1F3ED;',
  },
  plan: {
    title: 'Choose your plan',
    subtitle: 'Each plan unlocks more capabilities for your business.',
    bullets: ['Free 7-day trial', 'Pay-as-you-go transaction fees', 'Upgrade or downgrade anytime', 'Pro & Premium: connect your own WhatsApp number'],
    visual: '&#x1F4B3;',
  },
  details: {
    title: 'Business information',
    subtitle: 'Set up your business profile and WhatsApp connection.',
    bullets: ['Google address autocomplete', 'Localized payment gateways', 'Custom WhatsApp bot code'],
    visual: '&#x1F4CD;',
  },
  success: {
    title: 'You\'re live!',
    subtitle: 'Your WhatsApp automation is ready. Share your link and start accepting customers.',
    bullets: ['Share your WhatsApp link', 'Test the bot yourself', 'Manage everything from your dashboard'],
    visual: '&#x1F680;',
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
    title: 'Use Waaiio\'s WhatsApp Number',
    badge: 'Easiest',
    badgeColor: 'bg-green-100 text-green-700',
    description: 'Your bot runs on our shared WhatsApp number. Customers text a unique code to reach your business.',
    pros: [
      'Instant setup — no configuration needed',
      'No Facebook Business account required',
      'Free — no additional number costs',
      'Perfect for testing and small businesses',
    ],
    cons: [
      'Shared number (not branded to your business)',
      'Customers must text your bot code to start',
      'Cannot use WhatsApp Business features (catalog, status)',
    ],
  },
  {
    key: 'transfer',
    title: 'Transfer Your Own Number',
    badge: 'Recommended',
    badgeColor: 'bg-brand-100 text-brand-700',
    description: 'Disconnect your existing WhatsApp and transfer the number to Waaiio via Facebook Business. Fully branded.',
    pros: [
      'Customers message YOUR number directly',
      'Fully branded experience — your name, your number',
      'Access to WhatsApp Business API features',
      'Best for established businesses with existing customers',
    ],
    cons: [
      'You lose personal WhatsApp on this number',
      'Requires Facebook Business Manager account',
      'Setup takes 10-30 minutes',
      'Chat history is NOT transferred',
    ],
  },
  {
    key: 'coexist',
    title: 'WhatsApp Business Coexistence',
    badge: 'Beta',
    badgeColor: 'bg-amber-100 text-amber-700',
    description: 'Keep your WhatsApp Business app running AND connect to Waaiio automation simultaneously.',
    pros: [
      'Keep your WhatsApp Business app active',
      'Bot handles automated flows, you handle personal chats',
      'No need to give up your current WhatsApp',
      'Great for businesses already using WhatsApp Business',
    ],
    cons: [
      'Requires WhatsApp Business app (not regular WhatsApp)',
      'Requires Facebook Business Manager account',
      'Some features limited in coexistence mode',
      'Meta policy: 24-hour messaging window applies',
    ],
  },
];

/* ─── Warnings for connecting own number ─── */

const OWN_NUMBER_WARNINGS = [
  {
    number: 1,
    title: 'Personal WhatsApp access ends',
    text: 'You will no longer be able to use this WhatsApp number for personal use. You\'ll need to disconnect it first. You can use a different number for personal WhatsApp.',
  },
  {
    number: 2,
    title: '24-hour messaging window',
    text: 'By Meta\'s policy, you can reply to customers within 24 hours of their last message. After that period, you\'ll need to use pre-approved WhatsApp message templates to reach them.',
  },
  {
    number: 3,
    title: 'Some features won\'t work',
    text: 'Your WhatsApp Business app will stop working after connecting, along with some features like contact lists, voice calls, group chats, and group calls.',
  },
  {
    number: 4,
    title: 'Chat history won\'t transfer',
    text: 'Your existing chat history won\'t be transferred. Back up your chats first — check out backup options for iPhone and Android in WhatsApp settings.',
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

function OnboardingWizard() {
  useCategoryConfig(); // trigger DB load for category templates
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedPlan = searchParams.get('plan') as SubscriptionTier | null;
  const successBusinessId = searchParams.get('business_id');
  const successStep = searchParams.get('step');

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

  useEffect(() => {
    loadCountries().then(() => setCountryList(getCountryList()));
  }, []);

  // Category
  const [category, setCategory] = useState<BusinessCategoryKey | ''>('');
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [selectedCapabilities, setSelectedCapabilities] = useState<CapabilityId[]>([]);

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
  const [fbConnectionData, setFbConnectionData] = useState<{
    waba_id: string;
    phone_number_id: string;
    access_token: string;
    token_expires_at: string | null;
    display_name?: string;
    phone_number?: string;
  } | null>(null);

  // Discovered WABAs and phones from Facebook
  const [discoveredWabas, setDiscoveredWabas] = useState<Array<{
    waba_id: string;
    waba_name: string;
    phones: Array<{
      id: string;
      display_phone_number: string;
      verified_name: string;
      quality_rating: string;
    }>;
  }>>([]);
  const [selectedWabaId, setSelectedWabaId] = useState('');
  const [selectedPhoneId, setSelectedPhoneId] = useState('');

  // Plan & payment
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionTier>(
    preselectedPlan && ['growth', 'business'].includes(preselectedPlan) ? preselectedPlan : 'growth'
  );
  const [businessId, setBusinessId] = useState('');
  const [botCode, setBotCode] = useState('');

  // Success state
  const [successData, setSuccessData] = useState<{ bot_code: string; business_id: string } | null>(null);

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
      plan: 'onboarding_plan',
      details: 'onboarding_details',
      success: 'onboarding_success',
    };
    ph.capture(stepMap[step], { step, category: category || undefined, country: selectedCountry });
  }, [step]);

  useEffect(() => {
    if (step !== 'success' || successData) return;
    if (!successBusinessId) return;

    const ref = searchParams.get('reference') || searchParams.get('trxref');
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
      const supabase = createClient();
      await supabase.auth.signInWithOtp({ phone });
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

      setStep('plan');
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
          body: JSON.stringify({ business_id: data.business_id, plan: 'free' }),
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
          body: JSON.stringify({ business_id: data.business_id, plan: selectedPlan }),
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
        body: JSON.stringify({ business_id: businessId, plan: selectedPlan }),
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
        body: JSON.stringify({ business_id: businessId, plan: 'free' }),
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
    { key: 'category', label: 'Category' },
    { key: 'plan', label: 'Plan' },
    { key: 'details', label: 'Details' },
    { key: 'success', label: 'Live!' },
  ];

  const stepIndex = steps.findIndex(s => s.key === step);

  if (loading && step === 'auth') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  const countryCities = getCitiesForCountry(selectedCountry);
  const cityOptions = Object.entries(countryCities).map(([key, val]) => ({ value: key, label: val.name }));
  // neighborhoodOptions removed — using Google Places autocomplete now

  // For shared numbers: wa.me/{waaiioNumber}?text={botCode}
  // For dedicated numbers (transfer/coexist): wa.me/{theirOwnNumber} (no bot code needed)
  const sharedNumber = WHATSAPP_NUMBERS[selectedCountry];
  const dedicatedNumber = fbConnectionData?.phone_number?.replace(/[^0-9]/g, '') || ownPhone.replace(/[^0-9]/g, '');
  const waNumber = waMethod !== 'shared' && dedicatedNumber ? dedicatedNumber : sharedNumber;
  const waLink = waMethod !== 'shared' && dedicatedNumber
    ? `https://wa.me/${dedicatedNumber}`
    : `https://wa.me/${sharedNumber}?text=${encodeURIComponent(successData?.bot_code || botCode)}`;
  const localTiers = getPricingTiers(selectedCountry);
  const panel = STEP_PANELS[step];

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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Waaiio" className="h-8 brightness-0 invert" />
          </Link>

          <div className="flex-1 flex flex-col justify-center">
            <div className="mb-6 text-6xl" dangerouslySetInnerHTML={{ __html: panel.visual }} />
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Waaiio" className="h-7" />
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

            {error && (
              <div className="mb-6 rounded-xl bg-red-50 border border-red-100 p-4 text-sm text-red-700">
                {error}
                <button onClick={() => setError('')} className="ml-2 font-semibold underline">Dismiss</button>
              </div>
            )}

            {/* ── Step 1: Auth ── */}
            {step === 'auth' && (
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Create your account</h2>
                <p className="mt-1 text-sm text-gray-500">Sign up with your email and password</p>

                {emailSent ? (
                  <div className="mt-6 rounded-xl border border-brand-100 bg-brand-50 p-6 text-center">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-2xl">
                      &#9993;
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900">Check your inbox</h3>
                    <p className="mt-2 text-sm text-gray-600">
                      We sent a confirmation link to <span className="font-medium text-gray-900">{email}</span>.
                      Click the link to verify your email and continue setup.
                    </p>
                    <button
                      type="button"
                      disabled={authLoading}
                      onClick={async () => {
                        setAuthLoading(true);
                        const supabase = createClient();
                        await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/get-started` } });
                        setAuthLoading(false);
                      }}
                      className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                    >
                      {authLoading ? 'Sending...' : 'Resend email'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEmailSent(false); setEmail(''); setPassword(''); }}
                      className="mt-3 block w-full text-center text-sm text-gray-500 hover:text-brand"
                    >
                      Use a different email
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleEmailSignup} className="mt-6 space-y-4">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">Email</label>
                      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required autoComplete="email" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">Password</label>
                      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 6 characters" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required minLength={6} autoComplete="new-password" />
                    </div>
                    <button type="submit" disabled={!email || !password || authLoading} className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
                      {authLoading ? 'Creating account...' : 'Create Account'}
                    </button>
                    <p className="mt-4 text-center text-sm text-gray-500">
                      Already have an account?{' '}
                      <a href="/login" className="font-medium text-brand hover:underline">Log in</a>
                    </p>
                  </form>
                )}
              </div>
            )}

            {/* ── Step 2: Category ── */}
            {step === 'category' && (
              <div>
                <>
                    <h2 className="text-2xl font-bold text-gray-900">Where is your business?</h2>
                    <p className="mt-1 text-sm text-gray-500">Select your country and industry</p>
                    <div className="mt-6">
                      <label className="mb-2 block text-sm font-medium text-gray-700">Country</label>
                      <div className="flex flex-wrap gap-2">
                        {countryList.map(c => (
                          <button key={c.code} type="button" onClick={() => { setSelectedCountry(c.code); setCity(''); }}
                            className={`flex items-center gap-2 rounded-xl border-2 px-4 py-2.5 text-sm font-medium transition ${selectedCountry === c.code ? 'border-brand bg-brand-50 text-brand' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                            <span>{c.flag}</span><span>{c.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-8">
                      <label className="mb-2 block text-sm font-medium text-gray-700">Industry</label>
                      <select
                        value={selectedGroupIndex}
                        onChange={(e) => setSelectedGroupIndex(Number(e.target.value))}
                        className="mb-4 w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
                      >
                        {CATEGORY_GROUPS.map((group, i) => (
                          <option key={group.label} value={i}>{group.label}</option>
                        ))}
                      </select>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {CATEGORY_GROUPS[selectedGroupIndex].keys
                          .map(k => getCategoryByKey(k))
                          .filter((cat): cat is NonNullable<typeof cat> => !!cat)
                          .map((cat) => (
                            <button key={cat.key} type="button" onClick={() => {
                              setCategory(cat.key as BusinessCategoryKey);
                              const defaults = CATEGORY_DEFAULT_CAPABILITIES[cat.key as BusinessCategoryKey] || ['scheduling'];
                              setSelectedCapabilities([...defaults]);
                            }}
                              className={`flex items-center gap-3 rounded-xl border-2 px-3 py-3 text-left transition ${category === cat.key ? 'border-brand bg-brand-50' : 'border-gray-200 hover:border-gray-300'}`}>
                              <span className="text-xl">{cat.icon}</span>
                              <span className="text-xs font-medium text-gray-700">{cat.label}</span>
                            </button>
                          ))}
                      </div>
                    </div>
                    {category && (
                      <div className="mt-4 rounded-xl bg-brand-50 border border-brand-100 px-4 py-3">
                        <p className="text-xs text-gray-600">
                          <span className="font-semibold text-brand">{categoryInfo?.label}</span> — default capabilities: {(CATEGORY_DEFAULT_CAPABILITIES[category] || ['scheduling']).join(', ')}
                        </p>
                      </div>
                    )}
                    <div className="mt-8">
                      <button type="button" onClick={() => setStep('plan')} disabled={!category} className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">Continue</button>
                    </div>
                  </>
              </div>
            )}

            {/* ── Step 3: Plan ── */}
            {step === 'plan' && (
              <div>
                <button type="button" onClick={() => setStep('category')} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  Back
                </button>
                <h2 className="text-2xl font-bold text-gray-900">Choose your plan</h2>
                <p className="mt-1 text-sm text-gray-500">
                  Select the plan that fits your business needs. Each tier unlocks more capabilities.
                </p>

                <div className="mt-6 space-y-4">
                  {/* Free / Starter */}
                  <button type="button" onClick={() => setSelectedPlan('free')} className={`w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'free' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-bold text-gray-900">{localTiers.free.name}</h3>
                        <p className="text-2xl font-bold text-brand">{formatCurrency(0, selectedCountry)} <span className="text-sm font-normal text-gray-400">7-day trial</span></p>
                      </div>
                      <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'free' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
                        {selectedPlan === 'free' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-gray-600">Try Waaiio risk-free. Accept bookings, collect payments, and chat with customers on WhatsApp.</p>
                    <ul className="mt-3 space-y-1.5 text-xs text-gray-500">
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Auto-book appointments &amp; take orders</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Collect payments via WhatsApp</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Up to 50 bookings/month</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> {localTiers.free.feePercentage}% per transaction — no monthly fee</li>
                    </ul>
                  </button>

                  {/* Growth / Pro */}
                  <button type="button" onClick={() => setSelectedPlan('growth')} className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'growth' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
                    <span className="absolute -top-3 right-4 rounded-full bg-accent px-3 py-0.5 text-xs font-bold text-gray-900">Most Popular</span>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-bold text-gray-900">{localTiers.growth.name}</h3>
                        <p className="text-2xl font-bold text-brand">{formatCurrency(localTiers.growth.price as number, selectedCountry)}<span className="text-sm font-normal text-gray-400">/mo</span></p>
                      </div>
                      <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'growth' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
                        {selectedPlan === 'growth' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-gray-600">Grow faster with automated reminders, loyalty rewards, and your own WhatsApp number.</p>
                    <ul className="mt-3 space-y-1.5 text-xs text-gray-500">
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Everything in Starter</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Automated reminders — reduce no-shows by 60%</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Loyalty points &amp; referral program — customers come back</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Up to 500 bookings/month &middot; Lower {localTiers.growth.feePercentage}% fees</li>
                      <li className="flex items-center gap-2"><span className="text-brand">&#9733;</span> <span className="font-medium text-gray-700">Connect your own WhatsApp number</span></li>
                    </ul>
                  </button>

                  {/* Business / Premium */}
                  <button type="button" onClick={() => setSelectedPlan('business')} className={`w-full rounded-2xl border-2 p-5 text-left transition ${selectedPlan === 'business' ? 'border-brand bg-brand-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-bold text-gray-900">{localTiers.business.name}</h3>
                        <p className="text-2xl font-bold text-brand">{formatCurrency(localTiers.business.price as number, selectedCountry)}<span className="text-sm font-normal text-gray-400">/mo</span></p>
                      </div>
                      <div className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selectedPlan === 'business' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
                        {selectedPlan === 'business' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-gray-600">Full platform with unlimited bookings, e-signatures, staff management, and your brand — not ours.</p>
                    <ul className="mt-3 space-y-1.5 text-xs text-gray-500">
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Everything in Pro</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Unlimited bookings &amp; conversations</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> WhatsApp Sign — send documents for e-signature</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Staff management, queue, waitlist, invoices</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Whitelabel — your brand, not Waaiio</li>
                      <li className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Lowest fees: {localTiers.business.feePercentage}% per transaction</li>
                    </ul>
                  </button>
                </div>

                <div className="mt-8">
                  <button type="button" onClick={() => setStep('details')} disabled={!selectedPlan} className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* ── Step 3: Details ── */}
            {step === 'details' && (
              <form onSubmit={handleRegister}>
                <h2 className="text-2xl font-bold text-gray-900">{categoryInfo ? `${categoryInfo.label} Details` : 'Business Details'}</h2>
                <p className="mt-1 text-sm text-gray-500">Tell us about your {categoryInfo?.label.toLowerCase() || 'business'}</p>
                <div className="mt-6 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">First Name *</label>
                      <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)}
                        placeholder="e.g. Ayodeji"
                        className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">Last Name *</label>
                      <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)}
                        placeholder="e.g. Ogunleye"
                        className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">{categoryInfo?.label || 'Business'} Name *</label>
                    <input type="text" value={name} onChange={(e) => handleNameChange(e.target.value)}
                      placeholder={category === 'restaurant' ? 'e.g. Bukka Hut & Grill' : category === 'barber' ? "e.g. King's Cuts" : 'e.g. Your Business Name'}
                      className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
                    {nameCheckStatus === 'checking' && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                        Checking availability...
                      </p>
                    )}
                    {nameCheckStatus === 'available' && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-green-600">
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        Available
                      </p>
                    )}
                    {nameCheckStatus === 'taken' && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-600">
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        Name taken, will be adjusted automatically
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Your WhatsApp Business Name *</label>
                    <p className="mb-2 text-xs text-gray-500">
                      This is the name customers will text to the Waaiio WhatsApp number to find and interact with your business.
                      It also appears in your WhatsApp link. Pick something short, memorable, and easy to spell.
                    </p>
                    <input
                      type="text"
                      value={customBotCode}
                      onChange={(e) => handleBotCodeChange(e.target.value)}
                      placeholder="e.g. LOLAH-BEAUTY"
                      className="w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm uppercase outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
                      required
                    />
                    {botCodeStatus === 'checking' && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                        Checking availability...
                      </p>
                    )}
                    {botCodeStatus === 'available' && customBotCode.length >= 2 && (
                      <div className="mt-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          Available!
                        </p>
                        <p className="mt-1 text-xs text-green-600">
                          Customers will text <strong>&quot;{customBotCode}&quot;</strong> to the Waaiio WhatsApp number to reach your business.
                        </p>
                      </div>
                    )}
                    {botCodeStatus === 'taken' && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-red-600">
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        Already taken. Try something different like &quot;{suggestedBotCode ? suggestedBotCode + '-' + (name.split(' ')[name.split(' ').length - 1]?.toUpperCase().slice(0, 4) || 'BIZ') : 'YOUR-CODE'}&quot;
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Address *</label>
                    <AddressAutocomplete
                      defaultValue={address}
                      countryCode={selectedCountry}
                      onSelect={(result) => {
                        setAddress(result.address);
                        setCity(result.city);
                        setState(result.state);
                        setZipCode(result.zipCode);
                      }}
                      onManualChange={(val) => setAddress(val)}
                    />
                    <p className="mt-1 text-xs text-gray-400">Start typing to search — city, state, and zip will auto-fill</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">City *</label>
                      <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">State</label>
                      <input type="text" value={state} onChange={(e) => setState(e.target.value)} placeholder="State / Province" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">Zip Code</label>
                      <input type="text" value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="Zip / Postal" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Phone *</label>
                    <PhoneInput value={businessPhone} onChange={setBusinessPhone} />
                  </div>
                </div>
                {/* WhatsApp Connection (Pro/Premium only) */}
                {selectedPlan !== 'free' && (
                  <div className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-5">
                    <h3 className="text-sm font-bold text-gray-900">WhatsApp Connection</h3>
                    <p className="mt-1 text-xs text-gray-500">As a {selectedPlan === 'growth' ? 'Pro' : 'Premium'} user, you can connect your own WhatsApp number.</p>
                    <div className="mt-4 space-y-2">
                      <button type="button" onClick={() => setWaMethod('shared')} className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition ${waMethod === 'shared' ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'}`}>
                        <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${waMethod === 'shared' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
                          {waMethod === 'shared' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">Use Waaiio&apos;s shared number</p>
                          <p className="text-xs text-gray-500">Get started instantly — no setup needed</p>
                        </div>
                      </button>
                      <button type="button" onClick={() => setWaMethod('transfer')} className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition ${waMethod !== 'shared' ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'}`}>
                        <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${waMethod !== 'shared' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
                          {waMethod !== 'shared' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">Connect my own WhatsApp number</p>
                          <p className="text-xs text-gray-500">Use your existing business or personal number</p>
                        </div>
                      </button>
                    </div>
                    {waMethod !== 'shared' && (
                      <div className="mt-4 space-y-4">
                        {/* Facebook Embedded Signup */}
                        {!fbConnected ? (
                          <div className="rounded-xl border border-gray-200 bg-white p-4">
                            <div className="flex items-center gap-3 mb-3">
                              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1877F2]">
                                <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                                </svg>
                              </div>
                              <div>
                                <h4 className="text-sm font-bold text-gray-900">Connect with Facebook</h4>
                                <p className="text-xs text-gray-500">Link your WhatsApp Business Account</p>
                              </div>
                            </div>
                            {fbConnecting ? (
                              <div className="flex flex-col items-center py-4">
                                <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                                <p className="mt-3 text-xs text-gray-500">Complete the signup in the popup...</p>
                                <button type="button" onClick={() => setFbConnecting(false)} className="mt-2 text-xs text-gray-400 hover:text-brand underline">Cancel</button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={launchWhatsAppSignup}
                                disabled={!fbSdkReady}
                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1877F2] py-3 text-sm font-bold text-white transition hover:bg-[#166FE5] disabled:opacity-50"
                              >
                                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                                </svg>
                                {fbSdkReady ? 'Connect with Facebook' : 'Loading Facebook...'}
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="rounded-xl border-2 border-green-200 bg-green-50 p-4">
                            <div className="flex items-center gap-3">
                              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-green-100">
                                <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                              <div>
                                <h4 className="text-sm font-bold text-green-900">Facebook Connected</h4>
                                <p className="text-xs text-green-700">{discoveredWabas[0]?.waba_name || 'WhatsApp Business Account linked'}</p>
                              </div>
                              <button type="button" onClick={() => { setFbConnected(false); setFbConnectionData(null); setDiscoveredWabas([]); }} className="ml-auto text-xs text-green-600 hover:underline">Reconnect</button>
                            </div>
                          </div>
                        )}

                        {/* Phone number + Display name */}
                        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
                          <div>
                            <label className="mb-1.5 block text-sm font-medium text-gray-700">WhatsApp Phone Number *</label>
                            <PhoneInput value={ownPhone} onChange={setOwnPhone} countryCode={selectedCountry} />
                            <p className="mt-1 text-xs text-gray-400">The number you want to use with Waaiio</p>
                          </div>
                          <div>
                            <label className="mb-1.5 block text-sm font-medium text-gray-700">WhatsApp Display Name</label>
                            <input
                              type="text"
                              value={fbConnectionData?.display_name || ''}
                              onChange={(e) => setFbConnectionData(prev => prev ? { ...prev, display_name: e.target.value } : { waba_id: '', phone_number_id: '', access_token: '', token_expires_at: '', display_name: e.target.value })}
                              placeholder={name || 'Your business name on WhatsApp'}
                              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
                            />
                          </div>
                        </div>

                        <p className="text-xs text-gray-400 text-center">You can also set this up later from your dashboard settings.</p>
                      </div>
                    )}
                  </div>
                )}

                {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

                <div className="mt-8 flex gap-3">
                  <button type="button" onClick={() => setStep('plan')} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
                  <button type="submit" disabled={loading || !firstName || !lastName || !name || !city || !address || !businessPhone || !customBotCode || customBotCode.length < 2 || botCodeStatus === 'taken'} className={`flex-1 rounded-xl py-3.5 text-sm font-bold transition disabled:opacity-50 ${selectedPlan === 'free' ? 'bg-brand text-white hover:bg-brand-600' : 'bg-accent text-gray-900 shadow-lg shadow-accent/20 hover:bg-accent-400'}`}>
                    {loading ? 'Setting up...' : selectedPlan === 'free' ? 'Start Free Trial' : `Pay ${formatCurrency(localTiers[selectedPlan]?.price as number || 0, selectedCountry)}/mo & Launch`}
                  </button>
                </div>
              </form>
            )}

            {/* Persona and Connect steps removed — persona is post-signup, connect is merged into details */}
            {/* Old plan step removed — now in step 3 above */}

            {/* ── Step 7: Success ── */}
            {step === 'success' && (
              <div className="text-center">
                {loading ? (
                  <div className="py-16">
                    <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-brand border-t-transparent" />
                    <p className="mt-4 text-sm text-gray-500">Verifying payment...</p>
                  </div>
                ) : successData ? (
                  <>
                    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
                      <svg className="h-10 w-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <h2 className="mt-6 text-2xl font-bold text-gray-900">Your automation is live!</h2>
                    <p className="mt-2 text-sm text-gray-500">
                      {waMethod === 'shared'
                        ? 'Share this link with customers to start taking '
                        : 'Your WhatsApp number is being connected. In the meantime, share this test link: '}
                      {selectedCapabilities.includes('scheduling') ? 'bookings' : selectedCapabilities.includes('ordering') ? 'orders' : selectedCapabilities.includes('ticketing') ? 'tickets' : 'payments'}
                    </p>

                    {waMethod !== 'shared' && (
                      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left">
                        <p className="text-xs font-semibold text-amber-800">WhatsApp Number Connection</p>
                        <p className="mt-1 text-xs text-amber-700">
                          Our team is setting up your dedicated WhatsApp number. You&apos;ll receive an email when it&apos;s ready (usually within 24 hours). For now, you can test using our shared number below.
                        </p>
                      </div>
                    )}

                    <div className="mt-6 rounded-2xl bg-green-50 border border-green-200 p-6">
                      <p className="text-xs font-bold uppercase tracking-wider text-green-700">Your WhatsApp Link</p>
                      <p className="mt-3 break-all text-sm font-mono text-green-900">{waLink}</p>
                    </div>

                    <div className="mt-6"><QRCodeDisplay value={waLink} /></div>

                    <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
                      <button type="button" onClick={() => navigator.clipboard.writeText(waLink)} className="rounded-xl border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50">Copy Link</button>
                      <a href={waLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-bold text-white transition" style={{ backgroundColor: '#25D366' }}>
                        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                        Test on WhatsApp
                      </a>
                    </div>

                    <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <p className="text-sm font-medium text-amber-800">Set up your payout account</p>
                      <p className="mt-1 text-xs text-amber-700">
                        Add your bank details so you can receive customer payments directly.
                      </p>
                      <a href="/dashboard/payouts" className="mt-2 inline-block text-sm font-semibold text-brand hover:underline">
                        Set up now &rarr;
                      </a>
                    </div>

                    <div className="mt-10 border-t border-gray-200 pt-8">
                      <a href="/dashboard" className="inline-block rounded-xl bg-brand px-8 py-3.5 text-sm font-bold text-white transition hover:bg-brand-600">Go to Dashboard</a>
                    </div>
                  </>
                ) : (
                  <div className="py-16">
                    <p className="text-sm text-gray-500">{error || 'Something went wrong. Please contact support.'}</p>
                    <button type="button" onClick={() => { setStep('plan'); setError(''); }} className="mt-4 text-sm font-semibold text-brand hover:underline">Try again</button>
                  </div>
                )}
              </div>
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

export default function GetStartedPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    }>
      <OnboardingWizard />
    </Suspense>
  );
}
