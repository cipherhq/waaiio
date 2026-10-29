// Browser-only loader shared by the existing address widgets.
let pending: Promise<void> | undefined;

export function googlePlacesApiKey(): string | undefined {
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;
}

export function loadGooglePlaces(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Browser required'));
  if (window.google?.maps?.places) return Promise.resolve();
  if (pending) return pending;
  const apiKey = googlePlacesApiKey();
  if (!apiKey) return Promise.reject(new Error('Places not configured'));

  pending = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src*="maps.googleapis.com/maps/api/js"]');
    const script = existing || document.createElement('script');
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      script.removeEventListener('load', ready);
      script.removeEventListener('error', failed);
      if (error) {
        // Only remove a failed script that this loader owns.
        if (!existing) script.remove();
        reject(error);
      } else resolve();
    };
    const ready = () => {
      if (window.google?.maps?.places) finish();
      else if (window.google?.maps?.importLibrary) {
        window.google.maps.importLibrary('places').then(() => {
          if (window.google?.maps?.places) finish();
          else finish(new Error('Places unavailable'));
        }, () => finish(new Error('Places unavailable')));
      } else finish(new Error('Places unavailable'));
    };
    const failed = () => finish(new Error('Places unavailable'));
    const timeout = setTimeout(failed, 15000);
    script.addEventListener('load', ready);
    script.addEventListener('error', failed);
    if (window.google?.maps?.importLibrary) ready();
    else if (!existing) {
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch(error => {
    pending = undefined;
    throw error;
  });
  return pending;
}
