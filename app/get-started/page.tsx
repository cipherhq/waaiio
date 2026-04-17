'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { OtpInput } from '@/components/auth/OtpInput';
import {
  BUSINESS_CATEGORIES,
  CATEGORY_FLOW_MAP,
  formatCurrency,
  getPricingTiers,
  getCitiesForCountry,
  type BusinessCategoryKey,
  type SubscriptionTier,
  type CountryCode,
} from '@/lib/constants';
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

type WizardStep = 'auth' | 'category' | 'details' | 'persona' | 'connect' | 'plan' | 'success';
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
    subtitle: 'We support 40+ business categories with 6 capability types.',
    bullets: ['Scheduling, payments, ordering, ticketing', 'Crowdfunding and reminders', 'Mix & match capabilities per business', 'Industry-specific customizations'],
    visual: '&#x1F3ED;',
  },
  details: {
    title: 'Business information',
    subtitle: 'This helps us customize your WhatsApp bot for your location and customers.',
    bullets: ['Available in 5 countries', 'Localized payment gateways', 'City-specific neighborhoods'],
    visual: '&#x1F4CD;',
  },
  persona: {
    title: 'Make it yours',
    subtitle: 'Give your bot a name and greeting that matches your brand personality.',
    bullets: ['Custom assistant name', 'Personalized greeting message', 'Live preview as you type'],
    visual: '&#x1F916;',
  },
  connect: {
    title: 'Connect WhatsApp',
    subtitle: 'Choose how to connect your business to WhatsApp. Reach 2 billion users worldwide.',
    bullets: ['Use our shared number instantly', 'Transfer your own number', 'Coexist with WhatsApp Business', 'Facebook Business integration'],
    visual: '&#x1F4AC;',
  },
  plan: {
    title: 'Choose your plan',
    subtitle: 'Start free and upgrade when you\'re ready. No contracts, cancel anytime.',
    bullets: ['Free 7-day trial', 'Pay-as-you-go transaction fees', 'Upgrade or downgrade anytime'],
    visual: '&#x1F4B3;',
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
  const [neighborhood, setNeighborhood] = useState('');
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
          setStep('connect');
        } else {
          setStep('category');
        }
      }
      setLoading(false);
    });
  }, [successStep, successBusinessId]);

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
    setAuthLoading(true);
    setError('');
    try {
      const supabase = createClient();
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/get-started`,
        },
      });
      if (signUpError) { setError(signUpError.message); return; }
      if (signUpData.session) {
        setUser(signUpData.user);
        setStep('category');
      } else if (signUpData.user) {
        setEmailSent(true);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      setError('Network error. Please try again.');
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
                setConnectSubStep('phone_select');
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
    if (!name || !city || !neighborhood || !address || !businessPhone || !category) return;
    setLoading(true);
    setError('');
    try {
      // Step 1: Register the business
      const registerRes = await fetch('/api/onboarding/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, city, neighborhood, address,
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
    if (!name || !city || !neighborhood || !address || !businessPhone || !category) return;
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
          neighborhood,
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
      setStep('plan');
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
  const categoryInfo = category ? BUSINESS_CATEGORIES.find(c => c.key === category) : null;

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
    { key: 'details', label: 'Details' },
    { key: 'persona', label: 'Persona' },
    { key: 'connect', label: 'Connect' },
    { key: 'plan', label: 'Plan' },
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
  const neighborhoodOptions = city && countryCities[city as keyof typeof countryCities]
    ? countryCities[city as keyof typeof countryCities].neighborhoods.map((n: string) => ({ value: n, label: n }))
    : [];

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
                <p className="mt-1 text-sm text-gray-500">Get started with WhatsApp automation in minutes</p>

                <div className="mt-6 flex rounded-xl bg-gray-100 p-1">
                  <button type="button" onClick={() => { setAuthMode('email'); setError(''); }} className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition ${authMode === 'email' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>Email</button>
                  <button type="button" onClick={() => { setAuthMode('phone'); setError(''); }} className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition ${authMode === 'phone' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>Phone</button>
                </div>

                <p className="mt-4 text-sm text-gray-500">
                  {authMode === 'email' ? 'Sign up with your email and password' : authStep === 'phone' ? 'Enter your phone number to get started' : `We sent a 6-digit code to ${phone}`}
                </p>

                {authMode === 'email' && emailSent ? (
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
                ) : authMode === 'email' ? (
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
                  </form>
                ) : authStep === 'phone' ? (
                  <form onSubmit={handleSendOtp} className="mt-6 space-y-4">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">Phone Number</label>
                      <PhoneInput value={phone} onChange={setPhone} disabled={authLoading} />
                    </div>
                    <button type="submit" disabled={!phone || authLoading} className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
                      {authLoading ? 'Sending...' : 'Send OTP'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleVerifyOtp} className="mt-6 space-y-4">
                    <OtpInput value={otp} onChange={setOtp} disabled={authLoading} />
                    <button type="submit" disabled={otp.length !== 6 || authLoading} className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
                      {authLoading ? 'Verifying...' : 'Verify & Continue'}
                    </button>
                    <button type="button" onClick={() => { setAuthStep('phone'); setOtp(''); setError(''); }} className="w-full text-center text-sm text-gray-500 hover:text-brand">Change phone number</button>
                  </form>
                )}

                <p className="mt-8 text-center text-sm text-gray-500">
                  Already have an account?{' '}
                  <Link href="/login?redirect=/get-started" className="font-semibold text-brand hover:underline">Sign in</Link>
                </p>
              </div>
            )}

            {/* ── Step 2: Category ── */}
            {step === 'category' && (
              <div>
                {!showCapabilities ? (
                  <>
                    <h2 className="text-2xl font-bold text-gray-900">Where is your business?</h2>
                    <p className="mt-1 text-sm text-gray-500">Select your country and industry</p>
                    <div className="mt-6">
                      <label className="mb-2 block text-sm font-medium text-gray-700">Country</label>
                      <div className="flex flex-wrap gap-2">
                        {countryList.map(c => (
                          <button key={c.code} type="button" onClick={() => { setSelectedCountry(c.code); setCity(''); setNeighborhood(''); }}
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
                          .map(k => BUSINESS_CATEGORIES.find(c => c.key === k))
                          .filter((cat): cat is (typeof BUSINESS_CATEGORIES)[number] => !!cat)
                          .map((cat) => (
                            <button key={cat.key} type="button" onClick={() => {
                              setCategory(cat.key);
                              const defaults = CATEGORY_DEFAULT_CAPABILITIES[cat.key] || ['scheduling'];
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
                      <button type="button" onClick={() => setShowCapabilities(true)} disabled={!category} className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">Continue</button>
                    </div>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => setShowCapabilities(false)} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                      Change category
                    </button>
                    <h2 className="text-2xl font-bold text-gray-900">Confirm capabilities</h2>
                    <p className="mt-1 text-sm text-gray-500">
                      These are the default capabilities for <span className="font-semibold text-brand">{categoryInfo?.label}</span>. Toggle to customize.
                    </p>
                    <div className="mt-6 space-y-3">
                      {CAPABILITIES.map((cap) => {
                        const isSelected = selectedCapabilities.includes(cap.id);
                        const isDefault = (CATEGORY_DEFAULT_CAPABILITIES[category as BusinessCategoryKey] || []).includes(cap.id);
                        return (
                          <button
                            key={cap.id}
                            type="button"
                            onClick={() => {
                              setSelectedCapabilities(prev =>
                                prev.includes(cap.id)
                                  ? prev.filter(c => c !== cap.id)
                                  : [...prev, cap.id]
                              );
                            }}
                            className={`flex w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition ${
                              isSelected ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                            }`}
                          >
                            <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 ${
                              isSelected ? 'border-brand bg-brand' : 'border-gray-300'
                            }`}>
                              {isSelected && (
                                <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-lg">{cap.icon}</span>
                                <span className="text-sm font-semibold text-gray-900">{cap.label}</span>
                                {isDefault && (
                                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold text-brand">Default</span>
                                )}
                              </div>
                              <p className="mt-0.5 text-xs text-gray-500">{cap.description}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {selectedCapabilities.length === 0 && (
                      <p className="mt-3 text-xs text-red-500">Select at least one capability to continue.</p>
                    )}
                    <div className="mt-8">
                      <button
                        type="button"
                        onClick={() => setStep('details')}
                        disabled={selectedCapabilities.length === 0}
                        className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                      >
                        Continue
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Step 3: Details ── */}
            {step === 'details' && (
              <form onSubmit={(e) => { e.preventDefault(); setStep('persona'); }}>
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
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">City *</label>
                      <select value={city} onChange={(e) => { setCity(e.target.value); setNeighborhood(''); }} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required>
                        <option value="">Select city</option>
                        {cityOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700">Neighborhood *</label>
                      <select value={neighborhood} onChange={(e) => setNeighborhood(e.target.value)} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required disabled={!city}>
                        <option value="">Select area</option>
                        {neighborhoodOptions.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Address *</label>
                    <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 12 Admiralty Way, Lekki Phase 1" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Phone *</label>
                    <PhoneInput value={businessPhone} onChange={setBusinessPhone} />
                  </div>
                </div>
                <div className="mt-8 flex gap-3">
                  <button type="button" onClick={() => setStep('category')} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
                  <button type="submit" disabled={!firstName || !lastName || !name || !city || !neighborhood || !address || !businessPhone || !customBotCode || customBotCode.length < 2 || botCodeStatus === 'taken'} className="flex-1 rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">Continue</button>
                </div>
              </form>
            )}

            {/* ── Step 4: Persona ── */}
            {step === 'persona' && (
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Customize your bot</h2>
                <p className="mt-1 text-sm text-gray-500">Give your WhatsApp assistant a name and greeting (optional)</p>
                <div className="mt-6 space-y-5">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Assistant Name <span className="text-gray-400">(optional)</span></label>
                    <input type="text" value={botAlias} onChange={(e) => setBotAlias(e.target.value)}
                      placeholder={category === 'barber' ? 'e.g. King, Blade' : category === 'church' ? 'e.g. Grace Bot' : 'e.g. Your Assistant Name'}
                      className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Custom Greeting <span className="text-gray-400">(optional)</span></label>
                    <textarea value={botGreeting} onChange={(e) => setBotGreeting(e.target.value)} placeholder={defaultGreeting} rows={3} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" />
                  </div>
                  {/* Live preview */}
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                    <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Live Preview</p>
                    <div className="mx-auto max-w-xs overflow-hidden rounded-2xl border border-gray-200 shadow-lg">
                      <div className="flex items-center gap-3 px-4 py-2.5" style={{ backgroundColor: '#075E54' }}>
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-xs font-bold text-white">{(botAlias || name || 'S').charAt(0)}</div>
                        <div>
                          <p className="text-sm font-semibold text-white">{botAlias || name || 'Waaiio'}</p>
                          <p className="text-[10px] text-green-200">online</p>
                        </div>
                      </div>
                      <div className="space-y-2 p-3" style={{ backgroundColor: '#ECE5DD' }}>
                        <div className="flex justify-start">
                          <div className="max-w-[85%] whitespace-pre-line rounded-lg bg-white px-3 py-2 text-xs leading-relaxed text-gray-800">{botGreeting || defaultGreeting}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-8 flex gap-3">
                  <button type="button" onClick={() => setStep('details')} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
                  <button type="button" onClick={() => { setStep('connect'); setConnectSubStep('choose'); }} className="flex-1 rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600">Continue</button>
                </div>
              </div>
            )}

            {/* ── Step 5: Connect WhatsApp ── */}
            {step === 'connect' && (
              <div>
                {/* Sub-step: Choose method */}
                {connectSubStep === 'choose' && (
                  <>
                    <h2 className="text-2xl font-bold text-gray-900">How would you like to connect?</h2>
                    <p className="mt-1 text-sm text-gray-500">Reach 2 billion WhatsApp users worldwide</p>

                    <div className="mt-6 space-y-3">
                      {WA_OPTIONS.map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setWaMethod(opt.key)}
                          className={`relative w-full rounded-2xl border-2 p-5 text-left transition ${
                            waMethod === opt.key ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="text-sm font-bold text-gray-900">{opt.title}</h3>
                                {opt.badge && (
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${opt.badgeColor}`}>{opt.badge}</span>
                                )}
                              </div>
                              <p className="mt-1 text-xs text-gray-500">{opt.description}</p>
                            </div>
                            <div className={`mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                              waMethod === opt.key ? 'border-brand bg-brand' : 'border-gray-300'
                            }`}>
                              {waMethod === opt.key && (
                                <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                          </div>

                          {/* Pros & Cons */}
                          {waMethod === opt.key && (
                            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                              <div>
                                <p className="text-xs font-semibold text-green-700 mb-1.5">Advantages</p>
                                <ul className="space-y-1">
                                  {opt.pros.map((p) => (
                                    <li key={p} className="flex items-start gap-1.5 text-xs text-gray-600">
                                      <svg className="mt-0.5 h-3 w-3 flex-shrink-0 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                      </svg>
                                      {p}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              <div>
                                <p className="text-xs font-semibold text-red-600 mb-1.5">Limitations</p>
                                <ul className="space-y-1">
                                  {opt.cons.map((c) => (
                                    <li key={c} className="flex items-start gap-1.5 text-xs text-gray-600">
                                      <svg className="mt-0.5 h-3 w-3 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                      </svg>
                                      {c}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          )}
                        </button>
                      ))}
                    </div>

                    <div className="mt-8 flex gap-3">
                      <button type="button" onClick={() => setStep('persona')} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
                      <button type="button" onClick={handleConnectContinue}
                        className="flex-1 rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
                        {waMethod === 'shared' ? 'Continue' : 'Next'}
                      </button>
                    </div>
                  </>
                )}

                {/* Sub-step: Warnings */}
                {connectSubStep === 'warnings' && (
                  <>
                    <button type="button" onClick={() => setConnectSubStep('choose')} className="mb-6 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                      Back
                    </button>

                    <h2 className="text-2xl font-bold text-gray-900">Know before connecting your {waMethod === 'transfer' ? 'own' : 'business'} number</h2>
                    <p className="mt-1 text-sm text-gray-500">Please read these important points carefully</p>

                    <div className="mt-8 space-y-5">
                      {(waMethod === 'transfer' ? OWN_NUMBER_WARNINGS : COEXIST_WARNINGS).map((w) => (
                        <div key={w.number} className="flex gap-4">
                          <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${
                            w.number === 1 ? 'bg-red-500' : w.number === 2 ? 'bg-amber-500' : w.number === 3 ? 'bg-blue-500' : 'bg-gray-500'
                          }`}>
                            {w.number}
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold text-gray-900">{w.title}</h3>
                            <p className="mt-1 text-sm leading-relaxed text-gray-600">{w.text}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-10 flex gap-3">
                      <button type="button" onClick={() => setConnectSubStep('choose')} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
                      <button type="button" onClick={() => setConnectSubStep('setup')} className="flex-1 rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600">
                        I Understand, Continue
                      </button>
                    </div>

                    <p className="mt-4 text-center text-sm text-gray-400">
                      <button type="button" onClick={() => { setWaMethod('shared'); setConnectSubStep('choose'); }} className="text-brand hover:underline">
                        Use Waaiio&apos;s number instead (no setup needed)
                      </button>
                    </p>
                  </>
                )}

                {/* Sub-step: Facebook Business Setup */}
                {connectSubStep === 'setup' && (
                  <>
                    <button type="button" onClick={() => { setConnectSubStep('warnings'); setFbConnected(false); setFbConnecting(false); setFbConnectionData(null); setShowManualGuide(false); }} className="mb-6 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                      Back
                    </button>

                    <h2 className="text-2xl font-bold text-gray-900">
                      {waMethod === 'transfer' ? 'Connect your WhatsApp number' : 'Set up WhatsApp Business coexistence'}
                    </h2>
                    <p className="mt-1 text-sm text-gray-500">
                      {fbConnected
                        ? 'Your WhatsApp number is connected! Continue to choose your plan.'
                        : 'Connect your number instantly through Facebook, or set up manually.'}
                    </p>

                    {/* ── Success State ── */}
                    {fbConnected && fbConnectionData && (
                      <div className="mt-6">
                        <div className="rounded-2xl border-2 border-green-200 bg-green-50 p-6">
                          <div className="flex items-center gap-3">
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                              <svg className="h-6 w-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                            <div>
                              <h3 className="text-sm font-bold text-green-900">WhatsApp Connected Successfully</h3>
                              <p className="text-xs text-green-700">Your number is ready for automation</p>
                            </div>
                          </div>
                          {(fbConnectionData.display_name || fbConnectionData.phone_number) && (
                            <div className="mt-4 space-y-2 rounded-xl bg-white/60 p-3">
                              {fbConnectionData.display_name && (
                                <div className="flex items-center justify-between text-sm">
                                  <span className="text-gray-500">Display Name</span>
                                  <span className="font-medium text-gray-900">{fbConnectionData.display_name}</span>
                                </div>
                              )}
                              {fbConnectionData.phone_number && (
                                <div className="flex items-center justify-between text-sm">
                                  <span className="text-gray-500">Phone Number</span>
                                  <span className="font-medium text-gray-900">{fbConnectionData.phone_number}</span>
                                </div>
                              )}
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-gray-500">Connection Type</span>
                                <span className="font-medium text-gray-900 capitalize">{waMethod}</span>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="mt-8 flex gap-3">
                          <button type="button" onClick={() => { setFbConnected(false); setFbConnectionData(null); }} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Reconnect</button>
                          <button
                            type="button"
                            onClick={handleFbConnectAndRegister}
                            disabled={loading}
                            className="flex-1 rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                          >
                            {loading ? 'Setting up...' : (successStep === 'whatsapp' && successBusinessId) ? 'Save & Go to Dashboard' : 'Continue to Plan'}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Connecting State ── */}
                    {fbConnecting && !fbConnected && (
                      <div className="mt-8 flex flex-col items-center py-8">
                        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                        <p className="mt-4 text-sm font-medium text-gray-700">Connecting to Facebook...</p>
                        <p className="mt-1 text-xs text-gray-500">Complete the signup in the popup window</p>
                        <button
                          type="button"
                          onClick={() => setFbConnecting(false)}
                          className="mt-4 text-sm text-gray-500 hover:text-brand underline"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {/* ── Default State: Connect Buttons ── */}
                    {!fbConnected && !fbConnecting && (
                      <>
                        {/* Primary: Facebook Embedded Signup */}
                        <div className="mt-6">
                          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                            <div className="mb-4 flex items-center gap-3">
                              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1877F2]">
                                <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                                </svg>
                              </div>
                              <div>
                                <h3 className="text-sm font-bold text-gray-900">Quick Setup with Facebook</h3>
                                <p className="text-xs text-gray-500">Connect in under 2 minutes — no manual steps</p>
                              </div>
                            </div>
                            <p className="text-sm leading-relaxed text-gray-600">
                              Sign in with Facebook to automatically connect your WhatsApp Business number.
                              We&apos;ll handle the technical setup — no need to copy IDs or configure anything manually.
                            </p>
                            <button
                              type="button"
                              onClick={launchWhatsAppSignup}
                              disabled={!fbSdkReady}
                              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#1877F2] py-3.5 text-sm font-bold text-white transition hover:bg-[#166FE5] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                              </svg>
                              {fbSdkReady ? 'Connect with Facebook' : 'Loading Facebook...'}
                            </button>
                          </div>
                        </div>

                        {/* Divider */}
                        <div className="mt-6 flex items-center gap-4">
                          <div className="h-px flex-1 bg-gray-200" />
                          <span className="text-xs font-medium text-gray-400">or</span>
                          <div className="h-px flex-1 bg-gray-200" />
                        </div>

                        {/* Secondary: Manual Setup */}
                        <div className="mt-6">
                          <button
                            type="button"
                            onClick={() => setShowManualGuide(!showManualGuide)}
                            className="flex w-full items-center justify-between rounded-xl border border-gray-200 px-5 py-4 text-left transition hover:bg-gray-50"
                          >
                            <div>
                              <h3 className="text-sm font-semibold text-gray-900">Set up manually</h3>
                              <p className="text-xs text-gray-500">Follow step-by-step instructions to connect via Facebook Business Manager</p>
                            </div>
                            <svg className={`h-5 w-5 flex-shrink-0 text-gray-400 transition ${showManualGuide ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>

                          {showManualGuide && (
                            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-6">
                              {/* Phone number input */}
                              <div className="mb-6">
                                <label className="mb-2 block text-sm font-semibold text-gray-900">Phone number to connect</label>
                                <PhoneInput value={ownPhone} onChange={setOwnPhone} countryCode={selectedCountry} />
                                <p className="mt-2 text-xs text-gray-500">
                                  {waMethod === 'transfer'
                                    ? 'This number will be disconnected from personal WhatsApp and connected to Waaiio.'
                                    : 'This must be the number registered on your WhatsApp Business app.'}
                                </p>
                              </div>

                              {/* Before You Start */}
                              <div className="mb-6">
                                <h3 className="text-sm font-bold text-gray-900">Before you start</h3>
                                <p className="mt-1 text-xs text-gray-500">Make sure you have the following ready:</p>
                                <ul className="mt-3 space-y-2">
                                  {[
                                    'A Facebook account (personal — used to manage your business)',
                                    'Access to Facebook Business Manager (or create one)',
                                    'A verified WhatsApp Business Account (WABA)',
                                    'The phone number you want to connect',
                                    'Access to receive SMS or calls on that number (for verification)',
                                  ].map((item, i) => (
                                    <li key={i} className="flex items-start gap-2 text-xs text-gray-600">
                                      <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand">{i + 1}</span>
                                      {item}
                                    </li>
                                  ))}
                                </ul>
                              </div>

                              {/* Step-by-step guide */}
                              <div className="mb-6">
                                <h3 className="text-sm font-bold text-gray-900">Setup steps</h3>
                                <div className="mt-4 space-y-5">
                                  <SetupStep number={1} title="Create or access Facebook Business Manager" description="Go to Facebook Business Manager and create an account if you don't have one. Use your personal Facebook login." link="https://business.facebook.com" linkLabel="Open Facebook Business Manager" />
                                  <SetupStep number={2} title="Verify your WABA (WhatsApp Business Account)" description="In Business Manager, go to Business Settings > Accounts > WhatsApp Accounts. Create one if you don't have it." link="https://business.facebook.com/settings/whatsapp-business-accounts" linkLabel="WhatsApp Business Accounts Settings" />
                                  <SetupStep number={3} title="Add your phone number" description="In your WABA settings, click 'Add Phone Number' and verify via SMS or phone call." link="https://business.facebook.com/latest/whatsapp_manager/phone_numbers" linkLabel="WhatsApp Manager — Phone Numbers" />
                                  <SetupStep number={4} title="Verify the phone number" description="Enter the 6-digit verification code sent to your phone. Once verified, your number will show as 'Connected'." />
                                  <SetupStep number={5} title="Set your display name" description={`Set your display name to "${name || 'Your Business Name'}". Meta will review and approve it.`} link="https://www.facebook.com/business/help/338047025165344" linkLabel="Display Name Guidelines" />
                                  <SetupStep number={6} title="Share your WABA ID with us" description="Copy your WABA ID from Business Manager. We'll connect it to your Waaiio bot." note="Find your WABA ID in Business Settings > Accounts > WhatsApp Accounts." />
                                </div>
                              </div>

                              {/* Help links */}
                              <div className="mb-6 rounded-xl border border-blue-100 bg-blue-50 p-4">
                                <p className="text-xs font-semibold text-blue-800">Need help?</p>
                                <ul className="mt-2 space-y-1.5">
                                  <li><a href="https://www.facebook.com/business/help" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">Facebook Business Help Center &rarr;</a></li>
                                  <li><a href="https://faq.whatsapp.com/general/account-and-profile/about-whatsapp-business-accounts" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">About WhatsApp Business Accounts &rarr;</a></li>
                                </ul>
                              </div>

                              <div className="flex gap-3">
                                <button type="button" onClick={() => setConnectSubStep('warnings')} className="rounded-xl border border-gray-300 px-5 py-3 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
                                <button
                                  type="button"
                                  onClick={() => handleRegister({ preventDefault: () => {} } as React.FormEvent)}
                                  disabled={loading || !ownPhone}
                                  className="flex-1 rounded-xl bg-whatsapp py-3 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-50"
                                >
                                  {loading ? 'Connecting...' : 'Connect & Continue'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Fallback to shared number */}
                        <p className="mt-6 text-center text-sm text-gray-400">
                          Don&apos;t have a Facebook Business account?{' '}
                          <button type="button" onClick={() => { setWaMethod('shared'); handleRegister({ preventDefault: () => {} } as React.FormEvent); }} className="text-brand hover:underline">
                            Use Waaiio&apos;s number instead
                          </button>
                        </p>
                      </>
                    )}
                  </>
                )}

                {/* Sub-step: WABA Phone Selection */}
                {connectSubStep === 'phone_select' && discoveredWabas.length > 0 && (
                  <>
                    <button type="button" onClick={() => { setConnectSubStep('setup'); setDiscoveredWabas([]); setFbConnectionData(null); }} className="mb-6 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                      Back
                    </button>

                    <h2 className="text-2xl font-bold text-gray-900">Select your WhatsApp number</h2>
                    <p className="mt-1 text-sm text-gray-500">
                      Confirm which WhatsApp Business Account and phone number to connect with Waaiio.
                    </p>

                    {/* WABA Selection (if multiple) */}
                    {discoveredWabas.length > 1 && (
                      <div className="mt-6">
                        <label className="mb-2 block text-sm font-medium text-gray-700">WhatsApp Business Account</label>
                        <div className="space-y-2">
                          {discoveredWabas.map((waba) => (
                            <button
                              key={waba.waba_id}
                              type="button"
                              onClick={() => {
                                setSelectedWabaId(waba.waba_id);
                                if (waba.phones.length > 0) {
                                  setSelectedPhoneId(waba.phones[0].id);
                                } else {
                                  setSelectedPhoneId('');
                                }
                              }}
                              className={`flex w-full items-center gap-3 rounded-xl border-2 p-4 text-left transition ${
                                selectedWabaId === waba.waba_id ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                              }`}
                            >
                              <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                                selectedWabaId === waba.waba_id ? 'border-brand bg-brand' : 'border-gray-300'
                              }`}>
                                {selectedWabaId === waba.waba_id && (
                                  <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-semibold text-gray-900">{waba.waba_name}</p>
                                <p className="text-xs text-gray-500">ID: {waba.waba_id} &middot; {waba.phones.length} phone{waba.phones.length !== 1 ? 's' : ''}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Single WABA display */}
                    {discoveredWabas.length === 1 && (
                      <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                            <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{discoveredWabas[0].waba_name}</p>
                            <p className="text-xs text-gray-500">WhatsApp Business Account ID: {discoveredWabas[0].waba_id}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Phone Number Selection */}
                    {(() => {
                      const currentWaba = discoveredWabas.find(w => w.waba_id === selectedWabaId);
                      const phones = currentWaba?.phones || [];
                      return (
                        <div className="mt-6">
                          <label className="mb-2 block text-sm font-medium text-gray-700">
                            Phone Number {phones.length > 1 ? '(select one)' : ''}
                          </label>
                          {phones.length === 0 ? (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                              <p className="text-sm text-amber-800">No phone numbers found for this account.</p>
                              <p className="mt-1 text-xs text-amber-600">
                                Please add a phone number in the Facebook Embedded Signup flow or try again.
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {phones.map((phone) => (
                                <button
                                  key={phone.id}
                                  type="button"
                                  onClick={() => setSelectedPhoneId(phone.id)}
                                  className={`flex w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition ${
                                    selectedPhoneId === phone.id ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
                                  }`}
                                >
                                  <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                                    selectedPhoneId === phone.id ? 'border-brand bg-brand' : 'border-gray-300'
                                  }`}>
                                    {selectedPhoneId === phone.id && (
                                      <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                      </svg>
                                    )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-semibold text-gray-900">{phone.display_phone_number}</p>
                                      {phone.quality_rating && (
                                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                          phone.quality_rating === 'GREEN' ? 'bg-green-100 text-green-700' :
                                          phone.quality_rating === 'YELLOW' ? 'bg-amber-100 text-amber-700' :
                                          'bg-red-100 text-red-700'
                                        }`}>
                                          {phone.quality_rating === 'GREEN' ? 'High Quality' :
                                           phone.quality_rating === 'YELLOW' ? 'Medium Quality' :
                                           phone.quality_rating}
                                        </span>
                                      )}
                                    </div>
                                    {phone.verified_name && (
                                      <p className="text-xs text-gray-500">{phone.verified_name}</p>
                                    )}
                                    <p className="text-[11px] text-gray-400">ID: {phone.id}</p>
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Warning */}
                    <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <div className="flex gap-3">
                        <svg className="h-5 w-5 flex-shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <div>
                          <p className="text-sm font-semibold text-amber-800">Important</p>
                          <p className="mt-1 text-xs leading-relaxed text-amber-700">
                            This phone number will be connected to Waaiio for WhatsApp Business API messaging.
                            {waMethod === 'transfer' && ' You will no longer be able to use this number for personal WhatsApp.'}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-8 flex gap-3">
                      <button
                        type="button"
                        onClick={() => { setConnectSubStep('setup'); setDiscoveredWabas([]); setFbConnectionData(null); }}
                        className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          // Update connection data with selected values
                          if (fbConnectionData) {
                            const selectedWaba = discoveredWabas.find(w => w.waba_id === selectedWabaId);
                            const selectedPhone = selectedWaba?.phones.find(p => p.id === selectedPhoneId);
                            setFbConnectionData({
                              ...fbConnectionData,
                              waba_id: selectedWabaId,
                              phone_number_id: selectedPhoneId,
                              display_name: selectedPhone?.verified_name,
                              phone_number: selectedPhone?.display_phone_number,
                            });
                          }
                          setFbConnected(true);
                          setConnectSubStep('setup');
                        }}
                        disabled={!selectedWabaId || !selectedPhoneId}
                        className="flex-1 rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                      >
                        {(successStep === 'whatsapp' && successBusinessId) ? 'Connect Number' : 'Confirm & Continue'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Step 6: Plan & Pay ── */}
            {step === 'plan' && (
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Choose your plan</h2>
                <p className="mt-1 text-sm text-gray-500">Start free with a 7-day trial, or upgrade for more features</p>

                <div className="mt-6 space-y-3">
                  <PlanOption selected={selectedPlan === 'free'} onClick={() => setSelectedPlan('free')} name={localTiers.free.name} price={formatCurrency(0, selectedCountry)} period="" features={localTiers.free.features} />
                  <PlanOption selected={selectedPlan === 'growth'} onClick={() => setSelectedPlan('growth')} name={localTiers.growth.name} price={formatCurrency(localTiers.growth.price as number, selectedCountry)} period="/mo" features={localTiers.growth.features} popular />
                  <PlanOption selected={selectedPlan === 'business'} onClick={() => setSelectedPlan('business')} name={localTiers.business.name} price={formatCurrency(localTiers.business.price as number, selectedCountry)} period="/mo" features={localTiers.business.features} />
                </div>

                <div className="mt-8 flex gap-3">
                  <button type="button" onClick={() => { setStep('connect'); setConnectSubStep('choose'); }} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
                  {selectedPlan === 'free' ? (
                    <button type="button" onClick={handleStartFree} disabled={loading} className="flex-1 rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
                      {loading ? 'Activating...' : 'Start Free Trial'}
                    </button>
                  ) : (
                    <button type="button" onClick={handlePay} disabled={loading} className="flex-1 rounded-xl bg-accent py-3.5 text-sm font-bold text-gray-900 shadow-lg shadow-accent/20 transition hover:bg-accent-400 disabled:opacity-50">
                      {loading ? 'Processing...' : `Pay ${formatCurrency(localTiers[selectedPlan].price as number, selectedCountry)}`}
                    </button>
                  )}
                </div>
              </div>
            )}

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
