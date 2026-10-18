/** Select only an authoritative option; never silently invent a country (e.g. NG). */
export function resolveOnboardingSelection(allowed: string[], current: string, preferred = ''): string {
  if (!allowed.length) return '';
  if (current && allowed.includes(current)) return current;
  if (preferred && allowed.includes(preferred)) return preferred;
  return allowed[0];
}
