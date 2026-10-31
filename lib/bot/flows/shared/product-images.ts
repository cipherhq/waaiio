import type { PromptMessage } from '../types';

/** Preserve primary/variant ordering and show every saved gallery image once. */
export function productImageMessages(primary: unknown, gallery: unknown, caption: string): PromptMessage[] {
  const urls = [primary, ...(Array.isArray(gallery) ? gallery : [])]
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
  return [...new Set(urls)].map(imageUrl => ({ type: 'image', imageUrl, caption }));
}
