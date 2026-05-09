'use client';

import { useState, useEffect, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

type Step = 'loading' | 'existing' | 'choose' | 'enter-phone' | 'verify-otp' | 'pending-approval' | 'success';

interface ExistingChannel {
  id: string;
  phone_number: string;
  display_name: string;
  connection_status: string;
  channel_type: string;
  connection_method: string;
}

export default function ConnectWhatsAppPage() {
  const business = useBusiness();
  const router = useRouter();

  const [step, setStep] = useState<Step>('loading');
  const [existingChannel, setExistingChannel] = useState<ExistingChannel | null>(null);
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState(business.name || '');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedNumber, setConnectedNumber] = useState('');

  // FB SDK state
  const [fbSdkReady, setFbSdkReady] = useState(false);
  const fbSdkLoaded = useRef(false);
  const [fbConnecting, setFbConnecting] = useState(false);

  const appId = (process.env.NEXT_PUBLIC_META_APP_ID || '').trim();
  const configId = (process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID || '').trim();

  // Check for existing channel on load
  useEffect(() => {
    async function checkExisting() {
      const supabase = createClient();
      const { data: channel } = await supabase
        .from('whatsapp_channels')
        .select('id, phone_number, display_name, connection_status, channel_type, connection_method')
        .eq('business_id', business.id)
        .eq('channel_type', 'dedicated')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (channel) {
        setExistingChannel(channel);
        if (channel.connection_status === 'pending_verification') {
          setStep('verify-otp');
          setPhone(channel.phone_number);
        } else if (channel.connection_status === 'active') {
          setStep('existing');
        } else {
          setStep('existing');
        }
      } else {
        setStep('choose');
      }
    }
    checkExisting();
  }, [business.id]);

  // Load FB SDK (only when advanced flow is selected)
  const [showAdvanced, setShowAdvanced] = useState(false);
  useEffect(() => {
    if (!showAdvanced || !appId || fbSdkLoaded.current) return;
    window.fbAsyncInit = function () {
      if (fbSdkLoaded.current) return;
      window.FB.init({ appId, cookie: true, xfbml: true, version: 'v22.0' });
      fbSdkLoaded.current = true;
      setFbSdkReady(true);
    };
    const stale = document.getElementById('facebook-jssdk');
    if (stale) { stale.remove(); (window as any).FB = undefined; }
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);
  }, [showAdvanced, appId]);

  // ── Simple flow: Enter phone → Send OTP ──
  const handleSendOTP = async () => {
    if (!phone.trim()) { setError('Please enter a phone number'); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/add-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, phone_number: phone.trim(), display_name: displayName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to send code'); setLoading(false); return; }
      setStep('verify-otp');
    } catch { setError('Something went wrong. Try again.'); }
    setLoading(false);
  };

  // ── Simple flow: Verify OTP ──
  const handleVerifyOTP = async () => {
    if (!otp.trim() || otp.length < 6) { setError('Enter the 6-digit code'); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/add-number?action=verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, otp: otp.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Verification failed'); setLoading(false); return; }
      setConnectedNumber(data.phone_number);
      setStep('success');
    } catch { setError('Something went wrong. Try again.'); }
    setLoading(false);
  };

  // ── Advanced flow: Facebook Embedded Signup ──
  function launchFacebookLogin() {
    if (!window.FB || !fbSdkLoaded.current) {
      setError('Facebook is still loading. Please wait.');
      return;
    }
    setError(null);
    setFbConnecting(true);
    window.FB.login(
      function (response: any) {
        if (response.authResponse) {
          const accessToken = response.authResponse.accessToken || response.authResponse.code;
          fetch('/api/auth/facebook/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: accessToken, access_token: response.authResponse.accessToken }),
          })
            .then(r => r.json().then(d => ({ ok: r.ok, d })))
            .then(({ ok, d }) => {
              if (!ok) { setError(d.message || 'Failed'); setFbConnecting(false); return; }
              const wabas = d.wabas || [];
              if (wabas.length === 0) { setError('No WhatsApp Business Account found.'); setFbConnecting(false); return; }
              const waba = wabas[0];
              const ph = waba.phones?.[waba.phones.length - 1];
              fetch('/api/auth/facebook/callback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ business_id: business.id, waba_id: waba.waba_id, phone_number_id: ph?.id, access_token: d.access_token, token_expires_at: d.token_expires_at, display_name: ph?.display_phone_number || ph?.verified_name, phone_number: ph?.display_phone_number }),
              })
                .then(r => r.json().then(d2 => ({ ok: r.ok, d2 })))
                .then(({ ok: ok2, d2 }) => {
                  if (ok2) { setConnectedNumber(ph?.display_phone_number || 'Connected'); setStep('success'); }
                  else { setError(d2.error || d2.message || 'Failed to save.'); }
                  setFbConnecting(false);
                })
                .catch(() => { setError('Failed. Try again.'); setFbConnecting(false); });
            })
            .catch(() => { setError('Failed. Try again.'); setFbConnecting(false); });
        } else { setFbConnecting(false); setError('Cancelled.'); }
      },
      { config_id: configId, response_type: 'code token', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } },
    );
  }

  // ── Loading ──
  if (step === 'loading') {
    return (
      <div className="max-w-lg mx-auto mt-12 text-center">
        <div className="animate-spin h-8 w-8 border-2 border-brand border-t-transparent rounded-full mx-auto" />
        <p className="text-sm text-gray-500 mt-3">Checking WhatsApp connection...</p>
      </div>
    );
  }

  // ── Existing Channel ──
  if (step === 'existing' && existingChannel) {
    const isActive = existingChannel.connection_status === 'active';
    return (
      <div className="max-w-lg mx-auto mt-8 space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">WhatsApp Connection</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Your business has a dedicated WhatsApp number.</p>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className={`h-3 w-3 rounded-full ${isActive ? 'bg-green-500' : 'bg-amber-500'}`} />
            <span className={`text-xs font-medium ${isActive ? 'text-green-700' : 'text-amber-700'}`}>
              {isActive ? 'Connected & Active' : existingChannel.connection_status === 'pending_verification' ? 'Pending Verification' : 'Inactive'}
            </span>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Phone Number</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{existingChannel.phone_number}</span>
            </div>
            {existingChannel.display_name && (
              <div className="flex justify-between">
                <span className="text-gray-500">Display Name</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{existingChannel.display_name}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-500">Connection</span>
              <span className="text-gray-700 dark:text-gray-300 capitalize">{existingChannel.connection_method?.replace(/_/g, ' ') || 'Direct'}</span>
            </div>
          </div>

          {!isActive && existingChannel.connection_status === 'pending_verification' && (
            <div className="mt-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3">
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Your number is pending verification. Meta is reviewing your display name.
                This typically takes a few minutes to 24 hours.
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => { setExistingChannel(null); setStep('choose'); }}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Connect a Different Number
          </button>
          <button
            onClick={() => router.push('/dashboard')}
            className="flex-1 rounded-lg bg-black px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Success ──
  if (step === 'success') {
    return (
      <div className="max-w-lg mx-auto mt-12 text-center">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">WhatsApp Connected!</h2>
        <p className="text-gray-500 dark:text-gray-400 mb-1">Your bot is now running on <strong>{connectedNumber}</strong></p>
        <p className="text-sm text-gray-400 mb-2">Customers can message this number to interact with your bot.</p>

        <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20 p-4 text-left">
          <h4 className="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-1">Display Name Review</h4>
          <p className="text-xs text-blue-700 dark:text-blue-400">
            Meta will review your display name. Until approved, your number will show as a phone number in chats.
            This usually takes a few minutes but can take up to 24 hours.
          </p>
        </div>

        <div className="flex gap-3 justify-center mt-6">
          <button onClick={() => router.push('/dashboard')} className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">Go to Dashboard</button>
          <button onClick={() => router.push('/dashboard/settings')} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">WhatsApp Settings</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto mt-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Connect Your WhatsApp Number</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Get your own dedicated WhatsApp number for your business bot.</p>
      </div>

      {/* How it works */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">How it works</h3>
        <div className="space-y-3">
          {[
            { num: '1', text: 'Enter your business phone number and verify with a code' },
            { num: '2', text: 'Your number gets connected to Waaiio\'s WhatsApp platform' },
            { num: '3', text: 'Customers message your number directly — your bot handles everything' },
          ].map(s => (
            <div key={s.num} className="flex items-start gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand">{s.num}</div>
              <p className="text-sm text-gray-600 dark:text-gray-400">{s.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Warning */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 p-4">
        <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-2">Important</h3>
        <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-1.5">
          <li>&#8226; <strong>Use a separate number</strong> — do NOT use your personal WhatsApp. It will be disconnected from your phone.</li>
          <li>&#8226; <strong>Get a second SIM</strong> or virtual number (e.g. Google Voice) for your business bot.</li>
          <li>&#8226; <strong>Landline numbers work too</strong> — we can verify via voice call.</li>
          <li>&#8226; <strong>Display name</strong> must match your business name. Meta reviews it (usually takes minutes).</li>
        </ul>
      </div>

      {/* ── Choose method ── */}
      {step === 'choose' && (
        <div className="space-y-3">
          <button
            onClick={() => setStep('enter-phone')}
            className="w-full rounded-lg border-2 border-brand bg-brand/5 p-4 text-left transition hover:bg-brand/10"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">📱</span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Enter Phone Number</p>
                <p className="text-xs text-gray-500 mt-0.5">Recommended — just enter your number and verify with OTP. Your number joins Waaiio&apos;s platform.</p>
              </div>
            </div>
          </button>

          <button
            onClick={() => { setShowAdvanced(true); }}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 p-4 text-left transition hover:bg-gray-50 dark:hover:bg-gray-700/50"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔗</span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Connect via Facebook</p>
                <p className="text-xs text-gray-500 mt-0.5">Use if you already have a WhatsApp Business Account on Meta.</p>
              </div>
            </div>
          </button>

          {showAdvanced && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-900/20 p-4 text-center">
              <button
                onClick={launchFacebookLogin}
                disabled={fbConnecting || !fbSdkReady}
                className="px-6 py-3 bg-[#1877F2] text-white rounded-lg text-sm font-semibold hover:bg-[#166FE5] disabled:opacity-50 inline-flex items-center gap-2"
              >
                {fbConnecting ? 'Connecting...' : (
                  <>
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
                    Connect with Facebook
                  </>
                )}
              </button>
              {!fbSdkReady && !fbConnecting && <p className="text-xs text-gray-400 mt-2">Loading Facebook SDK...</p>}
            </div>
          )}
        </div>
      )}

      {/* ── Enter Phone ── */}
      {step === 'enter-phone' && (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Enter your business phone number</h3>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Phone Number (with country code)</label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+1 234 567 8900"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Display Name (shown to customers on WhatsApp)</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Your Business Name"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
            <p className="text-xs text-gray-400 mt-1">Must match your real business name. Meta will review this.</p>
          </div>

          <p className="text-xs text-gray-400">We&apos;ll send a 6-digit verification code via SMS. Voice call available as fallback.</p>

          <div className="flex gap-3">
            <button onClick={() => setStep('choose')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Back</button>
            <button
              onClick={handleSendOTP}
              disabled={loading || !phone.trim()}
              className="flex-1 py-2.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
            >
              {loading ? 'Sending code...' : 'Send Verification Code'}
            </button>
          </div>
        </div>
      )}

      {/* ── Verify OTP ── */}
      {step === 'verify-otp' && (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Enter verification code</h3>
          <p className="text-xs text-gray-500">We sent a 6-digit code to <strong>{phone}</strong></p>

          <input
            type="text"
            value={otp}
            onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            maxLength={6}
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-center text-lg font-mono tracking-widest dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />

          <div className="flex gap-3">
            <button onClick={() => { setStep('enter-phone'); setOtp(''); }} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Back</button>
            <button
              onClick={handleVerifyOTP}
              disabled={loading || otp.length < 6}
              className="flex-1 py-2.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Verify & Connect'}
            </button>
          </div>

          <button onClick={handleSendOTP} disabled={loading} className="w-full text-xs text-brand hover:underline disabled:opacity-50">
            Didn&apos;t receive the code? Resend
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-900/20 p-4">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Need help */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4 text-center">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">Need help connecting your number?</p>
        <a
          href="https://wa.me/12029226251?text=Hi%2C%20I%20need%20help%20connecting%20my%20WhatsApp%20number%20to%20Waaiio"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2 text-sm font-medium text-white hover:bg-[#1ebe5d] transition"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z" /></svg>
          Chat with Support on WhatsApp
        </a>
      </div>

      <button onClick={() => router.push('/dashboard')} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
        Back to Dashboard
      </button>
    </div>
  );
}
