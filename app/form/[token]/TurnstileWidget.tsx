'use client';

import { useEffect, useRef } from 'react';

/**
 * Cloudflare Turnstile widget for the public form page.
 *
 * Rendered with appearance "interaction-only", so most people never see it: it
 * only shows a box when Cloudflare wants the visitor to click. The token it
 * produces is checked on the server by /api/forms/submit (lib/security/turnstile.ts).
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Cloudflare's documented always-pass test site key, used only outside production. */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';

/** The site key to use: the configured one, else the test key outside production, else none. */
export function resolveTurnstileSiteKey(configured: string | undefined, nodeEnv: string | undefined): string {
  const key = configured?.trim();
  if (key) return key;
  return nodeEnv !== 'production' ? TURNSTILE_TEST_SITE_KEY : '';
}

export function turnstileSiteKey(): string {
  // Literal process.env references, so Next.js inlines them into the browser bundle.
  return resolveTurnstileSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, process.env.NODE_ENV);
}

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

function getApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (getApi()) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        script.remove();
        reject(new Error('Turnstile script failed to load'));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

interface Props {
  /** Public site key; '' means the check cannot run, so the form cannot be sent. */
  siteKey: string;
  /** Called with a fresh token, or '' when the token expires or the check errors. */
  onToken: (token: string) => void;
  /** Called when the check cannot load or run. */
  onError: () => void;
  /** Bump this number to get a new token (tokens are single-use; the page drops a sent one). */
  resetSignal: number;
}

export function TurnstileWidget({ siteKey, onToken, onError, resetSignal }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbacks = useRef({ onToken, onError });
  callbacks.current = { onToken, onError };

  useEffect(() => {
    if (!siteKey) {
      callbacks.current.onError();
      return;
    }
    let cancelled = false;
    loadScript()
      .then(() => {
        const api = getApi();
        if (cancelled || !api || !containerRef.current) return;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          action: 'form_submit',
          appearance: 'interaction-only',
          callback: (token: string) => callbacks.current.onToken(token),
          'expired-callback': () => callbacks.current.onToken(''),
          'error-callback': () => {
            callbacks.current.onToken('');
            callbacks.current.onError();
          },
        });
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onError();
      });
    return () => {
      cancelled = true;
      const api = getApi();
      if (api && widgetIdRef.current) api.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetSignal === 0) return;
    const api = getApi();
    if (api && widgetIdRef.current) api.reset(widgetIdRef.current);
  }, [resetSignal]);

  return <div ref={containerRef} data-testid="turnstile-widget" className="flex justify-center" />;
}
