/**
 * Marketplace Search Service
 *
 * Finds Waaiio businesses based on customer criteria (category, location,
 * delivery, group size, free text, etc.).  Uses the businesses table with
 * discovery columns added in migration 239.
 *
 * Results are scored and ranked by relevance — category match, proximity,
 * open-now status, verification, and delivery support.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

// ── Public types ───────────────────────────────────────

export interface MarketplaceSearchCriteria {
  category?: string;
  serviceName?: string;
  productName?: string;
  locationText?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  openNow?: boolean;
  budgetMax?: number;
  supportsDelivery?: boolean;
  partySize?: number;
  query?: string; // Free text search
  country?: string;
  limit?: number;
}

export interface MarketplaceResult {
  businessId: string;
  name: string;
  category: string;
  shortDescription: string | null;
  distanceKm?: number;
  isOpenNow?: boolean;
  priceBand?: string;
  supportsDelivery?: boolean;
  address?: string;
  phone?: string;
  botCode?: string;
  matchReasons: string[];
  actions: string[];
}

// Row shape returned by the marketplace query — these columns include
// fields added in migration 239 that may not be in generated types yet.
interface BusinessRow {
  id: string;
  name: string;
  category: string;
  description: string | null;
  address: string | null;
  phone: string | null;
  bot_code: string | null;
  latitude: number | null;
  longitude: number | null;
  discovery_enabled: boolean | null;
  discovery_description: string | null;
  price_band: string | null;
  supports_delivery: boolean | null;
  max_group_size: number | null;
  is_verified: boolean | null;
  metadata: Record<string, unknown> | null;
  operating_hours: unknown;
}

// ── Main search function ───────────────────────────────

export async function searchMarketplace(
  supabase: SupabaseClient,
  criteria: MarketplaceSearchCriteria,
): Promise<MarketplaceResult[]> {
  const limit = Math.min(criteria.limit || 5, 10);

  try {
    let query = supabase
      .from('businesses')
      .select(
        'id, name, category, description, address, phone, bot_code, latitude, longitude, ' +
        'discovery_enabled, discovery_description, price_band, supports_delivery, ' +
        'max_group_size, is_verified, metadata, operating_hours',
      )
      .eq('is_active', true)
      .eq('status', 'active');

    // Category filter
    if (criteria.category) {
      query = query.ilike('category', `%${criteria.category}%`);
    }

    // Country filter
    if (criteria.country) {
      query = query.eq('country_code', criteria.country);
    }

    // Delivery filter
    if (criteria.supportsDelivery) {
      query = query.eq('supports_delivery', true);
    }

    // Group size filter
    if (criteria.partySize) {
      query = query.gte('max_group_size', criteria.partySize);
    }

    // Text search — name / description / category ILIKE
    if (criteria.query) {
      // Sanitize the query to prevent PostgREST injection
      const safeQ = criteria.query.replace(/[%_'"\\]/g, '');
      if (safeQ.length > 0) {
        query = query.or(
          `name.ilike.%${safeQ}%,description.ilike.%${safeQ}%,category.ilike.%${safeQ}%`,
        );
      }
    }

    // Fetch extra rows for scoring / filtering
    query = query.limit(limit * 3);

    const { data, error } = await query;
    const businesses = data as BusinessRow[] | null;

    if (error) {
      logger.error('[MARKETPLACE] Search error:', error.message);
      return [];
    }

    if (!businesses || businesses.length === 0) return [];

    // Score and rank results
    const scored = businesses.map((biz) => {
      let score = 0;
      const reasons: string[] = [];

      // Category match
      if (
        criteria.category &&
        biz.category?.toLowerCase().includes(criteria.category.toLowerCase())
      ) {
        score += 30;
        reasons.push('Category match');
      }

      // Name / description match
      if (criteria.query) {
        if (biz.name?.toLowerCase().includes(criteria.query.toLowerCase())) {
          score += 20;
          reasons.push('Name match');
        }
      }

      // Distance scoring (haversine)
      let distanceKm: number | undefined;
      if (
        criteria.latitude &&
        criteria.longitude &&
        biz.latitude &&
        biz.longitude
      ) {
        distanceKm = haversineDistance(
          criteria.latitude,
          criteria.longitude,
          biz.latitude,
          biz.longitude,
        );
        if (criteria.radiusKm && distanceKm > criteria.radiusKm) {
          return null; // Outside requested radius
        }
        if (distanceKm < 2) score += 25;
        else if (distanceKm < 5) score += 15;
        else if (distanceKm < 10) score += 10;
        reasons.push(`${distanceKm.toFixed(1)} km away`);
      }

      // Open now
      const isOpen = checkIfOpen(biz.operating_hours);
      if (criteria.openNow && !isOpen) return null;
      if (isOpen) {
        score += 10;
        reasons.push('Open now');
      }

      // Delivery
      if (biz.supports_delivery) {
        score += 5;
        if (criteria.supportsDelivery) reasons.push('Delivery available');
      }

      // Verified
      if (biz.is_verified) {
        score += 10;
        reasons.push('Verified');
      }

      // Actions — generic since we don't load capabilities here
      const actions: string[] = ['view_business', 'book', 'chat'];

      return {
        businessId: biz.id as string,
        name: biz.name as string,
        category: biz.category as string,
        shortDescription:
          (biz.discovery_description as string | null) ||
          ((biz.description as string | null)?.slice(0, 100) ?? null),
        distanceKm,
        isOpenNow: isOpen,
        priceBand: biz.price_band as string | undefined,
        supportsDelivery: biz.supports_delivery as boolean | undefined,
        address: biz.address as string | undefined,
        phone: biz.phone as string | undefined,
        botCode: biz.bot_code as string | undefined,
        matchReasons: reasons,
        actions,
        _score: score,
      };
    }).filter(Boolean) as (MarketplaceResult & { _score: number })[];

    // Sort by score descending
    scored.sort((a, b) => b._score - a._score);

    // Return top results without internal score
    return scored.slice(0, limit).map(({ _score: _, ...rest }) => rest);
  } catch (err) {
    logger.error('[MARKETPLACE] Search failed:', err);
    return [];
  }
}

// ── Format results for WhatsApp ────────────────────────

export function formatMarketplaceResults(
  results: MarketplaceResult[],
  searchDescription: string,
): string {
  if (results.length === 0) {
    return `I couldn't find any businesses matching "${searchDescription}". Try a different area or category.`;
  }

  const lines: string[] = [
    `I found ${results.length} Waaiio business${results.length > 1 ? 'es' : ''} for you:\n`,
  ];

  results.forEach((r, i) => {
    lines.push(`${i + 1}. *${r.name}*`);
    const details: string[] = [];
    if (r.distanceKm !== undefined) details.push(`${r.distanceKm.toFixed(1)} km away`);
    if (r.isOpenNow) details.push('Open now');
    if (r.supportsDelivery) details.push('Delivery available');
    if (details.length) lines.push(details.join(' · '));
    if (r.shortDescription) lines.push(r.shortDescription);
    if (r.botCode) lines.push(`Send *${r.botCode}* to connect`);
    lines.push('');
  });

  return lines.join('\n').trim();
}

// ── Helpers ────────────────────────────────────────────

function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function checkIfOpen(operatingHours: unknown): boolean {
  if (!operatingHours || typeof operatingHours !== 'object') return true; // Default to open
  const hours = operatingHours as Record<
    string,
    { open?: string; close?: string; closed?: boolean }
  >;
  const now = new Date();
  const days = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  const today = days[now.getDay()];
  const todayHours = hours[today];
  if (!todayHours || todayHours.closed) return false;
  if (!todayHours.open || !todayHours.close) return true;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [oH, oM] = todayHours.open.split(':').map(Number);
  const [cH, cM] = todayHours.close.split(':').map(Number);
  return currentMinutes >= oH * 60 + oM && currentMinutes <= cH * 60 + cM;
}
