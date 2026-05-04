'use client';

import { useState, useEffect, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { useRouter } from 'next/navigation';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

export default function ConnectWhatsAppPage() {
  const business = useBusiness();
  const router = useRouter();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ phone_number: string } | null>(null);
  const [fbSdkReady, setFbSdkReady] = useState(false);
  const fbSdkLoaded = useRef(false);

  const appId = (process.env.NEXT_PUBLIC_META_APP_ID || '').trim();
  const configId = (process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID || '').trim();

  // Load Facebook SDK — exact same pattern as get-started page (proven to work)
  useEffect(() => {
    if (!appId || fbSdkLoaded.current) return;

    window.fbAsyncInit = function () {
      if (fbSdkLoaded.current) return;
      window.FB.init({ appId, cookie: true, xfbml: true, version: 'v22.0' });
      fbSdkLoaded.current = true;
      setFbSdkReady(true);
    };

    // Remove stale SDK script
    const stale = document.getElementById('facebook-jssdk');
    if (stale) {
      stale.remove();
      (window as any).FB = undefined;
    }

    // Inject fresh script
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);
  }, [appId]);

  // FB.login — called directly from onClick, must be synchronous
  function launchFacebookLogin() {
    if (!window.FB || !fbSdkLoaded.current) {
      setError('Facebook is still loading. Please wait a moment and try again.');
      return;
    }

    setError(null);
    setConnecting(true);

    window.FB.login(
      function (response: any) {
        if (response.authResponse) {
          const accessToken = response.authResponse.accessToken || response.authResponse.code;

          fetch('/api/auth/facebook/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: accessToken, access_token: response.authResponse.accessToken }),
          })
            .then(res => res.json().then(data => ({ ok: res.ok, data })))
            .then(({ ok, data }) => {
              if (!ok) {
                const fbErrMsg = data.error?.error?.message || data.error?.message || '';
                const debugUri = data.debug_redirect_uri || '';
                setError((data.message || 'Failed to connect.') + (fbErrMsg ? ` (${fbErrMsg})` : '') + (debugUri ? ` [redirect_uri: ${debugUri}]` : ''));
                setConnecting(false);
                return;
              }

              // Discover returns WABAs — auto-connect the first one
              const wabas = data.wabas || [];
              if (wabas.length === 0) {
                setError('No WhatsApp Business Account found. Please try again.');
                setConnecting(false);
                return;
              }

              const waba = wabas[0];
              const phone = waba.phones?.[waba.phones.length - 1];

              // Save the channel via the callback endpoint
              fetch('/api/auth/facebook/callback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  business_id: business.id,
                  waba_id: waba.waba_id,
                  phone_number_id: phone?.id,
                  access_token: data.access_token,
                  token_expires_at: data.token_expires_at,
                  display_name: phone?.display_phone_number || phone?.verified_name,
                  phone_number: phone?.display_phone_number,
                }),
              })
                .then(r => r.json().then(d2 => ({ ok: r.ok, d2 })))
                .then(({ ok: ok2, d2 }) => {
                  if (ok2) {
                    setSuccess({ phone_number: phone?.display_phone_number || 'Connected' });
                  } else {
                    setError(d2.error || d2.message || 'Failed to save connection.');
                  }
                  setConnecting(false);
                })
                .catch(() => {
                  setError('Failed to save connection. Please try again.');
                  setConnecting(false);
                });
            })
            .catch(() => {
              setError('Something went wrong. Please try again.');
              setConnecting(false);
            });
        } else {
          setConnecting(false);
          setError('Connection cancelled or no access was granted.');
        }
      },
      {
        config_id: configId,
        response_type: 'code token',
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: '',
          sessionInfoVersion: '3',
        },
      },
    );
  }

  if (success) {
    return (
      <div className="max-w-lg mx-auto mt-12 text-center">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">WhatsApp Connected!</h2>
        <p className="text-gray-500 dark:text-gray-400 mb-1">Your bot is now running on <strong>{success.phone_number}</strong></p>
        <p className="text-sm text-gray-400 mb-6">Customers can message this number to interact with your bot.</p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => router.push('/dashboard/whatsapp')} className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">
            WhatsApp Settings
          </button>
          <button onClick={() => router.push('/dashboard')} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
            Dashboard
          </button>
        </div>
      </div>
    );
  }

  const supportNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || '12029226251';

  return (
    <div className="max-w-lg mx-auto mt-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Connect Your WhatsApp Number</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Get your own dedicated WhatsApp number for your business bot.
        </p>
      </div>

      {/* Benefits */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Why connect your own number?</h3>
        {[
          { icon: '🔒', text: 'Customers message you directly — no bot code needed' },
          { icon: '✅', text: 'Your verified business name shows in WhatsApp' },
          { icon: '📊', text: 'Higher messaging limits (up to 100K/day)' },
          { icon: '🎨', text: 'Custom profile picture and business description' },
        ].map((item, i) => (
          <div key={i} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <span>{item.icon}</span>
            <span>{item.text}</span>
          </div>
        ))}
      </div>

      {/* Warning */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 p-4">
        <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-2">⚠️ Important — Read Before Connecting</h3>
        <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-1.5">
          <li><strong>Use a separate number.</strong> Do NOT connect your personal WhatsApp number — it will be disconnected from your phone.</li>
          <li><strong>Get a second SIM</strong> or virtual number for your business bot. Keep your personal WhatsApp on your main number.</li>
          <li><strong>Already using WhatsApp Business app?</strong> That number will stop working on the app once connected here. All messages will go through Waaiio instead.</li>
          <li><strong>Landline numbers work too.</strong> Facebook can verify via voice call, not just SMS.</li>
        </ul>
      </div>

      {/* Steps */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">How it works</h3>
        <div className="space-y-2.5">
          {[
            { step: '1', text: 'Click "Connect with Facebook" below' },
            { step: '2', text: 'Log into your Facebook account (or create one)' },
            { step: '3', text: 'Create or select a Meta Business Portfolio' },
            { step: '4', text: 'Create a WhatsApp Business Account (automatic)' },
            { step: '5', text: 'Enter your business phone number and verify it via SMS or call' },
            { step: '6', text: 'Grant Waaiio permission to manage your WhatsApp' },
          ].map((item) => (
            <div key={item.step} className="flex items-start gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[10px] font-bold text-brand">{item.step}</span>
              <span className="text-sm text-gray-600 dark:text-gray-400">{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Connect button */}
      <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-900/20 p-5 text-center">

        <button
          onClick={launchFacebookLogin}
          disabled={connecting || !fbSdkReady}
          className="px-6 py-3 bg-[#1877F2] text-white rounded-lg text-sm font-semibold hover:bg-[#166FE5] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {connecting ? (
            'Connecting...'
          ) : (
            <>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
              Connect with Facebook
            </>
          )}
        </button>

        {!fbSdkReady && !connecting && (
          <p className="text-xs text-gray-400 mt-2">Loading Facebook SDK...</p>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-900/20 p-4">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Need help */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4 text-center">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">Need help connecting your number?</p>
        <a
          href={`https://wa.me/${supportNumber}?text=Hi%2C%20I%20need%20help%20connecting%20my%20WhatsApp%20number%20to%20Waaiio`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2 text-sm font-medium text-white hover:bg-[#1ebe5d] transition"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z" />
          </svg>
          Chat with Support on WhatsApp
        </a>
      </div>

      <button
        onClick={() => router.push('/dashboard/whatsapp')}
        className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
      >
        Back to WhatsApp Settings
      </button>
    </div>
  );
}
