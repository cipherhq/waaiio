/**
 * WhatsApp Catalog API Service
 *
 * Syncs products from Waaiio's database to WhatsApp's native product catalog.
 * Businesses with a synced catalog get native product browsing in WhatsApp.
 *
 * Docs: https://developers.facebook.com/docs/commerce-platform/catalog
 */

import { logger } from '@/lib/logger';

interface CatalogProduct {
  retailer_id: string; // Must match product ID in Waaiio DB
  name: string;
  description?: string;
  price: number; // In cents (smallest currency unit)
  currency: string; // ISO 4217 (e.g., 'NGN', 'USD')
  image_url?: string;
  url?: string;
  category?: string;
  availability?: 'in stock' | 'out of stock';
}

interface CatalogSyncResult {
  synced: number;
  failed: number;
  catalogId: string;
}

export class CatalogService {
  private accessToken: string;
  private wabaId: string;
  private apiVersion: string;

  constructor(accessToken: string, wabaId: string) {
    this.accessToken = accessToken;
    this.wabaId = wabaId;
    this.apiVersion = process.env.META_GRAPH_API_VERSION || 'v22.0';
  }

  private get baseUrl() {
    return `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Get or create a product catalog for a WABA.
   */
  async getOrCreateCatalog(businessName: string): Promise<string | null> {
    try {
      // Check for existing catalog
      const listRes = await fetch(
        `${this.baseUrl}/${this.wabaId}/product_catalogs`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );

      if (listRes.ok) {
        const listData = await listRes.json();
        if (listData.data?.length > 0) {
          return listData.data[0].id;
        }
      }

      // Create new catalog
      const createRes = await fetch(
        `${this.baseUrl}/${this.wabaId}/product_catalogs`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: `${businessName} Catalog` }),
        }
      );

      if (!createRes.ok) {
        const err = await createRes.json();
        logger.error('[CATALOG] Create catalog failed:', err);
        return null;
      }

      const data = await createRes.json();
      return data.id || null;
    } catch (error) {
      logger.error('[CATALOG] Get/create catalog error:', (error as Error).message);
      return null;
    }
  }

  /**
   * Sync products to WhatsApp catalog.
   * Creates or updates products via the Commerce API.
   */
  async syncProducts(
    catalogId: string,
    products: CatalogProduct[]
  ): Promise<CatalogSyncResult> {
    let synced = 0;
    let failed = 0;

    for (const product of products) {
      try {
        const res = await fetch(
          `${this.baseUrl}/${catalogId}/products`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              retailer_id: product.retailer_id,
              name: product.name,
              description: product.description || product.name,
              price: product.price,
              currency: product.currency,
              image_url: product.image_url || undefined,
              url: product.url || process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com',
              availability: product.availability || 'in stock',
              category: product.category || undefined,
            }),
          }
        );

        if (res.ok) {
          synced++;
        } else {
          const err = await res.json();
          logger.error(`[CATALOG] Sync product ${product.retailer_id} failed:`, err);
          failed++;
        }
      } catch {
        failed++;
      }
    }

    return { synced, failed, catalogId };
  }

  /**
   * Delete products from a WhatsApp catalog by retailer IDs.
   * Uses the batch endpoint to remove multiple products at once.
   */
  async deleteProducts(catalogId: string, retailerIds: string[]): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;

    // Meta batch endpoint supports up to 1000 items per request
    const batchSize = 1000;
    for (let i = 0; i < retailerIds.length; i += batchSize) {
      const batch = retailerIds.slice(i, i + batchSize);
      const requests = batch.map(id => ({
        method: 'DELETE',
        retailer_id: id,
      }));

      try {
        const res = await fetch(`${this.baseUrl}/${catalogId}/batch`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requests }),
        });

        if (res.ok) {
          deleted += batch.length;
        } else {
          const err = await res.json();
          logger.error(`[CATALOG] Batch delete failed:`, err);
          failed += batch.length;
        }
      } catch {
        failed += batch.length;
      }
    }

    return { deleted, failed };
  }
}

/**
 * Map country code to ISO 4217 currency code.
 */
export function getCurrencyForCountry(countryCode: string): string {
  const map: Record<string, string> = {
    NG: 'NGN', GH: 'GHS', US: 'USD', GB: 'GBP', CA: 'CAD',
  };
  return map[countryCode] || 'USD';
}
