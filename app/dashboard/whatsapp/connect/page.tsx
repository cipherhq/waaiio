'use client';

import { useState, useEffect } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { useRouter } from 'next/navigation';

export default function ConnectWhatsAppPage() {
  const business = useBusiness();
  const router = useRouter();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ phone_number: string } | null>(null);
  const [fbReady, setFbReady] = useState(false);

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID;

  // Load Facebook SDK directly (not via Next/Script to avoid timing issues)
  useEffect(() => {
    if (typeof window === 'undefined' || !appId) return;

    // Already loaded
    if (window.FB) {
      setFbReady(true);
      return;
    }

    // Set up fbAsyncInit BEFORE loading the script
    window.fbAsyncInit = function () {
      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: 'v22.0',
      });
      setFbReady(true);
    };

    // Load SDK script
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);

    return () => {
      // Cleanup on unmount
      try { document.body.removeChild(script); } catch { /* ignore */ }
    };
  }, [appId]);

  // Must be a plain function (not useCallback) called directly from onClick
  // to avoid popup blockers. FB.login MUST be synchronous from user click.
  function startEmbeddedSignup() {
    const FB = window.FB;
    if (!FB) {
      setError('Facebook SDK not loaded. Please refresh the page and try again.');
      return;
    }

    setError(null);
    setConnecting(true);

    // Call FB.login synchronously from click handler — critical for popup
    FB.login(
      function (response: { authResponse?: { code?: string } }) {
        if (!response.authResponse?.code) {
          setConnecting(false);
          setError('Connection cancelled or no access was granted.');
          return;
        }

        // Process the auth code
        fetch('/api/whatsapp/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: business.id,
            code: response.authResponse.code,
          }),
        })
          .then(res => res.json().then(data => ({ ok: res.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) {
              setError(data.error || 'Failed to connect. Please try again.');
            } else {
              setSuccess({ phone_number: data.phone_number });
            }
            setConnecting(false);
          })
          .catch(() => {
            setError('Something went wrong. Please try again.');
            setConnecting(false);
          });
      },
      {
        config_id: configId,
        response_type: 'code',
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

  return (
    <div className="max-w-lg mx-auto mt-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Connect Your WhatsApp Number</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Use your own WhatsApp Business number instead of the shared Waaiio number.
          Your bot will run on your dedicated number.
        </p>
      </div>

      {/* Benefits */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Why connect your own number?</h3>
        <div className="space-y-2">
          {[
            { icon: '🔒', text: 'Dedicated number — customers message you directly' },
            { icon: '✅', text: 'Verified business name shows in WhatsApp' },
            { icon: '📊', text: 'Higher messaging limits (up to 100K/day)' },
            { icon: '🎨', text: 'Custom profile picture and business description' },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <span>{item.icon}</span>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Connect button */}
      <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-900/20 p-5 text-center">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          You&apos;ll be redirected to Facebook to connect your WhatsApp Business Account.
        </p>

        <button
          onClick={startEmbeddedSignup}
          disabled={connecting || !fbReady}
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

        {!fbReady && !connecting && (
          <p className="text-xs text-gray-400 mt-2">Loading Facebook SDK...</p>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-900/20 p-4">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      <button
        onClick={() => router.push('/dashboard/whatsapp')}
        className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
      >
        Back to WhatsApp Settings
      </button>
    </div>
  );
}
